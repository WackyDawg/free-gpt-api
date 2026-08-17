import chalk from "chalk";
import { ChatGPTClient } from "./browser.util.js";
import { config } from "../config/config.js";

/**
 * Pool of ChatGPT browser workers: one Chromium instance hosting N tabs, each
 * a ChatGPTClient with its own page, interceptor and socket tap.
 *
 * Concurrency comes from having several clients, never from relaxing the
 * per-client lock — `_captureNextHeaders` and `_nativeRequestOptions` are
 * single-slot, so two requests through one client cross wires. Full history is
 * re-sent on every request, so any worker can serve any request.
 */

export class PoolBusyError extends Error {
  constructor(queueDepth) {
    super(`pool_saturated: ${queueDepth} requests already waiting`);
    this.name = "PoolBusyError";
    this.code = "pool_saturated";
  }
}

export class RequestAbortedError extends Error {
  constructor() {
    super("request_aborted");
    this.name = "RequestAbortedError";
    this.code = "request_aborted";
  }
}

export class ChatGPTClientPool {
  constructor(options = {}) {
    this.size = Math.max(1, options.size ?? config.poolSize);
    this.maxQueue = Math.max(0, options.maxQueue ?? config.maxQueue);
    this.clients = [];
    this.idle = [];
    this.waiters = [];
    this._initPromise = null;
    this._served = 0;
    this._rejected = 0;
    // Injectable so the pool's queueing can be tested without a browser.
    this._createClient = options.createClient || ((opts) => new ChatGPTClient(opts));
  }

  async init() {
    if (this._initPromise) return this._initPromise;

    this._initPromise = (async () => {
      // The first client owns the browser; the rest attach as tabs.
      const primary = this._createClient({ label: "w0" });
      await primary.init();
      this.clients.push(primary);
      this.idle.push(primary);

      // Sequential on purpose: parallel cold tabs all hit the Cloudflare check
      // at once and are far more likely to be challenged.
      for (let index = 1; index < this.size; index += 1) {
        const worker = this._createClient({
          browser: primary.browser,
          label: `w${index}`,
        });
        try {
          await worker.init();
          this.clients.push(worker);
          this.idle.push(worker);
        } catch (err) {
          console.warn(
            chalk.yellowBright("===> ") +
              `[pool] worker w${index} failed to start (${err.message}); continuing with ${this.clients.length}`,
          );
          break;
        }
      }

      console.log(
        chalk.greenBright("===> ") +
          `[pool] ready with ${this.clients.length}/${this.size} workers, queue limit ${this.maxQueue}`,
      );
    })();

    try {
      await this._initPromise;
    } catch (err) {
      this._initPromise = null;
      throw err;
    }
  }

  get pending() {
    return this.waiters.length;
  }

  stats() {
    return {
      workers: this.clients.length,
      idle: this.idle.length,
      busy: this.clients.length - this.idle.length,
      queued: this.waiters.length,
      queueLimit: this.maxQueue,
      served: this._served,
      rejected: this._rejected,
    };
  }

  /**
   * Takes a worker, waiting if all are busy.
   * @param {{ signal?: AbortSignal }} options
   */
  acquire({ signal } = {}) {
    if (signal?.aborted) return Promise.reject(new RequestAbortedError());

    const worker = this.idle.shift();
    if (worker) {
      worker.busy = true;
      return Promise.resolve(worker);
    }

    if (this.waiters.length >= this.maxQueue) {
      this._rejected += 1;
      return Promise.reject(new PoolBusyError(this.waiters.length));
    }

    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, onAbort: null };

      if (signal) {
        waiter.onAbort = () => {
          const at = this.waiters.indexOf(waiter);
          if (at !== -1) this.waiters.splice(at, 1);
          reject(new RequestAbortedError());
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }

      this.waiters.push(waiter);
    });
  }

  release(worker) {
    if (!worker) return;
    worker.busy = false;

    const waiter = this.waiters.shift();
    if (!waiter) {
      this.idle.push(worker);
      return;
    }

    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
    worker.busy = true;
    waiter.resolve(worker);
  }

  /**
   * Same signature as ChatGPTClient.chat, plus an options bag.
   * @param {{ signal?: AbortSignal }} options
   */
  async chat(messages, mode = "default", modelSlug = "auto", thinkingEffort, options = {}) {
    if (!this._initPromise) await this.init();

    const worker = await this.acquire(options);
    try {
      const result = await worker.chat(messages, mode, modelSlug, thinkingEffort, options);
      this._served += 1;
      return result;
    } finally {
      this.release(worker);
    }
  }

  async close() {
    for (const worker of this.clients) {
      await worker.close().catch(() => {});
    }
    // The primary owns the browser; closing it tears down the rest.
    await this.clients[0]?.browser?.close().catch(() => {});
    this.clients = [];
    this.idle = [];
  }
}
