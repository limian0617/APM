import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url))
    }
  },
  test: {
    environment: "node",
    fileParallelism: process.env.RUN_DATABASE_INTEGRATION !== "1",
    include: ["src/**/*.test.ts"]
  }
});
