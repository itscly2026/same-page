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
    include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.js"],
    setupFiles: ["./src/test/setup.ts"],
  },
});
