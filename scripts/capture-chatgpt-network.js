import fs from "fs";
import path from "path";
import readline from "readline";
import dotenv from "dotenv";
import chalk from "chalk";
import { connect } from "puppeteer-real-browser";

dotenv.config();

const projectDir = path.resolve();
const cookiesPath = path.resolve(
  process.env.CHATGPT_COOKIES_PATH || "src/cookies/chatgpt.com.cookies.json",
);
const outputPath = path.resolve(
  process.env.NETWORK_CAPTURE_PATH || "artifacts/chatgpt-network.jsonl",
);

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
const output = fs.createWriteStream(outputPath, { flags: "a" });

function redact(value) {
  if (typeof value !== "string") return value;
  return value
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(/(authorization|cookie|token|secret|session)[=:][^;&\s,}]+/gi, "$1=[REDACTED]")
    .replace(/eyJ[A-Za-z0-9_-]{20,}/g, "[JWT_REDACTED]");
}

function write(event, data = {}) {
  const record = { timestamp: new Date().toISOString(), event, ...data };
  output.write(`${JSON.stringify(record)}\n`);
  const summary = data.url || data.urlPath || data.type || "";
  console.log(chalk.gray(`[${event}] ${redact(summary)}`));
}

function safeHeaders(headers = {}) {
  const sensitive = /authorization|cookie|token|secret|session|csrf/i;
  return Object.fromEntries(
    Object.entries(headers)
      .filter(([name]) => !sensitive.test(name))
      .map(([name, value]) => [name, redact(String(value))]),
  );
}

function safeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "[invalid-url]";
  }
}

function safeWebSocketUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return {
      url: `${url.origin}${url.pathname}`,
      queryKeys: [...url.searchParams.keys()],
    };
  } catch {
    return { url: "[invalid-url]", queryKeys: [] };
  }
}

function payloadShape(payload) {
  if (typeof payload !== "string") return { type: typeof payload };
  try {
    const value = JSON.parse(payload);
    const shape = (item, depth = 0) => {
      if (depth > 3 || item === null) return item === null ? "null" : typeof item;
      if (Array.isArray(item)) return { array: item.length, first: shape(item[0], depth + 1) };
      if (typeof item === "object") {
        return Object.fromEntries(
          Object.entries(item).map(([key, child]) => [
            key,
              key === "encoded_item" && typeof child === "string"
                ? { type: "encoded", length: child.length, decoded: decodeEncodedShape(child) }
                : typeof child === "string"
              ? /^(type|command|status|event|action)$/.test(key)
                ? { type: "string", value: redact(child) }
                : { type: "string", length: child.length }
              : shape(child, depth + 1),
          ]),
        );
      }
      return typeof item;
    };
    return { encoding: "json", shape: shape(value) };
  } catch {
    return { encoding: "text", length: payload.length };
  }
}

function decodeEncodedShape(encoded) {
  try {
    const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const decoded = Buffer.from(padded, "base64").toString("utf8");
    return payloadShape(decoded);
  } catch {
    return { encoding: "unknown" };
  }
}

if (!fs.existsSync(cookiesPath)) {
  throw new Error(`Cookie file not found: ${cookiesPath}`);
}

const cookies = JSON.parse(fs.readFileSync(cookiesPath, "utf8"));
if (!Array.isArray(cookies)) throw new Error("Cookie file must contain a JSON array");

const { browser, page } = await connect({
  headless: false,
  defaultViewport: null,
  fingerprint: true,
  turnstile: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--start-maximized"],
});

// CDP catches sockets created by workers/frames as well as page-level sockets.
const cdp = await page.createCDPSession();
await cdp.send("Network.enable");
const wsUrlById = new Map();

cdp.on("Network.webSocketCreated", ({ requestId, url }) => {
  const safe = safeWebSocketUrl(url);
  wsUrlById.set(requestId, safe);
  write("websocketcreated", { requestId, ...safe });
});
cdp.on("Network.webSocketWillSendHandshakeRequest", ({ requestId, request }) => {
  write("websocket_handshake_request", {
    requestId,
    ...(wsUrlById.get(requestId) || {}),
    headers: safeHeaders(request.headers),
  });
});
cdp.on("Network.webSocketHandshakeResponseReceived", ({ requestId, response }) => {
  write("websocket_handshake_response", {
    requestId,
    ...(wsUrlById.get(requestId) || {}),
    status: response.status,
    headers: safeHeaders(response.headers),
  });
});
cdp.on("Network.webSocketFrameSent", ({ requestId, response }) => {
  write("websocket_frame_sent", {
    requestId,
    ...(wsUrlById.get(requestId) || {}),
    bytes: Buffer.byteLength(response.payloadData || "", "utf8"),
    payload: payloadShape(response.payloadData),
  });
});
cdp.on("Network.webSocketFrameReceived", ({ requestId, response }) => {
  write("websocket_frame_received", {
    requestId,
    ...(wsUrlById.get(requestId) || {}),
    bytes: Buffer.byteLength(response.payloadData || "", "utf8"),
    payload: payloadShape(response.payloadData),
  });
});
cdp.on("Network.webSocketFrameError", ({ requestId, errorMessage }) => {
  write("websocket_frame_error", {
    requestId,
    ...(wsUrlById.get(requestId) || {}),
    errorMessage: redact(errorMessage),
  });
});
cdp.on("Network.webSocketClosed", ({ requestId }) => {
  write("websocketclosed", { requestId, ...(wsUrlById.get(requestId) || {}) });
});

await page.setCookie(...cookies);

page.on("request", (request) => {
  write("request", {
    method: request.method(),
    url: safeUrl(request.url()),
    resourceType: request.resourceType(),
    headers: safeHeaders(request.headers()),
  });
});

page.on("response", async (response) => {
  write("response", {
    status: response.status(),
    url: safeUrl(response.url()),
    headers: safeHeaders(response.headers()),
  });
});

page.on("requestfailed", (request) => {
  write("requestfailed", {
    method: request.method(),
    url: safeUrl(request.url()),
    errorText: request.failure()?.errorText || "unknown",
  });
});

page.on("websocketcreated", (webSocket) => {
  write("websocketcreated", { url: safeUrl(webSocket.url()) });
});

page.on("websocketframesent", (webSocket, payload) => {
  write("websocket_frame_sent", {
    url: safeUrl(webSocket.url()),
    bytes: Buffer.byteLength(payload || "", "utf8"),
  });
});

page.on("websocketframereceived", (webSocket, payload) => {
  write("websocket_frame_received", {
    url: safeUrl(webSocket.url()),
    bytes: Buffer.byteLength(payload || "", "utf8"),
  });
});

page.on("websocketclosed", (webSocket) => {
  write("websocketclosed", { url: safeUrl(webSocket.url()) });
});

await page.goto("https://chatgpt.com", {
  waitUntil: "domcontentloaded",
  timeout: 90000,
});

console.log(chalk.green(`Browser ready. Submit your prompt manually in the opened window.`));
console.log(chalk.cyan(`Sanitized capture: ${outputPath}`));
console.log(chalk.yellow("Press Enter here when you are finished. No prompt text or credentials are recorded."));

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
await new Promise((resolve) => rl.once("line", resolve));
rl.close();
await browser.close();
output.end();
console.log(chalk.green("Capture complete."));
