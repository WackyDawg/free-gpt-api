import express from "express";

const modelsRouter = express.Router();

// const MODELS = [
//   { id: "gpt-5.4-thinking-mini", _slug: "gpt-5-4-t-mini", max_tokens: 262144, reasoning_type: "auto" },
//   { id: "gpt-5.3",               _slug: "gpt-5-3",         max_tokens: 34834,  reasoning_type: "auto" },
//   { id: "gpt-5.2",               _slug: "gpt-5-2",         max_tokens: 25384,  reasoning_type: "auto" },
//   { id: "gpt-5.1",               _slug: "gpt-5-1",         max_tokens: 17384,  reasoning_type: "auto" },
//   { id: "gpt-5",                 _slug: "gpt-5",           max_tokens: 16384,  reasoning_type: "auto" },
//   { id: "gpt-5-mini",            _slug: "gpt-5-mini",      max_tokens: 16384,  reasoning_type: "none" },
//   { id: "gpt-5-thinking-mini",   _slug: "gpt-5-t-mini",    max_tokens: 196608, reasoning_type: "auto" },
//   { id: "deep-research",         _slug: "research",         max_tokens: 34815,  reasoning_type: "none" },
//   { id: "auto",                  _slug: "auto",            max_tokens: 16384,  reasoning_type: "auto" },
// ];

const MODELS = [
  {
    id: "gpt-5.4-thinking-mini",
    _slug: "gpt-5-4-t-mini",
    max_tokens: 34834,
    owned_by: "openai",
    object: "model",
    created: 1740614400,
  },
  {
    id: "gpt-5.3-nano",
    _slug: "gpt-5-3-nano",
    max_tokens: 34834,
    owned_by: "openai",
    object: "model",
    created: 1740614400,
  },
  {
    id: "gpt-5-thinking-mini",
    _slug: "gpt-5-t-mini",
    max_tokens: 34834,
    owned_by: "openai",
    object: "model",
    created: 1740614400,
  },
  {
    id: "gpt-5.3",
    _slug: "gpt-5-3",
    max_tokens: 34834,
    owned_by: "openai",
    object: "model",
    created: 1740614400,
  },
  {
    id: "gpt-5.2",
    _slug: "gpt-5-2",
    max_tokens: 25384,
    owned_by: "openai",
    object: "model",
    created: 1740614400,
  },
  {
    id: "gpt-5.1",
    _slug: "gpt-5-1",
    max_tokens: 17384,
    owned_by: "openai",
    object: "model",
    created: 1740614400,
  },
  {
    id: "gpt-5",
    _slug: "gpt-5",
    max_tokens: 16384,
    owned_by: "openai",
    object: "model",
    created: 1740614400,
  },
  {
    id: "gpt-5-mini",
    _slug: "gpt-5-mini",
    max_tokens: 8191,
    owned_by: "openai",
    object: "model",
    created: 1740614400,
  },
  {
    id: "gpt-5.4-pro",
    _slug: "gpt-5-4-pro",
    max_tokens: 128000,
    owned_by: "openai",
    object: "model",
    created: 1740614400,
  },
  {
    id: "auto",
    _slug: "auto",
    max_tokens: 16384,
    owned_by: "openai",
    object: "model",
    created: 1740614400,
  },
  {
    id: "o1",
    _slug: "o1",
    max_tokens: 128000,
    owned_by: "openai",
    object: "model",
    created: 1740614400,
  },
  {
    id: "o1-mini",
    _slug: "o1-mini",
    max_tokens: 128000,
    owned_by: "openai",
    object: "model",
    created: 1740614400,
  },
  {
    id: "gpt-4o",
    _slug: "gpt-4o",
    max_tokens: 128000,
    owned_by: "openai",
    object: "model",
    created: 1740614400,
  },
  {
    id: "gpt-4o-mini",
    _slug: "gpt-4o-mini",
    max_tokens: 128000,
    owned_by: "openai",
    object: "model",
    created: 1740614400,
  },
];

export const MODEL_SLUG_MAP = Object.fromEntries(
  MODELS.map((m) => [m.id, m._slug]),
);

export const MODEL_MAX_TOKENS = Object.fromEntries(
  MODELS.map((m) => [m.id, m.max_tokens]),
);

modelsRouter.get("/", (_req, res) => {
  res.json({
    object: "list",
    data: MODELS.map(({ _slug, ...rest }) => rest),
  });
});

modelsRouter.get("/:id", (req, res) => {
  const model = MODELS.find((m) => m.id === req.params.id);
  if (!model) {
    return res.status(404).json({
      error: {
        message: `Model '${req.params.id}' not found`,
        type: "invalid_request_error",
      },
    });
  }
  const { _slug, ...rest } = model;
  res.json(rest);
});

export default modelsRouter;
