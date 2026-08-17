/**
 * Parser for ChatGPT's `delta_encoding: v1` event stream, which appears both as
 * the body of `POST /backend-api/f/conversation` and — unencoded, as raw
 * slices — in the `encoded_item` field of WebSocket turn frames.
 *
 * Wire format:
 *   event: delta_encoding      data: "v1"
 *   event: delta               data: { p?, o?, v, c? }
 *   event: message             data: { type: "message_marker" | ... }
 *   data: [DONE]
 *
 * Delta ops are JSON-Pointer patches against the most recent root object
 * ({ message, conversation_id, error, error_code }):
 *   o: "add"     replace/insert at p  (p === "" installs a new root object)
 *   o: "append"  concatenate onto the string at p
 *   o: "patch"   v is an array of sub-ops applied in order
 *   o omitted    treated as "add" at the sticky path
 */

const DONE = "[DONE]";

/** Splits an SSE body into { event, data } records. Tolerates partial tails. */
export function parseSseBlocks(text) {
  const records = [];
  for (const block of text.split("\n\n")) {
    if (!block.trim()) continue;
    let event = "message";
    const data = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) data.push(line.slice(6));
      else if (line.startsWith("data:")) data.push(line.slice(5));
    }
    if (data.length === 0) continue;
    records.push({ event, data: data.join("\n") });
  }
  return records;
}

function pointerParts(pointer) {
  if (!pointer || pointer === "/") return [];
  return pointer
    .replace(/^\//, "")
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function resolveParent(root, parts) {
  let node = root;
  for (const part of parts.slice(0, -1)) {
    if (node == null) return null;
    node = node[part];
  }
  return node;
}

function applyOp(state, op) {
  // `p` and `o` are sticky: a streamed answer is one {p, o:"append", v} plus
  // bare {v} continuations, and defaulting those to "add" would overwrite the
  // buffer with the last token.
  const path = op.p !== undefined ? op.p : state.stickyPath;
  if (op.p !== undefined) state.stickyPath = op.p;
  const kind = op.o !== undefined ? op.o : state.stickyOp;

  if (kind === "patch") {
    for (const sub of Array.isArray(op.v) ? op.v : []) applyOp(state, sub);
    return;
  }
  if (op.o !== undefined) state.stickyOp = op.o;

  if (path === "" || path === undefined) {
    if (kind === "add" && op.v && typeof op.v === "object") {
      state.root = op.v;
      state.index(op.v);
    }
    return;
  }

  const parts = pointerParts(path);
  const parent = resolveParent(state.root, parts);
  if (parent == null) return;
  const leaf = parts[parts.length - 1];

  if (kind === "append") {
    parent[leaf] = (parent[leaf] ?? "") + op.v;
    return;
  }
  if (kind === "remove") {
    if (Array.isArray(parent)) parent.splice(Number(leaf), 1);
    else delete parent[leaf];
    return;
  }
  // "add" / "replace"
  parent[leaf] = op.v;
}

/** Text of a message, whatever shape its content takes. */
function messageText(message) {
  const content = message?.content;
  if (!content) return "";
  if (Array.isArray(content.parts)) {
    return content.parts.filter((p) => typeof p === "string").join("");
  }
  return typeof content.text === "string" ? content.text : "";
}

/**
 * True for the assistant message a user would consider "the answer". Thinking
 * models emit several per turn (reasoning recap, tool messages, then prose on
 * channel "final"); matching on content_type + recipient covers both them and
 * plain models without hardcoding a slug.
 */
export function isFinalAnswer(message) {
  if (!message || message.author?.role !== "assistant") return false;
  if (message.recipient && message.recipient !== "all") return false;
  if (message.metadata?.is_visually_hidden_from_conversation) return false;
  const type = message.content?.content_type;
  if (type !== "text" && type !== "multimodal_text") return false;
  if (message.channel && message.channel !== "final") return false;
  return true;
}

/**
 * Consumes an SSE body (or a concatenation of encoded_item slices) and returns
 * the reconstructed turn.
 *
 * @param {string} text
 * @returns {{ encoding: string|null, done: boolean, streamComplete: boolean,
 *             conversationId: string|null, text: string,
 *             messages: object[], events: number }}
 */
export function parseTurnStream(text) {
  const state = {
    root: null,
    stickyPath: "",
    stickyOp: "add",
    messagesById: new Map(),
    index(envelope) {
      const message = envelope?.message;
      if (message?.id) state.messagesById.set(message.id, message);
    },
  };

  let encoding = null;
  let done = false;
  let streamComplete = false;
  let conversationId = null;
  let events = 0;
  let legacySnapshots = 0;

  for (const record of parseSseBlocks(text)) {
    events += 1;

    if (record.data === DONE) {
      done = true;
      continue;
    }

    let payload;
    try {
      payload = JSON.parse(record.data);
    } catch {
      continue; // truncated tail; caller may retry with more data
    }

    if (record.event === "delta_encoding") {
      encoding = payload;
      continue;
    }

    if (record.event === "delta") {
      if (payload?.conversation_id) conversationId = payload.conversation_id;
      applyOp(state, payload);
      continue;
    }

    if (payload?.conversation_id) conversationId = payload.conversation_id;
    if (payload?.type === "message_stream_complete") streamComplete = true;

    // Legacy (pre-delta) framing: every event is a full cumulative snapshot,
    // so indexing by id means the last one wins. v1 control envelopes are
    // unaffected — none of them carry `.message`.
    if (payload?.message?.id && !payload.type) {
      state.root = payload;
      state.index(payload);
      legacySnapshots += 1;
    }
  }

  const messages = [...state.messagesById.values()];
  const finals = messages.filter(isFinalAnswer);
  // Later messages supersede earlier ones on the same channel.
  const answer = finals.length ? messageText(finals[finals.length - 1]) : "";

  return {
    encoding,
    done,
    streamComplete,
    conversationId,
    text: answer,
    messages,
    events,
    legacySnapshots,
  };
}

/** Orders WebSocket stream items by walking the parent_stream_item_id chain. */
export function orderStreamItems(items) {
  const byId = new Map(items.map((item) => [item.stream_item_id, item]));
  const children = new Map();
  let root = null;

  for (const item of items) {
    const parent = item.parent_stream_item_id;
    if (!parent || !byId.has(parent)) {
      if (!root) root = item;
      continue;
    }
    children.set(parent, item);
  }
  if (!root) return items.slice();

  const ordered = [];
  const seen = new Set();
  let cursor = root;
  while (cursor && !seen.has(cursor.stream_item_id)) {
    seen.add(cursor.stream_item_id);
    ordered.push(cursor);
    cursor = children.get(cursor.stream_item_id);
  }
  for (const item of items) {
    if (!seen.has(item.stream_item_id)) ordered.push(item);
  }
  return ordered;
}

/** Convenience: WebSocket stream items -> reconstructed turn. */
export function parseStreamItems(items) {
  const body = orderStreamItems(items)
    .map((item) => item.encoded_item)
    .filter((slice) => typeof slice === "string")
    .join("");
  return parseTurnStream(body);
}
