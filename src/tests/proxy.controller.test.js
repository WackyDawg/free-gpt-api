import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

vi.mock("../utils/browser.util.js", () => {
  const ChatGPTClient = vi.fn();
  ChatGPTClient.prototype.chat = vi.fn();
  return { ChatGPTClient };
});

const { default: app } = await import("../app.js");
const { ChatGPTClient } = await import("../utils/browser.util.js");
const mockChat = ChatGPTClient.prototype.chat;

const READ_TOOL = {
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

function post(body) {
  return request(app).post("/v1/chat/completions").send(body);
}

describe("POST /v1/chat/completions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("400 when messages missing", async () => {
    const res = await post({ model: "gpt-x" });
    expect(res.status).toBe(400);
    expect(res.body.error.type).toBe("invalid_request_error");
  });

  it("400 when stream: true", async () => {
    mockChat.mockResolvedValue("ok");
    const res = await post({
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    expect(res.status).toBe(400);
  });

  it("returns a normal text completion", async () => {
    mockChat.mockResolvedValue("The answer is 42.");
    const res = await post({
      model: "gpt-5.3",
      messages: [{ role: "user", content: "What is 6 × 7?" }],
    });

    expect(res.status).toBe(200);
    expect(res.body.choices[0].finish_reason).toBe("stop");
    expect(res.body.choices[0].message.content).toBe("The answer is 42.");
    expect(res.body.choices[0].message.tool_calls).toBeUndefined();
  });

  it("returns tool_calls when model emits a <tool_call> tag", async () => {
    mockChat.mockResolvedValue(
      `<tool_call id="call_abc" name="Read">{"path":"notes.txt"}</tool_call>`,
    );

    const res = await post({
      model: "gpt-5.3",
      tools: [READ_TOOL],
      messages: [{ role: "user", content: "What is in notes.txt?" }],
    });

    expect(res.status).toBe(200);
    const choice = res.body.choices[0];
    expect(choice.finish_reason).toBe("tool_calls");
    expect(choice.message.content).toBeNull();
    expect(choice.message.tool_calls).toHaveLength(1);
    expect(choice.message.tool_calls[0]).toMatchObject({
      id: "call_abc",
      type: "function",
      function: { name: "Read", arguments: '{"path":"notes.txt"}' },
    });
  });

  it("returns final text answer after tool result is fed back", async () => {
    mockChat.mockResolvedValue("The file contains: Buy milk, Call dentist.");

    const res = await post({
      model: "gpt-5.3",
      tools: [READ_TOOL],
      messages: [
        { role: "user", content: "What is in notes.txt?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_tuefggdxl",
              type: "function",
              function: { name: "Read", arguments: '{"path":"notes.txt"}' },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_tuefggdxl",
          content: "Buy milk\nCall dentist",
        },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.choices[0].finish_reason).toBe("stop");
    expect(res.body.choices[0].message.content).toContain("Buy milk");
  });

  it("500 when client.chat throws", async () => {
    mockChat.mockRejectedValue(new Error("auth_expired:401"));
    const res = await post({ messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(500);
    expect(res.body.error.message).toBe("auth_expired:401");
  });

  it("always includes usage block", async () => {
    mockChat.mockResolvedValue("hello");
    const res = await post({ messages: [{ role: "user", content: "hi" }] });
    expect(res.body.usage).toMatchObject({
      prompt_tokens: expect.any(Number),
      completion_tokens: expect.any(Number),
      total_tokens: expect.any(Number),
    });
  });

  it("id is prefixed with chatcmpl-", async () => {
    mockChat.mockResolvedValue("hello");
    const res = await post({ messages: [{ role: "user", content: "hi" }] });
    expect(res.body.id).toMatch(/^chatcmpl-/);
  });
});
