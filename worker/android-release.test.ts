import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import worker from "./index";

const bucket = env.ANDROID_RELEASES!;
const key = "android/latest.apk";
const metadata = { versionname: "1.0.0", versioncode: "1", sha256: "a".repeat(64) };
const request = (path = "", init?: RequestInit) => worker.fetch(new Request(`https://same-page.test/api/android-release${path}`, init), env);
beforeEach(async () => { await bucket.delete(key); });

it("keeps installation optional when no APK is available", async () => {
  const response = await request();
  expect(await response.json()).toEqual({ release: null });
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect((await request("/apk")).status).toBe(404);
});

it("serves the same object's bytes and metadata without authentication or caching", async () => {
  await bucket.put(key, "apk-one", { customMetadata: metadata });
  expect(await (await request()).json()).toEqual({ release: { versionName: "1.0.0", versionCode: 1, sha256: metadata.sha256, size: 7 } });
  const response = await request("/apk");
  expect(response.headers.get("content-type")).toBe("application/vnd.android.package-archive");
  expect(response.headers.get("content-disposition")).toContain('same-page-1.0.0.apk');
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.text()).toBe("apk-one");
  const head = await request("/apk", { method: "HEAD" });
  expect(head.headers.get("content-length")).toBe("7");
  expect(await head.text()).toBe("");
});

it("restarts ranges against the complete latest APK instead of splicing releases", async () => {
  await bucket.put(key, "old", { customMetadata: metadata });
  const old = await request("/apk");
  await bucket.put(key, "new-complete", { customMetadata: { ...metadata, versionname: "1.0.1", versioncode: "2" } });
  const response = await request("/apk", { headers: { Range: "bytes=3-", "If-Range": old.headers.get("etag")! } });
  expect(response.status).toBe(200);
  expect(response.headers.get("accept-ranges")).toBe("none");
  expect(response.headers.get("content-range")).toBeNull();
  expect(await response.text()).toBe("new-complete");
  expect((await bucket.list()).objects.map(object => object.key)).toEqual([key]);
});

it("does not advertise an incomplete or malformed release", async () => {
  await bucket.put(key, "bad", { customMetadata: { ...metadata, versionname: 'bad"name' } });
  expect(await (await request()).json()).toEqual({ release: null });
  expect((await request("/apk")).status).toBe(404);
});
