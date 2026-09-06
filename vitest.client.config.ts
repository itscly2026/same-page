import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "virtual:pwa-register/react": "/src/test/pwa-register-mock.ts",
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/client/**/*.test.{ts,tsx}"],
    exclude: ["**/*.node.test.ts"],
    setupFiles: ["./src/test/setup.ts"],
  },
});
