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
            // Upstream rejects the whole body when a model with no reasoning
            // mode carries an effort setting, so never let one through.
            if (options.thinkingEffort) body.thinking_effort = options.thinkingEffort;
            else delete body.thinking_effort;

            // The page must stay the sender (only then does its client
            // subscribe to the thinking model's WebSocket topic), so the
            // structured payload is swapped into its own request here.
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

    // A thinking model returns an empty SSE body and streams its answer over
    // the page's WebSocket, but only for a request the page issued itself — so
    // it is sent by the page with the body rewritten by the interceptor.
    // Everything else goes out as a direct fetch that carries the answer.
    const useNativeRequest = modelSlug === "gpt-5-6-thinking";

    // Both paths carry the structured list in the body, so the composer text is
    // only a trigger. It stays as the real question so a failed rewrite
    // degrades to a sensible single-turn prompt.
    const wireMessages = messageList
      .map((m) => ({ ...toUpstreamMessage(m), id: randomUUID() }))
      .filter((m) => m.text);

    const submissionText = lastUserMessage;

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

    // Snapshot known turns before submitting so this request's turn can be
    // attributed. Needed on both paths — a thinking model can leave the SSE
    // body empty and deliver over the WebSocket instead.
    this.tap?.mark();

    await this._insertPrompt(submissionText);
    const _tInsert = _since();
    // Give React one frame to register the inserted text before Enter submits,
    // rather than a fixed 300ms. If the composer still shows text we proceed
    // immediately; the short poll replaces a blind sleep.
    await this._awaitComposerReady(submissionText);
    await page.keyboard.press("Enter");
    const _tSubmit = _since();

    const headers = await headersPromise;
    const _tHeaders = _since();
    if (config.debug) {
      console.log(
        chalk.magentaBright("===> ") +
          `[timing:${this.label}] clear=${_tClear}ms insert=${_tInsert}ms ` +
          `submit=${_tSubmit}ms trigger=${_tHeaders}ms (request fired)`,
      );
    }

    if (useNativeRequest) {
      // Read the turn off the WebSocket: `done`/`conversation-turn-complete`
      // are exact boundaries, so no DOM polling is needed.
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

      // Fallback: read the rendered message. Racy — the DOM lags the stream.
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
