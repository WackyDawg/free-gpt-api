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
  // Authenticated headers captured from a real page request (Bearer + oai-*).
  // The create's ingest-vs-library routing keys off the Bearer, so a
  // cookie-only fetch lands on the wrong (library) storage service.
  const authHeaders = opts.headers || {};

  const result = await page.evaluate(
    async (content, name, createEndpoint, auth) => {
      const bytes = new TextEncoder().encode(content);
      // Same-origin JSON POST carrying the captured auth headers, but stripped
      // to clean auth: request-scoped sentinel/conduit/turnstile tokens are
      // bound to the conversation call and appear to interfere with the file
      // API's user-biscuit derivation.
      const authJson = { ...auth, "content-type": "application/json" };
      for (const k of Object.keys(authJson)) {
        const keep =
          k === "authorization" ||
          k === "cookie" ||
          k === "content-type" ||
          k.startsWith("oai-");
        if (!keep) delete authJson[k];
      }

      const post = (url, body) =>
        fetch(url, {
          method: "POST",
          headers: authJson,
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
        // false routes to the non-library ingest service (file_0000… ids on the
        // sdmntpr… host), which is the file type a conversation attachment can
        // read. true routes to the library service (file-… ids) that the
        // conversation cannot resolve — the root of the "file not available" bug.
        store_in_library: false,
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
        headers: {
          "x-ms-blob-type": "BlockBlob",
          "x-ms-version": "2020-04-08",
          "content-type": "text/plain",
        },
        body: bytes,
      });

      // 3. Finalize via the real endpoint (observed from the UI's big-paste
      // flow): process_upload_stream. It returns a STREAM, so read it as text
      // and surface the tail — the processed file only becomes usable once this
      // stream completes.
      let finalize = null;
      try {
        const res = await fetch("/backend-api/files/process_upload_stream", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            file_id: fileId,
            use_case: "my_files",
            index_for_retrieval: true,
            file_name: name,
            entry_surface: "chat_composer",
            // Matches the real big-paste finalize exactly: no library_file_info
            // / origination — an is_temporary_chat ingest file is referenced
            // directly by the attachment, with no conversation binding.
            metadata: {
              store_in_library: false,
              is_temporary_chat: true,
              library_eligibility_reason: "eligible",
              is_project_thread: false,
            },
          }),
        });
        const text = await res.text();
        finalize = { status: res.status, ready: text.includes("file_ready"), tail: text.slice(-160) };
      } catch (e) {
        finalize = { error: String(e) };
      }

      return {
        fileId,
        size: bytes.length,
        putStatus: put.status,
        finalize,
      };
    },
    text,
    fileName,
    CREATE_ENDPOINT,
    authHeaders,
  );

  // Structural probe of the handshake (no secrets) so the real create/finalize
  // shapes can be confirmed from logs and the field access tightened.
  try {
    console.log(
      "===> [bigpaste] " +
        JSON.stringify({
          error: result?.error,
          fileId: result?.fileId,
          putStatus: result?.putStatus,
          finalizeKeys: result?.finalize ? Object.keys(result.finalize) : null,
          finalize: result?.finalize,
        }).slice(0, 1400),
    );
  } catch {}

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
      attachment = await upload(text, message.id);
      if (attachment && cache) cache.set(text, attachment);
    }
    if (!attachment) continue; // upload failed; leave the message inline

    message.content.parts = [""];
    message.metadata = message.metadata || {};
    message.metadata.attachments = [...(message.metadata.attachments || []), attachment];
  }
  return body;
}
