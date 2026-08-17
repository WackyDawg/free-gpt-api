/**
 * Flattens an assistant reply to single-line plain text.
 *
 * The original implementation stripped markdown with
 * `/(\*\*|__|\*|_|~~|`|#{1,6}\s+|[-*+]\s+)/g`, which also matched arithmetic
 * and identifier characters: `return a + b` became `return a b`, and
 * `snake_case` became `snakecase`. That corrupted code and tool-call arguments
 * silently. Here every markdown rule is anchored — emphasis must be paired,
 * bullets and headings must start a line — so operators and identifiers in the
 * middle of text are left alone.
 */

/** Removes markdown formatting without touching operators or identifiers. */
function stripMarkdown(text) {
  return (
    text
      // fenced blocks: drop the fence and its language tag, keep the code
      .replace(/```[a-zA-Z0-9_+-]*\n?/g, "")
      .replace(/``?/g, "")
      // paired emphasis only
      .replace(/\*\*([\s\S]+?)\*\*/g, "$1")
      .replace(/~~([\s\S]+?)~~/g, "$1")
      .replace(/(^|[\s(])\*(?=\S)([\s\S]*?\S)\*(?=[\s).,;:!?]|$)/g, "$1$2")
      // __bold__ / _italic_ only when not inside a word (snake_case is safe)
      .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?![\w])/g, "$1$2")
      .replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?![\w])/g, "$1$2")
      // line-anchored: headings and list bullets
      .replace(/^[ \t]*#{1,6}[ \t]+/gm, "")
      .replace(/^[ \t]*[-*+][ \t]+/gm, "")
      .replace(/^[ \t]*\d+\.[ \t]+/gm, "")
  );
}

/**
 * @param {string} text
 * @param {{ flatten?: boolean, stripMarkdown?: boolean }} options
 */
/**
 * Tool calls are machine payloads, not prose.
 *
 * Flattening a `<tool_call>` blob collapses the newlines inside its JSON
 * arguments, so a Write call carrying a source file arrives as one line. The
 * result is still valid JSON and still parses, which means nothing errors and
 * the caller writes a corrupted file believing it succeeded. So the spans are
 * held out of normalisation entirely and re-inserted verbatim.
 */
const TOOL_CALL_SPAN = /<tool_call\b[\s\S]*?<\/tool_call>/gi;

export function normalizeReply(text, options = {}) {
  if (typeof text !== "string" || text.length === 0) return "";

  const spans = text.match(TOOL_CALL_SPAN);
  if (spans) {
    const parts = text.split(TOOL_CALL_SPAN);
    return parts
      .map((part, index) => {
        const prose = normalizeProse(part, options);
        return index < spans.length ? prose + spans[index] : prose;
      })
      .join("")
      .trim();
  }

  return normalizeProse(text, options);
}

function normalizeProse(text, options = {}) {
  const { flatten = true, stripMarkdown: strip = true } = options;
  if (typeof text !== "string" || text.length === 0) return "";

  let out = text
    // ChatGPT citation markers and inline reference entities
    .replace(/【[^】]+】/g, "")
    .replace(/\[\d+\]/g, "")
    .replace(/entity\["[^"]+","([^"]+)"(?:\s*,\s*"[^"]*")*\]/g, "$1");

  if (strip) out = stripMarkdown(out);

  if (flatten) {
    out = out.replace(/[\r\n]+/g, " ").replace(/[ \t]{2,}/g, " ");
  } else {
    out = out.replace(/[ \t]+$/gm, "");
  }

  return out.trim();
}
