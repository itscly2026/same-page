// Local-only synthetic data; the actual reader, editor and IndexedDB are used.
import { createServer } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import react from "@vitejs/plugin-react";

import { createVisualFixtureSession } from "../visual-report/fixtures.mjs";
const fixture = createVisualFixtureSession({ dense: true });
const stored = new Map();
const accepted = new Map();
let cursor = 2;
const server = await createServer({
  configFile: false,
  define: { __SAME_PAGE_BUILD_ID__: JSON.stringify("local-editor-preview"), __SAME_PAGE_BUILD_RUN_ID__: JSON.stringify("") },
  server: { host: "127.0.0.1", port: 4176, strictPort: true },
  plugins: [react(), VitePWA({ registerType: "prompt" }), {
    name: "local-editor-fixtures",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = new URL(req.url, "http://localhost").pathname;
        if (!pathname.startsWith("/api/")) return next();
        const respond = result => { res.writeHead(result.status, { "content-type": result.contentType, ...result.headers }); res.end(result.body); };
        const json = body => respond({status:200,contentType:"application/json",body:JSON.stringify(body)});
        if (pathname.endsWith("/annotations/push") && req.method === "POST") {
          let raw = ""; req.on("data", chunk => { raw += chunk; });
          req.on("end", () => {
            try {
              const results = JSON.parse(raw).operations.map(op => {
                if (accepted.has(op.opId)) return accepted.get(op.opId);
                const previous = stored.get(op.annotationId);
                const object = { id:op.annotationId, layerId:op.layerId, version:(previous?.version ?? op.baseVersion)+1, deleted:op.type === "delete", payload:op.payload, createdByDisplayName:"预览用户", updatedByDisplayName:"预览用户", updatedAt:Date.now() };
                stored.set(object.id, object); cursor++;
                const result = {opId:op.opId,status:"accepted",object}; accepted.set(op.opId,result); return result;
              });
              json({results});
            } catch { res.writeHead(400); res.end(); }
          }); return;
        }
        const result = fixture.resolve({ pathname, method: req.method, identity: "admin", cookie: req.headers.cookie ?? "" });
        if (pathname.endsWith("/annotations") && req.method === "GET") {
          const body = JSON.parse(result.body);
          const objects = new Map(body.objects.map(object => [object.id,object]));
          for (const [id,object] of stored) objects.set(id,object);
          return json({cursor,objects:[...objects.values()]});
        }
        respond(result);
      });
    },
  }],
});
await server.listen();
console.log("Reader editor preview: http://127.0.0.1:4176/choirs/visual-choir/scores/visual-score");
