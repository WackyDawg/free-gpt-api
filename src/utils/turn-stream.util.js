import chalk from "chalk";
import { parseStreamItems } from "./sse-delta.util.js";

/**
 * Read-only tap on the page's own conversation WebSocket, via CDP: it never
 * opens a socket and never touches cookies, headers or the `verify` value —
 * only frames Chrome has already decrypted.
 *
 * It supplies authoritative turn boundaries (`done` /
 * `conversation-turn-complete`) in place of DOM polling, plus the turn's event
 * stream, whose `encoded_item` slices reassemble into the same
 * `delta_encoding: v1` body the HTTP path serves.
 */

const DEFAULT_TURN_TIMEOUT_MS = 300000;
const DEFAULT_IDLE_TIMEOUT_MS = 90000;
const MAX_RETAINED_TURNS = 20;

class Turn {
  constructor(key) {
    this.key = key;
    this.conversationId = null;
    this.turnId = null;
    this.items = [];
    this.seenItemIds = new Set();
    this.state = "streaming"; // streaming -> done -> complete
    this.lastActivity = Date.now();
  }

  addItem(payload) {
    this.conversationId = payload.conversation_id;
    this.turnId = payload.turn_id;
    this.lastActivity = Date.now();
    // A resumed subscription replays frames, so dedupe or the answer doubles.
    if (payload.stream_item_id) {
      if (this.seenItemIds.has(payload.stream_item_id)) return;
      this.seenItemIds.add(payload.stream_item_id);
    }
    this.items.push(payload);
  }

  parse() {
    return parseStreamItems(this.items);
  }
}

export class TurnStreamTap {
  /**
   * @param {import('puppeteer').Page} page
   * @param {{ debug?: boolean }} options
   */
  constructor(page, options = {}) {
    this.page = page;
    this.debug = Boolean(options.debug);
    this.cdp = null;
    this.turns = new Map();
    this.topics = new Set();
    this.watchers = new Set();
    this.knownTurnIds = new Set();
  }

  async attach() {
    if (this.cdp) return;
    this.cdp = await this.page.createCDPSession();
    await this.cdp.send("Network.enable");
    this.cdp.on("Network.webSocketFrameReceived", ({ response }) =>
      this._onFrame(response?.payloadData),
    );
    this.cdp.on("Network.webSocketClosed", () => this._fail("websocket_closed"));
    // A navigation tears down the socket view; re-attach after page.reload().
  }

  async detach() {
    try {
      await this.cdp?.detach();
    } catch {}
    this.cdp = null;
    this.turns.clear();
    this.watchers.clear();
  }

  _log(...args) {
    if (this.debug) console.log(chalk.gray("===> [ws]"), ...args);
  }

  _onFrame(raw) {
    if (typeof raw !== "string") return;
    let frames;
    try {
      frames = JSON.parse(raw);
    } catch {
      return; // control frames / non-JSON keepalives
    }
    if (!Array.isArray(frames)) frames = [frames];

    for (const frame of frames) {
      // Replies only confirm subscription state; they carry no turn content.
      if (frame?.type === "reply") {
        const reply = frame.reply || {};
        if (reply.type === "subscribe" && reply.topic_id) {
          this.topics.add(reply.topic_id);
          this._log("subscribed", reply.topic_id, "recovered=", reply.recovered);
        }
        if (reply.type === "unsubscribe" && reply.topic_id) {
          this.topics.delete(reply.topic_id);
          this._log("unsubscribed", reply.topic_id);
        }
        continue;
      }

      const envelope = frame?.payload;
      if (!envelope || typeof envelope !== "object") continue;
      this._onEnvelope(envelope);
    }
  }

  _onEnvelope(envelope) {
    const inner = envelope.payload || {};

    if (envelope.type === "conversation-turn-stream") {
      const key = `${inner.conversation_id}:${inner.turn_id}`;

      if (inner.type === "stream-item") {
        const turn = this._turn(key);
        turn.addItem(inner);
        this._notify();
        return;
      }

      if (inner.type === "done") {
        const turn = this._turn(key);
        turn.state = "done";
        turn.lastActivity = Date.now();
        this._log("turn done", turn.items.length, "items");
        this._notify();
        return;
      }
      return;
    }

    if (envelope.type === "conversation-turn-complete") {
      // Conversation-scoped: no turn_id, so complete every turn on it.
      const conversationId = inner.conversation_id;
      for (const turn of this.turns.values()) {
        if (turn.conversationId === conversationId) turn.state = "complete";
      }
      this._log("conversation complete", conversationId);
      this._notify();
    }
  }

  _turn(key) {
    if (!this.turns.has(key)) {
      this.turns.set(key, new Turn(key));
      // Keep only recent turns; the proxy is long-lived.
      while (this.turns.size > MAX_RETAINED_TURNS) {
        const oldest = this.turns.keys().next().value;
        if (oldest === undefined) break;
        this.turns.delete(oldest);
        this.knownTurnIds.delete(oldest);
      }
    }
    return this.turns.get(key);
  }

  _notify() {
    for (const watcher of this.watchers) watcher();
  }

  _fail(reason) {
    for (const watcher of this.watchers) watcher(new Error(reason));
  }

  /**
   * Snapshot known turn ids. Call BEFORE submitting a prompt so the next new
   * turn can be attributed to this request.
   */
  mark() {
    this.knownTurnIds = new Set(this.turns.keys());
    return this.knownTurnIds;
  }

  /**
   * Waits for the first turn that appeared after mark() to reach `complete`
   * (or `done`, if acceptDone is set).
   *
   * @returns {Promise<{ turnId: string, conversationId: string, itemCount: number,
   *                     state: string, text: string|null }>}
   */
  waitForTurn({
    timeoutMs = DEFAULT_TURN_TIMEOUT_MS,
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
    acceptDone = false,
  } = {}) {
    const known = this.knownTurnIds;
    const startedAt = Date.now();

    return new Promise((resolve, reject) => {
      let idleTimer = null;
      let overallTimer = null;

      const settle = (fn, value) => {
        clearTimeout(idleTimer);
        clearTimeout(overallTimer);
        this.watchers.delete(watcher);
        fn(value);
      };

      const pick = () => {
        for (const [key, turn] of this.turns) {
          if (!known.has(key)) return turn;
        }
        return null;
      };

      const resetIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          const turn = pick();
          // Silence after a `done` is normal if complete was missed.
          if (turn && turn.state === "done") {
            settle(resolve, this._describe(turn));
            return;
          }
          settle(reject, new Error("turn_stream_idle_timeout"));
        }, idleTimeoutMs);
      };

      const watcher = (err) => {
        if (err) return settle(reject, err);
        const turn = pick();
        if (!turn) return;
        resetIdle();
        const finished =
          turn.state === "complete" || (acceptDone && turn.state === "done");
        if (finished) settle(resolve, this._describe(turn));
      };

      this.watchers.add(watcher);
      overallTimer = setTimeout(() => {
        settle(reject, new Error(`turn_stream_timeout:${Date.now() - startedAt}ms`));
      }, timeoutMs);
      resetIdle();
      watcher(); // the turn may already have finished
    });
  }

  _describe(turn) {
    const parsed = turn.parse();
    return {
      turnId: turn.turnId,
      conversationId: turn.conversationId || parsed.conversationId,
      itemCount: turn.items.length,
      state: turn.state,
      encoding: parsed.encoding,
      streamComplete: parsed.streamComplete,
      text: parsed.text,
      messages: parsed.messages,
    };
  }
}
