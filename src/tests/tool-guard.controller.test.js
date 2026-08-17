import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
const { config } = await import("../config/config.js");
const mockChat = ChatGPTClientPool.prototype.chat;

const READ_TOOL_ANTHROPIC = {
  name: "Read",
  description: "Read a file",
  input_schema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
};

const READ_TOOL_OPENAI = {
  type: "function",
  function: {
    name: "Read",
    description: "Read the contents of a file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
};

const READ_CALL = `<tool_call id="call_abc" name="Read">{"path":"notes.txt"}</tool_call>`;
const FABRICATED = "I checked /workspace/notes.txt, and the file does not exist.";

const postMessages = (body) => request(app).post("/v1/messages").send(body);
const postCompletions = (body) => request(app).post("/v1/chat/completions").send(body);

/** An Anthropic transcript where Read(notes.txt) has already returned. */
const anthropicWithResult = [
  { role: "user", content: "What is in notes.txt?" },
  {
    role: "assistant",
    content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { path: "notes.txt" } }],
  },
  {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "Buy milk" }],
  },
];

/** The same transcript in OpenAI shape. */
const openaiWithResult = [
  { role: "user", content: "What is in notes.txt?" },
  {
    role: "assistant",
    content: null,
    tool_calls: [
      { id: "call_1", type: "function", function: { name: "Read", arguments: '{"path":"notes.txt"}' } },
    ],
  },
  { role: "tool", tool_call_id: "call_1", content: "Buy milk" },
];

describe("tool guard — POST /v1/messages", () => {
  beforeEach(() => vi.clearAllMocks());

  it("retries exactly once on a fabricated result and returns the recovered tool call", async () => {
    mockChat.mockResolvedValueOnce(FABRICATED).mockResolvedValueOnce(READ_CALL);

    const res = await postMessages({
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      tools: [READ_TOOL_ANTHROPIC],
      messages: [{ role: "user", content: "what is in /workspace/notes.txt?" }],
    });

    expect(mockChat).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
    expect(res.body.stop_reason).toBe("tool_use");
    expect(res.body.content[0]).toMatchObject({
      type: "tool_use",
      name: "Read",
      input: { path: "notes.txt" },
    });

    // the retry carries a correction that forces a call
    const correction = mockChat.mock.calls[1][0].at(-1);
    expect(correction.role).toBe("user");
    expect(correction.content).toContain("<tool_call");
  });

  it("retries once on a duplicate call and answers from the existing tool_result", async () => {
    mockChat.mockResolvedValueOnce(READ_CALL).mockResolvedValueOnce("notes.txt says: Buy milk.");

    const res = await postMessages({
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      tools: [READ_TOOL_ANTHROPIC],
      messages: anthropicWithResult,
    });

    expect(mockChat).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
    expect(res.body.stop_reason).toBe("end_turn");
    expect(res.body.content[0].text).toBe("notes.txt says: Buy milk.");
    expect(mockChat.mock.calls[1][0].at(-1).content).toContain("Buy milk");
  });

  it("does NOT retry a legitimate prose answer while tools are present", async () => {
    mockChat.mockResolvedValue(
      "Express matches middleware in registration order, so mount the catch-all last.",
    );

    const res = await postMessages({
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      tools: [READ_TOOL_ANTHROPIC],
      messages: [{ role: "user", content: "why does my route 404?" }],
    });

    expect(mockChat).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(res.body.stop_reason).toBe("end_turn");
  });

  it("does NOT retry a first-time tool call", async () => {
    mockChat.mockResolvedValue(READ_CALL);

    await postMessages({
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      tools: [READ_TOOL_ANTHROPIC],
      messages: [{ role: "user", content: "read notes.txt" }],
    });

    expect(mockChat).toHaveBeenCalledTimes(1);
  });

  it("returns the best available answer when the retry does not fix it", async () => {
    mockChat.mockResolvedValue(FABRICATED); // both attempts fabricate

    const res = await postMessages({
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      tools: [READ_TOOL_ANTHROPIC],
      messages: [{ role: "user", content: "what is in /workspace/notes.txt?" }],
    });

    expect(mockChat).toHaveBeenCalledTimes(2); // budget never exceeded
    expect(res.status).toBe(200);
    expect(res.body.content[0].text).toBe(FABRICATED);
  });

  it("still returns the first reply when the retry call fails upstream", async () => {
    mockChat
      .mockResolvedValueOnce(FABRICATED)
      .mockRejectedValueOnce(new Error("empty_response"));

    const res = await postMessages({
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      tools: [READ_TOOL_ANTHROPIC],
      messages: [{ role: "user", content: "what is in /workspace/notes.txt?" }],
    });

    expect(res.status).toBe(200);
    expect(res.body.content[0].text).toBe(FABRICATED);
  });

  it("guards the streaming path too", async () => {
    mockChat.mockResolvedValueOnce(FABRICATED).mockResolvedValueOnce(READ_CALL);

    const res = await postMessages({
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: true,
      tools: [READ_TOOL_ANTHROPIC],
      messages: [{ role: "user", content: "what is in /workspace/notes.txt?" }],
    });

    expect(mockChat).toHaveBeenCalledTimes(2);
    expect(res.text).toContain('"type":"tool_use"');
  });
});

describe("tool guard — POST /v1/chat/completions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("retries exactly once on a fabricated result and returns the recovered tool call", async () => {
    mockChat.mockResolvedValueOnce(FABRICATED).mockResolvedValueOnce(READ_CALL);

    const res = await postCompletions({
      model: "gpt-5.3",
      tools: [READ_TOOL_OPENAI],
      messages: [{ role: "user", content: "what is in /workspace/notes.txt?" }],
    });

    expect(mockChat).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
    expect(res.body.choices[0].finish_reason).toBe("tool_calls");
    expect(res.body.choices[0].message.tool_calls[0].function.name).toBe("Read");
  });

  it("retries once on a duplicate call and answers from the existing tool_result", async () => {
    mockChat.mockResolvedValueOnce(READ_CALL).mockResolvedValueOnce("The file contains: Buy milk.");

    const res = await postCompletions({
      model: "gpt-5.3",
      tools: [READ_TOOL_OPENAI],
      messages: openaiWithResult,
    });

    expect(mockChat).toHaveBeenCalledTimes(2);
    expect(res.body.choices[0].finish_reason).toBe("stop");
    expect(res.body.choices[0].message.content).toBe("The file contains: Buy milk.");
  });

  it("does NOT retry a legitimate prose answer while tools are present", async () => {
    mockChat.mockResolvedValue("Add the exports field to package.json to control the surface.");

    const res = await postCompletions({
      model: "gpt-5.3",
      tools: [READ_TOOL_OPENAI],
      messages: [{ role: "user", content: "how do I scope a package?" }],
    });

    expect(mockChat).toHaveBeenCalledTimes(1);
    expect(res.body.choices[0].finish_reason).toBe("stop");
  });

  it("does not run at all when the request has no tools", async () => {
    mockChat.mockResolvedValue(FABRICATED);

    const res = await postCompletions({
      model: "gpt-5.3",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(mockChat).toHaveBeenCalledTimes(1);
    expect(res.body.choices[0].message.content).toBe(FABRICATED);
  });
});

describe("tool guard — disabled by config", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    config.toolGuard = true;
    config.toolGuardMaxRetries = 1;
  });

  it("returns the original reply verbatim on both surfaces when TOOL_GUARD=false", async () => {
    config.toolGuard = false;
    mockChat.mockResolvedValue(FABRICATED);

    const anthropic = await postMessages({
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      tools: [READ_TOOL_ANTHROPIC],
      messages: [{ role: "user", content: "what is in /workspace/notes.txt?" }],
    });
    expect(mockChat).toHaveBeenCalledTimes(1);
    expect(anthropic.body.content[0].text).toBe(FABRICATED);

    const openai = await postCompletions({
      model: "gpt-5.3",
      tools: [READ_TOOL_OPENAI],
      messages: [{ role: "user", content: "what is in /workspace/notes.txt?" }],
    });
    expect(mockChat).toHaveBeenCalledTimes(2); // one per request, no retries
    expect(openai.body.choices[0].message.content).toBe(FABRICATED);
  });

  it("honours a retry budget of zero", async () => {
    config.toolGuardMaxRetries = 0;
    mockChat.mockResolvedValue(FABRICATED);

    await postCompletions({
      model: "gpt-5.3",
      tools: [READ_TOOL_OPENAI],
      messages: [{ role: "user", content: "what is in /workspace/notes.txt?" }],
    });

    expect(mockChat).toHaveBeenCalledTimes(1);
  });
});
