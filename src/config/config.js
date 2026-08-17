import dotenv from "dotenv";

dotenv.config();

export const config = {
  port: process.env.PORT || 3000,
  headless: process.env.HEADLESS === "true",
  turnstile: process.env.TURNSTILE === "true",
  fingerprint: process.env.FINGERPRINT === "true",
  debug: process.env.DEBUG === "true",
  // Exported browser cookies, loaded into the page at startup. Keep the file
  // out of version control.
  chatgptCookiesPath:
    process.env.CHATGPT_COOKIES_PATH || "src/cookies/chatgpt.com.cookies.json",
  // Legacy transport for gpt-5-6-thinking: the page issues its own request and
  // the answer is read off its WebSocket. It submits the whole conversation as
  // one composer message, which breaks tool calling, so it is off by default.
  nativeThinkingPath: process.env.NATIVE_THINKING_PATH === "true",
  // One browser tab per worker; requests are serialised within a worker.
  // Raising this past what the account tolerates trades throughput for limits.
  poolSize: Math.max(1, Number(process.env.POOL_SIZE) || 3),
  // Requests waiting for a free worker; beyond this the proxy returns 429.
  maxQueue: Math.max(0, Number(process.env.MAX_QUEUE ?? 32)),
  // When set, clients must send it as x-api-key, Authorization: Bearer, or
  // anthropic-auth-token. Empty disables authentication.
  authToken: process.env.ANTHROPIC_AUTH_TOKEN || "",
  // Claude model classes (claude-opus-4-*, claude-3-5-haiku-*, …) route here.
  modelOpus: process.env.MODEL_OPUS || "gpt-5-6-thinking",
  modelSonnet: process.env.MODEL_SONNET || "gpt-5.3",
  modelHaiku: process.env.MODEL_HAIKU || "gpt-5.3-nano",
  // Set either to false to return replies verbatim, for clients that consume
  // code blocks or markdown.
  flattenOutput: process.env.FLATTEN_OUTPUT !== "false",
  stripMarkdown: process.env.STRIP_MARKDOWN !== "false",
  // Inspect replies for invented or repeated tool results and issue one
  // corrective retry (see src/utils/tool-guard.util.js).
  toolGuard: process.env.TOOL_GUARD !== "false",
  // Hard-capped at 2 so a misconfiguration cannot multiply upstream traffic.
  toolGuardMaxRetries: Math.min(
    2,
    Math.max(0, Number(process.env.TOOL_GUARD_MAX_RETRIES ?? 1) || 0),
  ),
  braveAPIKey: process.env.BRAVE_API_KEY,
  braveAPIUrl: process.env.BRAVE_API_URL,
  // Fallback for callers that send no system prompt of their own; Claude Code,
  // Codex and opencode all do, so it is ignored for them.
  systemPrompt:
    process.env.SYSTEM_PROMPT ||
    "You are an interactive agent that helps users with software engineering tasks. Use the instructions below and the tools available to you to assist the user.\n\nIMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.\n\nIMPORTANT: You must NEVER generate or guess URLs for the user unless you are confident that the URLs are for helping the user with programming. You may use URLs provided by the user in their messages or local files.",
};
