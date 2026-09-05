import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, stat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

async function files(root) {
  const entries = await readdir(root, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => entry.isDirectory() ? files(path.join(root, entry.name)) : [path.join(root, entry.name)]))).flat();
}
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
export async function verifyPrecache(root = "dist/client", designRoot = "design") {
  const designHashes = new Set(await Promise.all((await files(designRoot)).filter((file) => !file.endsWith(".md")).map(async (file) => digest(await readFile(file)))));
  const published = await files(root);
  for (const file of published) assert.ok(!designHashes.has(digest(await readFile(file))), `Design source published: ${file}`);
  const worker = await readFile(path.join(root, "sw.js"), "utf8");
  const entries = [...worker.matchAll(/\{url:"([^"]+)",revision:(?:"[^"]+"|null)\}/g)].map((match) => match[1]);
  assert.ok(entries.length > 0, "Generated precache manifest not found");
  for (const required of ["index.html", "favicon-32.png", "apple-touch-icon.png", "icon-192.png", "icon-512.png", "icon-maskable-512.png"]) assert.ok(entries.includes(required), `Missing offline dependency: ${required}`);
  assert.ok(entries.some((file) => /pdf\.worker.*\.mjs$/.test(file)), "PDF worker not precached");
  for (const file of published.filter((file) => file.endsWith(".woff2"))) assert.ok(entries.includes(path.relative(root, file)), `Font not precached: ${file}`);
  const bytes = (await Promise.all(entries.map(async (file) => (await stat(path.join(root, file))).size))).reduce((a, b) => a + b, 0);
  const report = { entries: entries.length, bytes, baseline: { entries: 60, bytes: 5403008 }, deltaEntries: entries.length - 60, deltaBytes: bytes - 5403008 };
  return report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const report = await verifyPrecache();
  await mkdir("artifacts/verification", { recursive: true });
  await writeFile("artifacts/verification/precache-136.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
