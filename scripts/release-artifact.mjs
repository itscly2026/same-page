import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isReleaseScriptPath } from "./deployment-identity.mjs";

async function releaseFiles(cwd) {
  const files = ["wrangler.jsonc", "package-lock.json"];
  async function walk(directory) {
    for (const entry of await readdir(path.join(cwd, directory), { withFileTypes: true })) {
      const name = `${directory}/${entry.name}`;
      if (entry.name === "__pycache__" || entry.name.endsWith(".pyc")) continue;
      if (entry.isDirectory()) await walk(name);
      else {
        assert.ok(entry.isFile(), `release cannot contain links: ${name}`);
        files.push(name);
      }
    }
  }
  await walk("dist");
  await walk("migrations");
  await walk("renderer");
  return Object.fromEntries(await Promise.all(files.sort().map(async (file) => [
    file, createHash("sha256").update(await readFile(path.join(cwd, file))).digest("hex"),
  ])));
}

async function verifyIdentity(cwd, sha, files) {
  assert.match(sha, /^[a-f0-9]{40}$/, "release source must be a full commit SHA");
  const build = JSON.parse(await readFile(path.join(cwd, "dist/client/build.json"), "utf8"));
  assert.equal(build.buildId, sha, "release build must match source SHA");
  const scripts = Object.fromEntries(Object.entries(files)
    .filter(([name]) => name.startsWith("dist/client/") && isReleaseScriptPath(name.slice("dist/client".length)))
    .map(([name, hash]) => [name.slice("dist/client".length), hash]));
  assert.ok(Object.keys(scripts).length > 0, "release scripts are missing");
  assert.deepEqual(build.scripts, scripts, "script manifest must describe final build bytes");
  const shell = await readFile(path.join(cwd, "dist/client/index.html"), "utf8");
  assert.ok(shell.includes(`<meta name="same-page-build-id" content="${sha}">`), "shell must match source SHA");
  const worker = await readFile(path.join(cwd, "dist/same_page/index.js"), "utf8");
  assert.ok(worker.includes(sha), "Worker must match source SHA");
}

export async function sealRelease({ cwd, sha, runId }) {
  const files = await releaseFiles(cwd);
  await verifyIdentity(cwd, sha, files);
  const manifest = { sha, runId, files };
  await writeFile(path.join(cwd, "release.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export async function verifyRelease({ cwd, sha }) {
  const manifest = JSON.parse(await readFile(path.join(cwd, "release.json"), "utf8"));
  assert.equal(manifest.sha, sha, "artifact source must match this release");
  const files = await releaseFiles(cwd);
  assert.deepEqual(files, manifest.files, "release bytes differ from verified artifact");
  await verifyIdentity(cwd, sha, files);
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , command, sha] = process.argv;
  assert.ok(["seal", "verify"].includes(command), "usage: release-artifact.mjs seal|verify SHA");
  const manifest = await (command === "seal" ? sealRelease : verifyRelease)({ cwd: process.cwd(), sha, runId: process.env.GITHUB_RUN_ID });
  console.log(`${command}: source ${manifest.sha}, verification run ${manifest.runId ?? "local"}`);
}
