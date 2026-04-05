# ChatGPT OpenAI-Compatible Proxy

> [!TIP]
> Check our [Project Roadmap](ROADMAP.md) for current progress and upcoming features.

**Goal:** I aim to achieve full Anthropic API parity so this proxy can be hooked up to the **leaked Claude Code source code**, allowing it to serve as a complete replacement for the Anthropic API.

A Node.js proxy server that exposes an **OpenAI-compatible REST API** backed by a headless ChatGPT browser session (Puppeteer). Supports plain chat completions and full **tool/function calling** via a structured prompt translation layer.

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
        │  calls /backend-anon/f/conversation via in-page fetch
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

```
Server running on port 3000
Initializing browser...
[init] waiting for #prompt-textarea...
[init] ready
```

---

## Docker

You can also run the proxy as a Docker container. The included Dockerfile handles all dependencies and sets up a virtual display (Xvfb) so the browser can run in a headless environment.

### 1. Build the image

```bash
docker build -t chatgpt-proxy .
```

### 2. Run the container

```bash
docker run -d \
  --name chatgpt-proxy \
  -p 3000:3000 \
  --shm-size=2gb \
  chatgpt-proxy
```

> [!IMPORTANT]
> The `--shm-size=2gb` flag is required. Puppeteer/Chrome uses `/dev/shm` to share data between processes, and the default Docker limit (64MB) is usually too small for stable browser operation.

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
