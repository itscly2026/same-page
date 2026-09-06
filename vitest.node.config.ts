import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["scripts/**/*.test.js", "src/shared/**/*.test.ts", "src/client/**/*.node.test.ts"],
  },
});
