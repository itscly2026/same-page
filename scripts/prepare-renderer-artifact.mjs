import { readFile, writeFile } from "node:fs/promises";

// Vite resolves Docker paths on the build host. Seal portable paths so deployment
// uses the verified renderer from the release artifact on a different host.
const path = "dist/same_page/wrangler.json";
const config = JSON.parse(await readFile(path, "utf8"));
for (const container of config.containers) {
  if (container.class_name !== "PdfRenderer") throw new Error("unreviewed_container");
  container.image = "../../renderer/Dockerfile";
  container.image_build_context = "../../renderer";
}
await writeFile(path, JSON.stringify(config));
