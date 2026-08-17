import { getEncoding } from "js-tiktoken";

const enc = getEncoding("cl100k_base");

/**
 * @param {string} text
 * @returns {number} tiktoken (cl100k_base) token count
 */
export function estimateTokens(text) {
  if (!text) return 0;
  try {
    return enc.encode(text).length;
  } catch (err) {
    console.error("[token_util] encode error:", err);
    return Math.ceil(text.length / 3.5);
  }
}
