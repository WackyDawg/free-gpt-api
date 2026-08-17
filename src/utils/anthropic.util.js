/**
 * Translation between the Anthropic Messages API and the internal
 * (OpenAI-shaped) pipeline used by tools.util.js.
 *
 * Anthropic request -> OpenAI-shaped messages/tools -> buildPromptWithTools
 * ChatGPT reply -> parseToolCallReply -> Anthropic content blocks / SSE events
 *
 * Reusing the OpenAI shape in the middle means tool calling behaves identically
 * for /v1/messages and /v1/chat/completions — there is one prompt format and
 * one reply parser, not two.
 */

import { randomUUID } from "crypto";
import { config } from "../config/config.js";

/**
 * Routes a Claude model name to a backend model id by class.
 * Claude Code sends names like `claude-opus-4-20250514`,
 * `claude-sonnet-4-5-20250929`, `claude-3-5-haiku-20241022`.
 */
export function resolveClaudeModel(name) {
  const lower = typeof name === "string" ? name.toLowerCase() : "";
  if (lower.includes("opus")) return config.modelOpus;
  if (lower.includes("haiku")) return config.modelHaiku;
  if (lower.includes("sonnet")) return config.modelSonnet;
  // Anything else (including a backend model id passed straight through) is
  // used verbatim so callers can target a specific upstream model.
  return name || config.modelSonnet;
}

/** Anthropic tool ids are conventionally `toolu_`-prefixed. */
export function toolUseId(id) {
  if (typeof id === "string" && id.startsWith("toolu_")) return id;
  const suffix = typeof id === "string" && id ? id.replace(/[^A-Za-z0-9_-]/g, "") : randomUUID().replace(/-/g, "").slice(0, 24);
  return `toolu_${suffix}`;
}

/** Flattens a `system` field that may be a string or an array of blocks. */
export function systemToText(system) {
  if (!system) return "";
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  return system
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n\n");
}

function blockToText(block) {
  if (typeof block === "string") return block;
  if (!block || typeof block !== "object") return "";

  switch (block.type) {
    case "text":
      return typeof block.text === "string" ? block.text : "";
    case "thinking":
    case "redacted_thinking":
      // Never replay prior reasoning back into the prompt.
      return "";
    case "image":
      // The upstream transport is a text box; images cannot be forwarded.
      return "[image omitted: this proxy forwards text only]";
    case "document":
      return "[document omitted: this proxy forwards text only]";
    default:
      return "";
  }
}

/** tool_result content may be a string or an array of blocks. */
function toolResultToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(blockToText).filter(Boolean).join("\n");
  if (content == null) return "";
  return JSON.stringify(content);
}

/**
 * Converts Anthropic messages into the OpenAI-shaped list the prompt builder
 * expects. A single Anthropic user message can produce several internal
 * messages, because tool_result blocks become their own `tool` messages.
 */
export function anthropicMessagesToInternal(messages = []) {
  const out = [];

  for (const message of messages) {
    const role = message?.role;
    const content = message?.content;

    if (typeof content === "string") {
      out.push({ role, content });
      continue;
    }
    if (!Array.isArray(content)) continue;

    if (role === "assistant") {
      const text = content.map(blockToText).filter(Boolean).join("\n");
      const toolCalls = content
        .filter((block) => block?.type === "tool_use")
        .map((block) => ({
          id: toolUseId(block.id),
          type: "function",
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          },
        }));
      if (text || toolCalls.length > 0) {
        out.push({
          role: "assistant",
          content: text,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        });
      }
      continue;
    }

    // user (or anything else): tool_result blocks break out into `tool`
    // messages so the prompt shows each result against its call id.
    const texts = [];
    for (const block of content) {
      if (block?.type === "tool_result") {
        if (texts.length > 0) {
          out.push({ role: "user", content: texts.join("\n") });
          texts.length = 0;
        }
        out.push({
          role: "tool",
          tool_call_id: toolUseId(block.tool_use_id),
          content: toolResultToText(block.content),
        });
        continue;
      }
      const text = blockToText(block);
      if (text) texts.push(text);
    }
    if (texts.length > 0) out.push({ role: role || "user", content: texts.join("\n") });
  }

  return out;
}

/** Anthropic tool definitions -> OpenAI function-tool definitions. */
export function anthropicToolsToInternal(tools = []) {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((tool) => tool && typeof tool.name === "string")
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description || "",
        parameters: tool.input_schema || tool.parameters || { type: "object", properties: {} },
      },
    }));
}

/**
 * Reply (text + OpenAI-shaped tool calls) -> Anthropic content blocks.
 * @returns {{ content: object[], stopReason: string }}
 */
export function replyToContentBlocks(text, toolCalls) {
  const content = [];

  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    for (const call of toolCalls) {
      let input = {};
      try {
        input = JSON.parse(call.function?.arguments || "{}");
      } catch {
        // Keep the raw string rather than dropping the call outright.
        input = { _raw: call.function?.arguments ?? "" };
      }
      content.push({
        type: "tool_use",
        id: toolUseId(call.id),
        name: call.function?.name || "unknown",
        input,
      });
    }
    return { content, stopReason: "tool_use" };
  }

  content.push({ type: "text", text: text ?? "" });
  return { content, stopReason: "end_turn" };
}

/**
 * Builds the full Anthropic SSE event sequence for a completed reply.
 *
 * The upstream browser transport resolves with the whole reply, so text is
 * emitted as a series of text_delta chunks rather than true token-by-token
 * streaming. The event ordering is exactly what a streaming client expects,
 * which is what matters for compatibility.
 *
 * @returns {Array<{ event: string, data: object }>}
 */
export function buildMessageStreamEvents({
  messageId,
  model,
  content,
  stopReason,
  inputTokens = 0,
  outputTokens = 0,
  chunkSize = 96,
}) {
  const events = [];

  events.push({
    event: "message_start",
    data: {
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: 0 },
      },
    },
  });
  events.push({ event: "ping", data: { type: "ping" } });

  content.forEach((block, index) => {
    if (block.type === "text") {
      events.push({
        event: "content_block_start",
        data: {
          type: "content_block_start",
          index,
          content_block: { type: "text", text: "" },
        },
      });
      const text = block.text ?? "";
      for (let at = 0; at < text.length; at += chunkSize) {
        events.push({
          event: "content_block_delta",
          data: {
            type: "content_block_delta",
            index,
            delta: { type: "text_delta", text: text.slice(at, at + chunkSize) },
          },
        });
      }
      if (text.length === 0) {
        events.push({
          event: "content_block_delta",
          data: {
            type: "content_block_delta",
            index,
            delta: { type: "text_delta", text: "" },
          },
        });
      }
      events.push({ event: "content_block_stop", data: { type: "content_block_stop", index } });
      return;
    }

    if (block.type === "tool_use") {
      events.push({
        event: "content_block_start",
        data: {
          type: "content_block_start",
          index,
          content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
        },
      });
      const json = JSON.stringify(block.input ?? {});
      for (let at = 0; at < json.length; at += chunkSize) {
        events.push({
          event: "content_block_delta",
          data: {
            type: "content_block_delta",
            index,
            delta: { type: "input_json_delta", partial_json: json.slice(at, at + chunkSize) },
          },
        });
      }
      events.push({ event: "content_block_stop", data: { type: "content_block_stop", index } });
    }
  });

  events.push({
    event: "message_delta",
    data: {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: outputTokens },
    },
  });
  events.push({ event: "message_stop", data: { type: "message_stop" } });

  return events;
}

/** Serialises one event to the SSE wire format. */
export function formatSseEvent({ event, data }) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Anthropic-shaped error body. */
export function anthropicError(type, message) {
  return { type: "error", error: { type, message } };
}
