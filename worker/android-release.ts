import { Hono } from "hono";
import { androidReleaseSchema } from "../src/shared/android-release";
import type { AppEnvironment } from "./env";

const key = "android/latest.apk";
export const androidReleaseRoutes = new Hono<AppEnvironment>();
androidReleaseRoutes.use("/android-release*", async (context, next) => {
  context.header("Cache-Control", "no-store");
  context.header("X-Content-Type-Options", "nosniff");
  await next();
});

function release(object: R2Object | null) {
  if (!object) return null;
  const metadata = object.customMetadata ?? {};
  const parsed = androidReleaseSchema.safeParse({
    versionName: metadata.versionname,
    versionCode: Number(metadata.versioncode),
    sha256: metadata.sha256,
    size: object.size,
  });
  return parsed.success ? parsed.data : null;
}

androidReleaseRoutes.get("/android-release", async context => {
  const object = await context.env.ANDROID_RELEASES?.head(key) ?? null;
  return context.json({ release: release(object) });
});

androidReleaseRoutes.on(["GET", "HEAD"], "/android-release/apk", async context => {
  const bucket = context.env.ANDROID_RELEASES;
  const object = bucket ? await bucket.get(key) : null;
  const info = release(object);
  if (!object || !info) return context.json({ error: "android_release_unavailable" }, 404);
  // A mutable latest object must never splice ranges across releases. Deliberately
  // ignore Range/If-Range (HTTP permits a full 200 response) and restart downloads.
  const headers = new Headers({
    "Content-Type": "application/vnd.android.package-archive",
    "Content-Disposition": `attachment; filename="same-page-${info.versionName}.apk"`,
    "Content-Length": String(object.size),
    "Cache-Control": "no-store",
    "Accept-Ranges": "none",
    "ETag": object.httpEtag,
    "X-Content-Type-Options": "nosniff",
  });
  if (context.req.method === "HEAD") {
    await object.body.cancel();
    return new Response(null, { headers });
  }
  return new Response(object.body, { headers });
});
