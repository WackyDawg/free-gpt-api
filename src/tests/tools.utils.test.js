import { describe, it, expect } from "vitest";
import {
  serializeTools,
  serializeMessage,
  buildPromptWithTools,
  parseToolCallReply,
  toUpstreamMessage,
  buildWireMessages,
} from "../utils/tools.util.js";

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

describe("serializeTools", () => {
  it("returns empty string when no tools", () => {
    expect(serializeTools([])).toBe("");
    expect(serializeTools(null)).toBe("");
  });

  it("wraps tool in <available_tools> block", () => {
    const out = serializeTools([READ_TOOL]);
    expect(out).toContain("<available_tools>");
    expect(out).toContain('<tool name="Read">');
    expect(out).toContain("Read the contents of a file");
    expect(out).toContain("</available_tools>");
  });

  it("skips non-function tools", () => {
    const out = serializeTools([{ type: "retrieval" }]);
    expect(out).toBe("<available_tools>\n</available_tools>");
  });
});

describe("serializeMessage", () => {
  it("serialises user message", () => {
    expect(serializeMessage({ role: "user", content: "Hello" })).toBe(
      "User: Hello",
    );
  });

  it("serialises system message", () => {
    expect(serializeMessage({ role: "system", content: "Be helpful" })).toBe(
      "[System]: Be helpful",
    );
  });

  it("serialises assistant message with tool_calls", () => {
    const msg = {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_abc",
          type: "function",
          function: { name: "Read", arguments: '{"path":"notes.txt"}' },
        },
      ],
    };
    const out = serializeMessage(msg);
    expect(out).toContain('<tool_call id="call_abc" name="Read">');
    expect(out).toContain('{"path":"notes.txt"}');
  });

  it("serialises tool result", () => {
    const msg = { role: "tool", tool_call_id: "call_abc", content: "Buy milk" };
    const out = serializeMessage(msg);
    expect(out).toBe('<tool_result id="call_abc">Buy milk</tool_result>');
  });

  it("serialises tool result without id", () => {
    const msg = { role: "tool", content: "Buy milk" };
    expect(serializeMessage(msg)).toBe("<tool_result>Buy milk</tool_result>");
  });
});

describe("parseToolCallReply", () => {
  it("returns text when no tool_call tags present", () => {
    const { text, toolCalls } = parseToolCallReply("The file has: Buy milk");
    expect(text).toBe("The file has: Buy milk");
    expect(toolCalls).toBeNull();
  });

  it("parses a single tool call", () => {
    const raw = `<tool_call id="call_1" name="Read">{"path":"notes.txt"}</tool_call>`;
    const { text, toolCalls } = parseToolCallReply(raw);
    expect(text).toBeNull();
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({
      id: "call_1",
      type: "function",
      function: { name: "Read", arguments: '{"path":"notes.txt"}' },
    });
  });

  it("parses multiple tool calls", () => {
    const raw = `
      <tool_call id="call_1" name="Read">{"path":"a.txt"}</tool_call>
      <tool_call id="call_2" name="Read">{"path":"b.txt"}</tool_call>
    `;
    const { toolCalls } = parseToolCallReply(raw);
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[1].id).toBe("call_2");
  });

  it("trims whitespace from arguments", () => {
    const raw = `<tool_call id="c" name="Fn">  {"x":1}  </tool_call>`;
    const { toolCalls } = parseToolCallReply(raw);
    expect(toolCalls[0].function.arguments).toBe('{"x":1}');
  });
});

describe("buildPromptWithTools", () => {
  it("includes tool schema and instruction when tools present", () => {
    const messages = [{ role: "user", content: "Read notes.txt" }];
    const { prompt } = buildPromptWithTools(messages, [READ_TOOL]);
    expect(prompt).toContain("<available_tools>");
    expect(prompt).toContain("tool_call");
    expect(prompt).toContain("User: Read notes.txt");
    expect(prompt).toContain("Assistant:");
  });

  it("omits tool block when no tools", () => {
    const messages = [{ role: "user", content: "Hello" }];
    const { prompt } = buildPromptWithTools(messages, []);
    expect(prompt).not.toContain("<available_tools>");
    expect(prompt).toContain("User: Hello");
  });

  it("uses the forcing reminder before any tool has run", () => {
    const { prompt } = buildPromptWithTools(
      [{ role: "user", content: "What is in notes.txt?" }],
      [READ_TOOL],
    );
    expect(prompt).toContain("No tool has run yet");
    // must not invite the model to reuse results it does not have
    expect(prompt).not.toMatch(/Do NOT call the tool again/);
  });

  it("switches to the anti-repetition reminder once a tool_result exists", () => {
    const { prompt } = buildPromptWithTools(
      [
        { role: "user", content: "What is in notes.txt?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "c1", type: "function", function: { name: "Read", arguments: '{"path":"notes.txt"}' } },
          ],
        },
        { role: "tool", tool_call_id: "c1", content: "Buy milk" },
      ],
      [READ_TOOL],
    );
    expect(prompt).toContain("Do NOT call the tool again");
    expect(prompt).not.toContain("No tool has run yet");
    // it still has to explain how to call a tool for genuinely new information
    expect(prompt).toContain("<tool_call");
  });

  it("round-trips the full tool-call conversation", () => {
    const messages = [
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
    ];
    const { prompt } = buildPromptWithTools(messages, [READ_TOOL]);
    expect(prompt).toContain("call_tuefggdxl");
    expect(prompt).toContain("Buy milk");
  });
});

describe("toUpstreamMessage", () => {
  it("sends a tool result as a user turn", () => {
    // Upstream rejects author.role "tool"; the result must travel as user text.
    const out = toUpstreamMessage({
      role: "tool",
      tool_call_id: "toolu_1",
      content: "file body",
    });
    expect(out.role).toBe("user");
    expect(out.text).toBe('<tool_result id="toolu_1">file body</tool_result>');
  });

  it("folds tool_calls into the assistant's text", () => {
    // Passing the message through untouched sends an empty part and drops the
    // call from the transcript entirely.
    const out = toUpstreamMessage({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "Read", arguments: '{"path":"a.txt"}' },
        },
      ],
    });
    expect(out.role).toBe("assistant");
    expect(out.text).toContain('<tool_call id="call_1" name="Read">');
    expect(out.text).toContain('{"path":"a.txt"}');
  });

  it("keeps plain messages unchanged", () => {
    expect(toUpstreamMessage({ role: "user", content: "hi" })).toEqual({
      role: "user",
      text: "hi",
    });
    expect(toUpstreamMessage({ role: "system", content: "be terse" })).toEqual({
      role: "system",
      text: "be terse",
    });
  });

  it("never emits a role upstream does not accept", () => {
    const roles = ["user", "assistant", "system", "tool"].map(
      (role) => toUpstreamMessage({ role, content: "x" }).role,
    );
    expect(new Set(roles)).toEqual(new Set(["user", "assistant", "system"]));
  });
});

describe("buildWireMessages", () => {
  it("shapes a wire message from role/text/id, with empty metadata by default", () => {
    const [out] = buildWireMessages([{ id: "m1", role: "user", text: "hi" }]);
    expect(out).toEqual({
      id: "m1",
      author: { role: "user" },
      content: { content_type: "text", parts: ["hi"] },
      metadata: {},
    });
  });

  it("attaches system_hints to metadata when provided", () => {
    const [out] = buildWireMessages([{ id: "m1", role: "user", text: "hi" }], {
      systemHints: ["reason"],
    });
    expect(out.metadata.system_hints).toEqual(["reason"]);
  });

  it("adds deep-research metadata only when mode is deep-research", () => {
    const [deepResearch] = buildWireMessages([{ id: "m1", role: "user", text: "hi" }], {
      mode: "deep-research",
    });
    expect(deepResearch.metadata).toMatchObject({
      deep_research_version: "standard",
      venus_model_variant: "standard",
    });

    const [defaultMode] = buildWireMessages([{ id: "m1", role: "user", text: "hi" }]);
    expect(defaultMode.metadata.deep_research_version).toBeUndefined();
  });

  it("preserves message order and per-message id/role across multiple messages", () => {
    const out = buildWireMessages([
      { id: "a", role: "user", text: "1" },
      { id: "b", role: "assistant", text: "2" },
    ]);
    expect(out.map((m) => [m.id, m.author.role, m.content.parts[0]])).toEqual([
      ["a", "user", "1"],
      ["b", "assistant", "2"],
    ]);
  });
});
