/**
 * Handles the round-trip translation between the OpenAI tool-call wire format
 * and the plain-text representation we inject into the ChatGPT prompt, then
 * parses the model's plain-text reply back into an OpenAI-compatible response.
 */

export function serializeTools(tools) {
  if (!tools || tools.length === 0) return "";
  const lines = ["<available_tools>"];
  for (const tool of tools) {
    if (tool.type !== "function") continue;
    const { name, description, parameters } = tool.function;
    lines.push(`  <tool name="${name}">`);
    if (description)
      lines.push(`    <description>${description}</description>`);
    if (parameters)
      lines.push(`    <parameters>${JSON.stringify(parameters)}</parameters>`);
    lines.push(`  </tool>`);
  }
  lines.push("</available_tools>");
  return lines.join("\n");
}

export function serializeMessage(msg) {
  switch (msg.role) {
    case "system":
      return `[System]: ${msg.content}`;
    case "user":
      return `User: ${msg.content}`;
    case "assistant": {
      const parts = [];
      if (msg.content) parts.push(`Assistant: ${msg.content}`);
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          parts.push(
            `<tool_call id="${tc.id}" name="${tc.function.name}">${tc.function.arguments}</tool_call>`,
          );
        }
      }
      return parts.join("\n");
    }
    case "tool": {
      const id = msg.tool_call_id ? ` id="${msg.tool_call_id}"` : "";
      const content =
        typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content);
      return `<tool_result${id}>${content}</tool_result>`;
    }
    default:
      return typeof msg.content === "string" ? msg.content : "";
  }
}

/** Has any tool already run in this conversation? */
export function hasToolResults(messages) {
  return (
    Array.isArray(messages) &&
    messages.some((msg) => msg?.role === "tool" && msg.content !== undefined)
  );
}

/**
 * The directive repeated last, after the conversation. Placed only among the
 * leading system messages it is reliably acknowledged but rarely acted on —
 * the model answers from its own knowledge instead of emitting a call.
 * Restating it in the most recent position is what makes tool use happen
 * without the user asking for it explicitly.
 *
 * It comes in two variants because one block cannot do both jobs. "Never claim
 * a file is missing, call the tool" is what lifted the trigger rate, and it is
 * also what made the model re-issue calls it had already run; "use the result
 * you already have" pulls the other way and, before any tool has run, reads as
 * permission not to call one. So: forcing wording while the transcript has no
 * <tool_result>, anti-repetition wording once it does.
 */
export function toolReminder(messages) {
  const head = `Reminder: you are running inside an automated agent loop with no direct access to files, the shell, the network, or the user's machine. The ONLY way to obtain that information is to call one of the tools listed in <available_tools>.`;

  if (!hasToolResults(messages)) {
    return `${head}

No tool has run yet in this conversation, so you have observed nothing at all.
- If a tool can supply the information, respond with ONLY the tool call and nothing else:
  <tool_call id="<unique_id>" name="<function_name>">{"arg":"value"}</tool_call>
- Never guess, recall, or invent the contents of a file, a command's output, or any other tool result. Answering from memory when a tool exists is always wrong.
- You have no way to know what exists on the machine. Never claim a file, directory, path, or command is missing, unavailable, or "not found in this environment" — you have not looked. Call the tool; its result is the only evidence about what exists.
- An unfamiliar or unusual-looking path is not evidence that it is absent. Call the tool.
- Never say you checked, read, ran, or looked at something unless a <tool_result> above proves you did.
- Only answer in prose when no tool could supply the information.`;
  }

  return `${head}

One or more tools have already run; their output is in the <tool_result> blocks above. Those results are your observations — use them.
- If the <tool_result> blocks already contain what you need, answer the user directly in prose. Do NOT call the tool again: an identical call returns identical output and stalls the loop.
- Call a tool only for information the existing results do not contain — a different tool, or the same tool with different arguments. Then respond with ONLY the call:
  <tool_call id="<unique_id>" name="<function_name>">{"arg":"value"}</tool_call>
- Never guess or invent anything beyond what the results actually say, and never contradict them.
- For anything not covered by a result, you still have not looked: call the tool rather than claiming a file, path, or command is missing.`;
}

export function buildPromptWithTools(messages, tools, internalSystemPrompt) {
  const sections = [];
  const structuredMessages = [];

  if (internalSystemPrompt) {
    structuredMessages.push({ role: "system", content: internalSystemPrompt });
  }

  const toolBlock = serializeTools(tools);
  if (toolBlock) {
    sections.push(toolBlock);
    structuredMessages.push({ role: "system", content: toolBlock });
  }

  if (tools && tools.length > 0) {
    const toolInstruct = `You are an agent with access to technical tools. When a user request can be fulfilled using a tool, you should PRIORITIZE calling that tool immediately rather than asking for clarification.
If a tool has optional parameters that are missing, use reasonable defaults or make a best guess based on the context to proceed. 
DO NOT ask for confirmation or preference (like units) if you can make a sensible choice yourself.

When you need to invoke a tool, respond ONLY with a JSON block wrapped in <tool_call> tags:
<tool_call id="<unique_id>" name="<function_name>">{"arg1":"value1"}</tool_call>

If you absolutely cannot proceed without more information, only then respond normally.`;
    sections.push(toolInstruct);
    structuredMessages.push({ role: "system", content: toolInstruct });
  }

  sections.push(messages.map(serializeMessage).join("\n\n"));
  structuredMessages.push(...messages);

  if (tools && tools.length > 0) {
    const reminder = toolReminder(messages);
    sections.push(reminder);
    structuredMessages.push({ role: "user", content: reminder });
  }

  sections.push("Assistant:");
  return {
    prompt: sections.join("\n\n"),
    structuredMessages,
  };
}

/**
 * Flattens an internal message into something the upstream conversation
 * endpoint accepts.
 *
 * Two things have to happen here. Upstream only knows the roles
 * user/assistant/system, so a `tool` message must travel as a user turn. And
 * a message's tool calls live in `tool_calls`, not in `content` — passing the
 * message through untouched sends an empty part and silently drops the call
 * from the transcript.
 *
 * @returns {{ role: string, text: string }}
 */
export function toUpstreamMessage(msg) {
  const role = msg.role === "tool" ? "user" : msg.role;

  if (msg.role === "tool") {
    return { role, text: serializeMessage(msg) };
  }

  if (msg.role === "assistant" && msg.tool_calls?.length > 0) {
    const parts = [];
    if (msg.content) parts.push(msg.content);
    for (const call of msg.tool_calls) {
      parts.push(
        `<tool_call id="${call.id}" name="${call.function.name}">${call.function.arguments}</tool_call>`,
      );
    }
    return { role, text: parts.join("\n") };
  }

  const text =
    typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? "");
  return { role, text };
}

export function parseToolCallReply(rawText) {
  const toolCallRegex =
    /<tool_call\s+id="([^"]+)"\s+name="([^"]+)">([\s\S]*?)<\/tool_call>/g;

  const toolCalls = [];
  let match;
  while ((match = toolCallRegex.exec(rawText)) !== null) {
    const [, id, name, rawArgs] = match;
    toolCalls.push({
      id,
      type: "function",
      function: { name, arguments: rawArgs.trim() },
    });
  }

  if (toolCalls.length > 0) return { text: null, toolCalls };
  return { text: rawText.trim(), toolCalls: null };
}
