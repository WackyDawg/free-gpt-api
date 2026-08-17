import express from "express";
import messagesController from "../controller/messages.controller.js";

const messagesRouter = express.Router();

messagesRouter.post("/", messagesController.createMessage.bind(messagesController));
messagesRouter.post(
  "/count_tokens",
  messagesController.countTokens.bind(messagesController),
);

export default messagesRouter;
