import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";
import { connect } from "puppeteer-real-browser";
import dotenv from "dotenv";
import chalk from "chalk";
import { config } from "../config/config.js";
import { parseTurnStream } from "./sse-delta.util.js";
import { TurnStreamTap } from "./turn-stream.util.js";
import { normalizeReply } from "./normalize.util.js";
import { toUpstreamMessage, buildWireMessages } from "./tools.util.js";
import { BigPasteCache, offloadLargeMessages, uploadBigPaste } from "./bigpaste.util.js";
dotenv.config({ path: "../../.env" });

const normalize = (text) =>
  normalizeReply(text, {
    flatten: config.flattenOutput,
    stripMarkdown: config.stripMarkdown,
  });

export class ChatGPTClient {
  /**
   * @param {{ browser?: import('puppeteer').Browser, label?: string }} options
   *   Pass an existing browser to run this client as an extra tab inside it.
   */
  constructor(options = {}) {
    this.browser = options.browser || null;
    this._sharedBrowser = Boolean(options.browser);
    this.label = options.label || "client";
    this.page = null;
    this._queue = Promise.resolve();
    this._captureNextHeaders = null;
    this._nativeRequestOptions = null;
    this._nativeUploadWaiter = null;
    this._initPromise = null;
    this.tap = null;
    this.busy = false;
    // Per-worker: a stable, repeated block (this client's own system prompt,
    // most often) uploads once and is re-attached on every subsequent turn.
    this._bigPasteCache = new BigPasteCache();
  }

  _setupInterceptor() {
    this.page.on("response", (response) => {
      if (!/\/backend-api\/files\/process_upload_stream(?:\?|$)/.test(response.url())) {
        return;
      }
      const waiter = this._nativeUploadWaiter;
      if (!waiter) return;
      this._nativeUploadWaiter = null;
      void response.text().then(
        (body) => {
          if (
            response.status() >= 200 &&
            response.status() < 300 &&
            body.includes("file.processing.completed")
          ) {
            waiter.resolve();
          }
          else waiter.reject(new Error(`native big-paste upload failed: ${response.status()}`));
        },
        () => waiter.reject(new Error("native big-paste upload response could not be read")),
      );
    });

    this.page.on("request", async (req) => {
      const type = req.resourceType();
      const url = req.url();

      if (["stylesheet", "image", "font", "media"].includes(type)) {
        req.abort();
        return;
      }

      if (/\/backend-api\/f\/conversation(?:\?|$)/.test(url) && this._captureNextHeaders) {
        const resolveHeaders = this._captureNextHeaders;
        this._captureNextHeaders = null;
        if (this._nativeRequestOptions) {
          const options = this._nativeRequestOptions;
          this._nativeRequestOptions = null;
          let postData = req.postData();
          try {
            const body = JSON.parse(postData || "{}");
            body.model = options.modelSlug;
            // Upstream rejects the whole body when a model with no reasoning
            // mode carries an effort setting, so never let one through.
            if (options.thinkingEffort) body.thinking_effort = options.thinkingEffort;
            else delete body.thinking_effort;

            // The page must stay the sender (only then does its client
            // subscribe to the thinking model's WebSocket topic), so the
            // structured payload is swapped into its own request here.
            if (options.wireMessages?.length) {
              const template = Array.isArray(body.messages) ? body.messages[0] : null;
              const templateMetadata = { ...(template?.metadata || {}) };
              delete templateMetadata.attachments;
              const built = options.wireMessages.map((m) => ({
                ...(template || {}),
                id: m.id,
                author: { role: m.role },
                content: { content_type: "text", parts: [m.text] },
                metadata: { ...templateMetadata },
              }));
              if (options.nativeBigPaste) {
                const nativeAttachments = (body.messages || []).flatMap((message) =>
                  message?.metadata?.attachments || [],
                );
                if (!nativeAttachments.length) {
                  throw new Error("ChatGPT did not create a native attachment");
                }
                // A large text paste has its own oversized message to empty out;
                // a binary file upload has none, so its attachments ride the last
                // user message while its prompt text stays inline.
                const largeIndex = built.findLastIndex(
                  (message) => Buffer.byteLength(message.content?.parts?.join("") || "", "utf8") >= 40_000,
                );
                const targetIndex = largeIndex >= 0 ? largeIndex : built.length - 1;
                if (largeIndex >= 0) built[targetIndex].content.parts = [""];
                built[targetIndex].metadata.attachments = nativeAttachments;
                body.messages = built;
              } else {
                // A turn's structured payload can carry the same oversized tool
                // results / handler bodies that would make ChatGPT reject an
                // inline conversation body; offload anything over threshold to
                // a big-paste attachment before it goes out.
                body.messages = (
                  await offloadLargeMessages(
                    { messages: built },
                    (text) => uploadBigPaste(this.page, text),
                    { cache: this._bigPasteCache },
                  )
                ).messages;
              }
            }
            postData = JSON.stringify(body);
          } catch (err) {
            console.warn(
              chalk.yellowBright("===> ") +
                `[intercept:${this.label}] could not rewrite request body: ${err.message}`,
            );
          }
          resolveHeaders({ ...req.headers() });
          req.continue({ postData });
          return;
        }
        resolveHeaders({ ...req.headers() });
        // Fulfilled, not aborted: _doChat replays the real request, and an
        // abort would make the app retry on its own, stealing the header
        // capture the next request is waiting for.
        req.respond({
          status: 200,
          contentType: "text/event-stream; charset=utf-8",
          body: 'event: delta_encoding\ndata: "v1"\n\ndata: [DONE]\n\n',
        });
        return;
      }

      req.continue();
    });
  }

  /** Cookie load, interception, socket tap and first navigation. */
  async _preparePage(page) {
    const tag = `[init:${this.label}]`;

    // Reuse the user's authenticated ChatGPT session. Cookies are read locally
    // only; they are never logged or sent to any other host.
    const cookiesPath = path.resolve(config.chatgptCookiesPath);
    if (fs.existsSync(cookiesPath)) {
      const cookies = JSON.parse(fs.readFileSync(cookiesPath, "utf8"));
      if (!Array.isArray(cookies)) {
        throw new Error("CHATGPT_COOKIES_PATH must contain a JSON cookie array");
      }
      await page.setCookie(
        ...cookies
          .filter((cookie) => cookie && cookie.name && cookie.value)
          .map(({ name, value, domain, path: cookiePath, expires, httpOnly, secure, sameSite }) => ({
            name,
            value,
            domain: domain || ".chatgpt.com",
            path: cookiePath || "/",
            ...(Number.isFinite(expires) && expires > 0 ? { expires } : {}),
            ...(typeof httpOnly === "boolean" ? { httpOnly } : {}),
            ...(typeof secure === "boolean" ? { secure } : {}),
            ...(sameSite ? { sameSite } : {}),
          })),
      );
      console.log(chalk.greenBright("===> ") + `${tag} loaded local ChatGPT cookies`);
    } else {
      console.warn(chalk.yellowBright("===> ") + `${tag} cookie file not found: ${cookiesPath}`);
    }

    await page.setViewport({ width: 1920, height: 1080 });
    await page.setRequestInterception(true);
    this._setupInterceptor();

    this.tap = new TurnStreamTap(page, { debug: config.debug });
    await this.tap.attach();

    await page.goto("https://chatgpt.com/?temporary-chat=true", {
      waitUntil: "domcontentloaded",
      timeout: 90000,
    });
    await page.bringToFront();
    await page.evaluate(() => window.focus()).catch(() => {});

    console.log(
      chalk.blueBright("===> ") +
        `${tag} waiting for #prompt-textarea (this may take a minute if Cloudflare check is active)...`,
    );

    await page.waitForSelector("#prompt-textarea", { timeout: 0 });
    await new Promise((r) => setTimeout(r, 2000));
    console.log(chalk.greenBright("===> ") + `${tag} ready`);
  }

  async init() {
    if (this._initPromise) return this._initPromise;
    this._initPromise = (async () => {
      // CHROME_PATH is what the container images set; the bundled Application/
      // directory is the local Windows fallback. Undefined lets
      // puppeteer-real-browser find an installed Chrome itself.
      const bundledChrome = path.join(path.resolve(), "Application", "chrome.exe");
      const executablePath =
        process.env.CHROME_PATH ||
        process.env.PUPPETEER_EXECUTABLE_PATH ||
        (fs.existsSync(bundledChrome) ? bundledChrome : undefined);

      if (this._sharedBrowser) {
        this.page = await this.browser.newPage();
        await this._preparePage(this.page);
        return;
      }

      const { browser, page } = await connect({
        headless: process.env.HEADLESS === "true",
        defaultViewport: null,
        executablePath,
        fingerprint: true,
        turnstile: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--ignore-certificate-errors",
          "--ignore-certificate-errors-spki-list",
          "--disable-gpu",
          "--disable-infobars",
          "--window-position=0,0",
          "--start-maximized",
          "--ignore-certifcate-errors",
          "--ignore-certifcate-errors-spki-list",
          "--disable-speech-api",
          "--disable-backgrounding-occluded-windows",
          "--disable-breakpad",
          "--disable-client-side-phishing-detection",
          "--disable-component-update",
          "--disable-default-apps",
          "--disable-dev-shm-usage",
          "--disable-domain-reliability",
          "--disable-extensions",
          "--disable-features=AudioServiceOutOfProcess",
          "--disable-hang-monitor",
          "--disable-ipc-flooding-protection",
          "--disable-notifications",
          "--disable-offer-store-unmasked-wallet-cards",
          "--disable-popup-blocking",
          "--disable-print-preview",
          "--disable-prompt-on-repost",
          "--disable-renderer-backgrounding",
          "--disable-setuid-sandbox",
          "--disable-sync",
          "--hide-scrollbars",
          "--ignore-gpu-blacklist",
          "--metrics-recording-only",
          "--mute-audio",
          "--no-default-browser-check",
          "--no-first-run",
          "--no-pings",
          "--no-sandbox",
          "--no-zygote",
          "--password-store=basic",
          "--use-gl=swiftshader",
          "--use-mock-keychain",
          "--incognito",
        ],
      });

      this.browser = browser;
      this.page = page;
      await this._preparePage(page);
    })();

    try {
      await this._initPromise;
    } catch (err) {
      console.error(chalk.redBright("===> ") + `[init:${this.label}] error:`, err.message);
      this._initPromise = null;
      if (this._sharedBrowser) {
        // Only the tab is ours to discard; the browser belongs to the pool.
        await this.page?.close().catch(() => {});
        this.page = null;
      } else if (this.browser) {
        await this.browser.close();
        this.browser = null;
        this.page = null;
      }
      throw err;
    }
  }

  /**
   * Puts text into the composer. keyboard.type() is per-character and far too
   * slow for an agent transcript, so insert in one shot via execCommand and
   * fall back to typing only if that is rejected.
   */
  async _insertPrompt(text) {
    const inserted = await this.page.evaluate((value) => {
      const el = document.querySelector("#prompt-textarea");
      if (!el) return false;
      el.focus();
      const ok = document.execCommand("insertText", false, value);
      return ok && (el.innerText || el.value || "").length > 0;
    }, text);

    if (!inserted) {
      await this.page.keyboard.type(text, { delay: 0 });
    }
  }

  /**
   * Waits until the composer actually reflects the inserted text, up to a small
   * budget. Replaces a fixed pre-Enter sleep: returns the instant the editor is
   * non-empty, so a fast page proceeds immediately and a slow one still waits.
   */
  async _awaitComposerReady(text, { budgetMs = 400, stepMs = 25 } = {}) {
    const wanted = (text || "").trim().slice(0, 24);
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      const ready = await this.page
        .$eval("#prompt-textarea", (el) => (el.innerText || el.value || "").trim().length > 0)
        .catch(() => false);
      if (ready) return;
      await new Promise((r) => setTimeout(r, stepMs));
    }
  }

  async _pastePrompt(text) {
    const clipboardReady = await this.page.evaluate(async (value) => {
      try {
        await navigator.clipboard.writeText(value);
        return true;
      } catch {
        return false;
      }
    }, text);
    if (clipboardReady) {
      await this.page.focus("#prompt-textarea");
      await this.page.keyboard.down("Control");
      await this.page.keyboard.press("v");
      await this.page.keyboard.up("Control");
      return;
    }

    const pasted = await this.page.evaluate((value) => {
      const el = document.querySelector("#prompt-textarea");
      if (!el) return false;
      el.focus();
      const data = new DataTransfer();
      data.setData("text/plain", value);
      el.dispatchEvent(new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      }));
      return true;
    }, text);
    if (!pasted) throw new Error("prompt textarea not found");
  }

  /**
   * Attaches binary files (zip, pdf, images, …) by setting them on the
   * composer's hidden file input and dispatching the events the app listens
   * for. ChatGPT then runs its OWN authenticated upload (ace_upload) — the same
   * biscuit-attached path the paste trick uses for text, so we never handle the
   * upload token ourselves. Each file is decoded from base64 inside the page.
   *
   * @param {{ filename: string, mime_type: string, base64: string }[]} files
   */
  async _attachFiles(files) {
    for (const file of files) {
      const uploaded = this._waitForNativeUpload();
      const ok = await this.page.evaluate(
        (name, mime, b64) => {
          const input = document.querySelector('input[type="file"]');
          if (!input) return false;
          const binary = atob(b64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
          const f = new File([bytes], name, { type: mime || "application/octet-stream" });
          const dt = new DataTransfer();
          dt.items.add(f);
          input.files = dt.files;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        },
        file.filename,
        file.mime_type,
        file.base64,
      );
      if (!ok) throw new Error("composer file input not found");
      await uploaded; // wait for ChatGPT's native upload to finish processing
    }
  }

  async _waitForNativeUpload() {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._nativeUploadWaiter = null;
        reject(new Error("native big-paste upload timeout"));
      }, 120_000);
      this._nativeUploadWaiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
    });
  }

  async _doChat(
    messages,
    mode = "default",
    modelSlug = "auto",
    thinkingEffort,
    options = {},
  ) {
    const page = this.page;
    const attachFiles = Array.isArray(options.attachFiles) ? options.attachFiles : [];

    const messageList = Array.isArray(messages)
      ? messages
      : [{ role: "user", content: messages }];

    const lastUserMessage =
      [...messageList].reverse().find((m) => m.role === "user")?.content ||
      messageList[messageList.length - 1].content;

    // A thinking model returns an empty SSE body and streams its answer over
    // the page's WebSocket, but only for a request the page issued itself — so
    // it is sent by the page with the body rewritten by the interceptor.
    // Everything else goes out as a direct fetch that carries the answer.
    const useNativeRequest = modelSlug === "gpt-5-6-thinking";

    // Both paths carry the structured list in the body, so the composer text is
    // only a trigger to harvest fresh headers — the real payload is swapped in
    // (interceptor) or sent by a separate fetch. A large message typed into the
    // composer makes ChatGPT's UI auto-convert it to its own attachment, so the
    // expected /backend-api/f/conversation POST never fires and header capture
    // times out. Keep the real question for small messages (a failed rewrite
    // then still degrades sensibly); use a tiny trigger for large ones.
    const wireMessages = messageList
      .map((m) => ({ ...toUpstreamMessage(m), id: randomUUID() }))
      .filter((m) => m.text);

    const largePrompt = [...wireMessages]
      .reverse()
      .find((message) => Buffer.byteLength(message.text || "", "utf8") >= 40_000)?.text;
    // The native path (page issues the request so its own upload biscuit is
    // attached) is needed for a large text paste OR any binary file upload.
    // Applies to thinking models too: they already send natively, so file
    // attachment and the interceptor's harvest work the same way.
    const nativeBigPaste = Boolean(largePrompt) || attachFiles.length > 0;
    const TRIGGER_MAX = 2000;
    const submissionText = largePrompt
      ? largePrompt
      : typeof lastUserMessage === "string" && lastUserMessage.length <= TRIGGER_MAX
        ? lastUserMessage
        : "continue";

    // Last line of defence: a rejected turn leaves the tab unable to serve the
    // next request, and callers can still let a stray effort value through.
    const effort = /thinking/i.test(modelSlug) ? thinkingEffort : undefined;

    // Timing breakdown: how much of a request is the keystroke/UI trigger
    // versus the model itself. `_t0` is set here; segment marks log below.
    const _t0 = Date.now();
    const _since = () => Date.now() - _t0;

    await page.focus("#prompt-textarea");
    await page.keyboard.down("Control");
    await page.keyboard.press("a");
    await page.keyboard.up("Control");
    await page.keyboard.press("Backspace");
    const _tClear = _since();

    if (useNativeRequest || nativeBigPaste) {
      this._nativeRequestOptions = {
        modelSlug,
        thinkingEffort: effort,
        wireMessages,
        nativeBigPaste,
      };
    }
    const nativeAssistantSelector = '[data-message-author-role="assistant"]';
    const nativeInitialCount =
      useNativeRequest || nativeBigPaste
        ? await page.$$eval(nativeAssistantSelector, (nodes) => nodes.length)
        : 0;

    // Snapshot known turns before submitting so this request's turn can be
    // attributed. Needed on both paths — a thinking model can leave the SSE
    // body empty and deliver over the WebSocket instead.
    this.tap?.mark();

    if (nativeBigPaste) {
      // Attach binary files first (each triggers the app's own upload), then
      // paste a large text prompt (also a native upload) or just type a small
      // prompt as the composer trigger.
      if (attachFiles.length) await this._attachFiles(attachFiles);
      if (largePrompt) {
        const nativeUpload = this._waitForNativeUpload();
        await this._pastePrompt(submissionText);
        await nativeUpload;
      } else {
        await this._insertPrompt(submissionText);
      }
    } else {
      await this._insertPrompt(submissionText);
    }
    const _tInsert = _since();

    // Arm header capture only now — after any file upload, which can take
    // minutes for a large binary. Arming it earlier lets the 15s timer expire
    // during the upload, before the conversation request that needs the headers
    // is ever sent.
    let headerTimer;
    const headersPromise = new Promise((resolve, reject) => {
      this._captureNextHeaders = (h) => {
        clearTimeout(headerTimer);
        resolve(h);
      };
      headerTimer = setTimeout(() => {
        this._captureNextHeaders = null;
        reject(new Error("header intercept timeout"));
      }, 15000);
    });
    // Safety net: keep the timeout rejection handled so a throw before we await
    // it cannot crash the process; the real value is consumed below.
    headersPromise.catch(() => {});

    // Give React one frame to register the inserted text before Enter submits,
    // rather than a fixed 300ms. If the composer still shows text we proceed
    // immediately; the short poll replaces a blind sleep.
    await this._awaitComposerReady(submissionText);
    await page.keyboard.press("Enter");
    const _tSubmit = _since();

    let headers = await headersPromise;
    const _tHeaders = _since();
    if (config.debug) {
      console.log(
        chalk.magentaBright("===> ") +
          `[timing:${this.label}] clear=${_tClear}ms insert=${_tInsert}ms ` +
          `submit=${_tSubmit}ms trigger=${_tHeaders}ms (request fired)`,
      );
    }

    if (useNativeRequest || nativeBigPaste) {
      // The page issued the real request itself (thinking model, or a native
      // big-paste whose attachment carries the app-minted biscuit). We must NOT
      // fire a second manual fetch \u2014 it would reuse the spent sentinel token and
      // 403. Read the answer the page's own request produces: off the WebSocket
      // for a thinking model, otherwise from the rendered DOM.
      let turn = null;
      if (useNativeRequest) {
        // Stream reasoning + answer deltas as they arrive over the WebSocket,
        // so a client can watch a thinking model work instead of waiting for
        // the whole turn. Deltas are the raw appended text since the last item.
        const onDelta = typeof options.onDelta === "function" ? options.onDelta : null;
        let lastReasoning = "";
        let lastAnswer = "";
        const onUpdate = onDelta
          ? (snap) => {
              const r = snap.reasoning || "";
              const a = snap.text || "";
              const emitAppend = (type, next, previous, setPrevious) => {
                if (!next || next.length <= previous.length) return;
                const delta = next.startsWith(previous)
                  ? next.slice(previous.length)
                  : next;
                if (delta) onDelta({ type, delta });
                setPrevious(next);
              };
              emitAppend("reasoning", r, lastReasoning, (value) => {
                lastReasoning = value;
              });
              emitAppend("answer", a, lastAnswer, (value) => {
                lastAnswer = value;
              });
            }
          : null;
        try {
          // Deep reasoning over a large uploaded file (e.g. a whole plugin
          // audit) can run many minutes with long gaps between stream items.
          turn = await this.tap.waitForTurn({ timeoutMs: 600000, idleTimeoutMs: 240000, onUpdate });
          console.log(
            chalk.cyanBright("===> ") +
              `[stream] ${turn.itemCount} items encoding=${turn.encoding} len=${turn.text.length}`,
          );
        } catch (err) {
          console.warn(
            chalk.yellowBright("===> ") + "[stream] " + err.message + " \u2014 falling back to DOM",
          );
        }
      }

      if (turn?.text) return normalize(turn.text);

      // Fallback: read the rendered message. Racy — the DOM lags the stream.
      await page.waitForFunction(
        ({ selector, count }) => document.querySelectorAll(selector).length > count,
        { timeout: 300000 },
        { selector: nativeAssistantSelector, count: nativeInitialCount },
      );
      // Stability loop: the DOM streams in and briefly shows a "Thinking…"
      // placeholder, so a single read races. Poll until the text settles.
      const startedAt = Date.now();
      let previousText = "";
      let stableReads = 0;
      let domText = "";
      while (Date.now() - startedAt < 480000) {
        domText = await page.$$eval(nativeAssistantSelector, (nodes) => {
          const node = nodes[nodes.length - 1];
          return (node?.innerText || node?.textContent || "").trim();
        });
        const placeholder = /^thinking(?:[.… ]*)$/i.test(domText);
        if (domText && !placeholder && domText === previousText) {
          if (++stableReads >= 2) break;
        } else {
          stableReads = 0;
        }
        previousText = domText;
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (!domText) throw new Error("empty_native_response");
      if (/^thinking(?:[.\u2026 ]*)$/i.test(domText)) {
        throw new Error("thinking_response_timeout");
      }
      return normalize(domText);
    }

    await page.focus("#prompt-textarea");
    await page.keyboard.down("Control");
    await page.keyboard.press("a");
    await page.keyboard.up("Control");
    await page.keyboard.press("Backspace");

    const systemHints =
      mode === "reasoning"
        ? ["reason"]
        : mode === "deep-research"
          ? ["connector:connector_openai_deep_research"]
          : mode === "tatertot"
            ? ["tatertot"]
            : mode === "quiz"
              ? ["connector:connector_openai_quizgpt_v2"]
              : [];

    // Built in Node context (not inside page.evaluate) so an oversized entry
    // — a large tool result, a big system prompt — can be offloaded to a
    // big-paste attachment before it ever crosses into the page; page.evaluate
    // cannot itself drive a nested page.evaluate for the upload.
    const builtMessages = buildWireMessages(wireMessages, { systemHints, mode });

    let offloadedMessages = builtMessages;
    if (!nativeBigPaste) {
      offloadedMessages = (
        await offloadLargeMessages(
          { messages: builtMessages },
          (text) => uploadBigPaste(page, text),
          { cache: this._bigPasteCache },
        )
      ).messages;
    }

    const result = await page.evaluate(
      async (p) => {
        const res = await fetch("/backend-api/f/conversation", {
          method: "POST",
          headers: {
            ...p.headers,
            accept: "text/event-stream",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            action: "next",
            messages: p.messages,
            parent_message_id: p.parentMessageId || p.parentId,
            model: p.modelSlug,
            ...(p.thinkingEffort
              ? { thinking_effort: p.thinkingEffort }
              : {}),
            timezone_offset_min: new Date().getTimezoneOffset(),
            suggestions: [],
            text: {
              format: {
                type: "text",
              },
            },
            reasoning: {},
            include: ["web_search_call.action.sources"],
            history_and_training_disabled: true,
            conversation_mode: { kind: "primary_assistant" },
            force_use_sse: true,
            system_hints: p.systemHints,
          }),
        });

        // Read the stream verbatim; parseTurnStream interprets it.
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let body = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          body += decoder.decode(value, { stream: true });
        }
        body += decoder.decode();

        localStorage.removeItem("perfStore:v1");
        return { status: res.status, body };
      },
      {
        headers,
        messages: offloadedMessages,
        parentId: randomUUID(),
        nativeBigPaste,
        systemHints,
        modelSlug,
        thinkingEffort: effort,
      },
    );

    if (result.status === 401 || result.status === 403) {
      throw new Error(`auth_expired:${result.status}`);
    }

    const parsed = parseTurnStream(result.body || "");
    const _tDone = _since();
    console.log(
      chalk.cyanBright("===> ") +
        `[chat] status=${result.status} encoding=${parsed.encoding} ` +
        `events=${parsed.events} len=${parsed.text.length}`,
    );
    if (config.debug) {
      console.log(
        chalk.magentaBright("===> ") +
          `[timing:${this.label}] trigger=${_tHeaders}ms response=${_tDone - _tHeaders}ms ` +
          `total=${_tDone}ms (${Math.round((_tHeaders / _tDone) * 100)}% trigger)`,
      );
    }

    if (parsed.text) return normalize(parsed.text);

    // Thinking models acknowledge the POST but deliver the turn over the
    // WebSocket, so an empty parse here is expected; read it off the tap.
    if (result.status === 200) {
      try {
        const turn = await this.tap.waitForTurn({ timeoutMs: 240000 });
        console.log(
          chalk.cyanBright("===> ") +
            `[chat] recovered over websocket: ${turn.itemCount} items len=${turn.text.length}`,
        );
        if (turn.text) return normalize(turn.text);
      } catch (err) {
        console.warn(
          chalk.yellowBright("===> ") + "[chat] websocket fallback: " + err.message,
        );
      }
    }

    {
      const body = result.body || "";
      // A non-SSE body is almost always a JSON error envelope; surfacing it
      // beats a bare "empty_response".
      try {
        const asJson = JSON.parse(body);
        const detail = asJson?.detail ?? asJson?.error;
        if (detail) {
          throw new Error(
            `upstream_error:${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 200)}`,
          );
        }
      } catch (err) {
        if (err.message?.startsWith("upstream_error:")) throw err;
      }

      const events = body.split("\n\n").filter((b) => b.trim());
      console.warn(
        chalk.redBright("===> ") +
          "[chat] parsed 0 chars — " +
          JSON.stringify({
            bodyLength: body.length,
            blocks: events.length,
            eventNames: [
              ...new Set(
                events
                  .map((b) => b.match(/^event: (.+)$/m)?.[1] ?? "<none>")
                  .slice(0, 12),
              ),
            ],
            hasDeltaEncoding: body.includes("delta_encoding"),
            legacySnapshots: parsed.legacySnapshots,
            messagesSeen: parsed.messages.map((m) => ({
              role: m.author?.role,
              ct: m.content?.content_type,
              channel: m.channel ?? null,
            })),
          }),
      );
      throw new Error("empty_response");
    }
  }

  async _reset() {
    console.warn(
      chalk.yellowBright("===> ") +
        "[reset] hard recovery — refreshing browser...",
    );
    try {
      await this.page
        .evaluate(() => {
          localStorage.removeItem("perfStore:v1");
        })
        .catch(() => {});
      await this.page.reload({ waitUntil: "domcontentloaded" });
      await this.page.waitForSelector("#prompt-textarea", { timeout: 0 });
      await new Promise((r) => setTimeout(r, 2000));
      // Reload replaces the page's socket, so re-tap from clean state.
      await this.tap?.detach();
      this.tap = new TurnStreamTap(this.page, { debug: config.debug });
      await this.tap.attach();
    } catch (err) {
      console.error(
        chalk.redBright("===> ") + "[reset] refresh error:",
        err.message,
      );
    }
  }

  chat(messages, mode = "default", modelSlug = "auto", thinkingEffort, options = {}) {
    const task = this._queue.then(async () => {
      if (!this.page) await this.init();
      try {
        return await this._doChat(messages, mode, modelSlug, thinkingEffort, options);
      } catch (err) {
        console.warn(
          chalk.yellowBright("===> ") + "[chat] error:",
          err.message,
          "— recovering...",
        );
        await this._reset();
        return await this._doChat(messages, mode, modelSlug, thinkingEffort, options);
      }
    });
    this._queue = task.catch(() => {});
    return task;
  }

  async close() {
    if (this._sharedBrowser) {
      await this.page?.close().catch(() => {});
      this.page = null;
      return;
    }
    await this.browser?.close();
  }
}
