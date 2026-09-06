import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// These tests exercise DOM/browser APIs without persisted workspaces. New tests
// default to isolated IndexedDB until their dependency needs have been audited.
const domOnly = [
  "components/join-code-field", "components/route-content", "components/reload-prompt", "components/app-header",
  "reader/pdf-page", "reader/reader-runtime", "reader/use-paged-reader", "reader/use-reader-fullscreen",
  "reader/use-reader-preferences", "reader/use-reader-gestures", "reader/reader-navigation-guard",
  "reader/reader-document-cache", "reader/reader-layout-canvas",
  "diagnostics/diagnostic-submission", "diagnostics/diagnostics-page",
  "routes/auth-page", "score-library/upload-dialog", "score-library/drive-library-cache",
  "score-library/drive-library", "score-library/drive-settings-dialog", "score-library/pdf-version-dialog",
  "score-library/invite-code-dialog",
].map(name => `src/client/${name}.test.{ts,tsx}`);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "virtual:pwa-register/react": "/src/test/pwa-register-mock.ts",
    },
  },
  test: {
    projects: [
      { extends: true, test: { name: "dom", environment: "jsdom", include: domOnly, setupFiles: ["./src/test/setup.ts"] } },
      { extends: true, test: {
        name: "database-dom", environment: "jsdom", include: ["src/client/**/*.test.tsx"], exclude: domOnly,
        setupFiles: ["./src/test/setup.ts", "./src/test/setup-database.ts"],
      } },
      { extends: true, test: {
        name: "database-logic", environment: "jsdom", include: ["src/client/**/*.test.ts"],
        exclude: ["**/*.node.test.ts", ...domOnly], setupFiles: ["./src/test/setup-database.ts"],
      } },
    ],
  },
});
