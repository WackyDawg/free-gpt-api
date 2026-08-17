import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Runs before config.js reads the environment, so a developer's local .env
    // cannot change what the suite asserts. See src/tests/setup.js.
    setupFiles: ["./src/tests/setup.js"],
    include: ["src/tests/**/*.test.js"],
  },
});
