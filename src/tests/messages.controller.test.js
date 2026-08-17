import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

vi.mock("../utils/browser.pool.js", async (importOriginal) => {
  const actual = await importOriginal();
  const ChatGPTClientPool = vi.fn();
  ChatGPTClientPool.prototype.chat = vi.fn();
  ChatGPTClientPool.prototype.stats = vi.fn(() => ({ workers: 1, idle: 1 }));
  return { ...actual, ChatGPTClientPool };
});

const { default: app } = await import("../app.js");
const { ChatGPTClientPool } = await import("../utils/browser.pool.js");
const mockChat = ChatGPTClientPool.prototype.chat;

const READ_TOOL = {
  name: "Read",
  description: "Read a file",
  input_schema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
};

const post = (body) => request(app).post("/v1/messages").send(body);

/** Parses an Anthropic SSE body into [{ event, data }]. */
function parseSse(text) {
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const event = block.match(/^event: (.+)$/m)?.[1];
      const data = block.match(/^data: (.+)$/m)?.[1];
      return { event, data: data ? JSON.parse(data) : null };
    })
    .filter((entry) => entry.event);
}

describe("POST /v1/messages", () => {
  beforeEach(() => vi.clearAllMocks());

  it("400 when messages is empty", async () => {
    const res = await post({ model: "claude-sonnet-4-5", messages: [] });
    expect(res.status).toBe(400);
    expect(res.body.type).toBe("error");
    expect(res.body.error.type).toBe("invalid_request_error");
  });

  it("returns a non-streaming message", async () => {
    mockChat.mockResolvedValue("The answer is 42.");
    const res = await post({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 1024,
      messages: [{ role: "user", content: "What is 6 x 7?" }],
    });

    expect(res.status).toBe(200);
    expect(res.body.type).toBe("message");
    expect(res.body.role).toBe("assistant");
    expect(res.body.content).toEqual([{ type: "text", text: "The answer is 42." }]);
    expect(res.body.stop_reason).toBe("end_turn");
    expect(res.body.usage.input_tokens).toBeGreaterThan(0);
  });

  it("emits a well-formed SSE sequence when stream: true", async () => {
    mockChat.mockResolvedValue("hello there");
    const res = await post({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 1024,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);

    const events = parseSse(res.text);
    const names = events.map((e) => e.event);

    expect(names[0]).toBe("message_start");
    expect(names).toContain("content_block_start");
    expect(names).toContain("content_block_stop");
    expect(names[names.length - 1]).toBe("message_stop");
    // message_delta must precede message_stop and carry the stop reason
    expect(events.at(-2).event).toBe("message_delta");
    expect(events.at(-2).data.delta.stop_reason).toBe("end_turn");

    const streamed = events
      .filter((e) => e.event === "content_block_delta")
      .map((e) => e.data.delta.text)
      .join("");
    expect(streamed).toBe("hello there");
  });

  it("converts a <tool_call> reply into a tool_use block", async () => {
    mockChat.mockResolvedValue(
      `<tool_call id="call_abc" name="Read">{"path":"notes.txt"}</tool_call>`,
    );
    const res = await post({
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      tools: [READ_TOOL],
      messages: [{ role: "user", content: "read notes.txt" }],
    });

    expect(res.status).toBe(200);
    expect(res.body.stop_reason).toBe("tool_use");
    expect(res.body.content[0]).toMatchObject({
      type: "tool_use",
      name: "Read",
      input: { path: "notes.txt" },
    });
    expect(res.body.content[0].id).toMatch(/^toolu_/);
  });

  it("streams tool_use as input_json_delta", async () => {
    mockChat.mockResolvedValue(
      `<tool_call id="call_abc" name="Read">{"path":"notes.txt"}</tool_call>`,
    );
    const res = await post({
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: true,
      tools: [READ_TOOL],
      messages: [{ role: "user", content: "read notes.txt" }],
    });

    const events = parseSse(res.text);
    const start = events.find((e) => e.event === "content_block_start");
    expect(start.data.content_block.type).toBe("tool_use");

    const json = events
      .filter((e) => e.event === "content_block_delta")
      .map((e) => e.data.delta.partial_json)
      .join("");
    expect(JSON.parse(json)).toEqual({ path: "notes.txt" });
    expect(events.at(-2).data.delta.stop_reason).toBe("tool_use");
  });

  it("round-trips a tool_result back into the prompt", async () => {
    mockChat.mockResolvedValue("done");
    await post({
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      tools: [READ_TOOL],
      messages: [
        { role: "user", content: "read notes.txt" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_1", name: "Read", input: { path: "notes.txt" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "file body here" },
          ],
        },
      ],
    });

    const sent = mockChat.mock.calls[0][0];
    const toolMessage = sent.find((m) => m.role === "tool");
    expect(toolMessage.tool_call_id).toBe("toolu_1");
    expect(toolMessage.content).toBe("file body here");
    const assistant = sent.find((m) => m.role === "assistant");
    expect(assistant.tool_calls[0].function.name).toBe("Read");
  });

  it("maps model classes onto backend models", async () => {
    mockChat.mockResolvedValue("ok");
    await post({
      model: "claude-3-5-haiku-20241022",
      max_tokens: 16,
      messages: [{ role: "user", content: "hi" }],
    });
    // 3rd arg is the upstream slug for the resolved model, 4th is thinkingEffort
    expect(mockChat.mock.calls[0][2]).toBe("gpt-5-3-nano");

    vi.clearAllMocks();
    mockChat.mockResolvedValue("ok");
    await post({
      model: "claude-opus-4-20250514",
      max_tokens: 16,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(mockChat.mock.calls[0][2]).toBe("gpt-5-6-thinking");
    expect(mockChat.mock.calls[0][3]).toBe("extended");
  });

  it("flattens a system prompt given as blocks", async () => {
    mockChat.mockResolvedValue("ok");
    await post({
      model: "claude-sonnet-4-5",
      max_tokens: 16,
      system: [{ type: "text", text: "You are terse." }],
      messages: [{ role: "user", content: "hi" }],
    });

    const sent = mockChat.mock.calls[0][0];
    expect(sent.some((m) => m.role === "system" && m.content.includes("You are terse."))).toBe(
      true,
    );
  });

  it("truncates when max_tokens is exceeded", async () => {
    mockChat.mockResolvedValue("word ".repeat(500));
    const res = await post({
      model: "claude-sonnet-4-5",
      max_tokens: 10,
      messages: [{ role: "user", content: "ramble" }],
    });

    expect(res.body.stop_reason).toBe("max_tokens");
    expect(res.body.content[0].text.length).toBeLessThan(2500);
  });

  it("surfaces upstream failures as an Anthropic error", async () => {
    mockChat.mockRejectedValue(new Error("empty_response"));
    const res = await post({
      model: "claude-sonnet-4-5",
      max_tokens: 16,
      messages: [{ role: "user", content: "hi" }],
    });

    expect(res.status).toBe(502);
    expect(res.body.error.type).toBe("api_error");
    expect(res.body.error.message).toBe("empty_response");
  });
});

describe("POST /v1/messages/count_tokens", () => {
  it("returns an input token estimate", async () => {
    const res = await request(app)
      .post("/v1/messages/count_tokens")
      .send({ messages: [{ role: "user", content: "hello world" }] });

    expect(res.status).toBe(200);
    expect(res.body.input_tokens).toBeGreaterThan(0);
  });
});

describe("service endpoints", () => {
  it("reports health", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("lists endpoints at the root", async () => {
    const res = await request(app).get("/");
    expect(res.body.endpoints).toContain("/v1/messages");
  });
});

describe("system prompt handling", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses the caller's system prompt instead of the built-in one", async () => {
    mockChat.mockResolvedValue("ok");
    await post({
      model: "claude-sonnet-4-5",
      max_tokens: 16,
      system: "You are Claude Code.",
      messages: [{ role: "user", content: "hi" }],
    });

    const systems = mockChat.mock.calls[0][0]
      .filter((m) => m.role === "system")
      .map((m) => m.content);
    expect(systems).toContain("You are Claude Code.");
    // the built-in fallback must not be prepended alongside it
    expect(systems.join("\n")).not.toMatch(/interactive agent that helps users/i);
  });

  it("falls back to the built-in prompt when the caller sends none", async () => {
    mockChat.mockResolvedValue("ok");
    await post({
      model: "claude-sonnet-4-5",
      max_tokens: 16,
      messages: [{ role: "user", content: "hi" }],
    });

    const systems = mockChat.mock.calls[0][0]
      .filter((m) => m.role === "system")
      .map((m) => m.content);
    expect(systems.length).toBeGreaterThan(0);
  });
});
