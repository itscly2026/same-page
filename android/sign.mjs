import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));
const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
assert.ok(sdk && process.env.ANDROID_KEYSTORE_PATH && process.env.ANDROID_KEYSTORE_PASSWORD, "Signing environment is incomplete");
mkdirSync(path.join(root, "out"), { recursive: true });
// Password is inherited only by the signing child; never passed as an argument or logged.
execFileSync(path.join(sdk, "build-tools/36.0.0/apksigner"), ["sign", "--ks", process.env.ANDROID_KEYSTORE_PATH, "--ks-type", "PKCS12", "--ks-key-alias", "samepage-release", "--ks-pass", "env:ANDROID_KEYSTORE_PASSWORD", "--key-pass", "env:ANDROID_KEYSTORE_PASSWORD", "--out", path.join(root, "out/same-page.apk"), path.join(root, "generated/app/build/outputs/apk/release/app-release-unsigned.apk")], { stdio: ["ignore", "pipe", "pipe"] });
console.log("APK signed; run verify.mjs before publishing.");
