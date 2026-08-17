/**
 * The suite must not depend on whoever's .env happens to be on disk.
 *
 * config.js calls dotenv.config() at import time, and dotenv skips any key
 * already present in process.env — so pinning values here wins over the file.
 * ANTHROPIC_AUTH_TOKEN is the one that actually breaks things: a real token in
 * .env makes every controller test 401. Auth itself is covered explicitly in
 * auth.middleware.test.js rather than through ambient config.
 */

process.env.ANTHROPIC_AUTH_TOKEN = "";
process.env.FLATTEN_OUTPUT = "true";
process.env.STRIP_MARKDOWN = "true";
process.env.TOOL_GUARD = "true";
process.env.TOOL_GUARD_MAX_RETRIES = "1";
