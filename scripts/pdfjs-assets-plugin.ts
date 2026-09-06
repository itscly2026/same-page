import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { Plugin } from "vite";
import { pdfJsDecoderFiles, pdfJsLicenseFiles, pdfJsWasmDirectory } from "../src/shared/pdfjs-assets";

export function pdfJsAssets(): Plugin {
  const root = path.join(path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json")), "wasm");
  const names = [...pdfJsDecoderFiles, ...pdfJsLicenseFiles];
  return {
    name: "same-page-pdfjs-decoders",
    applyToEnvironment: environment => environment.name === "client",
    async generateBundle() {
      for (const name of names) {
        this.emitFile({ type: "asset", fileName: pdfJsWasmDirectory + name, source: await readFile(path.join(root, name)) });
      }
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
        const name = names.find(name => pathname === `/${pdfJsWasmDirectory}${name}`);
        if (!name) return next();
        void readFile(path.join(root, name)).then(bytes => {
          response.setHeader("Content-Type", name.endsWith(".wasm") ? "application/wasm" : name.endsWith(".js") ? "text/javascript" : "text/plain");
          response.end(bytes);
        }).catch(next);
      });
    },
  };
}
