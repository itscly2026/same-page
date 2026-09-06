import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "worker/images/renderer.test.ts",
      "worker/auth/social-providers.test.ts",
      "worker/email/send-otp.test.ts",
      "worker/performance/server-timing.test.ts",
      "worker/security/security.test.ts",
    ],
  },
});
