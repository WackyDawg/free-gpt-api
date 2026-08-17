import express from "express";
import proxyRouter from "./routes/proxy.route.js";
import modelsRouter from "./routes/models.route.js";
import messagesRouter from "./routes/messages.route.js";
import { requireAuth } from "./middleware/auth.middleware.js";
import { client } from "./controller/proxy.controller.js";

const app = express();

// Claude Code and Codex can send large tool-result payloads; the 100kb
// express default rejects them.
app.use(express.json({ limit: "50mb" }));

// Anthropic surface (Claude Code CLI, opencode with an anthropic provider)
app.use("/v1/messages", requireAuth, messagesRouter);

// OpenAI surface (Codex, opencode with an openai-compatible provider)
app.use("/v1/chat", requireAuth, proxyRouter);
app.use("/v1/models", modelsRouter);

app.get("/health", (_req, res) => res.json({ status: "ok", pool: client.stats() }));
app.get("/", (_req, res) =>
  res.json({
    name: "free-gpt-api",
    endpoints: ["/v1/messages", "/v1/messages/count_tokens", "/v1/chat/completions", "/v1/models", "/health"],
  }),
);

export default app;
