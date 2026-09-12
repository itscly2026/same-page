import { readFile, writeFile, mkdir } from "node:fs/promises";
// Local-only synthetic data; the actual reader, editor and IndexedDB are used.
import { createServer } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import react from "@vitejs/plugin-react";

import { createVisualFixtureSession } from "../visual-report/fixtures.mjs";
const fixture = createVisualFixtureSession({ dense: false });
const statePath = new URL("../artifacts/layers-preview/server-state.json", import.meta.url);
let state = { cursor: 2, objects: [] };
try { state = JSON.parse(await readFile(statePath, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
for (const object of state.objects) if (object.payload?.kind === "ink" && !object.payload.nib) object.payload.nib = "round";
const stored = new Map(state.objects.map(object => [object.id, object]));
const accepted = new Map();
let cursor = state.cursor;
const personalOverrides = new Map();
const server = await createServer({
  configFile: false,
  define: { __SAME_PAGE_BUILD_ID__: JSON.stringify("local-layers-preview"), __SAME_PAGE_BUILD_RUN_ID__: JSON.stringify("") },
  server: { host: "127.0.0.1", port: 4178, strictPort: true },
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
          req.on("end", async () => {
            try {
              const results = JSON.parse(raw).operations.map(op => {
                if (accepted.has(op.opId)) return accepted.get(op.opId);
                const previous = stored.get(op.annotationId);
                const object = { id:op.annotationId, layerId:op.layerId, version:(previous?.version ?? op.baseVersion)+1, deleted:op.type === "delete", payload:op.payload, createdByDisplayName:"预览用户", updatedByDisplayName:"预览用户", updatedAt:Date.now() };
                stored.set(object.id, object); cursor++;
                const result = {opId:op.opId,status:"accepted",object}; accepted.set(op.opId,result); return result;
              });
              await mkdir(new URL("../artifacts/layers-preview/", import.meta.url), { recursive: true });
              await writeFile(statePath, JSON.stringify({ cursor, objects: [...stored.values()] }));
              json({results});
            } catch { res.writeHead(400); res.end(); }
          }); return;
        }
        if (req.method === "PUT") {
          let raw = ""; req.on("data", chunk => { raw += chunk; });
          req.on("end", () => {
            const body = JSON.parse(raw || "{}");
            const personalId = pathname.match(/personal-layers\/([^/]+)/)?.[1];
            if (personalId) { personalOverrides.set(personalId, { ...personalOverrides.get(personalId), ...body }); return json({}); }
            respond(fixture.resolve({ pathname, method: req.method, body, identity: "admin", cookie: req.headers.cookie ?? "" }));
          }); return;
        }
        const result = fixture.resolve({ pathname, method: req.method, identity: "admin", cookie: req.headers.cookie ?? "" });
        if (pathname.endsWith("/annotations") && req.method === "GET") {
          const body = JSON.parse(result.body);
          const objects = new Map(body.objects.map(object => [object.id,object]));
          for (const [id,object] of stored) objects.set(id,object);
          return json({cursor,objects:[...objects.values()]});
        }
        if (pathname.endsWith("/sync") || pathname.endsWith("/layers")) {
          const payload = JSON.parse(result.body);
          const group = pathname.endsWith("/sync") ? payload.layers : payload;
          if (group?.layers) {
            group.layers = group.layers.map(layer => layer.kind === "personal" ? { ...layer, canShare: true, sharing: false, revision: 1, ...personalOverrides.get(layer.id) } : layer);
            const own = group.layers.find(layer => layer.kind === "personal");
            if (own) group.layers.push({ ...own, id: "00000000-0000-4000-8000-000000000007", name: "周宁 · 排练提醒", canEdit: false, canShare: false, sharing: true, subscribed: false, ...personalOverrides.get("00000000-0000-4000-8000-000000000007") });
          }
          return json(payload);
        }
        respond(result);
      });
    },
  }],
});
await server.listen();
console.log("Reader layers preview: http://127.0.0.1:4178/choirs/visual-choir/scores/visual-score");
