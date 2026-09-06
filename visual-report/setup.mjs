import { startViteServer } from "../scripts/vite-server.mjs";

let server;

// Only the stateless dev server is shared. Every test still owns its browser
// contexts, IndexedDB, API routes and fixture responses.
export async function globalSetup() {
  if (!process.env.LAYOUT_TEST_ORIGIN) {
    server = await startViteServer({ script: "dev" });
    process.env.LAYOUT_TEST_ORIGIN = server.origin;
  }
}

export async function globalTeardown() {
  await server?.stop();
}

// Individual test files remain runnable directly without global setup.
export async function startVisualServer(options) {
  return process.env.LAYOUT_TEST_ORIGIN
    ? { origin: process.env.LAYOUT_TEST_ORIGIN, stop: async () => {} }
    : startViteServer(options);
}
