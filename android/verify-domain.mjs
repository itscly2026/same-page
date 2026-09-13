import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const config = JSON.parse(await readFile(new URL("./twa-manifest.json", import.meta.url), "utf8"));
const response = await fetch(`https://${config.host}/.well-known/assetlinks.json`, { redirect: "error", signal: AbortSignal.timeout(15000) });
assert.equal(response.status, 200);
assert.ok(response.headers.get("content-type")?.includes("application/json"));
const entries = await response.json();
assert.ok(entries.some(entry => entry.relation?.includes("delegate_permission/common.handle_all_urls") && entry.target?.namespace === "android_app" && entry.target?.package_name === config.packageId && entry.target?.sha256_cert_fingerprints?.includes(config.fingerprints[0].value)), "Live domain does not trust this APK signing identity");
console.log("Live Digital Asset Links verified.");
