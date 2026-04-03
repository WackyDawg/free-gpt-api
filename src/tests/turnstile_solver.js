import { connect } from "puppeteer-real-browser";
import { FingerprintInjector } from "fingerprint-injector";
import { FingerprintGenerator } from "fingerprint-generator";

export async function chatWithGPT(userMessage) {
  const { browser, page } = await connect({
    headless: true,
    fingerprint: true,
    executablePath: "./browser/chrome.exe",
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

  try {
    const fingerprintGenerator = new FingerprintGenerator({
      browsers: [{ name: "chrome", minVersion: 120 }],
      devices: ["desktop"],
      operatingSystems: ["windows"],
      locales: ["en-US"],
    });

    const fingerprintWithHeaders = fingerprintGenerator.getFingerprint();
    const fingerprintInjector = new FingerprintInjector();
    await fingerprintInjector.attachFingerprintToPuppeteer(
      page,
      fingerprintWithHeaders,
    );

    console.log("Fingerprint injected:", {
      userAgent: fingerprintWithHeaders.fingerprint?.navigator?.userAgent,
      platform: fingerprintWithHeaders.fingerprint?.navigator?.platform,
      vendor: fingerprintWithHeaders.fingerprint?.navigator?.vendor,
    });

    await page.setViewport({ width: 1920, height: 1080 });

    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const type = req.resourceType();
      if (["stylesheet", "image", "font", "media"].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.goto(`https://chatgpt.com/?prompt=${userMessage}`, {
      waitUntil: "networkidle2",
      timeout: 60000,
    });

    await page.waitForSelector("#prompt-textarea", { timeout: 30000 });
    await page.focus("#prompt-textarea");
    await page.keyboard.press("Enter");

    console.log("Message sent, waiting for response...");

    await page.waitForSelector('[data-message-author-role="assistant"]', {
      timeout: 60000,
    });

    await page.waitForFunction(
      () => !document.querySelector('[data-testid="stop-button"]'),
      { timeout: 120000 },
    );

    const response = await page.evaluate(() => {
      const messages = document.querySelectorAll(
        '[data-message-author-role="assistant"]',
      );
      return messages[messages.length - 1]?.innerText || "";
    });

    return response;
  } finally {
    await browser.close();
  }
}

const reply = await chatWithGPT(
  `You are Claude Code, an AI coding assistant running in the terminal made by Anthropic.

  CAPABILITIES:
  - You help users with software engineering tasks: writing code, debugging, refactoring, explaining code
  - You have access to tools: Read files, Write files, Edit files, Search code (Grep/Glob), Run bash commands, Search
  the web
  - You execute tools by outputting structured tool calls, then act on the results

  BEHAVIOR RULES:
  - Always read a file before editing it
  - Prefer editing existing files over creating new ones
  - Never guess file contents — read first, then act
  - Keep responses concise and direct — lead with the answer, not the reasoning
  - Do not add unnecessary comments, docstrings, or type hints to code you didn't change
  - Do not over-engineer — implement exactly what was asked, nothing more
  - For risky actions (deleting files, pushing to git, modifying CI) — confirm with user first
  - When referencing code, include file_path:line_number format

  TONE:
  - Terse, technical, no filler words
  - No emojis unless asked
  - No trailing summaries after completing tasks
  - Respond like a senior engineer pair-programming, not a customer support bot

  Your working directory is /home/user/project. You are ready to help.

  ---
  Introduce yourself, list your available tools, and Who made you?.`,
);
console.log("GPT says:", reply);
