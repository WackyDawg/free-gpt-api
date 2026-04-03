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

  sections.push("Assistant:");
  return {
    prompt: sections.join("\n\n"),
    structuredMessages,
  };
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
