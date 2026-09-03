export interface Env {
  DB: D1Database;
  SCORES_BUCKET: R2Bucket;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  RESEND_API_KEY_SAMEPAGE: string;
  AUTH_EMAIL_FROM: string;
  INVITE_SECRET: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  WECHAT_CLIENT_ID?: string;
  WECHAT_CLIENT_SECRET?: string;
}

export interface AppEnvironment {
  Bindings: Env;
}

export interface WaitUntilContext {
  waitUntil(promise: Promise<unknown>): void;
}
