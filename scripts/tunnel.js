/**
 * Opens a Cloudflare quick tunnel to an already-running proxy.
 *
 * This deliberately does NOT start the proxy. Chrome launched from a Node
 * child process ends up with a hidden window on Windows, which breaks the
 * turnstile solver — it drives a real cursor and needs a real window. Run
 * `npm start` in your own terminal, where the browser behaves normally, and
 * point this at it.
 *
 * Needs cloudflared (`winget install --id Cloudflare.cloudflared`).
 */

import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import process from "process";
import { config } from "../src/config/config.js";

const PORT = config.port;
const HEALTH_URL = `http://localhost:${PORT}/health`;

/**
 * A shell whose PATH predates the cloudflared install will not find it, which
 * is the normal state of the terminal you ran `winget install` from. Check the
 * known install locations before falling back to a PATH lookup.
 */
function resolveCloudflared() {
  const candidates = [
    process.env.CLOUDFLARED_PATH,
    process.env.ProgramFiles &&
      path.join(process.env.ProgramFiles, "cloudflared", "cloudflared.exe"),
    process.env["ProgramFiles(x86)"] &&
      path.join(process.env["ProgramFiles(x86)"], "cloudflared", "cloudflared.exe"),
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate)) || "cloudflared";
}

async function isServing() {
  try {
    const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Ask the server that is about to be exposed whether it actually rejects an
 * anonymous request.
 *
 * Checking config.authToken here only proves *this* process read a token — a
 * proxy started before the token was added to .env is still running happily
 * with auth disabled, and /health cannot tell you that. The property worth
 * verifying is the one an attacker would test.
 */
async function enforcesAuth() {
  try {
    const res = await fetch(`http://localhost:${PORT}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
      signal: AbortSignal.timeout(5000),
    });
    return res.status === 401;
  } catch {
    return false;
  }
}

function die(...lines) {
  for (const line of lines) console.error(`[tunnel] ${line}`);
  process.exit(1);
}

if (!(await isServing())) {
  die(
    `nothing is answering on ${HEALTH_URL}.`,
    "Start the proxy first, in its own terminal, so its browser window is visible:",
    "  npm start",
    "Wait for '[pool] ready with N/N workers', then run this again.",
  );
}

if (!(await enforcesAuth())) {
  die(
    `the proxy on port ${PORT} answered an unauthenticated request instead of 401.`,
    "It was started before ANTHROPIC_AUTH_TOKEN was set in .env — .env is read",
    "once at startup, so restart it and run this again.",
    "Exposing it as-is puts an open door to your ChatGPT account online.",
  );
}

console.log("[tunnel] proxy is up and rejects anonymous requests");
console.log("[tunnel] the https://<...>.trycloudflare.com line below is your base URL");
console.log("[tunnel] Ctrl+C closes the tunnel; the proxy keeps running");

const cloudflared = spawn(
  resolveCloudflared(),
  ["tunnel", "--url", `http://localhost:${PORT}`],
  { stdio: "inherit" },
);

cloudflared.on("error", (err) => {
  if (err.code === "ENOENT") {
    die(
      "cloudflared not found. Install it, then open a NEW terminal so PATH picks it up:",
      "  winget install --id Cloudflare.cloudflared",
      "Installed somewhere unusual? Set CLOUDFLARED_PATH to the exe.",
    );
  }
  die(`cloudflared failed to start: ${err.message}`);
});

cloudflared.on("exit", (code) => process.exit(code ?? 0));

const stop = () => cloudflared.kill();
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
