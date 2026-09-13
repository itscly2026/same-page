import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { TwaGenerator, TwaManifest, ConsoleLog } from "@bubblewrap/core";

const root = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(await readFile(path.join(root, "twa-manifest.json"), "utf8"));
// Use reviewed repository artwork, never mutable production assets as build inputs.
const icons = new Map(await Promise.all(["icon-512.png", "icon-maskable-512.png"].map(async name =>
  [`/${name}`, await readFile(path.join(root, "../public", name))])));
const server = createServer((req, res) => {
  const icon = icons.get(req.url);
  res.writeHead(icon ? 200 : 404, { "Content-Type": "image/png" });
  res.end(icon);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
try {
  const origin = `http://127.0.0.1:${server.address().port}`;
  const manifest = new TwaManifest({ ...config, iconUrl: `${origin}/icon-512.png`, maskableIconUrl: `${origin}/icon-maskable-512.png` });
  const generated = path.join(root, "generated");
  await mkdir(generated, { recursive: true });
  await new TwaGenerator().createTwaProject(generated, manifest, new ConsoleLog("same-page"));
  // Explicit, reviewed transformations on each fresh generation; no hand-edited output.
  const xmlPath = path.join(generated, "app/src/main/AndroidManifest.xml");
  let xml = await readFile(xmlPath, "utf8");
  const broad = /<data android:scheme="https"\s+android:host="@string\/hostName"\s*\/>/g;
  assert.equal([...xml.matchAll(broad)].length, 1, "upstream App Links template changed");
  xml = xml.replace(broad, '<data android:scheme="https" android:host="@string/hostName" android:pathPrefix="/choirs/"/>\n                    <data android:scheme="https" android:host="@string/hostName" android:path="/install"/>');
  await writeFile(xmlPath, xml);
  const buildPath = path.join(generated, "build.gradle");
  const wrapperPath = path.join(generated, "gradle/wrapper/gradle-wrapper.properties");
  await writeFile(wrapperPath, (await readFile(wrapperPath, "utf8")) + "\ndistributionSha256Sum=f397b287023acdba1e9f6fc5ea72d22dd63669d59ed4a289a29b1a76eee151c6\n");
  await writeFile(buildPath, (await readFile(buildPath, "utf8")).replaceAll("jcenter()", "mavenCentral()"));
} finally { server.closeAllConnections(); server.close(); }
