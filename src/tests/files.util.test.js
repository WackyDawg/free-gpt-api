import { describe, it, expect } from "vitest";
import { messagesWithFiles, extractFileBlocks } from "../utils/files.util.js";

describe("messagesWithFiles", () => {
  const prompt = [{ role: "user", content: "What does getKey() return?" }];

  it("returns messages unchanged when no files", () => {
    expect(messagesWithFiles(prompt, undefined)).toBe(prompt);
    expect(messagesWithFiles(prompt, [])).toBe(prompt);
  });

  it("prepends a file as a leading user message before the prompt", () => {
    const out = messagesWithFiles(prompt, [{ filename: "key.js", content: "const k = 42;" }]);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ role: "user", content: "File: key.js\n\nconst k = 42;" });
    expect(out[1]).toBe(prompt[0]);
  });

  it("omits the header when no filename is given", () => {
    const out = messagesWithFiles(prompt, [{ content: "raw text" }]);
    expect(out[0].content).toBe("raw text");
  });

  it("keeps file order and supports multiple files", () => {
    const out = messagesWithFiles(prompt, [
      { filename: "a.js", content: "AAA" },
      { filename: "b.js", content: "BBB" },
    ]);
    expect(out.map((m) => m.content)).toEqual([
      "File: a.js\n\nAAA",
      "File: b.js\n\nBBB",
      "What does getKey() return?",
    ]);
  });

  it("skips empty or malformed file entries", () => {
    const out = messagesWithFiles(prompt, [{ content: "" }, null, { filename: "x" }, 42]);
    expect(out).toBe(prompt); // nothing usable -> unchanged reference
  });
});

describe("extractFileBlocks", () => {
  it("pulls file blocks out of content arrays and leaves text", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "analyze this" },
          { type: "file", filename: "app.py", content: "print('hi')" },
        ],
      },
    ];
    const { files, cleanedMessages } = extractFileBlocks(messages);
    expect(files).toEqual([{ filename: "app.py", content: "print('hi')" }]);
    expect(cleanedMessages[0].content).toEqual([{ type: "text", text: "analyze this" }]);
  });

  it("leaves string-content and file-free messages untouched", () => {
    const messages = [{ role: "user", content: "hello" }];
    const { files, cleanedMessages } = extractFileBlocks(messages);
    expect(files).toEqual([]);
    expect(cleanedMessages[0]).toBe(messages[0]);
  });
});

describe("partitionFiles", () => {
  it("routes base64/binary files to binaryFiles and text to textFiles", async () => {
    const { partitionFiles } = await import("../utils/files.util.js");
    const { textFiles, binaryFiles } = partitionFiles([
      { filename: "a.js", content: "const x=1;" },
      { filename: "a.zip", mime_type: "application/zip", encoding: "base64", content: "UEsD" },
      { filename: "doc.pdf", mime_type: "application/pdf", content: "JVBER" },
      { filename: "notes.md", mime_type: "text/markdown", content: "# hi" },
    ]);
    expect(textFiles.map((f) => f.filename)).toEqual(["a.js", "notes.md"]);
    expect(binaryFiles.map((f) => f.filename)).toEqual(["a.zip", "doc.pdf"]);
    expect(binaryFiles[0]).toMatchObject({ mime_type: "application/zip", base64: "UEsD" });
  });

  it("skips empty entries", async () => {
    const { partitionFiles } = await import("../utils/files.util.js");
    const { textFiles, binaryFiles } = partitionFiles([{ content: "" }, null]);
    expect(textFiles).toEqual([]);
    expect(binaryFiles).toEqual([]);
  });
});
