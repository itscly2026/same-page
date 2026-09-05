export interface Env {
  DB: D1Database;
  IMAGE_JOBS: Queue<{ versionId: string; generation: string }>;
  PDF_RENDERER: DurableObjectNamespace<import("./images/container").PdfRenderer>;
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
  PERFORMANCE_TEST_DELAY_MS?: string;
}

export interface AppEnvironment {
  Bindings: Env;
  Variables: {
    serverTiming?: import("./performance/server-timing").RequestServerTiming;
  };
}

export interface WaitUntilContext {
  waitUntil(promise: Promise<unknown>): void;
}
