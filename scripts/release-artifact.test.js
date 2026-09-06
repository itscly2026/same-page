import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { sealRelease, verifyRelease } from "./release-artifact.mjs";
import { pdfJsWasmDirectory } from "../src/shared/pdfjs-assets.ts";

it("promotes the exact verified bytes and rejects modified artifacts or a different source SHA", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "same-page-artifact-"));
  const sha = "a".repeat(40);
  try {
    for (const dir of ["dist/client/assets", "dist/same_page", "migrations", "renderer"]) await mkdir(path.join(cwd, dir), { recursive: true });
    for (const [file, body] of Object.entries({
      "dist/client/build.json": JSON.stringify({ buildId: sha, scripts: { "/assets/app.js": createHash("sha256").update("export const value=1;").digest("hex") } }),
      "dist/client/assets/app.js": "export const value=1;",
      "dist/client/index.html": `<meta name="same-page-build-id" content="${sha}">`,
      "dist/same_page/index.js": `const buildId = "${sha}"`,
      "renderer/Dockerfile": "FROM python:3.14-slim",
      "dist/same_page/wrangler.json": "{}", "wrangler.jsonc": "{}", "package-lock.json": "{}", "migrations/0001.sql": "SELECT 1;",
    })) await writeFile(path.join(cwd, file), body);
    await sealRelease({ cwd, sha, runId: "42" });
    await expect(verifyRelease({ cwd, sha })).resolves.toMatchObject({ sha, runId: "42" });
    await expect(verifyRelease({ cwd, sha: "b".repeat(40) })).rejects.toThrow(/source/);
    // Runtime-imported decoders live outside /assets but still belong to the
    // exact script manifest, including before dependencies are installed.
    const decoderPath = `${pdfJsWasmDirectory}openjpeg_nowasm_fallback.js`;
    const decoderBody = "export default function decode() {}";
    await mkdir(path.join(cwd, "dist/client", pdfJsWasmDirectory), { recursive: true });
    await writeFile(path.join(cwd, "dist/client", decoderPath), decoderBody);
    await expect(sealRelease({ cwd, sha })).rejects.toThrow(/script manifest/);
    await writeFile(path.join(cwd, "dist/client/build.json"), JSON.stringify({
      buildId: sha,
      scripts: {
        "/assets/app.js": createHash("sha256").update("export const value=1;").digest("hex"),
        [`/${decoderPath}`]: createHash("sha256").update(decoderBody).digest("hex"),
      },
    }));
    await sealRelease({ cwd, sha, runId: "43" });
    await expect(verifyRelease({ cwd, sha })).resolves.toMatchObject({ sha, runId: "43" });
    await mkdir(path.join(cwd, "scripts"));
    for (const name of ["release-artifact.mjs", "deployment-identity.mjs"]) {
      await copyFile(new URL(name, import.meta.url), path.join(cwd, "scripts", name));
    }
    await expect(promisify(execFile)(process.execPath, ["scripts/release-artifact.mjs", "verify", sha], { cwd }))
      .resolves.toMatchObject({ stdout: expect.stringContaining(`verify: source ${sha}`) });
    await writeFile(path.join(cwd, "dist/client", decoderPath), "stale decoder");
    await expect(verifyRelease({ cwd, sha })).rejects.toThrow(/bytes/);
    await writeFile(path.join(cwd, "dist/client", decoderPath), decoderBody);
    await writeFile(path.join(cwd, "migrations/0001.sql"), "SELECT 2;");
    await expect(verifyRelease({ cwd, sha })).rejects.toThrow(/bytes/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
