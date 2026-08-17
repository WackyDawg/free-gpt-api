import fs from "fs";
import path from "path";
import readline from "readline";
import zlib from "zlib";
import dotenv from "dotenv";
import chalk from "chalk";
import { connect } from "puppeteer-real-browser";

dotenv.config();

/**
 * Structural probe for the `encoded_item` field carried by
 * conversation-turn-stream frames on the page's own WebSocket.
 *
 * Records ONLY structural facts (length, alphabet, magic bytes, decoder
 * outcomes, JSON key names). Never records message text, the `verify` query
 * value, cookies or headers. Set PROBE_PREVIEW=true to additionally record a
 * short redacted head/tail of each candidate decode while you are iterating —
 * leave it off for anything you intend to share.
 */

const PREVIEW = process.env.PROBE_PREVIEW === "true";
const cookiesPath = path.resolve(
  process.env.CHATGPT_COOKIES_PATH || "src/cookies/chatgpt.com.cookies.json",
);
const outputPath = path.resolve(
  process.env.PROBE_OUTPUT_PATH || "artifacts/encoded-item-probe.json",
);

fs.mkdirSync(path.dirname(outputPath), { recursive: true });

// ---------------------------------------------------------------------------
// Alphabet / framing analysis
// ---------------------------------------------------------------------------

const B64_STD = /^[A-Za-z0-9+/]*={0,2}$/;
const B64_URL = /^[A-Za-z0-9_-]*={0,2}$/;

function alphabetClass(text) {
  const classes = [];
  if (B64_URL.test(text)) classes.push("base64url-charset");
  if (B64_STD.test(text)) classes.push("base64-charset");
  if (/^[\x20-\x7e]*$/.test(text)) classes.push("printable-ascii");
  if (/[^\x00-\x7f]/.test(text)) classes.push("non-ascii");
  return classes.length ? classes : ["other"];
}

/** Characters outside the base64url alphabet, with counts — this is what tells
 *  you whether there is a version tag, a separator, or a different alphabet. */
function outliers(text) {
  const counts = {};
  for (const ch of text) {
    if (/[A-Za-z0-9_-]/.test(ch)) continue;
    counts[ch] = (counts[ch] || 0) + 1;
  }
  return counts;
}

/** base64 length is never ≡ 1 (mod 4). A population that hits 1 is not base64. */
function base64LengthPlausible(len) {
  return len % 4 !== 1;
}

// ---------------------------------------------------------------------------
// Candidate decoders — each returns { ok, bytes } or { ok: false, reason }
// ---------------------------------------------------------------------------

function tryBase64(text, urlSafe) {
  if (!(urlSafe ? B64_URL : B64_STD).test(text)) {
    return { ok: false, reason: "charset" };
  }
  const stripped = text.replace(/=+$/, "");
  if (!base64LengthPlausible(stripped.length)) {
    return { ok: false, reason: "length%4==1" };
  }
  const normalized = urlSafe
    ? stripped.replace(/-/g, "+").replace(/_/g, "/")
    : stripped;
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const bytes = Buffer.from(padded, "base64");
  // Buffer.from silently drops invalid input, so verify the round trip.
  const roundTrip = bytes.toString("base64").replace(/=+$/, "");
  if (roundTrip !== padded.replace(/=+$/, "")) {
    return { ok: false, reason: "round-trip-mismatch" };
  }
  return { ok: true, bytes };
}

/** Many wire formats prefix a version/type tag: "v1:", "1.", "a|"… Split on the
 *  first non-base64url character and retry the tail. */
function trySplitPrefix(text) {
  const match = text.match(/^([^A-Za-z0-9_-]{0,4}|[A-Za-z0-9]{1,4}[^A-Za-z0-9_-])/);
  if (!match || !match[0]) return { ok: false, reason: "no-prefix" };
  const tail = text.slice(match[0].length);
  const decoded = tryBase64(tail, true).ok
    ? tryBase64(tail, true)
    : tryBase64(tail, false);
  if (!decoded.ok) return { ok: false, reason: `prefix:${decoded.reason}` };
  return { ok: true, prefix: match[0], bytes: decoded.bytes };
}

function magic(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) return "gzip";
  if (bytes.length >= 2 && bytes[0] === 0x78 && [0x01, 0x5e, 0x9c, 0xda].includes(bytes[1])) {
    return "zlib";
  }
  if (
    bytes.length >= 4 &&
    bytes.readUInt32LE(0) === 0xfd2fb528
  ) {
    return "zstd";
  }
  if (bytes.length >= 1 && (bytes[0] === 0x7b || bytes[0] === 0x5b)) return "json-text";
  // protobuf: first byte is a varint key, low 3 bits are a valid wire type
  if (bytes.length >= 2 && (bytes[0] & 0x07) <= 5 && (bytes[0] & 0x07) !== 3 && (bytes[0] & 0x07) !== 4) {
    return "possible-protobuf";
  }
  if (bytes.length >= 1 && bytes[0] >= 0x80 && bytes[0] <= 0x9f) return "possible-msgpack-map";
  return "unknown";
}

function tryInflate(bytes) {
  for (const [name, fn] of [
    ["gunzip", zlib.gunzipSync],
    ["inflate", zlib.inflateSync],
    ["inflateRaw", zlib.inflateRawSync],
    ["brotli", zlib.brotliDecompressSync],
  ]) {
    try {
      return { ok: true, codec: name, bytes: fn(bytes) };
    } catch {}
  }
  return { ok: false };
}

/** Structural read of decoded bytes: is it JSON, SSE framing, or opaque? */
function classifyBytes(bytes) {
  const text = bytes.toString("utf8");
  const valid = Buffer.compare(Buffer.from(text, "utf8"), bytes) === 0;
  const report = {
    byteLength: bytes.length,
    magic: magic(bytes),
    validUtf8: valid,
  };

  if (valid) {
    if (/^(event|data|id|retry):/m.test(text)) {
      report.framing = "sse";
      report.sseFields = [...new Set(text.match(/^[a-z]+(?=:)/gm) || [])];
      const dataLines = text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim());
      for (const line of dataLines) {
        try {
          report.sseDataKeys = Object.keys(JSON.parse(line));
          break;
        } catch {}
      }
    }
    try {
      const value = JSON.parse(text);
      report.framing = "json";
      report.jsonKeys = Array.isArray(value) ? ["<array>"] : Object.keys(value);
    } catch {}
    if (PREVIEW) {
      report.head = text.slice(0, 120);
      report.tail = text.slice(-40);
    }
  }

  if (!report.framing) {
    const inflated = tryInflate(bytes);
    if (inflated.ok) {
      report.framing = `compressed:${inflated.codec}`;
      report.inner = classifyBytes(inflated.bytes);
    }
  }

  return report;
}

function probe(encoded) {
  const result = {
    length: encoded.length,
    lengthMod4: encoded.length % 4,
    alphabet: alphabetClass(encoded),
    nonBase64urlChars: outliers(encoded),
    decoders: {},
  };

  const attempts = {
    base64url: tryBase64(encoded, true),
    base64: tryBase64(encoded, false),
    prefixStripped: trySplitPrefix(encoded),
  };

  for (const [name, attempt] of Object.entries(attempts)) {
    if (!attempt.ok) {
      result.decoders[name] = { ok: false, reason: attempt.reason };
      continue;
    }
    result.decoders[name] = {
      ok: true,
      ...(attempt.prefix ? { prefix: attempt.prefix } : {}),
      ...classifyBytes(attempt.bytes),
    };
  }

  // The string may not be encoded at all.
  result.rawIsJson = (() => {
    try {
      return { ok: true, keys: Object.keys(JSON.parse(encoded)) };
    } catch {
      return { ok: false };
    }
  })();

  return result;
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

if (!fs.existsSync(cookiesPath)) {
  throw new Error(`Cookie file not found: ${cookiesPath}`);
}
const cookies = JSON.parse(fs.readFileSync(cookiesPath, "utf8"));
if (!Array.isArray(cookies)) throw new Error("Cookie file must contain a JSON array");

const samples = [];
const turns = new Map();

function record(inner) {
  const key = `${inner.conversation_id}:${inner.turn_id}`;
  if (!turns.has(key)) turns.set(key, { items: 0, done: false, complete: false });
  return turns.get(key);
}

const { browser, page } = await connect({
  headless: false,
  defaultViewport: null,
  fingerprint: true,
  turnstile: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--start-maximized"],
});

const cdp = await page.createCDPSession();
await cdp.send("Network.enable");

cdp.on("Network.webSocketFrameReceived", ({ response }) => {
  let frames;
  try {
    frames = JSON.parse(response.payloadData);
  } catch {
    return;
  }
  if (!Array.isArray(frames)) return;

  for (const frame of frames) {
    const envelope = frame?.payload;
    if (!envelope) continue;

    if (envelope.type === "conversation-turn-stream") {
      const inner = envelope.payload || {};
      const turn = record(inner);

      if (inner.type === "stream-item" && typeof inner.encoded_item === "string") {
        turn.items += 1;
        samples.push({
          turnKey: `${inner.conversation_id}:${inner.turn_id}`,
          index: turn.items,
          hasParent: Boolean(inner.parent_stream_item_id),
          ...probe(inner.encoded_item),
        });
        process.stdout.write(chalk.gray("."));
      }

      if (inner.type === "done") {
        turn.done = true;
        process.stdout.write(chalk.yellow("|done"));
      }
    }

    if (envelope.type === "conversation-turn-complete") {
      process.stdout.write(chalk.green("|complete\n"));
      for (const turn of turns.values()) turn.complete = true;
    }
  }
});

await page.setCookie(...cookies);
await page.goto("https://chatgpt.com", {
  waitUntil: "domcontentloaded",
  timeout: 90000,
});
await page.bringToFront();
await page.evaluate(() => window.focus()).catch(() => {});

console.log(chalk.green("\nBrowser ready. Send one prompt to gpt-5-6-thinking manually."));
console.log(chalk.cyan(`Probe output: ${outputPath}`));
console.log(
  chalk.yellow(
    PREVIEW
      ? "PROBE_PREVIEW=true — decoded text previews WILL be written. Do not share the output."
      : "Structural facts only. No message text, no verify value, no credentials.",
  ),
);
console.log(chalk.yellow("Press Enter here when the answer has finished rendering."));

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
await new Promise((resolve) => rl.once("line", resolve));
rl.close();

// ---------------------------------------------------------------------------
// Aggregate verdict
// ---------------------------------------------------------------------------

const lengths = samples.map((s) => s.length);
const mod4 = lengths.reduce((acc, len) => {
  acc[len % 4] = (acc[len % 4] || 0) + 1;
  return acc;
}, {});

const decoderHitRate = {};
for (const sample of samples) {
  for (const [name, outcome] of Object.entries(sample.decoders)) {
    decoderHitRate[name] = decoderHitRate[name] || { ok: 0, fail: 0, framings: {} };
    if (outcome.ok) {
      decoderHitRate[name].ok += 1;
      const framing = outcome.framing || outcome.magic || "opaque";
      decoderHitRate[name].framings[framing] =
        (decoderHitRate[name].framings[framing] || 0) + 1;
    } else {
      decoderHitRate[name].fail += 1;
    }
  }
}

const report = {
  capturedAt: new Date().toISOString(),
  sampleCount: samples.length,
  turnCount: turns.size,
  lengthStats: {
    min: Math.min(...lengths),
    max: Math.max(...lengths),
    mod4Distribution: mod4,
    // base64 output length is never ≡ 1 (mod 4) — any count here disproves base64
    base64Disproved: (mod4[1] || 0) > 0,
  },
  decoderHitRate,
  nonBase64urlCharHistogram: samples.reduce((acc, s) => {
    for (const [ch, count] of Object.entries(s.nonBase64urlChars)) {
      acc[ch] = (acc[ch] || 0) + count;
    }
    return acc;
  }, {}),
  samples,
};

fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));

console.log(chalk.green(`\nProbe complete: ${samples.length} stream-items across ${turns.size} turns.`));
console.log(chalk.cyan("length mod 4:"), mod4);
console.log(
  report.lengthStats.base64Disproved
    ? chalk.red("Verdict: NOT plain base64 (lengths ≡ 1 mod 4 observed).")
    : chalk.green("Verdict: lengths are base64-consistent."),
);
console.log(chalk.cyan("decoder hit rate:"), JSON.stringify(decoderHitRate, null, 2));
await browser.close();
