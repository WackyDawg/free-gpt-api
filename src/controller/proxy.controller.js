import { randomUUID } from "crypto";
import { ChatGPTClient } from "../utils/browser.util.js";
import { estimateTokens } from "../utils/token.util.js";
import {
  buildPromptWithTools,
  parseToolCallReply,
} from "../utils/tools.util.js";
import { config } from "../config/config.js";
import { MODEL_SLUG_MAP, MODEL_MAX_TOKENS } from "../routes/models.route.js";

export const client = new ChatGPTClient();

export class ProxyController {
  async chat(req, res) {
    const { messages, tools, model, mode, stream, max_tokens } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        error: {
          message: "messages is required",
          type: "invalid_request_error",
        },
      });
    }

    if (stream) {
      return res.status(400).json({
        error: {
          message: "stream is not supported by this proxy",
          type: "invalid_request_error",
        },
      });
    }

    const { prompt, structuredMessages } = buildPromptWithTools(
      messages,
      tools,
      config.systemPrompt,
    );

    try {
      const requestedModel = model || "gpt-5.3";
      const gptSlug = MODEL_SLUG_MAP[requestedModel] ?? "auto";
      const modelMaxTokens = MODEL_MAX_TOKENS[requestedModel] ?? 16384;

      const effectiveMaxTokens = max_tokens
        ? Math.min(max_tokens, modelMaxTokens)
        : modelMaxTokens;

      const rawText = await client.chat(
        structuredMessages,
        mode || "default",
        gptSlug,
      );

      const { text, toolCalls } = parseToolCallReply(rawText);

      let finalText = text;
      let finishReason = "stop";

      if (effectiveMaxTokens) {
        const tokens = estimateTokens(finalText);
        if (tokens > effectiveMaxTokens) {
          const ratio = effectiveMaxTokens / tokens;
          finalText = finalText.slice(0, Math.floor(finalText.length * ratio));
          finishReason = "length";
        }
      }

      const promptTokens = estimateTokens(prompt);
      const completionTokens = estimateTokens(rawText);

      const choice = toolCalls
        ? {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: toolCalls,
            },
            finish_reason: "tool_calls",
          }
        : {
            index: 0,
            message: {
              role: "assistant",
              content: finalText,
            },
            finish_reason: finishReason,
          };

      return res.json({
        id: `chatcmpl-${randomUUID()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: model || "chatgpt-proxy",
        choices: [choice],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
      });
    } catch (err) {
      return res.status(500).json({
        error: { message: err.message, type: "proxy_error" },
      });
    }
  }
}

export default new ProxyController();
