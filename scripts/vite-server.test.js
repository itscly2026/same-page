import { mkdtemp, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { startViteServer } from "./vite-server.mjs";

it("isolates simultaneous servers and removes each owned directory on stop", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "same-page-server-test-"));
  const servers = [];
  try {
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({ scripts: { dev: "node server.cjs" } }));
    await writeFile(path.join(cwd, "wrangler.jsonc"), JSON.stringify({ main: "worker.ts" }));
    await writeFile(path.join(cwd, "server.cjs"), `require('node:http').createServer((q,r)=>{r.setHeader('x-same-page-test-server',process.env.SAME_PAGE_TEST_RUN);r.end(process.env.SAME_PAGE_TEST_STATE)}).listen(Number(process.argv[process.argv.indexOf('--port')+1]),'127.0.0.1');`);
    await Promise.all([1, 2].map(async () => servers.push(await startViteServer({ cwd, script: "dev" }))));
    const states = await Promise.all(servers.map((server) => fetch(server.origin).then((r) => r.text())));
    expect(states[0]).not.toBe(states[1]);
    await servers[0].stop();
    await expect(access(states[0])).rejects.toThrow();
    expect(await fetch(servers[1].origin).then((r) => r.text())).toBe(states[1]);
    await servers[1].stop();
    await expect(access(states[1])).rejects.toThrow();
  } finally { await Promise.all(servers.map((server) => server.stop())); await rm(cwd, { recursive: true, force: true }); }
}, 15_000);

it("fails promptly with the original child error and cleans prepared state", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "same-page-server-fail-"));
  let statePath;
  try {
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({ scripts: { dev: "node -e \"console.error('fixture startup broke');process.exit(17)\"" } }));
    await writeFile(path.join(cwd, "wrangler.jsonc"), "{}");
    const start = Date.now();
    await expect(startViteServer({ cwd, script: "dev", timeoutMs: 20_000, prepare: async (state) => { statePath = state.statePath; await readFile(state.configPath); } })).rejects.toThrow(/fixture startup broke/);
    expect(Date.now() - start).toBeLessThan(8_000);
    await expect(access(statePath)).rejects.toThrow();
  } finally { await rm(cwd, { recursive: true, force: true }); }
}, 15_000);

it("waits for fixture preparation to release resources before signal exit", async () => {
  const { spawn } = await import("node:child_process");
  const { once } = await import("node:events");
  const cwd = await mkdtemp(path.join(tmpdir(), "same-page-prepare-signal-"));
  let child;
  try {
    await writeFile(path.join(cwd, "wrangler.jsonc"), "{}");
    await writeFile(path.join(cwd, "prepare.mjs"), `
      import { writeFile } from 'node:fs/promises';
      import { startViteServer } from ${JSON.stringify(new URL("./vite-server.mjs", import.meta.url).href)};
      await startViteServer({script:'dev', prepare:async ({statePath,signal})=>{
        const keepAlive=setInterval(()=>{},1000);
        console.log(statePath);
        try { await new Promise(resolve=>signal?.addEventListener('abort',resolve,{once:true})); }
        finally { await writeFile('released','yes'); clearInterval(keepAlive); }
      }}).catch(()=>{});
    `);
    child = spawn(process.execPath, ["prepare.mjs"], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const exited = once(child, "exit");
    const [output] = await once(child.stdout, "data");
    const statePath = String(output).trim();
    child.kill("SIGTERM");
    await exited;
    expect(await readFile(path.join(cwd, "released"), "utf8")).toBe("yes");
    await expect(access(statePath)).rejects.toThrow();
  } finally {
    if (child && child.exitCode === null) child.kill("SIGKILL");
    await rm(cwd, { recursive: true, force: true });
  }
}, 10_000);
