# ChatGPT Anthropic- and OpenAI-Compatible Proxy

> [!TIP]
> Check our [Project Roadmap](ROADMAP.md) for current progress and upcoming features.

A Node.js proxy server that exposes both an **Anthropic Messages API** (`/v1/messages`) and an **OpenAI Chat Completions API** (`/v1/chat/completions`), backed by an authenticated ChatGPT browser session (Puppeteer). Point **Claude Code CLI**, **Codex**, or **opencode** at it — see [Connecting CLI clients](#connecting-cli-clients).

Supports streaming on both surfaces and full **tool/function calling** via a structured prompt translation layer.

---

## How It Works

```
Client (OpenAI SDK / curl)
        │  POST /v1/chat/completions
        ▼
  proxy.controller.js
        │  buildPromptWithTools()
        │  Serialises messages + tool schemas → plain text prompt
        ▼
  browser.util.js (ChatGPTClient)
        │  Types prompt into chatgpt.com, intercepts auth headers,
        │  calls /backend-api/f/conversation via in-page fetch
        ▼
  ChatGPT (chatgpt.com)
        │  Returns plain text — either an answer or a <tool_call> block
        ▼
  tools.utils.js → parseToolCallReply()
        │  Detects <tool_call> tags → OpenAI tool_calls shape
        │  OR passes text through as content
        ▼
  OpenAI-format JSON response → Client
```

---

## Project Structure

```
src/
├── server.js                    # Entry point — starts Express, initialises browser
├── app.js                       # Express app, mounts routes
├── routes/
│   ├── proxy.route.js           # POST /v1/chat/completions
│   └── models.route.js          # GET /v1/models (list and individual lookups)
├── controller/
│   └── proxy.controller.js      # Request validation, orchestration, response shaping
└── utils/
    ├── browser.util.js          # ChatGPTClient — Puppeteer browser automation
    ├── tools.utils.js           # Tool schema serialisation + tool_call reply parsing
    ├── tool-guard.util.js       # Detects fabricated / repeated tool calls, retries once
    ├── token.util.js            # Token counting via js-tiktoken (cl100k_base)
    └── proxy.util.js            # Proxy utilities
```

---

## Setup

```bash
npm install
npm start          # starts on PORT env var or 3000
```

On startup the server launches a Chromium window, navigates to `chatgpt.com`, and waits for the prompt textarea. If Cloudflare is active this may take up to 60 seconds. The browser stays alive and is reused for all subsequent requests.

### Reusing an authenticated browser session

Place a Chromium/ChatGPT cookie export at `src/cookies/chatgpt.com.cookies.json` (or set `CHATGPT_COOKIES_PATH` to another local path). The server loads these cookies into its isolated browser context and uses the authenticated `/backend-api/f/conversation` request. Cookie exports are credentials: keep them out of source control, rotate them if they have been shared, and never expose them to clients.

The `gpt-5-6-thinking` model is available through the same endpoint. Set `thinking_effort` (for example, `"extended"`) in the request body to pass the effort setting through to ChatGPT.

To inspect the browser transport interactively, run `npm run capture:network`. A visible authenticated browser opens; submit the prompt yourself, then press Enter in the terminal. Sanitized request/response and WebSocket lifecycle/frame metadata (including worker/iframe sockets via CDP) is written to `artifacts/chatgpt-network.jsonl`; credentials and prompt/frame contents are not recorded.

```
Server running on port 3000
Initializing browser...
[init] waiting for #prompt-textarea...
[init] ready
```

---

## Connecting CLI clients

The proxy exposes two surfaces over the same browser session:

| Surface | Endpoints | Clients |
| --- | --- | --- |
| Anthropic Messages | `POST /v1/messages`, `POST /v1/messages/count_tokens` | Claude Code CLI, opencode (anthropic provider) |
| OpenAI Chat Completions | `POST /v1/chat/completions`, `GET /v1/models` | Codex, opencode (openai-compatible provider), any OpenAI SDK |

Both support `stream: true`. Because the upstream browser transport resolves
with a complete reply, streaming is emitted as a correctly ordered chunk
sequence rather than true token-by-token output — clients parse it normally,
but text appears in one burst at the end.

### Authentication

`ANTHROPIC_AUTH_TOKEN` is empty by default, so nothing is required for a local
setup. Set it to require a shared secret, accepted as `x-api-key`,
`Authorization: Bearer <token>`, or `anthropic-auth-token`.

### Model routing

Claude clients ask for `claude-opus-*`, `claude-sonnet-*`, `claude-3-5-haiku-*`.
Each class routes to a backend model from `GET /v1/models`:

```bash
MODEL_OPUS=gpt-5-6-thinking     # Claude Code's main model
MODEL_SONNET=gpt-5.3
MODEL_HAIKU=gpt-5.3-nano        # background/summarisation calls
```

Any other model string is passed through verbatim, so you can target a backend
model directly.

### Claude Code CLI

```powershell
# PowerShell
$env:ANTHROPIC_BASE_URL="http://localhost:3000"; claude
```

```bash
# bash/zsh
ANTHROPIC_BASE_URL="http://localhost:3000" claude
```

Add `ANTHROPIC_AUTH_TOKEN="<token>"` to both if you enabled authentication.

### Codex

Point it at the OpenAI surface:

```bash
OPENAI_BASE_URL="http://localhost:3000/v1" OPENAI_API_KEY="unused" codex
```

### opencode

In `opencode.json`, either surface works:

```json
{
  "provider": {
    "free-gpt-api": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://localhost:3000/v1" },
      "models": { "gpt-5.3": {}, "gpt-5-6-thinking": {} }
    }
  }
}
```

### Concurrency

Requests are served by a pool of browser tabs, so several agents (or several
subagents of one agent) can work at once:

```bash
POOL_SIZE=3      # tabs serving requests in parallel
MAX_QUEUE=32     # requests allowed to wait before the proxy returns 429
```

Each tab handles one request at a time — that lock is load-bearing, since a
tab's request interceptor holds per-request state that two concurrent requests
would cross-wire. Concurrency comes from having more tabs, never from relaxing
it. Because the design is stateless (full history is re-sent on every request),
any tab can serve any request.

When all tabs are busy, requests queue. Past `MAX_QUEUE` the proxy returns
`429` with `Retry-After` rather than letting every client sit in an unbounded
queue and time out. If a client disconnects, its queued request is dropped
before it starts; a request already running in the browser finishes and frees
its tab normally.

`GET /health` reports live pool state:

```json
{ "status": "ok",
  "pool": { "workers": 3, "idle": 2, "busy": 1, "queued": 0,
            "queueLimit": 32, "served": 41, "rejected": 0 } }
```

All tabs share one ChatGPT account, so upstream rate limits are shared. Tune
`POOL_SIZE` to what the account tolerates.

### Tool calling

Neither surface has native function calling upstream — tools are translated
into a structured prompt block and the reply is parsed back out (see
[Tool Calling](#tool-calling)). Anthropic `tool_use` / `tool_result` blocks and
OpenAI `tool_calls` both round-trip through the same translation layer, so tool
ids and arguments are preserved across turns.

### Tool-call guard

Because tool compliance is prompt-based rather than native, the model does not
always follow the protocol. Two failures matter in an agent loop:

| Failure | What it looks like | Why it hurts |
| --- | --- | --- |
| **Fabricated result** | Answers in prose and invents the outcome: *"I checked `/workspace/notes.txt`, and the file does not exist."* | The model has no filesystem — that is a confident false report. |
| **Repeated call** | Re-issues a call whose `<tool_result>` is already in the transcript. | Read → Read → Read forever. |

`src/utils/tool-guard.util.js` inspects every reply before it is returned and
issues **at most one** corrective retry:

- **No tool call + a fabricated-result claim** → retried with a correction that
  forces a call. The detector is deliberately conservative: an evidence-shaped
  claim (*"I checked…"*, *"does not exist"*, *"not found"*, *"I don't have
  access"*) and a concrete target (a path, a `command`, or a word like *file* /
  *directory*) must appear in the **same sentence**, and questions, plans
  (*"let me read…"*) and conditionals (*"if the file does not exist…"*) never
  fire it. Prose that merely mentions a filename is left alone.
- **A call whose exact `(name, arguments)` pair already has a `tool_result`**
  (compared key-order- and whitespace-insensitively) → retried with an
  instruction to answer from the result it already has.

If the retry does not improve things — or fails upstream — the original reply is
returned rather than an error, and the guard logs which case fired. The retry
budget is spent at most once per request, so a request never costs more than two
upstream calls. The reminder appended to the prompt also comes in two variants
(forcing before any tool has run, anti-repetition once results are present),
since one block trying to do both jobs is what made these failure modes trade
off against each other.

| Env var | Default | Effect |
| --- | --- | --- |
| `TOOL_GUARD` | `true` | Set to `false` to disable the guard entirely and return the model's first reply verbatim. |
| `TOOL_GUARD_MAX_RETRIES` | `1` | Extra attempts allowed when a guard fires. `0` detects without retrying; hard-capped at `2`. |

---

## Docker

You can also run the proxy as a Docker container. The included Dockerfile handles all dependencies and sets up a virtual display (Xvfb) so the browser can run in a headless environment.

### 1. Build the image

```bash
docker build -t chatgpt-proxy .
```

### 2. Run the container

The cookie export is deliberately excluded from the image (see `.dockerignore`) so
that a session credential is never baked into a layer you might push somewhere.
Supply it at run time instead — either as a mount:

```bash
docker run -d \
  --name chatgpt-proxy \
  -p 3000:3000 \
  --shm-size=2gb \
  -v "$(pwd)/src/cookies/chatgpt.com.cookies.json:/run/cookies.json:ro" \
  -e CHATGPT_COOKIES_PATH=/run/cookies.json \
  chatgpt-proxy
```

…or, where only environment variables are available, base64-encoded:

```bash
docker run -d \
  --name chatgpt-proxy \
  -p 3000:3000 \
  --shm-size=2gb \
  -e CHATGPT_COOKIES_B64="$(base64 -w0 src/cookies/chatgpt.com.cookies.json)" \
  chatgpt-proxy
```

The entrypoint decodes `CHATGPT_COOKIES_B64` to a file at startup and points
`CHATGPT_COOKIES_PATH` at it, overriding whatever that variable was set to.

> [!IMPORTANT]
> The `--shm-size=2gb` flag is required. Puppeteer/Chrome uses `/dev/shm` to share data between processes, and the default Docker limit (64MB) is usually too small for stable browser operation.

---

## Remote access with Cloudflare Tunnel

The cheapest and, for this proxy specifically, the most reliable way to reach it
from anywhere: keep it running on your own machine and put a Cloudflare Tunnel in
front. No server bill, and — the part that matters — the ChatGPT session keeps
using your own residential IP, so it looks like the browser it is pretending to
be. Every hosted option trades that away.

The cost is that the machine has to be awake to answer.

### 1. Set a token first

A tunnel makes the proxy reachable from the public internet. `ANTHROPIC_AUTH_TOKEN`
in `.env` is what stands between that URL and your ChatGPT account, so set it
before you open the tunnel, not after:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

### 2. Install cloudflared

```powershell
winget install --id Cloudflare.cloudflared
```

### 3. Start the proxy, then the tunnel

Two terminals. The proxy must be started from your own terminal — Chrome
launched from a Node child process gets a hidden window on Windows, and the
turnstile solver needs a real one:

```powershell
npm start
```

Wait for `[pool] ready with N/N workers`, then in a second terminal:

```powershell
npm run tunnel
```

cloudflared prints a `https://<random-words>.trycloudflare.com` URL. That is a
quick tunnel: no Cloudflare account, no domain, live immediately — and a new
hostname every restart, which is fine for trying it and annoying for daily use.

`npm run tunnel` reuses a proxy that is already listening rather than starting a
second one, and before opening the tunnel it sends an unauthenticated request to
confirm the answer is `401`. If it is not, it refuses to expose anything. A proxy
started before you set `ANTHROPIC_AUTH_TOKEN` is still serving with auth
disabled — **`.env` is read once at startup, so restart the proxy after changing
it**, or you will be publishing an open endpoint.

### 4. Point a client at it

```powershell
$env:ANTHROPIC_BASE_URL = "https://<random-words>.trycloudflare.com"
$env:ANTHROPIC_AUTH_TOKEN = "<the token from your .env>"
claude
```

### A stable hostname

Quick tunnels rotate. For a URL that survives restarts you need a Cloudflare
account with a domain on it, then a named tunnel:

```powershell
cloudflared tunnel login
cloudflared tunnel create free-gpt-api
cloudflared tunnel route dns free-gpt-api gpt.yourdomain.com
cloudflared tunnel run --url http://localhost:3000 free-gpt-api
```

Install it as a Windows service so it comes back after a reboot:

```powershell
cloudflared service install
```

For a second lock, put Cloudflare Access in front of the hostname — then the
endpoint requires an identity check before a request ever reaches the token.

### Keeping it answering

The machine sleeping is the failure mode that will actually bite you. Sleep drops
the tunnel and suspends Chromium:

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
```

Turning the monitor off, or locking the session, is fine — Chrome keeps running.
It is system sleep that breaks things.

`GET /health` through the tunnel is the quickest way to confirm the whole chain —
tunnel, proxy, browser pool — is up.

---

## Deploying to Render

> [!CAUTION]
> There is no free tier for this workload. Render's free web service is 512 MB
> RAM and 0.1 CPU and spins down after 15 minutes idle; a headed Chromium needs
> more memory than that before it loads a page, and every spin-down destroys the
> logged-in browser session. The Blueprint below specifies a paid Standard
> instance (2 GB, ~$25/mo) because that is the floor at which this runs at all.
> If you are not paying for that, use the Cloudflare Tunnel setup above.

`render.yaml` in the repo root is a Blueprint for a single Docker web service:
Xvfb, headed Chromium and the Express API in one container.

> [!WARNING]
> Read this first. The proxy drives your ChatGPT account from the deployment's
> IP address. Moving a session from your home connection to a datacentre IP in
> another region is exactly the pattern Cloudflare and OpenAI look for, so
> expect more frequent challenges than you get locally, and accept that the
> session — or the account — may be flagged. Deploy an account you can afford
> to lose, and read `LEGAL_NOTICE.md`.

### 1. Push the repo to GitHub or GitLab

Render builds from a connected git repository. The cookie file is gitignored and
must stay that way; step 3 supplies it out of band.

### 2. Create the Blueprint

In Render: **New → Blueprint**, pick the repository, and apply. It reads
`render.yaml` and creates the service with the environment already configured,
including a generated `ANTHROPIC_AUTH_TOKEN`.

Edit two lines in `render.yaml` before applying if the defaults do not suit you:

| Field | Default | Notes |
| --- | --- | --- |
| `plan` | `standard` | 2 GB RAM. Chromium plus a virtual display will not fit in the 512 MB `free`/`starter` plans — it OOMs during page load. |
| `region` | `oregon` | Pick the one closest to where the account normally signs in; a sudden continent change is an extra risk signal. |

### 3. Add the cookies as a Secret File

Blueprints cannot carry secrets, so this step is manual and the first deploy will
fail authentication without it.

Go to the service → **Environment → Secret Files → Add Secret File**:

- **Filename:** `chatgpt.com.cookies.json`
- **Contents:** paste your exported cookie JSON verbatim

Render mounts it at `/etc/secrets/chatgpt.com.cookies.json`, which is where
`CHATGPT_COOKIES_PATH` already points. If the mount ever gives you a permissions
error (the container runs as the non-root `pptruser`), delete the secret file and
set `CHATGPT_COOKIES_B64` as a normal environment variable instead — locally,
`base64 -w0 src/cookies/chatgpt.com.cookies.json` produces the value.

### 4. Deploy and watch the first boot

The first start is slow: image build, then Chromium launch, then a Cloudflare
check. Logs should reach `[pool] ready with 1/1 workers`. Until they do, `/health`
answers `200` with an empty pool — that is intentional, so Render's health check
does not restart the service while the browser is still coming up.

### 5. Point your clients at it

```bash
export ANTHROPIC_BASE_URL="https://<your-service>.onrender.com"
export ANTHROPIC_AUTH_TOKEN="<the generated token from Render → Environment>"
claude
```

The generated token is not optional in this setup. A Render URL is public, and
without it anyone who finds the hostname is issuing requests against your
ChatGPT account.

### Operating notes

| Symptom | Cause | Fix |
| --- | --- | --- |
| Deploy exits ~code 137 during boot | Out of memory | Move to a 2 GB plan, keep `POOL_SIZE=1` |
| Every request returns `auth_expired:401` | Cookies expired or rejected from this IP | Re-export cookies, update the Secret File, redeploy |
| Boot hangs at `waiting for #prompt-textarea` | Cloudflare challenge is not clearing | Confirm `HEADLESS=false` so Chromium runs headed under Xvfb; try a different region |
| `429` with `Retry-After` | Queue past `MAX_QUEUE` | Expected backpressure — one browser tab serves one request at a time |

Cookies are read at startup and on reconnect, never written back, so nothing
needs a persistent disk. When they expire, update the Secret File and redeploy.

Raising `POOL_SIZE` costs roughly 300–500 MB per extra worker and drives more
concurrent traffic at one account; raise the instance plan with it, and treat
upstream rate limiting as the real ceiling rather than the memory.

---

## Endpoints

### `GET /health`

Liveness check. Returns immediately without touching the browser.

**Response**

```json
{ "status": "ok" }
```

---

### `GET /v1/models`

Standard OpenAI endpoint to list available models, their max tokens, and metadata.

**Supported Models:**
- `gpt-5.3` (Slug: `gpt-5-3`)
- `gpt-5.2` (Slug: `gpt-5-2`)
- `gpt-5.1` (Slug: `gpt-5-1`)
- `gpt-5` (Slug: `gpt-5`)
- `gpt-5-mini` (Slug: `gpt-5-mini`)
- `o1`, `o1-mini`
- `gpt-4o`, `gpt-4o-mini`
- `auto`

**Response**

```json
{
  "object": "list",
  "data": [
    {
      "id": "gpt-5.3",
      "max_tokens": 34834,
      "owned_by": "openai",
      "object": "model",
      "created": 1740614400
    },
    ...
  ]
}
```

---

### `GET /v1/models/:id`

Retrieve details for a single model.

---

### `POST /v1/chat/completions`

OpenAI-compatible chat completions endpoint. Supports plain conversations and tool/function calling.

**Headers**

```
Content-Type: application/json
```

---

## Request Format

### Example Request (with System Role)

```json
{
  "model": "auto",
  "tools": [],
  "messages": [
    { "role": "system", "content": "You are a trading assistant." },
    { "role": "user", "content": "Whats your role?" }
  ]
}
```

| Field        | Type   | Required | Description                                                      |
| ------------ | ------ | -------- | ---------------------------------------------------------------- |
| `messages`   | array  | ✅ yes   | Conversation history. See [Message Roles](#message-roles)        |
| `model`      | string | no       | Label for the response. Default: `"chatgpt-proxy"`               |
| `max_tokens` | number | no       | Max tokens to return. Truncates and sets `finish_reason: length` |
| `mode`       | string | no       | Trigger specific features (reasoning, deep-research, etc.)       |
| `files`      | array  | no       | Files to prompt against. See [File uploads](#file-uploads)       |

---

## File uploads

Attach one or more files to prompt against — the model reads the file contents
and answers your `messages`. Works on both surfaces.

```json
{
  "model": "gpt-5.3",
  "messages": [{ "role": "user", "content": "What does getLicenseKey() return?" }],
  "files": [{ "filename": "licensing.js", "content": "<the file text>" }]
}
```

Each file becomes a leading user message the model reads before your prompt.
A file large enough to exceed the inline limit is delivered as a **big-paste
attachment**: the proxy pastes it into ChatGPT's composer so the app performs
its own authenticated upload, then references the resulting file in the turn.
Smaller files travel inline. Either way, keep the *question* in `messages` (it
governs) and the *file* in `files` (reference material the model reads).

### Binary files (zip, pdf, images…)

Non-text files upload through ChatGPT's own file picker. Pass the bytes as
base64 with a `mime_type`:

```json
{
  "model": "gpt-5.3",
  "messages": [{ "role": "user", "content": "What plugin is in this archive and what are its main files?" }],
  "files": [{
    "filename": "plugin.zip",
    "mime_type": "application/zip",
    "encoding": "base64",
    "content": "<base64 of the file>"
  }]
}
```

The proxy sets the file on the composer's file input so the app runs its own
authenticated upload; the model then reads the file (ChatGPT extracts archives,
parses PDFs, etc.). A file is treated as binary when `encoding` is `"base64"`
or its `mime_type` is non-text.

On the Anthropic surface (`/v1/messages`) you may pass the same top-level
`files` array, or inline `file` content blocks:

```json
{ "role": "user",
  "content": [
    { "type": "text", "text": "Summarize this module." },
    { "type": "file", "filename": "module.py", "content": "<the file text>" }
  ] }
```

Notes and limits:
- **Model support:** the large-file (big-paste) path runs on non-thinking models
  (`gpt-5.3`, etc.). On `gpt-5-6-thinking`, large files fall back to the
  inline/legacy path and may not attach — keep those under the inline limit.
- **Latency:** a large file drives a real composer paste + upload + rendered
  read, so it is heavier than an inline turn.
- **Factual Q&A, not governance:** the model *reads and answers about* an
  uploaded file well; it does not treat an uploaded file as a governing system
  prompt.

---

## ChatGPT Modes

The `mode` field in the request body can be used to trigger specific ChatGPT features.

| `mode` value     | Description                                | Underlying ChatGPT Feature       |
| :--------------- | :----------------------------------------- | :------------------------------- |
| `reasoning`      | High-level reasoning mode                  | `system_hints: ["reason"]`       |
| `deep-research`  | ChatGPT Deep Research                      | `connector_openai_deep_research` |
| `tatertot`       | Specialized "tatertot" hint(studying mode) | `system_hints: ["tatertot"]`     |
| `quiz`           | QuizGPT connector                          | `connector_openai_quizgpt_v2`    |
| (empty or other) | Standard assistant                         | `primary_assistant`              |

---

## Limitations

- **No streaming** — `stream: true` returns a 400. The browser-based transport receives the full response before it can be forwarded.
- **Single concurrent request** — `ChatGPTClient` serialises all calls through a queue. Concurrent requests wait in order.
- **Auth session** — The proxy relies on the browser's active ChatGPT session. If the session expires a browser restart or re-login is required.
- **Headless mode** — While supported via the `HEADLESS=true` env var, Cloudflare checks are much more likely to fail in fully headless environments. If running on a server without a GUI, consider using `xvfb-run` or similar virtual displays.

---

## Message Roles

All four OpenAI message roles are supported.

### `system`

```json
{ "role": "system", "content": "You are a concise assistant." }
```

### `user`

```json
{ "role": "user", "content": "Read the file notes.txt" }
```

### `assistant` — plain reply

```json
{ "role": "assistant", "content": "The file contains your shopping list." }
```

### `assistant` — with tool calls

```json
{
  "role": "assistant",
  "content": null,
  "tool_calls": [
    {
      "id": "call_tuefggdxl",
      "type": "function",
      "function": {
        "name": "Read",
        "arguments": "{\"path\":\"notes.txt\"}"
      }
    }
  ]
}
```

### `tool` — tool result

```json
{
  "role": "tool",
  "tool_call_id": "call_tuefggdxl",
  "content": "Buy milk\nCall dentist"
}
```

> `tool_call_id` is optional but recommended — include it to match OpenAI's spec and keep multi-tool conversations unambiguous.

---

## Tool Calling

### 1. Define tools in the request

```json
{
  "model": "gpt-5.3",
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "Read",
        "description": "Read the contents of a file",
        "parameters": {
          "type": "object",
          "properties": {
            "path": { "type": "string", "description": "The file path to read" }
          },
          "required": ["path"]
        }
      }
    }
  ],
  "messages": [{ "role": "user", "content": "What is in notes.txt?" }]
}
```

### 2. Proxy responds with a tool call

When the model decides to use a tool, `finish_reason` is `"tool_calls"` and `content` is `null`:

```json
{
  "id": "chatcmpl-abc123",
  "object": "chat.completion",
  "created": 1716000000,
  "model": "gpt-5.3",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": null,
        "tool_calls": [
          {
            "id": "call_tuefggdxl",
            "type": "function",
            "function": {
              "name": "Read",
              "arguments": "{\"path\":\"notes.txt\"}"
            }
          }
        ]
      },
      "finish_reason": "tool_calls"
    }
  ],
  "usage": {
    "prompt_tokens": 142,
    "completion_tokens": 18,
    "total_tokens": 160
  }
}
```

### 3. Execute the tool and send the result back

Append the assistant's tool call message and the tool result to your messages array, then call the endpoint again:

```json
{
  "model": "gpt-5.3",
  "tools": [
    /* same tools array */
  ],
  "messages": [
    { "role": "user", "content": "What is in notes.txt?" },
    {
      "role": "assistant",
      "content": null,
      "tool_calls": [
        {
          "id": "call_tuefggdxl",
          "type": "function",
          "function": {
            "name": "Read",
            "arguments": "{\"path\":\"notes.txt\"}"
          }
        }
      ]
    },
    {
      "role": "tool",
      "tool_call_id": "call_tuefggdxl",
      "content": "Buy milk\nCall dentist"
    }
  ]
}
```

### 4. Proxy returns the final answer

```json
{
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "The file notes.txt contains two items: Buy milk and Call dentist."
      },
      "finish_reason": "stop"
    }
  ]
}
```

---

## Response Format

All successful responses follow the OpenAI `chat.completion` shape. Below is an example of a cleaned, flattened response:

```json
{
    "id": "chatcmpl-e9f87659-dd9f-40fc-ada4-92cec1935b3e",
    "object": "chat.completion",
    "created": 1775385588,
    "model": "auto",
    "choices": [
        {
            "index": 0,
            "message": {
                "role": "assistant",
                "content": "Answering questions & explaining concepts (from simple to complex) Software engineering help (coding, debugging, system design) Trading & market insights (analysis, strategies, risk concepts—not financial advice) Research & summaries Planning & decision support Creative and practical writing I aim to give clear, accurate, and useful responses tailored to what you need. If you want, you can test me—ask me anything 👍"
            },
            "finish_reason": "stop"
        }
    ],
    "usage": {
        "prompt_tokens": 16,
        "completion_tokens": 80,
        "total_tokens": 96
    }
}
```

> Token counts are calculated using `js-tiktoken` with the `cl100k_base` encoding (same as GPT-4).

---

## Error Responses

All errors use the OpenAI error envelope:

```json
{
  "error": {
    "message": "Human-readable description",
    "type": "invalid_request_error" | "proxy_error"
  }
}
```

| Status | `type`                  | Cause                                                      |
| ------ | ----------------------- | ---------------------------------------------------------- |
| `400`  | `invalid_request_error` | `messages` missing or empty                                |
| `400`  | `invalid_request_error` | `stream: true` in the request                              |
| `500`  | `proxy_error`           | Browser/ChatGPT error (auth expired, empty response, etc.) |

---

## Using with the OpenAI SDK

Point the SDK at this server by overriding `baseURL`:

```js
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "not-needed", // required by SDK but ignored by proxy
  baseURL: "http://localhost:3000/v1",
});

// Plain chat
const res = await client.chat.completions.create({
  model: "gpt-5.3",
  messages: [{ role: "user", content: "Hello!" }],
});

// With tools
const res2 = await client.chat.completions.create({
  model: "gpt-5.3",
  tools: [
    {
      type: "function",
      function: {
        name: "Read",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    },
  ],
  messages: [{ role: "user", content: "What is in notes.txt?" }],
});
```

---

## Limitations

- **No streaming** — `stream: true` returns a 400. The browser-based transport receives the full response before it can be forwarded.
- **Single concurrent request** — `ChatGPTClient` serialises all calls through a queue. Concurrent requests wait in order.
- **Auth session** — The proxy relies on the browser's active ChatGPT session. If the session expires a browser restart or re-login is required.
- **Headless supported** — Runs in `headless: true` mode by default while still passing bot checks.

---

## Testing

```bash
npm install -D vitest supertest
npm test
```

Tests mock `ChatGPTClient` so no browser is required. See `src/tests/` for unit tests covering `tools.utils.js` and integration tests covering the full HTTP stack.
