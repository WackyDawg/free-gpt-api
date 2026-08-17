import { randomUUID } from "crypto";
import chalk from "chalk";
import { ChatGPTClientPool } from "../utils/browser.pool.js";
import { estimateTokens } from "../utils/token.util.js";
import { buildPromptWithTools } from "../utils/tools.util.js";
import { runWithToolGuard } from "../utils/tool-guard.util.js";
import { config } from "../config/config.js";
import { MODEL_SLUG_MAP, MODEL_MAX_TOKENS } from "../routes/models.route.js";

export const client = new ChatGPTClientPool();

/**
 * Aborts when the caller hangs up. This only prevents work that has not
 * started; a request already executing in the browser runs to completion and
 * frees its worker when it finishes.
 */
export function abortSignalFor(req, res) {
  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  req.on("close", onClose);
  res.on("finish", () => req.off("close", onClose));
  return controller.signal;
}

export class ProxyController {
  async chat(req, res) {
    const {
      messages,
      tools,
      model,
      mode,
      stream,
      max_tokens,
      thinking_effort,
      reasoning_effort,
    } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        error: {
          message: "messages is required",
          type: "invalid_request_error",
        },
      });
    }


    // Only inject the built-in prompt when the caller supplied none of its own;
    // agent clients bring a system prompt that ours would otherwise compete with.
    const callerHasSystem = messages.some((m) => m?.role === "system" && m.content);
    const { prompt, structuredMessages } = buildPromptWithTools(
      messages,
      tools,
      callerHasSystem ? undefined : config.systemPrompt,
    );

    try {
      const requestedModel = model || "gpt-5.3";
      const gptSlug = MODEL_SLUG_MAP[requestedModel] ?? "auto";
      const modelMaxTokens = MODEL_MAX_TOKENS[requestedModel] ?? 16384;
      // Only thinking models accept an effort setting; upstream rejects the
      // whole request with "Invalid conversation body" if one is attached to
      // any other model. Clients send this unconditionally — opencode puts
      // reasoning_effort on every call — so it has to be filtered here rather
      // than trusted.
      const supportsThinking = /thinking/i.test(requestedModel);
      const effectiveThinkingEffort = supportsThinking
        ? thinking_effort || reasoning_effort || "extended"
        : undefined;

      const effectiveMaxTokens = max_tokens
        ? Math.min(max_tokens, modelMaxTokens)
        : modelMaxTokens;

      const signal = abortSignalFor(req, res);

      // Tool compliance is prompt-based upstream, so the reply is inspected
      // rather than trusted: an invented tool result or a call whose
      // <tool_result> is already in the transcript buys one corrective retry.
      const { rawText, text, toolCalls } = await runWithToolGuard({
        chat: (msgs) =>
          client.chat(msgs, mode || "default", gptSlug, effectiveThinkingEffort, {
            signal,
          }),
        structuredMessages,
        priorMessages: messages,
        tools,
        enabled: config.toolGuard,
        maxRetries: config.toolGuardMaxRetries,
        onGuard: ({ kind, recovered }) =>
          console.log(
            chalk.yellow("===> ") +
              `[tool-guard] ${kind} on /v1/chat/completions — retried, ` +
              (recovered ? "corrected" : "kept original reply"),
          ),
      });

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

      const id = `chatcmpl-${randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);
      const usage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      };

      if (stream) {
        return this._streamCompletion(res, {
          id,
          created,
          model: model || "chatgpt-proxy",
          choice,
          usage,
        });
      }

      return res.json({
        id,
        object: "chat.completion",
        created,
        model: model || "chatgpt-proxy",
        choices: [choice],
        usage,
      });
    } catch (err) {
      if (err.code === "request_aborted") return; // caller hung up
      if (res.headersSent) {
        res.write("data: [DONE]\n\n");
        return res.end();
      }
      if (err.code === "pool_saturated") {
        return res
          .status(429)
          .set("Retry-After", "5")
          .json({ error: { message: err.message, type: "rate_limit_error" } });
      }
      return res.status(500).json({
        error: { message: err.message, type: "proxy_error" },
      });
    }
  }

  /**
   * Emits an OpenAI chat.completion.chunk stream. The upstream transport
   * resolves with the whole reply, so text is chunked here rather than
   * streamed token by token; the chunk sequence is what clients parse.
   */
  _streamCompletion(res, { id, created, model, choice, usage }) {
    res.status(200).set({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();

    const send = (delta, finishReason = null) => {
      res.write(
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        })}\n\n`,
      );
    };

    send({ role: "assistant", content: "" });

    if (choice.message.tool_calls) {
      choice.message.tool_calls.forEach((call, index) => {
        send({
          tool_calls: [
            {
              index,
              id: call.id,
              type: "function",
              function: { name: call.function.name, arguments: call.function.arguments },
            },
          ],
        });
      });
    } else {
      const text = choice.message.content ?? "";
      const size = 96;
      for (let at = 0; at < text.length; at += size) {
        send({ content: text.slice(at, at + size) });
      }
    }

    send({}, choice.finish_reason);
    res.write(
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [],
        usage,
      })}\n\n`,
    );
    res.write("data: [DONE]\n\n");
    return res.end();
  }
}

export default new ProxyController();
