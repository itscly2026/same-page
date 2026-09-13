import { test } from "node:test";
import assert from "node:assert/strict";
import { admitRelease } from "./publish.mjs";
const candidate = { signed: true, sourceSha: "a".repeat(40), versionCode: 2, sha256: "b".repeat(64) };
test("admits first/new versions and recognizes exact retry", () => {
  assert.equal(admitRelease(undefined, candidate), "publish");
  assert.equal(admitRelease({ versioncode: "1" }, candidate), "publish");
  assert.equal(admitRelease({ versioncode: "2", sha256: candidate.sha256 }, candidate), "already-published");
});
test("rejects stale, conflicting, malformed and unsigned releases", () => {
  for (const previous of [{ versioncode: "3" }, { versioncode: "2", sha256: "different" }, { versioncode: "bad" }]) assert.throws(() => admitRelease(previous, candidate));
  assert.throws(() => admitRelease(undefined, { ...candidate, signed: false }));
});
