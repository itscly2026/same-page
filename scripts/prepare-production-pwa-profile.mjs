import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import process from "node:process";

import { webkit } from "@playwright/test";

const origin = new URL(process.argv[2] ?? "https://samepage.clyapps.com").origin;
const profilePath = process.argv[3];
const evidencePath = process.argv[4];
assert.ok(profilePath, "usage: prepare-production-pwa-profile <origin> <profile-path> <evidence-path>");
assert.ok(evidencePath, "usage: prepare-production-pwa-profile <origin> <profile-path> <evidence-path>");

await mkdir(profilePath, { recursive: true });
const context = await webkit.launchPersistentContext(profilePath, {
  headless: true,
  locale: "zh-CN",
  serviceWorkers: "allow",
});

try {
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.evaluate(async () => {
    await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("service_worker_timeout")), 20_000)),
    ]);
  });
  if (!(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)))) {
    await page.reload({ waitUntil: "domcontentloaded" });
  }
  assert.equal(
    await page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
    true,
    "production PWA is not controlled",
  );
  const evidence = await page.evaluate(() => ({
    buildId: document.documentElement.dataset.buildId ?? null,
    documentAssets: [...document.querySelectorAll("script[src],link[rel='stylesheet']")]
      .map((element) => new URL(element.getAttribute("src") ?? element.getAttribute("href") ?? "", location.origin).pathname)
      .filter((pathname) => pathname.startsWith("/assets/")),
    serviceWorkerState: navigator.serviceWorker.controller?.state ?? "uncontrolled",
  }));
  await writeFile(evidencePath, `${JSON.stringify({ origin, ...evidence }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ origin, ...evidence }, null, 2)}\n`);
} finally {
  await context.close();
}
