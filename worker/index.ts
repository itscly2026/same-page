import { Hono } from "hono";

import { healthResponseSchema } from "../src/shared/health";

const app = new Hono().basePath("/api");

app.get("/health", (context) => {
  return context.json(
    healthResponseSchema.parse({
      status: "ok",
      service: "same-page",
      runtime: "cloudflare-worker",
    }),
  );
});

app.notFound((context) => context.json({ error: "not_found" }, 404));

export default app;
