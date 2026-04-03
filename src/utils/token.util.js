import { getEncoding } from "js-tiktoken";

const enc = getEncoding("cl100k_base");

/**
 * Accurately count OpenAI tokens using tiktoken.
 *
 * @param {string} text
 * @returns {number}
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
