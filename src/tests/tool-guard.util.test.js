import { describe, it, expect, vi } from "vitest";
import {
  looksLikeFabricatedToolResult,
  isDuplicateToolCall,
  existingResultFor,
  findDuplicateCall,
  canonicalizeArguments,
  correctionPrompt,
  runWithToolGuard,
  toolNamesOf,
  GUARD_FABRICATED,
  GUARD_DUPLICATE,
} from "../utils/tool-guard.util.js";

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

const BASH_TOOL = {
  type: "function",
  function: {
    name: "Bash",
    description: "Run a shell command",
    parameters: { type: "object", properties: { command: { type: "string" } } },
  },
};

const TOOLS = [READ_TOOL, BASH_TOOL];

/** call -> tool_result pair, as the controllers hand it to the guard. */
function conversationWithResult({
  id = "call_1",
  name = "Read",
  args = '{"path":"notes.txt"}',
  result = "Buy milk",
} = {}) {
  return [
    { role: "user", content: "What is in notes.txt?" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id, type: "function", function: { name, arguments: args } }],
    },
    { role: "tool", tool_call_id: id, content: result },
  ];
}

describe("looksLikeFabricatedToolResult", () => {
  it("fires on a claim to have inspected a file", () => {
    expect(
      looksLikeFabricatedToolResult(
        "I checked /workspace/notes.txt, and the file does not exist.",
        TOOLS,
      ),
    ).toBe(true);
  });

  it("fires on an absence verdict about a concrete path", () => {
    expect(
      looksLikeFabricatedToolResult(
        "The file src/config/settings.json was not found in this environment.",
        TOOLS,
      ),
    ).toBe(true);
  });

  it("fires on a fabricated command result", () => {
    expect(
      looksLikeFabricatedToolResult(
        "I ran `npm test` and every one of the suites passed.",
        TOOLS,
      ),
    ).toBe(true);
  });

  it("fires on a capability disclaimer when a tool exists for the job", () => {
    expect(
      looksLikeFabricatedToolResult(
        "I don't have access to your filesystem, so I can only describe the format in general.",
        TOOLS,
      ),
    ).toBe(true);
  });

  it("fires when the claim is buried in an otherwise helpful answer", () => {
    const reply = [
      "Here is how the loader resolves modules.",
      "I looked at the package.json in the repo root and there is no exports field.",
      "You can add one to control the public surface.",
    ].join("\n");
    expect(looksLikeFabricatedToolResult(reply, TOOLS)).toBe(true);
  });

  // --- the over-firing guard: everything below must stay false ---------------

  it("does not fire on prose that merely mentions a filename", () => {
    expect(
      looksLikeFabricatedToolResult(
        "Put your keys in .env and load them with dotenv at the top of src/app.js.",
        TOOLS,
      ),
    ).toBe(false);
  });

  it("does not fire on a plan to call a tool", () => {
    expect(
      looksLikeFabricatedToolResult(
        "Let me read /workspace/notes.txt first, then I'll summarise it.",
        TOOLS,
      ),
    ).toBe(false);
  });

  it("does not fire on a conditional about a missing file", () => {
    expect(
      looksLikeFabricatedToolResult(
        "If the config file does not exist, the server falls back to the defaults.",
        TOOLS,
      ),
    ).toBe(false);
  });

  it("does not fire on a question about a file", () => {
    expect(
      looksLikeFabricatedToolResult(
        "Which file should I read — notes.txt or notes.md?",
        TOOLS,
      ),
    ).toBe(false);
  });

  it("does not fire on general technical explanation", () => {
    const reply = [
      "A 404 means the route was not matched by any handler.",
      "Express walks the middleware stack in order, so a catch-all registered first shadows everything after it.",
    ].join(" ");
    expect(looksLikeFabricatedToolResult(reply, TOOLS)).toBe(false);
  });

  it("does not fire on an answer derived from a tool result", () => {
    expect(
      looksLikeFabricatedToolResult(
        "notes.txt contains two entries: buy milk and call the dentist.",
        TOOLS,
      ),
    ).toBe(false);
  });

  it("does not fire when the reply is itself a tool call", () => {
    expect(
      looksLikeFabricatedToolResult(
        `<tool_call id="c1" name="Read">{"path":"/workspace/notes.txt"}</tool_call>`,
        TOOLS,
      ),
    ).toBe(false);
  });

  it("does not fire when no tools were offered", () => {
    expect(
      looksLikeFabricatedToolResult(
        "I checked /workspace/notes.txt and the file does not exist.",
        [],
      ),
    ).toBe(false);
    expect(
      looksLikeFabricatedToolResult("I checked the file, it is missing.", undefined),
    ).toBe(false);
  });

  it("handles empty and non-string input", () => {
    expect(looksLikeFabricatedToolResult("", TOOLS)).toBe(false);
    expect(looksLikeFabricatedToolResult(null, TOOLS)).toBe(false);
    expect(looksLikeFabricatedToolResult(undefined, TOOLS)).toBe(false);
  });

  it("accepts Anthropic-shaped tools and bare names", () => {
    expect(toolNamesOf([{ name: "Read" }, "Bash", READ_TOOL])).toEqual([
      "Read",
      "Bash",
      "Read",
    ]);
    expect(
      looksLikeFabricatedToolResult("I checked the file; it does not exist.", [
        { name: "Read", input_schema: {} },
      ]),
    ).toBe(true);
  });
});

describe("canonicalizeArguments", () => {
  it("is insensitive to key order and whitespace", () => {
    expect(canonicalizeArguments('{"a":1,"b":2}')).toBe(
      canonicalizeArguments('{ "b": 2, "a": 1 }'),
    );
  });

  it("falls back to the trimmed string for unparseable arguments", () => {
    expect(canonicalizeArguments("  not json  ")).toBe("not json");
    expect(canonicalizeArguments(null)).toBe("{}");
  });
});

describe("isDuplicateToolCall", () => {
  const call = (name, args) => ({
    id: "call_new",
    type: "function",
    function: { name, arguments: args },
  });

  it("detects an identical call that already has a result", () => {
    expect(
      isDuplicateToolCall(call("Read", '{"path":"notes.txt"}'), conversationWithResult()),
    ).toBe(true);
  });

  it("ignores key order and formatting differences", () => {
    const prior = conversationWithResult({ args: '{"path":"a.txt","limit":10}' });
    expect(
      isDuplicateToolCall(call("Read", '{ "limit": 10, "path": "a.txt" }'), prior),
    ).toBe(true);
  });

  it("is false for a different argument", () => {
    expect(
      isDuplicateToolCall(call("Read", '{"path":"other.txt"}'), conversationWithResult()),
    ).toBe(false);
  });

  it("is false for a different tool with the same arguments", () => {
    expect(
      isDuplicateToolCall(call("Write", '{"path":"notes.txt"}'), conversationWithResult()),
    ).toBe(false);
  });

  it("is false when the prior call was never answered", () => {
    const prior = conversationWithResult().slice(0, 2); // no tool_result
    expect(isDuplicateToolCall(call("Read", '{"path":"notes.txt"}'), prior)).toBe(false);
  });

  it("attributes an id-less tool_result to the outstanding call", () => {
    const prior = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "Read", arguments: '{"path":"a"}' } },
        ],
      },
      { role: "tool", content: "body" },
    ];
    expect(isDuplicateToolCall(call("Read", '{"path":"a"}'), prior)).toBe(true);
  });

  it("handles an empty or malformed history", () => {
    expect(isDuplicateToolCall(call("Read", "{}"), [])).toBe(false);
    expect(isDuplicateToolCall(call("Read", "{}"), null)).toBe(false);
    expect(isDuplicateToolCall({}, conversationWithResult())).toBe(false);
  });

  it("surfaces the result that already answered the call", () => {
    const prior = conversationWithResult({ result: "Buy milk\nCall dentist" });
    expect(existingResultFor(call("Read", '{"path":"notes.txt"}'), prior)).toBe(
      "Buy milk\nCall dentist",
    );
    expect(findDuplicateCall([call("Read", '{"path":"notes.txt"}')], prior)).not.toBeNull();
    expect(findDuplicateCall([call("Read", '{"path":"new.txt"}')], prior)).toBeNull();
  });
});

describe("correctionPrompt", () => {
  it("forces a call for the fabricated case and names the tools", () => {
    const out = correctionPrompt(GUARD_FABRICATED, { tools: TOOLS });
    expect(out).toContain("<tool_call");
    expect(out).toContain("Read, Bash");
    expect(out).not.toMatch(/already been made/i);
  });

  it("forbids a repeat and echoes the existing result for the duplicate case", () => {
    const out = correctionPrompt(GUARD_DUPLICATE, {
      toolCall: {
        function: { name: "Read", arguments: '{"path":"notes.txt"}' },
      },
      result: "Buy milk",
    });
    expect(out).toMatch(/already/i);
    expect(out).toContain("Read");
    expect(out).toContain("Buy milk");
    expect(out).toMatch(/do not emit a <tool_call>/i);
  });

  it("truncates a huge tool result instead of replaying it whole", () => {
    const out = correctionPrompt(GUARD_DUPLICATE, {
      toolCall: { function: { name: "Read", arguments: "{}" } },
      result: "x".repeat(10000),
    });
    expect(out).toContain("[...truncated]");
    expect(out.length).toBeLessThan(6000);
  });
});

describe("runWithToolGuard", () => {
  const base = {
    structuredMessages: [{ role: "user", content: "read notes.txt" }],
    tools: TOOLS,
    enabled: true,
    maxRetries: 1,
  };

  it("returns the first reply untouched when nothing is wrong", async () => {
    const chat = vi.fn().mockResolvedValue("Here is a summary of how it works.");
    const out = await runWithToolGuard({ ...base, chat });

    expect(chat).toHaveBeenCalledTimes(1);
    expect(out.guard).toBeNull();
    expect(out.retried).toBe(false);
    expect(out.text).toBe("Here is a summary of how it works.");
  });

  it("retries once on a fabricated result and returns the recovered call", async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce("I checked /workspace/notes.txt and the file does not exist.")
      .mockResolvedValueOnce(
        `<tool_call id="c1" name="Read">{"path":"/workspace/notes.txt"}</tool_call>`,
      );

    const out = await runWithToolGuard({ ...base, chat });

    expect(chat).toHaveBeenCalledTimes(2);
    expect(out.guard).toBe(GUARD_FABRICATED);
    expect(out.recovered).toBe(true);
    expect(out.toolCalls[0].function.name).toBe("Read");

    // the correction is appended after the original reply, nothing is dropped
    const retryMessages = chat.mock.calls[1][0];
    expect(retryMessages.slice(0, 1)).toEqual(base.structuredMessages);
    expect(retryMessages.at(-2).role).toBe("assistant");
    expect(retryMessages.at(-1).role).toBe("user");
    expect(retryMessages.at(-1).content).toContain("<tool_call");
  });

  it("retries once on a duplicate call and returns the answer from the result", async () => {
    const prior = conversationWithResult({ result: "Buy milk" });
    const chat = vi
      .fn()
      .mockResolvedValueOnce(`<tool_call id="c9" name="Read">{"path":"notes.txt"}</tool_call>`)
      .mockResolvedValueOnce("notes.txt says: Buy milk.");

    const out = await runWithToolGuard({ ...base, chat, priorMessages: prior });

    expect(chat).toHaveBeenCalledTimes(2);
    expect(out.guard).toBe(GUARD_DUPLICATE);
    expect(out.recovered).toBe(true);
    expect(out.toolCalls).toBeNull();
    expect(out.text).toBe("notes.txt says: Buy milk.");
    expect(chat.mock.calls[1][0].at(-1).content).toContain("Buy milk");
  });

  it("does not retry a fresh call that has no prior result", async () => {
    const chat = vi
      .fn()
      .mockResolvedValue(`<tool_call id="c1" name="Read">{"path":"notes.txt"}</tool_call>`);
    const out = await runWithToolGuard({ ...base, chat, priorMessages: [] });

    expect(chat).toHaveBeenCalledTimes(1);
    expect(out.guard).toBeNull();
  });

  it("never spends more than the retry budget", async () => {
    const chat = vi.fn().mockResolvedValue("I checked notes.txt; the file does not exist.");
    const out = await runWithToolGuard({ ...base, chat });

    expect(chat).toHaveBeenCalledTimes(2); // 1 attempt + 1 retry, never more
    expect(out.guard).toBe(GUARD_FABRICATED);
    expect(out.recovered).toBe(false);
    // best available answer, not an error
    expect(out.text).toBe("I checked notes.txt; the file does not exist.");
  });

  it("keeps the original reply when the retry throws", async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce("I checked notes.txt; the file does not exist.")
      .mockRejectedValueOnce(new Error("empty_response"));

    const out = await runWithToolGuard({ ...base, chat });

    expect(chat).toHaveBeenCalledTimes(2);
    expect(out.text).toBe("I checked notes.txt; the file does not exist.");
    expect(out.retried).toBe(true);
    expect(out.recovered).toBe(false);
  });

  it("propagates a failure of the first attempt to the caller", async () => {
    const chat = vi.fn().mockRejectedValue(new Error("auth_expired:401"));
    await expect(runWithToolGuard({ ...base, chat })).rejects.toThrow("auth_expired:401");
  });

  it("reports which guard fired", async () => {
    const onGuard = vi.fn();
    const chat = vi
      .fn()
      .mockResolvedValueOnce("I checked notes.txt; the file does not exist.")
      .mockResolvedValueOnce(`<tool_call id="c1" name="Read">{"path":"notes.txt"}</tool_call>`);

    await runWithToolGuard({ ...base, chat, onGuard });
    expect(onGuard).toHaveBeenCalledTimes(1);
    expect(onGuard.mock.calls[0][0]).toMatchObject({
      kind: GUARD_FABRICATED,
      retried: true,
      recovered: true,
    });
  });

  it("is a no-op when disabled or when the budget is zero", async () => {
    const reply = "I checked notes.txt; the file does not exist.";

    const disabled = vi.fn().mockResolvedValue(reply);
    const off = await runWithToolGuard({ ...base, chat: disabled, enabled: false });
    expect(disabled).toHaveBeenCalledTimes(1);
    expect(off.guard).toBeNull();
    expect(off.text).toBe(reply);

    const noBudget = vi.fn().mockResolvedValue(reply);
    await runWithToolGuard({ ...base, chat: noBudget, maxRetries: 0 });
    expect(noBudget).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when the request carried no tools", async () => {
    const chat = vi.fn().mockResolvedValue("I checked notes.txt; the file does not exist.");
    await runWithToolGuard({ ...base, chat, tools: [] });
    expect(chat).toHaveBeenCalledTimes(1);
  });
});
