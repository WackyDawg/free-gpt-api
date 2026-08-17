import { randomUUID } from "crypto";
import chalk from "chalk";
import { client, abortSignalFor } from "./proxy.controller.js";
import { estimateTokens } from "../utils/token.util.js";
import { buildPromptWithTools } from "../utils/tools.util.js";
import { messagesWithFiles, extractFileBlocks, partitionFiles } from "../utils/files.util.js";
import { runWithToolGuard } from "../utils/tool-guard.util.js";
import { config } from "../config/config.js";
import { MODEL_SLUG_MAP, MODEL_MAX_TOKENS } from "../routes/models.route.js";
import {
  anthropicError,
  anthropicMessagesToInternal,
  anthropicToolsToInternal,
  buildMessageStreamEvents,
  formatSseEvent,
  replyToContentBlocks,
  resolveClaudeModel,
  systemToText,
} from "../utils/anthropic.util.js";

/**
 * Anthropic Messages API surface, so Claude Code CLI (and any other Anthropic
 * client) can point ANTHROPIC_BASE_URL at this proxy.
 */
export class MessagesController {
  async createMessage(req, res) {
    const {
      model,
      messages,
      system,
      tools,
      max_tokens: maxTokens,
      stream,
      thinking,
      metadata,
      files,
    } = req.body || {};

    if (!Array.isArray(messages) || messages.length === 0) {
      return res
        .status(400)
        .json(anthropicError("invalid_request_error", "messages: at least one message is required"));
    }

    const backendModel = resolveClaudeModel(model);
    const gptSlug = MODEL_SLUG_MAP[backendModel] ?? "auto";
    const modelMaxTokens = MODEL_MAX_TOKENS[backendModel] ?? 16384;

    // The client asking for `thinking` is not enough: the effort control only
    // exists on thinking models, and elsewhere upstream rejects the request
    // with "Invalid conversation body".
    const thinkingEffort = /thinking/i.test(String(backendModel)) ? "extended" : undefined;

    // Files may arrive as a top-level `files` array or as inline `file` content
    // blocks; both become leading user messages the model reads before the
    // prompt (large ones as native big-paste attachments).
    const { files: blockFiles, cleanedMessages } = extractFileBlocks(messages);
    const { textFiles, binaryFiles } = partitionFiles([...(files || []), ...blockFiles]);
    const withFiles = messagesWithFiles(cleanedMessages, textFiles);
    const internalMessages = anthropicMessagesToInternal(withFiles);
    const systemText = systemToText(system);
    const internalTools = anthropicToolsToInternal(tools);

    // Agent clients ship their own system prompt; ours would compete with it,
    // so it is only a fallback for bare clients.
    const combinedSystem = systemText || config.systemPrompt;

    const { prompt, structuredMessages } = buildPromptWithTools(
      internalMessages,
      internalTools,
      combinedSystem,
    );

    const inputTokens = estimateTokens(prompt);
    const messageId = `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`;

    console.log(
      chalk.blueBright("===> ") +
        `[messages] model=${model} -> ${backendModel} msgs=${messages.length} ` +
        `tools=${internalTools.length} stream=${Boolean(stream)}`,
    );

    let rawText;
    let text;
    let toolCalls;
    try {
      const signal = abortSignalFor(req, res);
      ({ rawText, text, toolCalls } = await runWithToolGuard({
        chat: (msgs) =>
          client.chat(msgs, "default", gptSlug, thinkingEffort, { signal, attachFiles: binaryFiles }),
        structuredMessages,
        priorMessages: internalMessages,
        tools: internalTools,
        enabled: config.toolGuard,
        maxRetries: config.toolGuardMaxRetries,
        onGuard: ({ kind, recovered }) =>
          console.log(
            chalk.yellow("===> ") +
              `[tool-guard] ${kind} on /v1/messages — retried, ` +
              (recovered ? "corrected" : "kept original reply"),
          ),
      }));
    } catch (err) {
      if (err.code === "request_aborted") return; // caller hung up
      console.error(chalk.redBright("===> ") + "[messages] " + err.message);

      if (stream && res.headersSent) {
        res.write(formatSseEvent({ event: "error", data: anthropicError("api_error", err.message) }));
        return res.end();
      }
      if (err.code === "pool_saturated") {
        return res
          .status(429)
          .set("Retry-After", "5")
          .json(anthropicError("rate_limit_error", err.message));
      }
      const status = err.message?.startsWith("auth_expired") ? 401 : 502;
      return res.status(status).json(anthropicError("api_error", err.message));
    }

    let { content, stopReason } = replyToContentBlocks(text, toolCalls);

    const limit = maxTokens ? Math.min(maxTokens, modelMaxTokens) : modelMaxTokens;
    let outputTokens = estimateTokens(rawText);
    if (stopReason === "end_turn" && limit && outputTokens > limit) {
      const ratio = limit / outputTokens;
      content = content.map((block) =>
        block.type === "text"
          ? { ...block, text: block.text.slice(0, Math.floor(block.text.length * ratio)) }
          : block,
      );
      stopReason = "max_tokens";
      outputTokens = limit;
    }

    if (!stream) {
      return res.json({
        id: messageId,
        type: "message",
        role: "assistant",
        model: model || backendModel,
        content,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      });
    }

    res.status(200).set({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();

    for (const event of buildMessageStreamEvents({
      messageId,
      model: model || backendModel,
      content,
      stopReason,
      inputTokens,
      outputTokens,
    })) {
      res.write(formatSseEvent(event));
    }
    return res.end();
  }

  async countTokens(req, res) {
    const { messages, system, tools } = req.body || {};
    if (!Array.isArray(messages)) {
      return res
        .status(400)
        .json(anthropicError("invalid_request_error", "messages: expected an array"));
    }

    const { prompt } = buildPromptWithTools(
      anthropicMessagesToInternal(messages),
      anthropicToolsToInternal(tools),
      systemToText(system),
    );
    return res.json({ input_tokens: estimateTokens(prompt) });
  }
}

export default new MessagesController();
