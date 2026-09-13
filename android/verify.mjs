import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(await readFile(path.join(root, "twa-manifest.json"), "utf8"));
const apk = path.resolve(process.argv[2] ?? path.join(root, "out/same-page.apk"));
const unsigned = process.argv.includes("--unsigned");
const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
assert.ok(sdk, "ANDROID_HOME is required");
const tools = path.join(sdk, "build-tools/36.0.0");
const run = (tool, args) => execFileSync(path.join(tools, tool), args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const badging = run("aapt", ["dump", "badging", apk]);
assert.ok(badging.includes(`package: name='${config.packageId}' versionCode='${config.appVersionCode}' versionName='${config.appVersion}'`), "APK identity/version mismatch");
assert.ok(badging.includes("targetSdkVersion:'36'"));
assert.ok(badging.includes(`sdkVersion:'${config.minSdkVersion}'`));
const permissions = [...badging.matchAll(/uses-permission(?:-sdk-\d+)?: name='([^']+)'/g)].map(m => m[1]);
const allowed = new Set(["android.permission.INTERNET", "android.permission.ACCESS_NETWORK_STATE", `${config.packageId}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`]);
assert.ok(permissions.every(p => allowed.has(p)), `Unexpected permissions: ${permissions.filter(p => !allowed.has(p)).join(", ")}`);
const xml = run("aapt", ["dump", "xmltree", apk, "AndroidManifest.xml"]);
assert.ok(xml.includes('"/choirs/"') && xml.includes('"/install"'), "App Links must be scoped");
assert.ok(!badging.includes("application-debuggable"), "Release must not be debuggable");
if (!unsigned) {
  const certificate = run("apksigner", ["verify", "--verbose", "--print-certs", apk]);
  const actual = /Signer #1 certificate SHA-256 digest: ([a-f0-9]+)/i.exec(certificate)?.[1].toUpperCase();
  assert.equal(actual, config.fingerprints[0].value.replaceAll(":", ""), "Signing certificate mismatch");
}
const bytes = await readFile(apk);
const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const metadata = { packageId: config.packageId, versionName: config.appVersion, versionCode: config.appVersionCode, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, sourceSha, certificateSha256: config.fingerprints[0].value, signed: !unsigned };
await mkdir(path.join(root, "out"), { recursive: true });
await writeFile(path.join(root, "out/release.json"), JSON.stringify(metadata, null, 2) + "\n");
console.log(JSON.stringify(metadata));
