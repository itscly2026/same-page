import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { verifyPrecache } from "./verify-precache.mjs";

it("rejects a renamed design source in published output and a missing offline worker", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "precache-audit-"));
  const output = path.join(temporary, "published"), design = path.join(temporary, "design");
  try {
    await mkdir(output); await mkdir(design);
    await writeFile(path.join(design, "original.png"), "design pixels");
    const required = ["index.html", "favicon-32.png", "apple-touch-icon.png", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "pdf.worker-current.mjs"];
    for (const file of required) await writeFile(path.join(output, file), "runtime asset");
    const manifest = files => `precacheAndRoute([${files.map(url => `{url:"${url}",revision:null}`).join(",")}])`;
    await writeFile(path.join(output, "sw.js"), manifest(required));
    await expect(verifyPrecache(output, design)).resolves.toMatchObject({ entries: 7 });
    await writeFile(path.join(output, "renamed.png"), "design pixels");
    await expect(verifyPrecache(output, design)).rejects.toThrow("Design source published");
    await rm(path.join(output, "renamed.png"));
    await writeFile(path.join(output, "sw.js"), manifest(required.slice(0, -1)));
    await expect(verifyPrecache(output, design)).rejects.toThrow("PDF worker not precached");
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
