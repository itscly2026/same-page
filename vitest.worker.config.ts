import path from "node:path";

import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        d1Databases: ["DB"],
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(
            path.join(process.cwd(), "migrations"),
          ),
          BETTER_AUTH_SECRET:
            "test-better-auth-secret-with-at-least-32-characters",
          BETTER_AUTH_URL: "https://same-page.test",
          RESEND_API_KEY: "re_test_key",
          AUTH_EMAIL_FROM: "Same Page <login@example.test>",
          INVITE_SECRET: "test-invite-secret-with-at-least-32-characters",
        },
      },
    })),
  ],
  test: {
    include: ["worker/**/*.test.ts"],
    setupFiles: ["./worker/test/setup.ts"],
  },
});
