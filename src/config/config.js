import dotenv from "dotenv";

dotenv.config();

export const config = {
  port: process.env.PORT || 3000,
  headless: process.env.HEADLESS === "true",
  turnstile: process.env.TURNSTILE === "true",
  fingerprint: process.env.FINGERPRINT === "true",
  debug: process.env.DEBUG === "true",
  // Exported browser cookies are loaded into the Puppeteer page at startup.
  // Keep this file outside version control and override with
  // CHATGPT_COOKIES_PATH when deploying.
  chatgptCookiesPath:
    process.env.CHATGPT_COOKIES_PATH || "src/cookies/chatgpt.com.cookies.json",
  // Legacy transport for gpt-5-6-thinking: let the page issue its own request
  // and read the answer off its WebSocket, instead of posting the structured
  // message list. It submits the whole conversation as one composer message,
  // which breaks tool calling, so it is off by default. Only useful as a
  // fallback if the structured path regresses for thinking models.
  nativeThinkingPath: process.env.NATIVE_THINKING_PATH === "true",
  // Concurrency. Each worker is a browser tab with its own page and socket
  // tap; requests are serialised per worker, never within one. Raising this
  // past what the upstream account tolerates trades throughput for rate limits.
  poolSize: Math.max(1, Number(process.env.POOL_SIZE) || 3),
  // Requests waiting for a free worker. Beyond this the proxy returns 429
  // rather than letting every client sit in an unbounded queue and time out.
  maxQueue: Math.max(0, Number(process.env.MAX_QUEUE ?? 32)),
  // Anthropic-compatible surface (/v1/messages). When authToken is empty no
  // authentication is required; when set, clients must send it as x-api-key,
  // Authorization: Bearer <token>, or anthropic-auth-token.
  authToken: process.env.ANTHROPIC_AUTH_TOKEN || "",
  // Claude model classes are routed to backend models by name. Claude Code
  // sends e.g. claude-opus-4-*, claude-sonnet-4-5-*, claude-3-5-haiku-*.
  modelOpus: process.env.MODEL_OPUS || "gpt-5-6-thinking",
  modelSonnet: process.env.MODEL_SONNET || "gpt-5.3",
  modelHaiku: process.env.MODEL_HAIKU || "gpt-5.3-nano",
  // Replies are flattened to single-line plain text by default. Set
  // FLATTEN_OUTPUT=false / STRIP_MARKDOWN=false to return the text verbatim
  // (needed if a client consumes code blocks or markdown).
  flattenOutput: process.env.FLATTEN_OUTPUT !== "false",
  stripMarkdown: process.env.STRIP_MARKDOWN !== "false",
  // Tool-call guard. Upstream has no native function calling, so compliance is
  // prompt-based and imperfect: the model sometimes answers in prose while
  // inventing a tool's result, or repeats a call whose <tool_result> it already
  // has. When enabled, replies are inspected and one corrective retry is issued
  // (see src/utils/tool-guard.util.js). Set TOOL_GUARD=false to disable it and
  // return the model's first reply verbatim.
  toolGuard: process.env.TOOL_GUARD !== "false",
  // Extra attempts allowed per request when a guard fires. Hard-capped at 2 so
  // a misconfiguration cannot multiply upstream traffic.
  toolGuardMaxRetries: Math.min(
    2,
    Math.max(0, Number(process.env.TOOL_GUARD_MAX_RETRIES ?? 1) || 0),
  ),
  braveAPIKey: process.env.BRAVE_API_KEY,
  braveAPIUrl: process.env.BRAVE_API_URL,
  // Fallback only: used when the caller sends no system prompt of its own.
  // Claude Code, Codex and opencode all send their own, so this is ignored for
  // them. Set SYSTEM_PROMPT="" to disable it entirely.
  systemPrompt:
    process.env.SYSTEM_PROMPT ||
    "You are an interactive agent that helps users with software engineering tasks. Use the instructions below and the tools available to you to assist the user.\n\nIMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.\n\nIMPORTANT: You must NEVER generate or guess URLs for the user unless you are confident that the URLs are for helping the user with programming. You may use URLs provided by the user in their messages or local files.",
};
