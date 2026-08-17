/**
 * Big-paste file offload for oversized prompts.
 *
 * ChatGPT rejects a conversation body whose inline text is very large, but the
 * UI's "big paste" feature sidesteps that: long pasted text is uploaded as a
 * text/plain file and referenced from the message's `metadata.attachments`,
 * with `content.parts` left empty. The model treats the attachment as the
 * pasted message content.
 *
 * Everything here runs inside the page via page.evaluate(), so the browser's
 * own session authenticates every call — no token, cookie, or sentinel value is
 * ever read, logged, or handled by this process. Observed request shapes come
 * from the authenticated UI; nothing here is a credential.
 *
 * The upload handshake response shapes are not fully documented, so the in-page
 * routine returns the raw create/finalize JSON alongside the resolved file id;
 * callers should log those once and tighten field access if the API differs.
 */

import { createHash } from "crypto";

const CREATE_ENDPOINT = "/backend-api/files";

/**
 * Per-worker cache of uploaded prompts: content hash -> attachment descriptor.
 * A stable system prompt (opencode's, Claude Code's) uploads once and is then
 * re-attached on every turn for free. Bounded so a long-lived process cannot
 * grow it without limit; distinct prompts are rare, so a small cap is plenty.
 */
export class BigPasteCache {
  constructor(maxEntries = 16) {
    this.maxEntries = maxEntries;
    this._byHash = new Map();
  }

  static hash(text) {
    return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 32);
  }

  get(text) {
    return this._byHash.get(BigPasteCache.hash(text)) || null;
  }

  set(text, attachment) {
    const key = BigPasteCache.hash(text);
    if (!this._byHash.has(key) && this._byHash.size >= this.maxEntries) {
      // drop oldest
      this._byHash.delete(this._byHash.keys().next().value);
    }
    this._byHash.set(key, attachment);
    return attachment;
  }
}

/**
 * Uploads `text` as a big-paste .txt and returns an attachment descriptor
 * ready to drop into a conversation message's metadata.attachments.
 *
 * @param {import('puppeteer').Page} page
 * @param {string} text
 * @param {{ fileName?: string }} [opts]
 * @returns {Promise<{ id: string, size: number, name: string, source: "local",
 *   non_library_my_files_injest_upload: true, is_big_paste: true } | null>}
 */
export async function uploadBigPaste(page, text, opts = {}) {
  const fileName = opts.fileName || "Pasted text.txt";

  const result = await page.evaluate(
    async (content, name, createEndpoint) => {
      const bytes = new TextEncoder().encode(content);

      const post = (url, body) =>
        fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }).then((r) => r.json());

      // 1. Register the upload. Mirrors the UI's generated_big_paste request.
      const created = await post(createEndpoint, {
        file_name: name,
        file_size: bytes.length,
        use_case: "my_files",
        timezone_offset_min: new Date().getTimezoneOffset(),
        reset_rate_limits: false,
        supports_direct_azure_multipart: true,
        mime_type: "text/plain",
        entry_surface: "chat_composer",
        selection_method: "generated_big_paste",
        client_resolved_mime_type: "text/plain",
        mime_resolution_source: "filename_extension",
        store_in_library: true,
        library_persistence_mode: "opportunistic",
      });

      const fileId = created.file_id || created.id;
      const uploadUrl = created.upload_url || created.upload_url_v2 || created.url;
      if (!fileId || !uploadUrl) {
        return { error: "unexpected create response", created };
      }

      // 2. PUT the bytes to blob storage. The SAS URL carries its own auth, so
      // this cross-origin request needs no cookies.
      const put = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "x-ms-blob-type": "BlockBlob", "content-type": "text/plain" },
        body: bytes,
      });

      // 3. Finalize.
      let finalize = null;
      try {
        finalize = await post(`${createEndpoint}/${fileId}/uploaded`, {});
      } catch (e) {
        finalize = { error: String(e) };
      }

      return {
        fileId,
        size: bytes.length,
        putStatus: put.status,
        created,
        finalize,
      };
    },
    text,
    fileName,
    CREATE_ENDPOINT,
  );

  if (!result || result.error || !result.fileId) {
    return null;
  }

  return {
    id: result.fileId,
    size: result.size,
    name: fileName,
    source: "local",
    non_library_my_files_injest_upload: true,
    is_big_paste: true,
  };
}

/**
 * Rewrites a conversation body so an oversized user turn is delivered as a
 * big-paste attachment instead of inline text. Returns the body unchanged when
 * nothing exceeds the threshold.
 *
 * @param {object} body               parsed conversation request body
 * @param {(text: string) => Promise<object|null>} upload  uploadBigPaste bound to the page
 * @param {object} [opts]
 * @param {number} [opts.thresholdBytes]
 * @param {BigPasteCache} [opts.cache]   reuse file ids for repeated prompts
 */
export async function offloadLargeMessages(body, upload, opts = {}) {
  const thresholdBytes = opts.thresholdBytes ?? 40_000;
  const cache = opts.cache;
  if (!Array.isArray(body?.messages)) return body;

  for (const message of body.messages) {
    const parts = message?.content?.parts;
    const text = Array.isArray(parts) ? parts.join("") : "";
    if (Buffer.byteLength(text, "utf8") < thresholdBytes) continue;

    // Reuse a prior upload of the identical prompt when we can.
    let attachment = cache?.get(text) || null;
    if (!attachment) {
      attachment = await upload(text);
      if (attachment && cache) cache.set(text, attachment);
    }
    if (!attachment) continue; // upload failed; leave the message inline

    message.content.parts = [""];
    message.metadata = message.metadata || {};
    message.metadata.attachments = [...(message.metadata.attachments || []), attachment];
  }
  return body;
}
