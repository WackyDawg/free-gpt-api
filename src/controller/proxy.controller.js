import { randomUUID } from "crypto";
import { ChatGPTClient } from "../utils/browser.util.js";
import { estimateTokens } from "../utils/token.util.js";
import {
  buildPromptWithTools,
  parseToolCallReply,
} from "../utils/tools.util.js";
import { config } from "../config/config.js";

export const client = new ChatGPTClient();

export class ProxyController {
  async chat(req, res) {
    const { messages, tools, model, mode, stream } = req.body;

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
      const rawText = await client.chat(structuredMessages, mode || "default");
      const { text, toolCalls } = parseToolCallReply(rawText);

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
              content: text,
            },
            finish_reason: "stop",
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
