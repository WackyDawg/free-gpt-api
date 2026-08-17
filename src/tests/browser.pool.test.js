import { describe, it, expect } from "vitest";
import {
  ChatGPTClientPool,
  PoolBusyError,
  RequestAbortedError,
} from "../utils/browser.pool.js";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/** Stand-in worker: records calls and completes only when told to. */
function fakeClientFactory(log = []) {
  return ({ label, browser }) => {
    const client = {
      label,
      // Only the primary owns a browser; the rest record what they were given.
      browser: browser || { owner: label },
      receivedBrowser: browser ?? null,
      inflight: null,
      async init() {
        log.push(`init:${label}`);
      },
      chat(...args) {
        const gate = deferred();
        client.inflight = gate;
        log.push(`chat:${label}`);
        return gate.promise.then(() => `reply from ${label} (${args[2]})`);
      },
      async close() {},
    };
    return client;
  };
}

async function poolOf(size, maxQueue = 32) {
  const log = [];
  const pool = new ChatGPTClientPool({
    size,
    maxQueue,
    createClient: fakeClientFactory(log),
  });
  await pool.init();
  return { pool, log };
}

describe("ChatGPTClientPool", () => {
  it("starts one worker per slot, sharing the primary's browser", async () => {
    const { pool, log } = await poolOf(3);
    expect(pool.clients).toHaveLength(3);
    expect(log).toEqual(["init:w0", "init:w1", "init:w2"]);
    // workers after the first are handed the primary's browser, not their own
    expect(pool.clients[0].receivedBrowser).toBeNull();
    expect(pool.clients[1].receivedBrowser).toBe(pool.clients[0].browser);
    expect(pool.clients[2].receivedBrowser).toBe(pool.clients[0].browser);
    expect(pool.stats()).toMatchObject({ workers: 3, idle: 3, busy: 0, queued: 0 });
  });

  it("runs requests concurrently up to the pool size", async () => {
    const { pool } = await poolOf(2);

    const a = pool.chat([], "default", "m-a");
    const b = pool.chat([], "default", "m-b");
    await Promise.resolve();
    await Promise.resolve();

    // both workers busy, nothing queued
    expect(pool.stats()).toMatchObject({ busy: 2, idle: 0, queued: 0 });

    pool.clients[0].inflight.resolve();
    pool.clients[1].inflight.resolve();
    expect(await a).toMatch(/m-a/);
    expect(await b).toMatch(/m-b/);
    expect(pool.stats()).toMatchObject({ busy: 0, idle: 2, served: 2 });
  });

  it("queues beyond capacity and hands the worker to the next waiter", async () => {
    const { pool } = await poolOf(1);

    const first = pool.chat([], "default", "first");
    await Promise.resolve();
    await Promise.resolve();
    const second = pool.chat([], "default", "second");
    await Promise.resolve();

    expect(pool.stats()).toMatchObject({ busy: 1, queued: 1 });

    pool.clients[0].inflight.resolve();
    expect(await first).toMatch(/first/);

    // the queued request now owns the freed worker
    await Promise.resolve();
    await Promise.resolve();
    pool.clients[0].inflight.resolve();
    expect(await second).toMatch(/second/);
    expect(pool.stats()).toMatchObject({ queued: 0, idle: 1 });
  });

  it("rejects with 'pool_saturated' once the queue limit is reached", async () => {
    const { pool } = await poolOf(1, 1);

    const running = pool.chat([], "default", "running");
    await Promise.resolve();
    await Promise.resolve();
    const queued = pool.chat([], "default", "queued");
    await Promise.resolve();

    // one running, one queued, limit is one -> the third is refused
    await expect(pool.chat([], "default", "overflow")).rejects.toBeInstanceOf(PoolBusyError);
    await expect(pool.chat([], "default", "overflow")).rejects.toMatchObject({
      code: "pool_saturated",
    });
    expect(pool.stats().rejected).toBe(2);

    pool.clients[0].inflight.resolve();
    await running;
    await Promise.resolve();
    await Promise.resolve();
    pool.clients[0].inflight.resolve();
    await queued;
  });

  it("drops a queued request when the caller aborts", async () => {
    const { pool } = await poolOf(1);

    const running = pool.chat([], "default", "running");
    await Promise.resolve();
    await Promise.resolve();

    const controller = new AbortController();
    const abandoned = pool.chat([], "default", "abandoned", undefined, {
      signal: controller.signal,
    });
    await Promise.resolve();
    expect(pool.stats().queued).toBe(1);

    controller.abort();
    await expect(abandoned).rejects.toBeInstanceOf(RequestAbortedError);
    expect(pool.stats().queued).toBe(0);

    // the worker is still healthy and goes back to idle
    pool.clients[0].inflight.resolve();
    await running;
    expect(pool.stats()).toMatchObject({ idle: 1, queued: 0 });
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const { pool } = await poolOf(1);
    const controller = new AbortController();
    controller.abort();

    await expect(
      pool.chat([], "default", "x", undefined, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(RequestAbortedError);
    expect(pool.stats()).toMatchObject({ idle: 1, queued: 0 });
  });

  it("releases the worker even when the request throws", async () => {
    const { pool } = await poolOf(1);

    const failing = pool.chat([], "default", "boom");
    await Promise.resolve();
    await Promise.resolve();
    pool.clients[0].inflight.reject(new Error("upstream exploded"));

    await expect(failing).rejects.toThrow("upstream exploded");
    expect(pool.stats()).toMatchObject({ idle: 1, busy: 0 });
  });

  it("keeps serving with fewer workers when one fails to start", async () => {
    const log = [];
    const factory = fakeClientFactory(log);
    const pool = new ChatGPTClientPool({
      size: 3,
      createClient: (opts) => {
        const client = factory(opts);
        if (opts.label === "w1") client.init = async () => {
          throw new Error("cloudflare challenge");
        };
        return client;
      },
    });
    await pool.init();

    expect(pool.clients).toHaveLength(1);
    expect(pool.stats()).toMatchObject({ workers: 1, idle: 1 });
  });
});
