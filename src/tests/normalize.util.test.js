import { describe, expect, it } from "vitest";
import { normalizeReply } from "../utils/normalize.util.js";

describe("normalizeReply", () => {
  it("flattens multi-line replies to a single line", () => {
    expect(normalizeReply("line one\nline two\n\nline three")).toBe(
      "line one line two line three",
    );
  });

  it("strips citation markers and reference entities", () => {
    expect(normalizeReply("Paris【4:0†source】 is the capital[12].")).toBe(
      "Paris is the capital.",
    );
    expect(normalizeReply('See entity["city","Berlin"] today')).toBe("See Berlin today");
  });

  describe("does not corrupt content (regressions from the old regex chain)", () => {
    it("keeps arithmetic operators", () => {
      // Old chain matched /[-*+]\s+/ and turned this into "return a b".
      expect(normalizeReply("```python\ndef add(a, b):\n    return a + b\n```")).toBe(
        "def add(a, b): return a + b",
      );
      expect(normalizeReply("3 * 4 - 1 + 2")).toBe("3 * 4 - 1 + 2");
    });

    it("keeps underscores in identifiers", () => {
      // Old chain matched a bare /_/ and produced "userid" / "getuserby".
      expect(normalizeReply("call get_user_by_id with user_id")).toBe(
        "call get_user_by_id with user_id",
      );
    });

    it("keeps tool-call blocks intact", () => {
      const call = '<tool_call id="call_1" name="read_file">{"file_path":"a_b.txt"}</tool_call>';
      expect(normalizeReply(call)).toBe(call);
    });

    it("does not eat a leading sentence that happens to contain a colon", () => {
      // Old chain had /^[A-Z][^.!?]{2,100}:\s*/ which deleted this outright.
      expect(normalizeReply("Note: keep the file")).toBe("Note: keep the file");
    });
  });

  describe("markdown stripping", () => {
    it("removes paired emphasis, headings, and bullets", () => {
      expect(normalizeReply("**bold** and ~~gone~~ and _it_")).toBe("bold and gone and it");
      expect(normalizeReply("## Title\n- one\n- two\n1. three")).toBe("Title one two three");
      expect(normalizeReply("use `npm run start` now")).toBe("use npm run start now");
    });

    it("can be disabled", () => {
      expect(normalizeReply("**bold**", { stripMarkdown: false })).toBe("**bold**");
    });
  });

  it("preserves newlines when flatten is disabled", () => {
    expect(normalizeReply("a\nb", { flatten: false })).toBe("a\nb");
  });

  it("handles empty and non-string input", () => {
    expect(normalizeReply("")).toBe("");
    expect(normalizeReply(null)).toBe("");
    expect(normalizeReply(undefined)).toBe("");
  });
});

describe("tool call payloads are never reshaped", () => {
  // As a model actually emits it: JSON with escaped newlines, on one line.
  const call =
    '<tool_call id="c1" name="Write">' +
    JSON.stringify({ path: "app.py", content: "def add(a, b):\n    return a + b\n" }) +
    "</tool_call>";

  it("round-trips arguments byte for byte", () => {
    const out = normalizeReply(call);
    expect(out).toBe(call);
    const args = JSON.parse(out.match(/>(\{[\s\S]*\})</)[1]);
    expect(args.content).toBe("def add(a, b):\n    return a + b\n");
  });

  it("does not strip markdown from file content being written", () => {
    // The dangerous case: markdown stripping mangles the payload but leaves
    // valid JSON behind, so nothing errors — the caller writes "Title" instead
    // of "# Title" and reports success.
    const md =
      '<tool_call id="c2" name="Write">' +
      JSON.stringify({ path: "README.md", content: "# Title\n- item _one_\n**bold**" }) +
      "</tool_call>";
    const args = JSON.parse(normalizeReply(md).match(/>(\{[\s\S]*\})</)[1]);
    expect(args.content).toBe("# Title\n- item _one_\n**bold**");
  });

  it("preserves literal newlines when a model emits unescaped JSON", () => {
    const sloppy =
      '<tool_call id="c3" name="Write">{"content":"line one\nline two"}</tool_call>';
    expect(normalizeReply(sloppy)).toBe(sloppy);
  });

  it("still flattens the prose around a tool call", () => {
    const out = normalizeReply(`I will write it now.\n\n${call}\n\n**Done**`);
    expect(out).toContain(call);
    expect(out).toContain("I will write it now.");
    expect(out).not.toContain("**Done**");
    expect(out).toContain("Done");
  });

  it("handles several tool calls in one reply", () => {
    const out = normalizeReply(`${call}\nand\n${call}`);
    expect(out.match(/<tool_call/g)).toHaveLength(2);
    expect(out).toContain(call);
  });
});
