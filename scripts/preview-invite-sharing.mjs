// Local-only product preview with synthetic API data. Never used by production builds.
import { createServer } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import react from "@vitejs/plugin-react";
import { createVisualFixtureSession } from "../visual-report/fixtures.mjs";
const fixture = createVisualFixtureSession();
let code = "ABCDEFGH";
const server = await createServer({
  configFile: false,
  define: { __SAME_PAGE_BUILD_ID__: JSON.stringify("local-invite-preview") },
  server: { host: "127.0.0.1", port: 4175, strictPort: true },
  plugins: [react(), VitePWA({ registerType: "prompt" }), {
    name: "local-invite-fixtures",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = new URL(req.url, "http://localhost").pathname;
        if (!pathname.startsWith("/api/")) return next();
        const choir = { id: "visual-choir", name: "示例云盘", guestAdmissionMode: "invite" };
        if (pathname === "/api/guest/session" && req.method === "POST") {
          let body = "";
          req.on("data", chunk => { body += chunk; });
          req.on("end", () => {
            let valid = false;
            try { valid = JSON.parse(body).joinCode === code; } catch { /* invalid request */ }
            res.writeHead(valid ? 200 : 403, { "content-type": "application/json" });
            res.end(JSON.stringify(valid ? { choir, entryKind: "admission" } : { error: "invalid_or_expired_join_code" }));
          });
          return;
        }
        if (pathname === "/api/choirs/current-guest/join-state") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ status: "joined", choir }));
          return;
        }
        let result;
        if (pathname.includes("/join-code")) {
          if (req.method === "POST") code = code === "ABCDEFGH" ? "HGFEDCBA" : "ABCDEFGH";
          result = { status: 200, contentType: "application/json", body: JSON.stringify({ joinCode: code }) };
        } else {
          result = fixture.resolve({ pathname, method: req.method, identity: "admin", cookie: req.headers.cookie ?? "" });
        }
        res.writeHead(result.status, { "content-type": result.contentType, ...result.headers });
        res.end(result.body);
      });
    },
  }],
});
await server.listen();
console.log("Local invite preview: http://127.0.0.1:4175/choirs/visual-choir");
