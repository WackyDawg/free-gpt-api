import app from "./app.js";
import { client } from "./controller/proxy.controller.js";
import chalk from "chalk";

process.on("uncaughtException", (err) => {
  console.error(chalk.redBright("===> ") + "[fatal] uncaught exception:", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error(chalk.redBright("===> ") + "[fatal] unhandled rejection:", reason);
  process.exit(1);
});

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, async () => {
  console.log(chalk.greenBright("===> ") + `Server running on port ${PORT}`);
  console.log(chalk.blueBright("===> ") + "Initializing browser...");
  try {
    await client.init();
  } catch (err) {
    console.warn(chalk.yellowBright("===> ") + `[init] initial browser launch failed: ${err.message}. It will retry on the first request.`);
  }
});

server.on("error", (err) => {
  console.error(chalk.redBright("===> ") + "[fatal] server error:", err);
  process.exit(1);
});
