# free-gpt-api — Roadmap to Anthropic API Parity

A prioritised list of everything needed to bring this proxy to production quality,
matching the reliability and feature set of a real LLM API.

## ✅ Currently Achieved

- [x] **OpenAI-Compatible Chat Completions**: Standard `/v1/chat/completions` endpoint implemented.
- [x] **Tool/Function Calling Support**: Translation layer for serializing tools and parsing `<tool_call>` responses.
- [x] **Token Usage Reporting**: Real-time token estimation using `js-tiktoken` (cl100k_base).
- [x] **Multiple ChatGPT Modes**: Support for `reasoning`, `deep-research`, `tatertot`, and `quiz` modes.
- [x] **Dockerized Environment**: Ready-to-use Dockerfile and Docker Compose with Xvfb for headless operation.
- [x] **Headless Mode Support**: Puppeteer configured to pass bot checks effectively.
- [x] **Basic Health Monitoring**: `/health` endpoint for liveness checks.
- [x] **Environment Configuration**: Robust configuration via `.env` and `config.js`.

---

## Priority 1 — Core Reliability (Breaks real usage today)

### 1.1 Streaming support (`stream: true`)
**Current state:** Returns a 400 error.  
**Why it matters:** Every serious client (OpenAI SDK, LangChain, Claude Code, Vercel AI SDK)
defaults to streaming. Blocking it makes the proxy unusable for most tools without config changes.  
**What to build:**  
- In `_doChat`, pipe the SSE chunks from ChatGPT's `/conversation` endpoint back to the Express
  response in real time instead of buffering to `fullText`.  
- Use `res.setHeader('Content-Type', 'text/event-stream')` and write
  `data: {"choices":[{"delta":{"content":"..."}}]}\n\n` per chunk.  
- End with `data: [DONE]\n\n`.  
- Add `transfer-encoding: chunked` and disable Express response buffering.

---

### 1.2 Session persistence and auth recovery
**Current state:** When the ChatGPT session expires (401/403), the proxy crashes the request
with `auth_expired`. There is no automatic recovery or session save/restore.  
**Why it matters:** Sessions expire. Without persistence, every restart requires a manual
RustDesk login.  
**What to build:**  
- On successful init, export cookies from the Puppeteer page and write them to a
  `session.json` file on disk.  
- On startup, if `session.json` exists, inject the cookies before navigating to chatgpt.com
  instead of waiting for a fresh login.  
- On 401/403, delete `session.json`, log a clear warning, and wait for a new manual login
  rather than crashing.  
- Expose a `GET /session/status` endpoint that returns `{ authenticated: true/false }` so
  operators can check without tailing logs.

---

### 1.3 Concurrent request handling
**Current state:** All requests queue behind a single `Promise` chain in `ChatGPTClient._queue`.
Concurrent requests from the same client block each other indefinitely.  
**Why it matters:** Any agent that fires parallel tool calls (Claude Code, LangChain agents,
multi-threaded clients) will hang.  
**What to build:**  
- Add a configurable concurrency limit (default 1, since the browser is single-session).
- Return a `429 Too Many Requests` with `Retry-After` header when the queue is full,
  rather than silently queuing forever.  
- Expose `GET /queue/status` returning `{ queued: N, maxConcurrent: 1 }`.

---

### 1.4 Tool call reliability — prompt compliance rate
**Current state:** The model ignores `<tool_call>` instructions 20-40% of the time and
responds with "I can't access files" or similar refusals.  
**Why it matters:** Tool calling is the core feature. Unreliable compliance makes agentic
use impossible.  
**What to build:**  
- **Retry on non-compliance:** In `_doChat`, if tools were provided and the reply contains
  no `<tool_call>` but the response looks like a refusal (heuristic: contains "I can't",
  "I'm unable", "please paste"), retry the request once with a reinforced instruction
  appended: `"REMINDER: You must call a tool. Do NOT refuse."`.  
- **Compliance metric:** Track and log the ratio of tool-call responses vs refusals per
  session to `console` so it's visible in Docker logs.

---

## Priority 2 — API Completeness (Missing from OpenAI spec)

### 2.1 `GET /v1/models`
**Current state:** Not implemented — returns 404.  
**Why it matters:** The OpenAI SDK calls this endpoint on initialisation. Without it, SDK
users see an error before making a single chat request.  
**What to build:**
```json
{
  "object": "list",
  "data": [
    { "id": "gpt-5.3",        "object": "model", "created": 1700000000, "owned_by": "chatgpt-proxy" },
    { "id": "gpt-4o",         "object": "model", "created": 1700000000, "owned_by": "chatgpt-proxy" },
    { "id": "gpt-4o-mini",    "object": "model", "created": 1700000000, "owned_by": "chatgpt-proxy" },
    { "id": "o1",             "object": "model", "created": 1700000000, "owned_by": "chatgpt-proxy" },
    { "id": "deep-research",  "object": "model", "created": 1700000000, "owned_by": "chatgpt-proxy" }
  ]
}
```
Map model IDs to `mode` values in the controller (e.g. `"o1"` → `mode: "reasoning"`,
`"deep-research"` → `mode: "deep-research"`).

---

### 2.2 `max_tokens` support
**Current state:** Ignored entirely.  
**Why it matters:** Clients use it to budget responses and avoid runaway completions.  
**What to build:**  
- Accept `max_tokens` from the request body.  
- After receiving the full response text, truncate at the token boundary using the existing
  `estimateTokens` logic.  
- Set `finish_reason: "length"` when truncation occurs (vs `"stop"` for natural completion).

---

### 2.3 `temperature` and `top_p` passthrough
**Current state:** Ignored — ChatGPT always uses its own defaults.  
**Why it matters:** Clients set these expecting deterministic or creative behaviour.  
**What to build:**  
- For `temperature: 0` (deterministic): prepend a system hint asking the model to be
  precise and consistent.  
- For `temperature > 1` (creative): prepend a hint asking for more imaginative responses.  
- This is best-effort — document clearly that ChatGPT does not expose these parameters
  natively.

---

### 2.4 `stop` sequences
**Current state:** Ignored.  
**Why it matters:** Many clients use stop sequences to delimit structured output.  
**What to build:**  
- After receiving `fullText`, scan for any string in the `stop` array.  
- Truncate at the first occurrence and set `finish_reason: "stop"`.

---

### 2.5 Multi-modal input (`image_url` content blocks)
**Current state:** Only `string` content is handled. Image content blocks crash silently.  
**Why it matters:** GPT-4o vision capability is a major differentiator.  
**What to build:**  
- In `serializeMessage`, detect content blocks of type `image_url`.  
- Fetch the image and inject it into the Puppeteer page via the file upload UI or paste
  it into the textarea as a base64 data URI.  
- Fall back gracefully with a `[image not supported]` placeholder if injection fails.

---

### 2.6 GitHub Repository Integration
**Current state:** Not implemented. Requests containing GitHub repo URLs are treated as plain text.  
**Why it matters:** ChatGPT now supports direct repo analysis. Adding this allows the model to fetch and reason over entire codebases via the official GitHub API.  
**What to build:**  
- Detect GitHub repository URLs or `selected_github_repos` in the request.  
- Integrate with `GET https://api.github.com/repos/{owner}/{repo}/contents`.  
- Inject the repository context into the Puppeteer session using the same internal structure ChatGPT uses.

---

## Priority 3 — Agent Loop Quality

### 3.1 Growing context window management
**Current state:** The agent loop (`agentLoop.util.js`) appends every message to `history`
indefinitely. By iteration 10+, the prompt sent to ChatGPT exceeds what the model can
reliably follow, causing drift and hallucination.  
**Why it matters:** The Claude Code audit example runs 20-50 iterations. Without context
management, it falls apart halfway through.  
**What to build:**  
- Track total token count of `history` using `estimateTokens` before each iteration.  
- When tokens exceed a configurable threshold (default: 80,000), summarise the oldest
  N messages into a single `[Summary]` system message using a dedicated summarisation
  call to the proxy itself.  
- Keep the last 5 messages verbatim (recency bias) and replace everything before them
  with the summary.

---

### 3.2 Parallel tool call execution
**Current state:** Tool calls are executed sequentially in a `for` loop even when the model
returns multiple `tool_calls` in one response.  
**Why it matters:** The Anthropic API supports parallel tool calls — multiple independent
reads/searches executing simultaneously. Sequential execution makes multi-tool iterations
3-5x slower.  
**What to build:**  
- Replace the `for` loop in `agentLoop.util.js` with `Promise.all(toolCalls.map(...))`.  
- Maintain result order when appending to `history` (collect all results, then push in
  original order).

---

### 3.3 Tool execution sandboxing
**Current state:** `toolExecutor.util.js` runs `execSync(args.cmd)` with no restrictions.
Any tool call can execute arbitrary shell commands on the host.  
**Why it matters:** If the model hallucinates a malicious command, or a prompt injection
attack occurs via tool results, the server is fully compromised.  
**What to build:**  
- Replace `execSync` with a sandboxed execution layer: a Docker-in-Docker container,
  a `vm2` sandbox, or a subprocess with an OS-level seccomp/apparmor profile.  
- Add a configurable `TOOL_ALLOWLIST` in `config.js` — only tools in the list can be
  called. Reject unknown tools with an error before execution.  
- Add a `SHELL_COMMAND_ALLOWLIST` for `RunShell` — only commands matching safe prefixes
  (`grep`, `find`, `cat`, `ls`, `node`, `npm`) are allowed. Everything else returns an
  error to the model.

---

### 3.4 Agent loop exposed as a proper endpoint
**Current state:** Agent mode is triggered by `agentLoop: true` in the request body —
a non-standard extension to the OpenAI spec that no standard client will send.  
**Why it matters:** Makes the agent loop invisible to standard clients.  
**What to build:**  
- Add `POST /v1/agent/run` as a dedicated endpoint that always runs the loop.  
- Accept the same body as `/v1/chat/completions` (messages, tools, model, mode).  
- Return the final answer plus `agent_iterations` and optionally the full `history`
  if `include_history: true` is passed.

---

## Priority 4 — Observability and Operations

### 4.1 Structured logging
**Current state:** Logging is `chalk`-coloured console output with no structure. Impossible
to query or alert on.  
**What to build:**  
- Replace `chalk` console logs with a structured logger (e.g. `pino`).  
- Log every request as a JSON object: `{ requestId, model, mode, toolCount, promptTokens,
  completionTokens, durationMs, finishReason, agentIterations }`.  
- Write logs to stdout (for Docker log collection) in JSON format.  
- Keep human-readable coloured output as a `DEBUG=true` option only.

---

### 4.2 Request tracing
**Current state:** No request IDs propagated through the stack. When something fails in
the agent loop at iteration 8, there is no way to correlate logs to the original request.  
**What to build:**  
- Generate a `requestId` (UUID) at the Express layer for every incoming request.  
- Thread it through `agentLoop`, `browser.util`, and all tool calls.  
- Include it in every log line and in the response headers as `X-Request-Id`.

---

### 4.3 Metrics endpoint
**Current state:** Only `/health` exists, returning `{ status: "ok" }`.  
**What to build:**  
- Add `GET /metrics` returning Prometheus-compatible text or a JSON object:
```json
{
  "requests_total": 142,
  "requests_failed": 3,
  "tool_calls_total": 891,
  "tool_compliance_rate": 0.94,
  "agent_iterations_avg": 7.2,
  "queue_depth": 0,
  "session_authenticated": true,
  "uptime_seconds": 3600
}
```

---

### 4.4 Rate limiting
**Current state:** No rate limiting. A single misbehaving client can saturate the queue
and block everyone else.  
**What to build:**  
- Add `express-rate-limit` middleware: configurable `RATE_LIMIT_RPM` (default: 10 req/min
  per IP).  
- Return `429` with `Retry-After` and `X-RateLimit-*` headers matching OpenAI's format.

---

## Priority 5 — Developer Experience

### 5.1 OpenAPI / Swagger spec
**What to build:**  
- Add `GET /v1/openapi.json` serving a full OpenAPI 3.0 spec of all endpoints.  
- Add `GET /docs` serving Swagger UI for interactive testing without Postman.

### 5.2 Environment variable documentation
**What to build:**  
- Create `.env.example` documenting every supported variable with type, default, and
  description.

```bash
PORT=3000                    # Server port
HEADLESS=false               # Run Chrome headless (requires Xvfb if false in Docker)
RUSTDESK_PASSWORD=changeme   # RustDesk remote access password
RATE_LIMIT_RPM=10            # Max requests per minute per IP
MAX_AGENT_ITERATIONS=20      # Max tool call iterations in agent mode
TOOL_ALLOWLIST=Read,Write,ListDir,RunShell,HttpRequest
SHELL_COMMAND_ALLOWLIST=grep,find,cat,ls,node,npm
DEBUG=false                  # Verbose coloured console logging
SYSTEM_PROMPT=               # Override the default system prompt
```

### 5.3 Test coverage gaps
**Current state:** Tests cover `tools.util.js` and HTTP layer but not `agentLoop.util.js`,
`toolExecutor.util.js`, or auth recovery paths.  
**What to build:**  
- Unit tests for `agentLoop`: mock `client.chat` to return tool calls then a final answer,
  assert correct iteration count and history shape.  
- Unit tests for `toolExecutor`: mock `fs` and `execSync`, assert correct output per tool.  
- Integration test for the 401 recovery path: mock `client.chat` to throw `auth_expired`,
  assert 500 response with correct error shape.  
- Test for `max_tokens` truncation and `finish_reason: "length"`.

---

## Summary Table

| # | Item | Effort | Impact |
|---|------|--------|--------|
| 1.1 | Streaming | High | Critical |
| 1.2 | Session persistence | Medium | Critical |
| 1.3 | Concurrent request 429 | Low | High |
| 1.4 | Tool call retry on refusal | Low | High |
| 2.1 | `GET /v1/models` | Low | High |
| 2.2 | `max_tokens` | Low | Medium |
| 2.3 | `temperature` best-effort | Low | Low |
| 2.4 | `stop` sequences | Low | Medium |
| 2.5 | Multi-modal images | High | Medium |
| 2.6 | GitHub Integration | Medium | High |
| 3.1 | Context window management | Medium | High |
| 3.2 | Parallel tool execution | Low | High |
| 3.3 | Tool execution sandboxing | High | Critical |
| 3.4 | `/v1/agent/run` endpoint | Low | Medium |
| 4.1 | Structured logging (pino) | Medium | High |
| 4.2 | Request tracing | Low | Medium |
| 4.3 | Metrics endpoint | Medium | Medium |
| 4.4 | Rate limiting | Low | High |
| 5.1 | OpenAPI / Swagger | Medium | Medium |
| 5.2 | `.env.example` | Low | Medium |
| 5.3 | Test coverage gaps | Medium | High |

---

## Recommended Build Order

```
Week 1 — Make it work reliably
  1.4 → 1.2 → 2.1 → 1.3 → 4.4

Week 2 — Make it complete
  1.1 → 2.2 → 2.4 → 3.2 → 3.1

Week 3 — Make it safe and observable
  3.3 → 4.1 → 4.2 → 4.3 → 3.4

Week 4 — Polish
  2.5 → 5.1 → 5.2 → 5.3 → 2.3
```
