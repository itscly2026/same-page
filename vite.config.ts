import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

import { navigationFallbackDenylist } from "./src/client/pwa-navigation.ts";

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
      includeAssets: [
        "favicon-32.png",
        "apple-touch-icon.png",
        "icon-192.png",
        "icon-512.png",
        "icon-maskable-512.png",
      ],
      manifest: {
        name: "Same Page",
        short_name: "Same Page",
        description: "合唱乐谱与排练批注",
        theme_color: "#014653",
        background_color: "#ffffff",
        display: "fullscreen",
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
        navigateFallback: "/index.html",
        // API navigations must always reach the Worker. In particular, OAuth
        // callbacks carry one-time codes that the application shell cannot
        // process and must never cache or render.
        navigateFallbackDenylist: navigationFallbackDenylist,
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
