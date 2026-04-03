import express from "express";
import proxyRouter from "./routes/proxy.route.js";

const app = express();

app.use(express.json());

app.use("/v1/chat", proxyRouter);

app.get("/health", (_req, res) => res.json({ status: "ok" }));

export default app;
