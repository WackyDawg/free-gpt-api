import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";
import { connect } from "puppeteer-real-browser";
import dotenv from "dotenv";
import chalk from "chalk";
dotenv.config({ path: "../../.env" });

export class ChatGPTClient {
  constructor() {
    this.browser = null;
    this.page = null;
    this._queue = Promise.resolve();
    this._captureNextHeaders = null;
    this._initPromise = null;
  }

  _setupInterceptor() {
    this.page.on("request", (req) => {
      const type = req.resourceType();
      const url = req.url();

      if (["stylesheet", "image", "font", "media"].includes(type)) {
        req.abort();
        return;
      }

      if (url.includes("/conversation") && this._captureNextHeaders) {
        this._captureNextHeaders({ ...req.headers() });
        this._captureNextHeaders = null;
        req.abort();
        return;
      }

      req.continue();
    });
  }

  async init() {
    if (this._initPromise) return this._initPromise;
    this._initPromise = (async () => {
      const projectDir = path.resolve();
      const chromePath = path.join(projectDir, "Application", "chrome.exe");
      const executablePath = fs.existsSync(chromePath) ? chromePath : undefined;

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

      await page.setViewport({ width: 1920, height: 1080 });
      await page.setRequestInterception(true);
      this._setupInterceptor();

      await page.goto("https://chatgpt.com/?prompt=Hello world", {
        waitUntil: "domcontentloaded",
        timeout: 90000,
      });

      console.log(
        chalk.blueBright("===> ") +
          "[init] waiting for #prompt-textarea (this may take a minute if Cloudflare check is active)...",
      );

      //await page.screenshot({ path: "./test.png" });
      await page.waitForSelector("#prompt-textarea", { timeout: 0 });
      await new Promise((r) => setTimeout(r, 2000));
      console.log(chalk.greenBright("===> ") + "[init] ready");
    })();

    try {
      await this._initPromise;
    } catch (err) {
      console.error(chalk.redBright("===> ") + "[init] error:", err.message);
      this._initPromise = null;
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
        this.page = null;
      }
      throw err;
    }
  }

  async _doChat(messages, mode = "default", modelSlug = "auto") {
    const page = this.page;

    const messageList = Array.isArray(messages)
      ? messages
      : [{ role: "user", content: messages }];

    const lastUserMessage =
      [...messageList].reverse().find((m) => m.role === "user")?.content ||
      messageList[messageList.length - 1].content;

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

    await page.keyboard.type(lastUserMessage, { delay: 0 });
    await new Promise((r) => setTimeout(r, 300));
    await page.keyboard.press("Enter");

    const headers = await headersPromise;
    console.log(
      chalk.magentaBright("===> ") + "[headers] fresh tokens captured",
    );

    await page.focus("#prompt-textarea");
    await page.keyboard.down("Control");
    await page.keyboard.press("a");
    await page.keyboard.up("Control");
    await page.keyboard.press("Backspace");

    const result = await page.evaluate(
      async (p) => {
        const res = await fetch("/backend-anon/f/conversation", {
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
                content: { content_type: "text", parts: [m.content] },
                metadata: msgMetadata,
              };
            }),
            parent_message_id: p.parentId,
            model: p.modelSlug,
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

        const reader = res.body.getReader();
        const decoder = new TextDecoder();

        let fullText = "";
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop();

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6).trim();
            if (data === "[DONE]") continue;
            try {
              const json = JSON.parse(data);
              const part = json?.message?.content?.parts?.[0];
              if (typeof part === "string") fullText = part;
            } catch {}
          }
        }

        const cleanText = fullText
          .replace(/(\\r\\n|\\n|\\r|[\r\n]+|【[^】]+】|\[\d+\])/g, " ")
          .replace(/^[A-Z][^.!?]{2,100}:\s*/, "")
          .replace(/entity\["[^"]+","([^"]+)"(?:\s*,\s*"[^"]*")*\]/g, "$1")
          .replace(/(\*\*|__|\*|_|~~|`|#{1,6}\s+|[-*+]\s+)/g, "")
          .replace(/\s{2,}/g, " ")
          .trim();

        localStorage.removeItem("perfStore:v1");
        return { status: res.status, text: cleanText };
      },
      {
        headers,
        messages: messageList.map((m) => ({
          ...m,
          id: randomUUID(),
        })),
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
      },
    );

    console.log(
      chalk.cyanBright("===> ") +
        `[chat] status=${result.status} len=${result.text.length}`,
    );

    if (result.status === 401 || result.status === 403) {
      throw new Error(`auth_expired:${result.status}`);
    }

    if (!result.text) {
      throw new Error("empty_response");
    }

    return result.text;
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
    } catch (err) {
      console.error(
        chalk.redBright("===> ") + "[reset] refresh error:",
        err.message,
      );
    }
  }

  chat(messages, mode = "default", modelSlug = "auto") {
    const task = this._queue.then(async () => {
      if (!this.page) await this.init();
      try {
        return await this._doChat(messages, mode, modelSlug);
      } catch (err) {
        console.warn(
          chalk.yellowBright("===> ") + "[chat] error:",
          err.message,
          "— recovering...",
        );
        await this._reset();
        return await this._doChat(messages, mode, modelSlug);
      }
    });
    this._queue = task.catch(() => {});
    return task;
  }

  async close() {
    await this.browser?.close();
  }
}
