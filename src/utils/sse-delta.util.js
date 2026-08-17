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
  for (const block of text.replace(/\r\n?/g, "\n").split("\n\n")) {
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
function textValue(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textValue).join("");
  if (!value || typeof value !== "object") return "";
  return textValue(value.text ?? value.messageText ?? value.content ?? value.summary);
}

function messageText(message) {
  const content = message?.content;
  return [
    textValue(content?.parts),
    textValue(content?.text),
    textValue(message?.messageText),
  ].find(Boolean) || "";
}

/** Text carried by a provider-exposed reasoning/summary message. */
function reasoningText(message) {
  const content = message?.content || {};
  return [
    textValue(content.parts),
    textValue(content.text),
    textValue(content.summary),
    textValue(content.thoughts),
    textValue(content.reasoning),
    // reasoning_recap stores its prose directly in content.content.
    textValue(content.content),
    textValue(message.messageText),
    textValue(message.summary),
    textValue(message.thoughts),
    textValue(message.reasoning),
  ].find(Boolean) || "";
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
 * True for a thinking model's reasoning summary — the "Thinking…" content that
 * streams before the final answer. Surfacing it lets a client watch the model
 * reason in real time instead of waiting for the whole turn.
 */
export function isReasoning(message) {
  if (!message || message.author?.role !== "assistant") return false;
  const type = message.content?.content_type;
  const metadata = message.metadata || {};
  const hasReasoningMetadata = Object.keys(metadata).some((key) =>
    /reasoning|thought/i.test(key),
  );
  return (
    type === "reasoning_recap" ||
    type === "thoughts" ||
    type === "reasoning" ||
    message.channel === "analysis" ||
    hasReasoningMetadata
  );
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
      if (record.event === "delta_encoding") {
        encoding = record.data.trim().replace(/^"|"$/g, "");
      }
      continue; // truncated tail; caller may retry with more data
    }

    if (record.event === "delta_encoding") {
      encoding = payload ?? record.data.trim().replace(/^"|"$/g, "");
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

  // Some WebSocket subscriptions begin after the control marker was emitted.
  // The delta event grammar is still unambiguously v1, so do not report a
  // missing marker as a failed decode.
  if (!encoding && /(?:^|\n)event:\s*delta(?:\s|$)/m.test(text)) encoding = "v1";

  const messages = [...state.messagesById.values()];
  const finals = messages.filter(isFinalAnswer);
  // Later messages supersede earlier ones on the same channel.
  const answer = finals.length ? messageText(finals[finals.length - 1]) : "";
  const reasoning = messages
    .filter(isReasoning)
    .map(reasoningText)
    .filter(Boolean)
    .join("\n");

  return {
    encoding,
    done,
    streamComplete,
    conversationId,
    text: answer,
    reasoning,
    messages,
    events,
    legacySnapshots,
  };
}

/** Orders WebSocket stream items by walking the parent_stream_item_id chain. */
export function orderStreamItems(items) {
  const byId = new Map(items.map((item) => [item.stream_item_id, item]));
  const children = new Map();
  const roots = [];

  for (const item of items) {
    const parent = item.parent_stream_item_id;
    if (!parent || !byId.has(parent)) {
      roots.push(item);
      continue;
    }
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(item);
  }
  if (!roots.length) return items.slice();

  const ordered = [];
  const seen = new Set();
  const byTime = (a, b) => (a.server_timestamp_ms || 0) - (b.server_timestamp_ms || 0);
  roots.sort(byTime);
  for (const siblings of children.values()) siblings.sort(byTime);
  const visit = (cursor) => {
    if (!cursor || seen.has(cursor.stream_item_id)) return;
    seen.add(cursor.stream_item_id);
    ordered.push(cursor);
    for (const child of children.get(cursor.stream_item_id) || []) visit(child);
  };
  for (const root of roots) visit(root);
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
