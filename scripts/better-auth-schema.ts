import { betterAuth } from "better-auth/minimal";
import { emailOTP } from "better-auth/plugins";

// Schema-only configuration. Runtime secrets, D1 and Resend are injected by
// worker/auth/create-auth.ts and must never be added here.
export const auth = betterAuth({
  baseURL: "http://127.0.0.1:5173",
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
  },
  plugins: [
    emailOTP({
      async sendVerificationOTP() {
        // The CLI only inspects plugin schemas; it never sends an email.
      },
    }),
  ],
});
