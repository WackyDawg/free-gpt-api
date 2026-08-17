import { config } from "../config/config.js";
import { anthropicError } from "../utils/anthropic.util.js";

/**
 * Optional shared-secret auth, disabled when ANTHROPIC_AUTH_TOKEN is unset so
 * the default localhost setup stays zero-config. The token is accepted from
 * x-api-key, `authorization: Bearer` or anthropic-auth-token, which is what
 * the supported clients send.
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
