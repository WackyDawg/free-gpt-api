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
import { toUpstreamMessage } from "./tools.util.js";
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
   *   puppeteer-real-browser re-applies its turnstile/cursor patches to every
   *   new target, so pooled tabs get the same protection as the first page.
   */
  constructor(options = {}) {
    this.browser = options.browser || null;
    this._sharedBrowser = Boolean(options.browser);
    this.label = options.label || "client";
    this.page = null;
    this._queue = Promise.resolve();
    this._captureNextHeaders = null;
    this._nativeRequestOptions = null;
    this._initPromise = null;
    this.tap = null;
    this.busy = false;
  }

  _setupInterceptor() {
    this.page.on("request", (req) => {
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
            // Never attach an effort setting unless one survived filtering:
            // upstream rejects the whole body when the model has no reasoning
            // mode, and the page's own value must not leak through either.
            if (options.thinkingEffort) body.thinking_effort = options.thinkingEffort;
            else delete body.thinking_effort;

            // The page must be the sender — only then does its client subscribe
            // to the WebSocket topic a thinking model streams over. But the
            // composer can only carry one blob of text, so the real payload is
            // swapped in here: the page keeps ownership of the request while
            // the model receives properly structured roles.
            if (options.wireMessages?.length) {
              const template = Array.isArray(body.messages) ? body.messages[0] : null;
              body.messages = options.wireMessages.map((m) => ({
                ...(template || {}),
                id: m.id,
                author: { role: m.role },
                content: { content_type: "text", parts: [m.text] },
                metadata: { ...(template?.metadata || {}) },
              }));
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
        // Deliberately fulfilled, not aborted. The real request is replayed by
        // _doChat; this one only exists to surface fresh headers. Aborting it
        // makes the app treat the send as failed, show an error state and retry
        // on its own — and those stray retries consume the header capture that
        // the *next* request is waiting for, so a tab degrades a little with
        // every call until it stops answering. A well-formed empty stream lets
        // the turn close cleanly instead.
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

  /**
   * Cookie load, interception, socket tap and first navigation. Shared by the
   * standalone path (own browser) and the pooled path (extra tab).
   */
  async _preparePage(page) {
    const tag = `[init:${this.label}]`;

    // Reuse the user's authenticated ChatGPT browser session. Cookies are
    // read locally only; they are never logged or sent to any other host.
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

    // Read-only tap on the page's own conversation socket. Authentication
    // stays in the browser; this only observes already-decrypted frames.
    this.tap = new TurnStreamTap(page, { debug: config.debug });
    await this.tap.attach();

    await page.goto("https://chatgpt.com/?temporary-chat=true", {
      waitUntil: "domcontentloaded",
      timeout: 90000,
    });

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
      const projectDir = path.resolve();
      const chromePath = path.join(projectDir, "Application", "chrome.exe");
      const executablePath = fs.existsSync(chromePath) ? chromePath : undefined;

      if (this._sharedBrowser) {
        this.page = await this.browser.newPage();
        await this._preparePage(this.page);
        return;
      }

      const { browser, page } = await connect({
        headless: process.env.HEADLESS === "true",
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
        // Only this tab is ours to discard; the browser belongs to the pool.
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
   * Puts text into the composer. keyboard.type() is per-character, which is
   * far too slow for an agent transcript (tool schemas alone run to thousands
   * of characters), so insert in one shot via execCommand — it fires the input
   * events the editor needs — and fall back to typing if that is rejected.
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

  async _doChat(
    messages,
    mode = "default",
    modelSlug = "auto",
    thinkingEffort,
  ) {
    const page = this.page;

    const messageList = Array.isArray(messages)
      ? messages
      : [{ role: "user", content: messages }];

    const lastUserMessage =
      [...messageList].reverse().find((m) => m.role === "user")?.content ||
      messageList[messageList.length - 1].content;

    // Who sends the request decides what can be read back. A thinking model
    // returns an empty SSE body and streams its answer over the user's
    // WebSocket, on a topic the page's client subscribes to using the
    // stream_topic_id from the early SSE events — and it only does that for a
    // request it issued itself. So thinking models are sent by the page, with
    // wireMessages swapped into the body by the interceptor; everything else
    // goes out as a direct fetch whose SSE body carries the answer.
    const useNativeRequest = modelSlug === "gpt-5-6-thinking";

    // Both paths now carry the structured message list in the request body, so
    // the composer text is only a trigger: on the native path the interceptor
    // replaces it, and on the fetch path the page's own request is aborted.
    // It stays as the real question so a failed rewrite degrades to a sensible
    // single-turn prompt rather than a stray placeholder.
    const wireMessages = messageList
      .map((m) => ({ ...toUpstreamMessage(m), id: randomUUID() }))
      .filter((m) => m.text);

    const submissionText = lastUserMessage;

    // Last line of defence: upstream rejects the entire request body when an
    // effort setting is attached to a model that has no reasoning mode, and a
    // rejected turn leaves the tab unable to serve the next request. Callers
    // filter this too, but one stray value poisons a worker, so never let it
    // through on a slug that cannot accept it.
    const effort = /thinking/i.test(modelSlug) ? thinkingEffort : undefined;

    await page.focus("#prompt-textarea");
    await page.keyboard.down("Control");
    await page.keyboard.press("a");
    await page.keyboard.up("Control");
    await page.keyboard.press("Backspace");
    await new Promise((r) => setTimeout(r, 200));

    const headersPromise = new Promise((resolve, reject) => {
      this._captureNextHeaders = resolve;
      setTimeout(() => {
        this._captureNextHeaders = null;
        reject(new Error("header intercept timeout"));
      }, 15000);
    });

    if (useNativeRequest) {
      this._nativeRequestOptions = { modelSlug, thinkingEffort: effort, wireMessages };
    }
    const nativeAssistantSelector = '[data-message-author-role="assistant"]';
    const nativeInitialCount = useNativeRequest
      ? await page.$$eval(nativeAssistantSelector, (nodes) => nodes.length)
      : 0;

    // Snapshot known turns immediately before submitting so the turn this
    // request produces can be attributed unambiguously. Done for every request:
    // the structured path needs it too, because a thinking model delivers its
    // answer over the WebSocket and leaves the SSE body empty.
    this.tap?.mark();

    await this._insertPrompt(submissionText);
    await new Promise((r) => setTimeout(r, 300));
    await page.keyboard.press("Enter");

    const headers = await headersPromise;
    console.log(
      chalk.magentaBright("===> ") + "[headers] fresh tokens captured",
    );

    if (useNativeRequest) {
      // The page issues its own authenticated request; we read the resulting
      // turn off its WebSocket. `done`/`conversation-turn-complete` are exact
      // boundaries, so no polling and no "Thinking\u2026" placeholder heuristic.
      let turn = null;
      try {
        turn = await this.tap.waitForTurn({ timeoutMs: 180000 });
        console.log(
          chalk.cyanBright("===> ") +
            `[stream] ${turn.itemCount} items encoding=${turn.encoding} len=${turn.text.length}`,
        );
      } catch (err) {
        console.warn(
          chalk.yellowBright("===> ") + "[stream] " + err.message + " \u2014 falling back to DOM",
        );
      }

      if (turn?.text) return normalize(turn.text);

      // Fallback: read the rendered message. Racy (the DOM can lag the stream),
      // which is why it is only used when the stream yielded nothing.
      await page.waitForFunction(
        ({ selector, count }) => document.querySelectorAll(selector).length > count,
        { timeout: 60000 },
        { selector: nativeAssistantSelector, count: nativeInitialCount },
      );
      const domText = await page.$$eval(nativeAssistantSelector, (nodes) => {
        const node = nodes[nodes.length - 1];
        return (node?.innerText || node?.textContent || "").trim();
      });
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
            messages: p.messages.map((m, idx) => {
              const msgMetadata = {};
              if (p.systemHints.length > 0) {
                msgMetadata.system_hints = p.systemHints;
              }
              if (p.mode === "deep-research") {
                msgMetadata.deep_research_version = "standard";
                msgMetadata.venus_model_variant = "standard";
              }
              return {
                id: m.id,
                author: { role: m.role },
                content: { content_type: "text", parts: [m.text] },
                metadata: msgMetadata,
              };
            }),
            parent_message_id: p.parentId,
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

        // Read the stream verbatim. Interpreting it is the parser's job — the
        // wire format is `delta_encoding: v1`, whose JSON-Pointer ops cannot be
        // reconstructed by scanning individual `data:` lines for text fields.
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
        messages: wireMessages,
        parentId: randomUUID(),
        mode,
        systemHints:
          mode === "reasoning"
            ? ["reason"]
            : mode === "deep-research"
              ? ["connector:connector_openai_deep_research"]
              : mode === "tatertot"
                ? ["tatertot"]
                : mode === "quiz"
                  ? ["connector:connector_openai_quizgpt_v2"]
                  : [],
        modelSlug,
        thinkingEffort: effort,
      },
    );

    if (result.status === 401 || result.status === 403) {
      throw new Error(`auth_expired:${result.status}`);
    }

    const parsed = parseTurnStream(result.body || "");
    console.log(
      chalk.cyanBright("===> ") +
        `[chat] status=${result.status} encoding=${parsed.encoding} ` +
        `events=${parsed.events} len=${parsed.text.length}`,
    );

    if (parsed.text) return normalize(parsed.text);

    // Thinking models acknowledge the POST but deliver the turn over the
    // user's WebSocket rather than in the SSE body, so an empty parse here is
    // expected rather than a failure. Read the same turn off the tap. This is
    // what the old native path was really compensating for.
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

      // Structural diagnostic — no message text, just framing facts.
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
            firstBlock: events[0]?.slice(0, 120) ?? "",
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
      // Reload replaces the page's socket; drop stale turn state and re-tap.
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

  chat(messages, mode = "default", modelSlug = "auto", thinkingEffort) {
    const task = this._queue.then(async () => {
      if (!this.page) await this.init();
      try {
        return await this._doChat(messages, mode, modelSlug, thinkingEffort);
      } catch (err) {
        console.warn(
          chalk.yellowBright("===> ") + "[chat] error:",
          err.message,
          "— recovering...",
        );
        await this._reset();
        return await this._doChat(messages, mode, modelSlug, thinkingEffort);
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
