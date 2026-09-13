import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

import { navigationFallbackDenylist } from "./src/client/pwa-navigation.ts";
import { pdfJsAssets } from "./scripts/pdfjs-assets-plugin.ts";

const buildId = process.env.SAME_PAGE_BUILD_ID
  ?? process.env.GITHUB_SHA
  ?? execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

const buildPublishedDate = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });

const buildRunId = process.env.GITHUB_RUN_ID ?? "";

const testState = process.env.SAME_PAGE_TEST_STATE;
const testHeaders = testState ? { "x-same-page-test-server": process.env.SAME_PAGE_TEST_RUN! } : undefined;

export default defineConfig(({ isPreview }) => ({
  ...(testState && isPreview ? { root: testState } : {}),
  ...(testState ? { cacheDir: `${testState}/vite-cache`, envDir: testState } : {}),
  server: { headers: testHeaders },
  preview: { headers: testHeaders },
  define: {
    __SAME_PAGE_BUILD_ID__: JSON.stringify(buildId),
    __SAME_PAGE_BUILD_RUN_ID__: JSON.stringify(buildRunId),
    __SAME_PAGE_BUILD_PUBLISHED_DATE__: JSON.stringify(buildPublishedDate),
  },
  build: {
    // The lazy reader contains the PDF.js display API (about 170 KiB gzip).
    // Keep the warning threshold explicit while the home/auth chunks remain
    // independent and much smaller.
    chunkSizeWarningLimit: 600,
  },
  plugins: [
    pdfJsAssets(),
    {
      name: "same-page-build-identity",
      configurePreviewServer(server) {
        if (testHeaders) server.middlewares.use((_request, response, next) => {
          response.setHeader("x-same-page-test-server", testHeaders["x-same-page-test-server"]);
          next();
        });
      },
      transformIndexHtml() {
        return [{ tag: "meta", attrs: { name: "same-page-build-id", content: buildId }, injectTo: "head" }];
      },
      async writeBundle(options, bundle) {
        // Read final disk bytes after Vite's preload/import rewrites.
        const output = options.dir!;
        const scripts = Object.fromEntries(await Promise.all(Object.values(bundle)
          .filter((entry) => /\.(?:m?js)$/.test(entry.fileName))
          .map(async (entry) => [`/${entry.fileName}`, createHash("sha256")
            .update(await readFile(path.join(output, entry.fileName))).digest("hex")])));
        await writeFile(path.join(output, "build.json"), `${JSON.stringify({ buildId, runId: buildRunId, scripts })}\n`);
      },
    },
    react(),
    cloudflare(testState ? {
      persistState: { path: testState }, inspectorPort: false, remoteBindings: false,
    } : {}),
    VitePWA({
      registerType: "prompt",
      injectRegister: false,
      includeAssets: [
        "favicon-32.png",
        "apple-touch-icon.png",
        "icon-192.png",
        "icon-512.png",
        "icon-maskable-512.png",
      ],
      manifest: {
        name: "合谱 · Same Page",
        short_name: "合谱",
        description: "合唱乐谱与排练批注",
        theme_color: "#014653",
        background_color: "#ffffff",
        display: "standalone",
        start_url: "/",
        icons: [
          {
            src: "/icon-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/icon-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        cleanupOutdatedCaches: true,
        importScripts: ["/update-coordination.js"],
        navigateFallback: "/index.html",
        // API navigations must always reach the Worker. In particular, OAuth
        // callbacks carry one-time codes that the application shell cannot
        // process and must never cache or render.
        navigateFallbackDenylist: navigationFallbackDenylist,
        globPatterns: ["**/*.{js,mjs,wasm,css,html,ico,png,webp,woff2}"],
        // PDF.js' worker is slightly larger than Workbox's 2 MiB default.
        // It is required to open a verified offline PDF, so keep it in the
        // application-shell precache rather than making offline claims depend
        // on whether the reader happened to load while online before.
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
      },
    }),
  ],
}));
