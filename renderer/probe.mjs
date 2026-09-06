import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
const origin = process.env.PDF_RENDERER_URL;
const secret = process.env.PDF_RENDERER_SECRET;
assert.ok(origin && secret?.length >= 32, "renderer probe configuration missing");
const health = await fetch(new URL("/health", origin), { signal: AbortSignal.timeout(30_000) });
assert.equal(health.status, 200);
assert.equal((await health.json()).buildId, process.argv[2]);
const denied = await fetch(new URL("/convert", origin), { method: "POST", body: "unauthorized", signal: AbortSignal.timeout(30_000) });
assert.equal(denied.status, 403);
const pdf = await readFile(new URL("./fixtures/score-specimen.pdf", import.meta.url));
const hash = createHash("sha256").update(pdf).digest("hex");
const timestamp = Math.floor(Date.now() / 1000).toString(), nonce = randomUUID();
const signature = createHmac("sha256", secret).update(`POST\n/convert\n${timestamp}\n${nonce}\n${hash}`).digest("hex");
const result = await fetch(new URL("/convert", origin), { method: "POST", body: pdf, signal: AbortSignal.timeout(180_000), headers: {
  "Content-Type": "application/pdf", "X-Render-Time": timestamp, "X-Render-Nonce": nonce, "X-Render-Sha256": hash, "X-Render-Signature": signature,
} });
assert.equal(result.status, 200, "signed renderer request failed");
const data = Buffer.from(await result.arrayBuffer());
let offset = 0;
function frame() {
  assert.ok(offset + 4 <= data.length, "renderer response truncated");
  const length = data.readUInt32BE(offset); offset += 4;
  assert.ok(length <= 32 * 1024 ** 2 && offset + length <= data.length, "invalid renderer frame");
  const payload = data.subarray(offset, offset + length); offset += length; return payload;
}
assert.equal(JSON.parse(frame().toString()).pages.length, 3);
const verified = JSON.parse(await readFile(new URL("./verified-output.json", import.meta.url), "utf8"));
for (let page = 1; page <= 3; page++) for (const edge of [2048, 3072]) {
  const expected = verified.results.find(row => row.page === page && row.edge === edge);
  assert.ok(expected, "verified Linux image output missing");
  assert.equal(createHash("sha256").update(frame()).digest("hex"), expected.sha256, `renderer image mismatch: ${page}/${edge}`);
}
assert.equal(frame().length, 0); assert.equal(offset, data.length);
console.log(`renderer verified: ${process.argv[2]}, unsigned 403, 3 pages, 6 reviewed PNGs`);
