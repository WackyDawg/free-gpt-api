/**
 * File-upload support for the chat surfaces.
 *
 * A request may carry a `files` array — `[{ filename?, content }]` — of file
 * contents to prompt against. Each file is turned into a leading user message
 * so it becomes conversation context ahead of the caller's actual prompt. Large
 * files then flow through the native big-paste upload path automatically (the
 * model reads them as an attachment); small ones travel inline. Either way the
 * model sees the file content and answers the prompt that follows.
 *
 * This keeps the file separate from the prompt, which is what makes "upload a
 * code file and ask about it" work: the prompt stays a real inline turn (it
 * governs), and the file is reference material the model reads.
 */

/** A single validated file entry, or null if unusable. */
function normalizeFile(file) {
  if (!file || typeof file !== "object") return null;
  const content = typeof file.content === "string" ? file.content : "";
  if (!content) return null;
  const filename = typeof file.filename === "string" && file.filename.trim() ? file.filename.trim() : null;
  return { filename, content };
}

/**
 * Prepends one user message per file to the message list. The caller's messages
 * (the prompt) follow, so the model reads the files first.
 *
 * @param {object[]} messages  the caller's messages
 * @param {Array} files        request `files` array
 * @returns {object[]}
 */
export function messagesWithFiles(messages, files) {
  if (!Array.isArray(files) || files.length === 0) return messages;

  const fileMessages = files
    .map(normalizeFile)
    .filter(Boolean)
    .map(({ filename, content }) => ({
      role: "user",
      content: filename ? `File: ${filename}\n\n${content}` : content,
    }));

  return fileMessages.length ? [...fileMessages, ...(messages || [])] : messages;
}

/**
 * Splits a `files` array into text files (delivered as inline / big-paste
 * message content) and binary files (delivered as native file-input uploads).
 *
 * A file is binary when it declares `encoding: "base64"`, or its `mime_type`
 * is not text-ish. Binary entries carry `{ filename, mime_type, base64 }`;
 * text entries carry `{ filename, content }`.
 *
 * @param {Array} files
 * @returns {{ textFiles: object[], binaryFiles: object[] }}
 */
export function partitionFiles(files) {
  const textFiles = [];
  const binaryFiles = [];
  for (const file of Array.isArray(files) ? files : []) {
    if (!file || typeof file.content !== "string" || !file.content) continue;
    const mime = typeof file.mime_type === "string" ? file.mime_type : "";
    const isTextMime = !mime || /^text\//i.test(mime) || /(json|xml|javascript|csv|markdown|yaml|x-sh)/i.test(mime);
    if (file.encoding === "base64" || !isTextMime) {
      binaryFiles.push({
        filename: typeof file.filename === "string" && file.filename.trim() ? file.filename.trim() : "file",
        mime_type: mime || "application/octet-stream",
        base64: file.content,
      });
    } else {
      textFiles.push({ filename: file.filename, content: file.content });
    }
  }
  return { textFiles, binaryFiles };
}

/**
 * Extracts `files` from Anthropic-style content blocks: a content array may
 * carry `{ type: "file", filename?, content }` blocks alongside text. Returns
 * `{ files, cleanedMessages }` with the file blocks removed from the text.
 */
export function extractFileBlocks(messages) {
  const files = [];
  const cleaned = (messages || []).map((message) => {
    if (!Array.isArray(message?.content)) return message;
    const kept = [];
    for (const block of message.content) {
      if (block?.type === "file" && typeof block.content === "string") {
        files.push({ filename: block.filename, content: block.content });
      } else {
        kept.push(block);
      }
    }
    return { ...message, content: kept };
  });
  return { files, cleanedMessages: cleaned };
}
