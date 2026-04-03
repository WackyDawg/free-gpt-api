import express from "express";
import proxyController from "../controller/proxy.controller.js";

const proxyRouter = express.Router();

proxyRouter.post("/completions", proxyController.chat.bind(proxyController));

export default proxyRouter;
