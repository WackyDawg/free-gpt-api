/**
 * Deterministic guard around a prompt-based (non-native) tool-calling loop.
 *
 * The upstream backend has no function calling: tool schemas are injected into
 * the prompt and the model is *asked* to answer with <tool_call> tags. Asking
 * is not a contract, and two failure modes show up in practice:
 *
 *   1. MISSING CALL     — the model answers in prose and invents the outcome of
 *                         a tool it never called ("I checked /etc/hosts, it
 *                         does not exist"). It has no filesystem, so this is a
 *                         confident false report: the worst possible output for
 *                         an agent loop.
 *   2. REPEATED CALL    — a <tool_result> for an identical call is already in
 *                         the transcript, and the model re-issues the same call
 *                         instead of reading the answer it already has. In an
 *                         agent loop that is an infinite Read -> Read -> Read.
 *
 * Prompt wording alone plateaued at ~83% compliance, and the phrasing that
 * fixed (1) is what caused (2). This module replaces that coin flip with a
 * check on the reply we actually got back, plus at most one bounded retry
 * carrying a targeted correction.
 *
 * Everything here except `runWithToolGuard` is a pure function, so the whole
 * detector is unit-testable without a browser session.
 */

import { parseToolCallReply } from "./tools.util.js";

export const GUARD_FABRICATED = "fabricated_result";
export const GUARD_DUPLICATE = "duplicate_call";

/* -------------------------------------------------------------------------- */
/* Fabricated-result detection                                                */
/* -------------------------------------------------------------------------- */

/**
 * First-person claims to have *performed* an inspection. The model cannot have
 * done any of these without emitting a tool call, so the claim is false by
 * construction. Deliberately past/perfect tense only: "I'll check the file" is
 * a plan, not a fabrication.
 */
const INSPECTION_CLAIMS = [
  /\bi (?:just |already |went ahead and )?(?:checked|looked|ran|opened|searched|scanned|inspected|examined|listed|reviewed|verified|confirmed|executed|fetched|browsed|grepped)\b/i,
  /\bi(?:'ve| have) (?:just |already )?(?:checked|looked|read|run|opened|searched|scanned|inspected|examined|listed|reviewed|verified|confirmed|executed|fetched)\b/i,
  /\b(?:after|having) (?:checking|looking|reading|running|inspecting|reviewing|searching|examining)\b/i,
  /\bi (?:could not|couldn't|was unable to) (?:find|locate|open|read|access)\b/i,
  /\b(?:looking|checking) at (?:the|your|this) (?:file|directory|folder|path|repo|repository|output)\b/i,
];

/**
 * Verdicts about what exists on a machine the model has never observed.
 * "not found" and friends are only evidence-shaped when they land in the same
 * sentence as a concrete target (see TARGETS), which is what keeps prose that
 * merely mentions a filename from tripping the guard.
 */
const EXISTENCE_VERDICTS = [
  /\b(?:does|do|did)(?:\s+n[o']t|\s+not)\s+exist\b/i,
  /\bdoesn't exist\b/i,
  /\bno such (?:file|directory|folder|path|command)\b/i,
  /\b(?:is|are|was|were)\s+(?:missing|absent)\b/i,
  /\b(?:is|are|was|were)\s+not\s+present\b/i,
  /\bnot found\b/i,
  /\bcould not be (?:found|located|opened|read)\b/i,
  /\bcouldn't be (?:found|located|opened|read)\b/i,
  /\bcannot be (?:found|located)\b/i,
  /\bthere (?:is|are|was|were) no (?:such |file|files|directory|directories|folder|path|command|script|log|output|entry)/i,
  /\b(?:is|appears to be) empty\b/i,
  /\bdoes not appear to (?:exist|be present)\b/i,
  /\b(?:the )?(?:file|directory|folder|path) (?:is|was) (?:empty|missing)\b/i,
];

/**
 * Refusals that should have been tool calls. Inside an agent loop the tool *is*
 * the access, so "I don't have access to your files" while a Read tool is on
 * the table is a protocol failure, not an honest limitation.
 */
const ACCESS_DISCLAIMERS = [
  /\bi (?:do not|don't) have (?:direct )?access\b/i,
  /\bi (?:do not|don't) have the ability to\b/i,
  /\bi (?:can|could)(?:not|n't) (?:access|read|open|run|execute|browse)\b/i,
  /\bi(?:'m| am) (?:unable|not able) to (?:access|read|open|run|execute|see|browse)\b/i,
  /\bi (?:have|possess) no (?:access|way) to\b/i,
  /\bas an ai\b/i,
];

/** Nouns that make a sentence a claim about the machine rather than a musing. */
const TARGET_WORDS =
  /\b(?:file|files|filename|directory|directories|folder|folders|path|paths|filesystem|file system|disk|repo|repository|codebase|workspace|command|commands|shell|terminal|script|scripts|log|logs|config|configuration|package\.json|readme|source tree|machine|environment|output)\b/i;

/** Anything path- or command-shaped: /a/b, ./x, C:\x, notes.txt, `ls -la`. */
const TARGET_SHAPES = [
  /(?:^|[\s"'`([])(?:\.{0,2}\/|~\/)[\w.\-/]+/, // /abs/path, ./rel, ~/home
  /\b[A-Za-z]:\\[\w.\-\\]+/, // C:\windows\path
  /\b[\w.\-]+\.(?:txt|md|js|mjs|cjs|ts|tsx|jsx|json|ya?ml|toml|ini|cfg|conf|env|sh|bash|zsh|py|rb|go|rs|java|c|h|cpp|hpp|css|html|xml|lock|log|sql|csv)\b/i,
  /`[^`\n]+`/, // `inline code` / `ls -la`
];

/**
 * Sentences framed as hypotheses, questions, offers or plans are not claims of
 * fact and must never trip the guard. "If the file does not exist, I'll create
 * it" is exactly the kind of sentence a well-behaved agent writes.
 */
const HYPOTHETICAL = [
  /\b(?:if|whether|unless|in case|suppose|assuming)\b/i,
  // NB: "could" is absent on purpose — "I couldn't find it" is a claim, not a
  // hypothesis, and listing it here would silently disable that detector.
  /\b(?:would|might|may|should|will|shall|going to|about to|let me|let's|i'll|i will|next step|plan(?:ning)? to|want me to|shall i)\b/i,
  /\b(?:when|after|before) (?:you|we|i) (?:run|check|read|open|create)\b/i,
];

/** Splits into sentence-ish spans; newlines count as boundaries. */
function toSentences(text) {
  return String(text)
    .split(/(?<=[.!?;:])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function anyMatch(patterns, text) {
  return patterns.some((re) => re.test(text));
}

/** A sentence only counts as evidence if it names something concrete. */
function mentionsTarget(sentence, toolNames = []) {
  if (TARGET_WORDS.test(sentence)) return true;
  if (anyMatch(TARGET_SHAPES, sentence)) return true;
  return toolNames.some(
    (name) => name && new RegExp(`\\b${escapeRegExp(name)}\\b`).test(sentence),
  );
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Accepts OpenAI-shaped tools, Anthropic-shaped tools, or bare names. */
export function toolNamesOf(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .map((tool) =>
      typeof tool === "string" ? tool : tool?.function?.name || tool?.name,
    )
    .filter((name) => typeof name === "string" && name.length > 0);
}

/**
 * True when a reply that contains no tool call nevertheless asserts something
 * only a tool could have established.
 *
 * Conservative by design — a false positive costs a wasted upstream round trip
 * on an answer that was already correct, so the bar is: an evidence-shaped
 * claim and a concrete target in the *same* sentence, with hypothetical,
 * interrogative and forward-looking sentences excluded outright. Prose that
 * merely mentions a filename ("open notes.txt in your editor") does not fire.
 *
 * @param {string} replyText  the model's reply
 * @param {Array}  tools      tools offered on this request; no tools, no fabrication
 * @returns {boolean}
 */
export function looksLikeFabricatedToolResult(replyText, tools) {
  if (typeof replyText !== "string" || replyText.trim() === "") return false;

  const toolNames = toolNamesOf(tools);
  // Nothing was fabricable if the model had nothing to call.
  if (toolNames.length === 0) return false;
  // A reply that did call a tool is not a fabrication, whatever else it says.
  if (/<tool_call\b/i.test(replyText)) return false;

  for (const sentence of toSentences(replyText)) {
    if (sentence.endsWith("?")) continue; // a question asserts nothing
    if (anyMatch(HYPOTHETICAL, sentence)) continue; // plans and conditionals

    const claimsInspection = anyMatch(INSPECTION_CLAIMS, sentence);
    const claimsVerdict = anyMatch(EXISTENCE_VERDICTS, sentence);
    const claimsNoAccess = anyMatch(ACCESS_DISCLAIMERS, sentence);
    if (!claimsInspection && !claimsVerdict && !claimsNoAccess) continue;

    if (mentionsTarget(sentence, toolNames)) return true;
  }

  return false;
}

/* -------------------------------------------------------------------------- */
/* Duplicate-call detection                                                   */
/* -------------------------------------------------------------------------- */

/** Order-insensitive, whitespace-insensitive form of a tool argument blob. */
export function canonicalizeArguments(args) {
  if (args == null) return "{}";
  const raw = typeof args === "string" ? args : JSON.stringify(args);
  try {
    return JSON.stringify(sortKeys(JSON.parse(raw)));
  } catch {
    return raw.trim();
  }
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((out, key) => {
        out[key] = sortKeys(value[key]);
        return out;
      }, {});
  }
  return value;
}

function callIdentity(call) {
  const name = call?.function?.name ?? call?.name;
  if (!name) return null;
  const args = call?.function?.arguments ?? call?.arguments ?? call?.input;
  return `${name}::${canonicalizeArguments(args)}`;
}

/**
 * Walks the transcript and returns, per call identity, the tool_result text
 * that already answered it. A `tool` message normally carries the call id it
 * belongs to; when it does not, it is attributed to the most recent still
 * unanswered assistant call, which is the only sane reading of the order.
 *
 * @returns {Map<string, string>} identity -> result text
 */
export function resolvedToolResults(priorMessages = []) {
  const byId = new Map(); // call id -> identity
  const pending = []; // ids emitted but not yet answered, oldest first
  const resolved = new Map();

  for (const message of Array.isArray(priorMessages) ? priorMessages : []) {
    if (message?.role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        const identity = callIdentity(call);
        if (!identity) continue;
        if (call.id) byId.set(call.id, identity);
        pending.push({ id: call.id, identity });
      }
      continue;
    }

    if (message?.role !== "tool") continue;

    const text =
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content ?? "");

    const id = message.tool_call_id;
    if (id && byId.has(id)) {
      resolved.set(byId.get(id), text);
      const at = pending.findIndex((entry) => entry.id === id);
      if (at !== -1) pending.splice(at, 1);
      continue;
    }
    // No usable id: answer the oldest outstanding call.
    const next = pending.shift();
    if (next) resolved.set(next.identity, text);
  }

  return resolved;
}

/**
 * True when this exact (name, arguments) call already has a tool_result in the
 * conversation — i.e. re-issuing it would spin the agent loop with no new
 * information.
 *
 * A prior call that was emitted but never answered is NOT a duplicate: the
 * retry is legitimate there.
 */
export function isDuplicateToolCall(toolCall, priorMessages = []) {
  const identity = callIdentity(toolCall);
  if (!identity) return false;
  return resolvedToolResults(priorMessages).has(identity);
}

/** The tool_result text that already answers this call, or undefined. */
export function existingResultFor(toolCall, priorMessages = []) {
  const identity = callIdentity(toolCall);
  if (!identity) return undefined;
  return resolvedToolResults(priorMessages).get(identity);
}

/** First duplicate among a parsed reply's calls, or null. */
export function findDuplicateCall(toolCalls, priorMessages = []) {
  if (!Array.isArray(toolCalls)) return null;
  return toolCalls.find((call) => isDuplicateToolCall(call, priorMessages)) ?? null;
}

/* -------------------------------------------------------------------------- */
/* Corrections                                                                */
/* -------------------------------------------------------------------------- */

const MAX_ECHOED_RESULT = 4000;

/**
 * The instruction appended before the single retry. Each kind gets its own
 * wording: one forces a call, the other forbids one. Merging them is what made
 * the single reminder block in buildPromptWithTools() unstable — the phrasing
 * that fixed fabrication caused repetition.
 *
 * @param {"fabricated_result"|"duplicate_call"} kind
 * @param {{ tools?: Array, toolCall?: object, result?: string, replyText?: string }} context
 * @returns {string}
 */
export function correctionPrompt(kind, context = {}) {
  if (kind === GUARD_DUPLICATE) {
    const call = context.toolCall;
    const name = call?.function?.name ?? call?.name ?? "that tool";
    const args = canonicalizeArguments(
      call?.function?.arguments ?? call?.arguments ?? call?.input,
    );
    const result = typeof context.result === "string" ? context.result : "";
    const echoed =
      result.length > MAX_ECHOED_RESULT
        ? `${result.slice(0, MAX_ECHOED_RESULT)}\n[...truncated]`
        : result;

    return [
      `STOP. You just called ${name} with ${args}, but that exact call has already been made in this conversation and its result is already above.`,
      "Calling it again returns the same thing and stalls the loop.",
      echoed
        ? `Here is the result you already have:\n<tool_result name="${name}">${echoed}</tool_result>`
        : "The result of that call is already present in the transcript above.",
      "",
      "Answer the user's question now using that result. Do NOT emit a <tool_call> for it again.",
      "Only call a tool if you need genuinely different information — a different tool, or the same tool with different arguments.",
    ].join("\n");
  }

  const names = toolNamesOf(context.tools);
  const list = names.length > 0 ? names.join(", ") : "the listed tools";

  return [
    "STOP. Your previous answer reported what a tool would have returned, but you never called one — so that report was invented, not observed.",
    "You are running inside an automated agent loop. You have no filesystem, no shell, no network and no view of the user's machine. You have not looked at anything.",
    "",
    `Retry now. Call the tool that supplies the missing information (available: ${list}) and respond with ONLY the call, no prose before or after:`,
    '<tool_call id="<unique_id>" name="<function_name>">{"arg":"value"}</tool_call>',
    "",
    "Rules for this retry:",
    "- Never state that a file, directory, path or command exists, is missing, is empty or is inaccessible. You have no evidence either way until a tool returns.",
    "- An unfamiliar-looking path is not evidence that it is absent. Call the tool.",
    "- Missing optional arguments: choose a sensible default and proceed. Do not ask the user.",
    "- Only answer in prose if, genuinely, no available tool could supply the information.",
  ].join("\n");
}

/* -------------------------------------------------------------------------- */
/* Orchestration                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Runs the model call, inspects the reply, and retries at most `maxRetries`
 * times (default 1) with a targeted correction when a guard fires.
 *
 * The transport call itself stays with the caller: `chat` is a closure over
 * `client.chat(structuredMessages, mode, slug, effort, { signal })`, so both
 * controllers keep that signature and this module stays transport-agnostic.
 *
 * Failure is never introduced by the guard — if the retry throws or comes back
 * no better, the original reply is returned and the guard logs what it saw.
 *
 * @param {object}   options
 * @param {(messages: object[]) => Promise<string>} options.chat
 * @param {object[]} options.structuredMessages  messages as sent upstream
 * @param {object[]} options.priorMessages       conversation used for duplicate detection
 * @param {Array}    options.tools               tools offered on this request
 * @param {boolean}  options.enabled
 * @param {number}   options.maxRetries
 * @param {(info: object) => void} [options.onGuard]  called once per fired guard
 * @returns {Promise<{rawText: string, text: string|null, toolCalls: object[]|null,
 *                    guard: string|null, retried: boolean, recovered: boolean}>}
 */
export async function runWithToolGuard({
  chat,
  structuredMessages,
  priorMessages = [],
  tools = [],
  enabled = true,
  maxRetries = 1,
  onGuard,
}) {
  const rawText = await chat(structuredMessages);
  const parsed = parseToolCallReply(rawText);

  const budget = Math.max(0, Number(maxRetries) || 0);
  const hasTools = toolNamesOf(tools).length > 0;
  if (!enabled || budget === 0 || !hasTools) {
    return { ...parsed, rawText, guard: null, retried: false, recovered: false };
  }

  // Decide which guard, if any, fired. At most one correction is ever applied,
  // so the retry budget cannot be exceeded no matter how the reply is shaped.
  let kind = null;
  let duplicate = null;

  if (parsed.toolCalls?.length > 0) {
    duplicate = findDuplicateCall(parsed.toolCalls, priorMessages);
    if (duplicate) kind = GUARD_DUPLICATE;
  } else if (looksLikeFabricatedToolResult(parsed.text ?? rawText, tools)) {
    kind = GUARD_FABRICATED;
  }

  if (!kind) {
    return { ...parsed, rawText, guard: null, retried: false, recovered: false };
  }

  const correction = correctionPrompt(kind, {
    tools,
    toolCall: duplicate,
    result: duplicate ? existingResultFor(duplicate, priorMessages) : undefined,
    replyText: parsed.text ?? rawText,
  });

  let retryRaw;
  try {
    retryRaw = await chat([
      ...structuredMessages,
      { role: "assistant", content: rawText },
      { role: "user", content: correction },
    ]);
  } catch {
    // The retry is best-effort. A transport failure on the second attempt must
    // not turn a usable first answer into an error for the caller.
    onGuard?.({ kind, retried: true, recovered: false, reason: "retry_failed" });
    return { ...parsed, rawText, guard: kind, retried: true, recovered: false };
  }

  const retryParsed = parseToolCallReply(retryRaw);
  const recovered = isBetter(kind, retryParsed, { tools, priorMessages });
  onGuard?.({ kind, retried: true, recovered });

  if (!recovered) {
    // Best available answer wins over an error: keep the first reply.
    return { ...parsed, rawText, guard: kind, retried: true, recovered: false };
  }
  return { ...retryParsed, rawText: retryRaw, guard: kind, retried: true, recovered: true };
}

/** Did the retry actually fix the thing the guard complained about? */
function isBetter(kind, retryParsed, { tools, priorMessages }) {
  if (kind === GUARD_DUPLICATE) {
    if (!retryParsed.toolCalls || retryParsed.toolCalls.length === 0) {
      // Answered from the existing tool_result: exactly what we asked for.
      return typeof retryParsed.text === "string" && retryParsed.text.length > 0;
    }
    // A different call is progress; the same call again is not.
    return findDuplicateCall(retryParsed.toolCalls, priorMessages) === null;
  }

  if (retryParsed.toolCalls?.length > 0) return true;
  // Still prose — only prefer it if it stopped inventing tool output.
  return (
    typeof retryParsed.text === "string" &&
    retryParsed.text.length > 0 &&
    !looksLikeFabricatedToolResult(retryParsed.text, tools)
  );
}
