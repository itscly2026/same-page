// Local-only preview using synthetic members and drives.
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { createVisualFixtureSession } from "../visual-report/fixtures.mjs";
const fixture = createVisualFixtureSession();
const server = await createServer({
  configFile: false,
  define: { __SAME_PAGE_BUILD_ID__: JSON.stringify("product-info-preview"), __SAME_PAGE_BUILD_RUN_ID__: JSON.stringify(""), __SAME_PAGE_BUILD_PUBLISHED_DATE__: JSON.stringify("2026-09-10") },
  server: { host: "127.0.0.1", port: 4177, strictPort: true },
  plugins: [react(), VitePWA({ registerType: "prompt" }), {
    name: "product-info-fixtures",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = new URL(req.url, "http://localhost").pathname;
        if (!pathname.startsWith("/api/")) return next();
        const result = fixture.resolve({ pathname, method: req.method, identity: "admin", cookie: req.headers.cookie ?? "" });
        res.writeHead(result.status, { "content-type": result.contentType, ...result.headers });
        res.end(result.body);
      });
    },
  }],
});
await server.listen();
console.log("Product information preview: http://127.0.0.1:4177/drives");
