import { config } from "../config/config.js";
import { anthropicError } from "../utils/anthropic.util.js";

/**
 * Optional shared-secret auth for the proxy.
 *
 * Disabled when ANTHROPIC_AUTH_TOKEN is unset, which keeps the default
 * localhost setup zero-config. When set, the token is accepted from any of the
 * headers the supported clients actually send:
 *   - x-api-key            (Claude Code with ANTHROPIC_API_KEY)
 *   - authorization: Bearer (Claude Code with ANTHROPIC_AUTH_TOKEN, Codex, opencode)
 *   - anthropic-auth-token  (explicit override)
 */
export function requireAuth(req, res, next) {
  const expected = config.authToken;
  if (!expected) return next();

  const bearer = req.get("authorization") || "";
  const presented =
    req.get("x-api-key") ||
    req.get("anthropic-auth-token") ||
    (bearer.toLowerCase().startsWith("bearer ") ? bearer.slice(7).trim() : "");

  // Clients may append a model selector after a colon (token:model-id).
  const token = presented.includes(":") ? presented.split(":")[0] : presented;

  if (token && token === expected) return next();

  return res
    .status(401)
    .json(anthropicError("authentication_error", "invalid or missing API key"));
}
