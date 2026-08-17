/**
 * Flattens an assistant reply to single-line plain text.
 *
 * Every markdown rule below is anchored — emphasis must be paired, bullets and
 * headings must start a line — so that operators and identifiers mid-text are
 * left alone. An unanchored strip turns `return a + b` into `return a b` and
 * `snake_case` into `snakecase`, silently corrupting code.
 */
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
 * Tool calls are machine payloads: flattening one collapses the newlines
 * inside its JSON arguments, which still parses, so a Write call silently
 * writes a corrupted file. These spans are held out and re-inserted verbatim.
 */
const TOOL_CALL_SPAN = /<tool_call\b[\s\S]*?<\/tool_call>/gi;

/**
 * @param {string} text
 * @param {{ flatten?: boolean, stripMarkdown?: boolean }} options
 */
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
