import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  build: {
    // The lazy reader contains the PDF.js display API (about 170 KiB gzip).
    // Keep the warning threshold explicit while the home/auth chunks remain
    // independent and much smaller.
    chunkSizeWarningLimit: 600,
  },
  plugins: [
    react(),
    cloudflare(),
    VitePWA({
      registerType: "prompt",
      injectRegister: false,
      includeAssets: ["icon.svg"],
      manifest: {
        name: "Same Page",
        short_name: "Same Page",
        description: "合唱乐谱与排练批注",
        theme_color: "#7c2d52",
        background_color: "#fffaf6",
        display: "standalone",
        start_url: "/",
        icons: [
          {
            src: "/icon.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any maskable",
          },
        ],
      },
      workbox: {
        cleanupOutdatedCaches: true,
        navigateFallback: "/index.html",
        globPatterns: ["**/*.{js,mjs,css,html,ico,png,woff2}"],
        // PDF.js' worker is slightly larger than Workbox's 2 MiB default.
        // It is required to open a verified offline PDF, so keep it in the
        // application-shell precache rather than making offline claims depend
        // on whether the reader happened to load while online before.
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
      },
    }),
  ],
});
