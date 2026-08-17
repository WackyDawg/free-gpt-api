import { describe, it, expect, vi } from "vitest";
import { BigPasteCache, offloadLargeMessages } from "../utils/bigpaste.util.js";

function textMessage(text, id = "msg_1") {
  return { id, content: { content_type: "text", parts: [text] }, metadata: {} };
}

describe("BigPasteCache", () => {
  it("returns null for text it has never seen", () => {
    const cache = new BigPasteCache();
    expect(cache.get("hello")).toBeNull();
  });

  it("returns the attachment stored for identical text", () => {
    const cache = new BigPasteCache();
    const attachment = { id: "file_1" };
    cache.set("hello", attachment);
    expect(cache.get("hello")).toBe(attachment);
  });

  it("evicts the oldest entry once maxEntries is exceeded", () => {
    const cache = new BigPasteCache(2);
    cache.set("a", { id: "1" });
    cache.set("b", { id: "2" });
    cache.set("c", { id: "3" });
    expect(cache.get("a")).toBeNull();
    expect(cache.get("b")).not.toBeNull();
    expect(cache.get("c")).not.toBeNull();
  });
});

describe("offloadLargeMessages", () => {
  it("leaves a message under the threshold untouched and never uploads", async () => {
    const upload = vi.fn();
    const body = { messages: [textMessage("short")] };

    const out = await offloadLargeMessages(body, upload, { thresholdBytes: 4096 });

    expect(upload).not.toHaveBeenCalled();
    expect(out.messages[0].content.parts).toEqual(["short"]);
    expect(out.messages[0].metadata.attachments).toBeUndefined();
  });

  it("offloads a message whose text meets or exceeds the threshold", async () => {
    const big = "x".repeat(100);
    const attachment = { id: "file_1", size: 100, name: "Pasted text.txt" };
    const upload = vi.fn().mockResolvedValue(attachment);
    const body = { messages: [textMessage(big)] };

    const out = await offloadLargeMessages(body, upload, { thresholdBytes: 50 });

    // upload receives (text, messageId) so the finalize can bind the file to
    // the message that carries the attachment.
    expect(upload).toHaveBeenCalledWith(big, "msg_1");
    expect(out.messages[0].content.parts).toEqual([""]);
    expect(out.messages[0].metadata.attachments).toEqual([attachment]);
  });

  it("leaves the message inline when the upload fails", async () => {
    const big = "x".repeat(100);
    const upload = vi.fn().mockResolvedValue(null);
    const body = { messages: [textMessage(big)] };

    const out = await offloadLargeMessages(body, upload, { thresholdBytes: 50 });

    expect(upload).toHaveBeenCalledOnce();
    expect(out.messages[0].content.parts).toEqual([big]);
    expect(out.messages[0].metadata.attachments).toBeUndefined();
  });

  it("reuses a cached attachment for identical text instead of re-uploading", async () => {
    const big = "x".repeat(100);
    const attachment = { id: "file_1" };
    const upload = vi.fn().mockResolvedValue(attachment);
    const cache = new BigPasteCache();

    await offloadLargeMessages({ messages: [textMessage(big)] }, upload, {
      thresholdBytes: 50,
      cache,
    });
    const second = await offloadLargeMessages({ messages: [textMessage(big)] }, upload, {
      thresholdBytes: 50,
      cache,
    });

    expect(upload).toHaveBeenCalledOnce();
    expect(second.messages[0].metadata.attachments).toEqual([attachment]);
  });

  it("offloads only the messages that individually exceed the threshold", async () => {
    const big = "x".repeat(100);
    const attachment = { id: "file_1" };
    const upload = vi.fn().mockResolvedValue(attachment);
    const body = { messages: [textMessage(big), textMessage("short")] };

    const out = await offloadLargeMessages(body, upload, { thresholdBytes: 50 });

    expect(upload).toHaveBeenCalledOnce();
    expect(out.messages[0].content.parts).toEqual([""]);
    expect(out.messages[1].content.parts).toEqual(["short"]);
  });

  it("returns the body unchanged when it has no messages array", async () => {
    const upload = vi.fn();
    const body = {};

    const out = await offloadLargeMessages(body, upload);

    expect(out).toBe(body);
    expect(upload).not.toHaveBeenCalled();
  });
});
