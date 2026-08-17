import { describe, it, expect, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { requireAuth } from "../middleware/auth.middleware.js";
import { config } from "../config/config.js";

const TOKEN = "s3cret-token";

const app = express();
app.use(express.json());
app.post("/guarded", requireAuth, (_req, res) => res.json({ ok: true }));

const post = () => request(app).post("/guarded").send({});

afterEach(() => {
  config.authToken = "";
});

describe("requireAuth", () => {
  it("is disabled when no token is configured", async () => {
    config.authToken = "";
    expect((await post()).status).toBe(200);
  });

  it("rejects a request with no credentials", async () => {
    config.authToken = TOKEN;
    const res = await post();
    expect(res.status).toBe(401);
    expect(res.body.error.type).toBe("authentication_error");
  });

  it("rejects a wrong token", async () => {
    config.authToken = TOKEN;
    expect((await post().set("x-api-key", "nope")).status).toBe(401);
  });

  it("accepts every header the supported clients send", async () => {
    config.authToken = TOKEN;
    expect((await post().set("x-api-key", TOKEN)).status).toBe(200);
    expect((await post().set("authorization", `Bearer ${TOKEN}`)).status).toBe(200);
    expect((await post().set("authorization", `bearer ${TOKEN}`)).status).toBe(200);
    expect((await post().set("anthropic-auth-token", TOKEN)).status).toBe(200);
  });

  it("strips a trailing model selector from the presented token", async () => {
    config.authToken = TOKEN;
    expect((await post().set("x-api-key", `${TOKEN}:gpt-5.3`)).status).toBe(200);
  });

  it("does not treat an empty presented token as a match", async () => {
    config.authToken = TOKEN;
    expect((await post().set("x-api-key", "")).status).toBe(401);
    expect((await post().set("authorization", "Bearer ")).status).toBe(401);
  });
});
