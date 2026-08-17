import { describe, expect, it } from "vitest";
import {
  isFinalAnswer,
  orderStreamItems,
  parseSseBlocks,
  parseStreamItems,
  parseTurnStream,
} from "../utils/sse-delta.util.js";

/**
 * Fixture mirrors a real gpt-5-6-thinking turn observed on the page's own
 * WebSocket: hidden system messages, the user echo, a reasoning_recap
 * (what the UI renders as "Thinking…"), then the final answer delivered as an
 * append onto /message/content/parts/0.
 */
const envelope = (message) =>
  JSON.stringify({ message, conversation_id: "conv-1", error: null, error_code: null });

const SSE = [
  `event: delta_encoding\ndata: "v1"\n`,
  `event: delta\ndata: {"p":"","o":"add","v":${envelope({
    id: "sys-1",
    author: { role: "system" },
    content: { content_type: "text", parts: [""] },
    metadata: { is_visually_hidden_from_conversation: true },
  })},"c":0}\n`,
  `event: delta\ndata: {"v":${envelope({
    id: "usr-1",
    author: { role: "user" },
    content: { content_type: "text", parts: ["ping"] },
    metadata: {},
  })},"c":1}\n`,
  `event: message\ndata: {"type":"message_marker","conversation_id":"conv-1"}\n`,
  `event: delta\ndata: {"p":"","o":"add","v":${envelope({
    id: "asst-recap",
    author: { role: "assistant" },
    recipient: "all",
    channel: null,
    content: { content_type: "reasoning_recap", parts: ["Thinking"] },
    metadata: { reasoning_status: "is_reasoning" },
  })},"c":2}\n`,
  `event: delta\ndata: {"p":"","o":"add","v":${envelope({
    id: "asst-final",
    author: { role: "assistant" },
    recipient: "all",
    channel: "final",
    status: "in_progress",
    content: { content_type: "text", parts: [""] },
    metadata: {},
  })},"c":3}\n`,
  `event: delta\ndata: {"p":"/message/content/parts/0","o":"append","v":"Hello"}\n`,
  `event: delta\ndata: {"v":", world"}\n`,
  `event: delta\ndata: {"p":"","o":"patch","v":[{"p":"/message/status","o":"replace","v":"finished_successfully"}]}\n`,
  `event: message\ndata: {"type":"message_stream_complete","conversation_id":"conv-1"}\n`,
  `data: [DONE]\n`,
].join("\n");

describe("parseSseBlocks", () => {
  it("splits events and tolerates a truncated tail", () => {
    const blocks = parseSseBlocks(`event: delta\ndata: {"a":1}\n\nevent: delta\ndata: {"a":`);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ event: "delta", data: '{"a":1}' });
  });
});

describe("parseTurnStream", () => {
  const result = parseTurnStream(SSE);

  it("reports the delta encoding version", () => {
    expect(result.encoding).toBe("v1");
  });

  it("extracts reasoning text from nested thoughts/summary fields", () => {
    const nested = parseTurnStream(
      `event: delta_encoding\r\ndata: "v1"\r\n\r\nevent: delta\r\ndata: {"p":"","o":"add","v":${envelope({
        id: "nested-reasoning",
        author: { role: "assistant" },
        channel: "analysis",
        content: { content_type: "text", thoughts: [{ summary: "Visible reasoning" }] },
        metadata: { reasoning_status: "streaming" },
      })}}\r\n\r\n`,
    );
    expect(nested.reasoning).toBe("Visible reasoning");
  });

  it("reconstructs the final answer from append ops", () => {
    expect(result.text).toBe("Hello, world");
  });

  it("continues the sticky path when p is omitted", () => {
    // ", world" arrived with no `p`; it must land on the same parts slot.
    expect(result.text.endsWith(", world")).toBe(true);
  });

  it("applies nested patch ops", () => {
    const final = result.messages.find((m) => m.id === "asst-final");
    expect(final.status).toBe("finished_successfully");
  });

  it("never returns the reasoning recap as the answer", () => {
    expect(result.text).not.toMatch(/Thinking/);
  });

  it("signals stream completion and DONE", () => {
    expect(result.streamComplete).toBe(true);
    expect(result.done).toBe(true);
    expect(result.conversationId).toBe("conv-1");
  });

  it("returns empty text rather than garbage on a truncated stream", () => {
    const truncated = parseTurnStream(SSE.slice(0, SSE.indexOf("append")));
    expect(truncated.text).toBe("");
    expect(truncated.done).toBe(false);
  });
});

describe("isFinalAnswer", () => {
  it("rejects reasoning, hidden, and tool-directed messages", () => {
    const base = {
      author: { role: "assistant" },
      recipient: "all",
      content: { content_type: "text" },
    };
    expect(isFinalAnswer(base)).toBe(true);
    expect(isFinalAnswer({ ...base, content: { content_type: "reasoning_recap" } })).toBe(false);
    expect(isFinalAnswer({ ...base, recipient: "python" })).toBe(false);
    expect(isFinalAnswer({ ...base, channel: "analysis" })).toBe(false);
    expect(
      isFinalAnswer({ ...base, metadata: { is_visually_hidden_from_conversation: true } }),
    ).toBe(false);
    expect(isFinalAnswer({ ...base, author: { role: "user" } })).toBe(false);
  });
});

describe("orderStreamItems", () => {
  const items = [
    { stream_item_id: "c", parent_stream_item_id: "b", encoded_item: "3" },
    { stream_item_id: "a", parent_stream_item_id: null, encoded_item: "1" },
    { stream_item_id: "b", parent_stream_item_id: "a", encoded_item: "2" },
  ];

  it("rebuilds arrival-independent order from the parent chain", () => {
    expect(orderStreamItems(items).map((i) => i.encoded_item)).toEqual(["1", "2", "3"]);
  });

  it("keeps orphans instead of dropping them", () => {
    const withOrphan = [...items, { stream_item_id: "z", parent_stream_item_id: "missing", encoded_item: "4" }];
    expect(orderStreamItems(withOrphan)).toHaveLength(4);
  });

  it("does not discard multiple children of one parent", () => {
    const branched = [
      { stream_item_id: "b", parent_stream_item_id: "a", encoded_item: "2" },
      { stream_item_id: "c", parent_stream_item_id: "a", encoded_item: "3" },
      { stream_item_id: "a", parent_stream_item_id: null, encoded_item: "1" },
    ];
    expect(orderStreamItems(branched)).toHaveLength(3);
  });
});

describe("parseStreamItems", () => {
  it("joins WebSocket slices and parses them as one stream", () => {
    // Split mid-token to prove slices are byte-continuations, not whole events.
    const cut = Math.floor(SSE.length / 2);
    const items = [
      { stream_item_id: "s1", parent_stream_item_id: null, encoded_item: SSE.slice(0, cut) },
      { stream_item_id: "s2", parent_stream_item_id: "s1", encoded_item: SSE.slice(cut) },
    ];
    expect(parseStreamItems(items).text).toBe("Hello, world");
    // ...and still works when frames arrive out of order.
    expect(parseStreamItems([items[1], items[0]]).text).toBe("Hello, world");
  });
});

describe("legacy (pre-delta) framing", () => {
  const snapshot = (parts) =>
    `data: ${JSON.stringify({
      message: {
        id: "asst-1",
        author: { role: "assistant" },
        recipient: "all",
        content: { content_type: "text", parts: [parts] },
        metadata: {},
      },
      conversation_id: "conv-legacy",
    })}\n`;

  const LEGACY = [snapshot("Hel"), snapshot("Hello"), snapshot("Hello, world"), `data: [DONE]\n`].join("\n");

  it("takes the last cumulative snapshot as the answer", () => {
    const result = parseTurnStream(LEGACY);
    expect(result.text).toBe("Hello, world");
    expect(result.legacySnapshots).toBe(3);
    expect(result.encoding).toBeNull();
    expect(result.done).toBe(true);
  });

  it("does not treat v1 control envelopes as snapshots", () => {
    const control = `data: {"type":"message_marker","conversation_id":"c","message_id":"m"}\n`;
    expect(parseTurnStream(control).legacySnapshots).toBe(0);
  });
});
