import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { admitRelease } from "./release-admission.mjs";

it("serial release attempts cannot go backwards, while documentation does not suppress the pending product release", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "same-page-release-git-"));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    git("init", "-q"); git("config", "user.email", "release@example.invalid"); git("config", "user.name", "fixture");
    const commit = (file, body) => { writeFileSync(path.join(cwd, file), body); git("add", "."); git("commit", "-qm", "fixture"); return git("rev-parse", "HEAD"); };
    const base = commit("product", "base");
    const old = commit("product", "old");
    const newer = commit("product", "new");
    commit("README.md", "documentation only");
    const records = [];
    const fetchImpl = async (url, init = {}) => {
      if (String(url).includes("/api/health")) return Response.json({ buildId: base });
      if (init.method === "POST") { records.unshift({ id: records.length + 1, ...JSON.parse(init.body) }); records[0].sha = records[0].ref; return Response.json(records[0]); }
      return Response.json(records.slice(0, 1));
    };
    const admit = (sha) => admitRelease({ cwd, sha, repository: "fixture/repo", token: "fixture", runId: "42", fetchImpl });
    expect(await admit(newer)).toMatchObject({ proceed: true });
    expect(await admit(old)).toMatchObject({ proceed: false });
    expect(records).toHaveLength(1);
    // Retrying a failed attempt at the same SHA is safe; its successor may proceed.
    expect(await admit(newer)).toMatchObject({ proceed: true });
    const successor = commit("product", "fix");
    expect(await admit(successor)).toMatchObject({ proceed: true });
    git("checkout", "--detach", base);
    const divergent = commit("product", "divergent");
    await expect(admit(divergent)).rejects.toThrow(/divergent/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
