import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { determineCiScope } from "./ci-scope.mjs";

function repository(t) {
  const cwd = mkdtempSync(path.join(tmpdir(), "same-page-ci-scope-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const put = (name, content = "test\n") => {
    mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
    writeFileSync(path.join(cwd, name), content);
  };
  const commit = () => {
    git("add", ".");
    git("commit", "-qm", "fixture");
    return git("rev-parse", "HEAD");
  };
  git("init", "-q");
  git("config", "user.email", "ci@example.invalid");
  git("config", "user.name", "CI test");
  put("README.md");
  put("src/app.ts");
  const base = commit();
  const scope = (eventName = "pull_request", event = { pull_request: { base: { sha: base } } }) =>
    determineCiScope({ cwd, eventName, event });
  return { cwd, put, git, commit, base, scope };
}

test("Markdown-only PRs use the lightweight path", (t) => {
  const repo = repository(t);
  repo.put("docs/with spaces/说明.md");
  repo.put("README.md", "updated\n");
  repo.commit();
  assert.equal(repo.scope().full, false);
});

test("code, config, dependencies, workflow and unknown files require full verification", (t) => {
  const repo = repository(t);
  for (const name of ["src/app.ts", "package-lock.json", ".github/workflows/ci.yml", "docs/example.js", "new.file"]) {
    repo.git("reset", "--hard", repo.base);
    repo.put(name, "updated\n");
    repo.commit();
    assert.equal(repo.scope().full, true, name);
  }
});

test("push scope includes every commit since before, not just the last commit", (t) => {
  const repo = repository(t);
  repo.put("src/app.ts", "changed\n");
  repo.commit();
  repo.put("README.md", "updated\n");
  repo.commit();
  assert.equal(repo.scope("push", { before: repo.base }).full, true);
});

test("renaming code to Markdown cannot bypass full verification", (t) => {
  const repo = repository(t);
  renameSync(path.join(repo.cwd, "src/app.ts"), path.join(repo.cwd, "CONTEXT.md"));
  repo.commit();
  assert.equal(repo.scope().full, true);
});

test("deleted code cannot bypass full verification", (t) => {
  const repo = repository(t);
  rmSync(path.join(repo.cwd, "src/app.ts"));
  repo.commit();
  assert.equal(repo.scope().full, true);
});

test("all files are examined beyond GitHub's 300-file workflow filter limit", (t) => {
  const repo = repository(t);
  for (let i = 0; i < 350; i++) repo.put(`docs/${i}.md`);
  repo.put("src/app.ts", "changed\n");
  repo.commit();
  assert.equal(repo.scope().full, true);
});

test("missing history, empty changes, new branches and unknown events fail closed", (t) => {
  const repo = repository(t);
  assert.equal(repo.scope().full, true);
  assert.equal(repo.scope("push", { before: "0".repeat(40) }).full, true);
  assert.equal(repo.scope("push", { before: "f".repeat(40) }).full, true);
  assert.equal(repo.scope("pull_request", {}).full, true);
  assert.equal(repo.scope("pull_request", null).full, true);
  assert.equal(repo.scope("workflow_dispatch", {}).full, true);
});

test("Markdown-only main pushes can skip deployment", (t) => {
  const repo = repository(t);
  repo.put("docs/operations/ci.md");
  repo.commit();
  assert.equal(repo.scope("push", { before: repo.base }).full, false);
});

test("a PR merge compares against the updated base, excluding unrelated main changes", (t) => {
  const repo = repository(t);
  repo.git("checkout", "-qb", "topic");
  repo.put("docs/change.md");
  repo.commit();
  repo.git("checkout", "-qb", "base", repo.base);
  repo.put("src/app.ts", "unrelated main change\n");
  const updatedBase = repo.commit();
  repo.git("merge", "--no-ff", "-qm", "synthetic PR merge", "topic");
  assert.equal(repo.scope("pull_request", { pull_request: { base: { sha: updatedBase } } }).full, false);
});

test("the workflow entrypoint emits scope and rejects whitespace errors in docs", (t) => {
  const repo = repository(t);
  const output = path.join(repo.cwd, ".git", "output");
  const eventPath = path.join(repo.cwd, ".git", "event.json");
  writeFileSync(eventPath, JSON.stringify({ before: repo.base }));
  const run = () => spawnSync(process.execPath, [fileURLToPath(new URL("./ci-scope.mjs", import.meta.url))], {
    cwd: repo.cwd,
    env: { ...process.env, GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: "" },
    encoding: "utf8",
  });
  repo.put("docs/change.md");
  repo.commit();
  assert.equal(run().status, 0);
  assert.equal(readFileSync(output, "utf8"), "full=false\n");
  rmSync(output);
  repo.put("docs/change.md", "bad whitespace \t\n");
  repo.commit();
  const result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /trailing whitespace/);
});
