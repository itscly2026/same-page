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

test("runtime areas select only their relevant expensive checks", (t) => {
  const repo = repository(t);
  const expectedByPath = new Map([
    ["src/client/routes/home-page.tsx", ["client", "visual", "performance", "build", "smoke", "deploy"]],
    ["src/client/pwa-navigation.ts", ["client", "visual", "pwa", "performance", "build", "smoke", "deploy"]],
    ["worker/index.ts", ["worker", "build", "smoke", "deploy"]],
    ["src/shared/health.ts", ["client", "worker", "visual", "performance", "build", "smoke", "deploy"]],
    ["migrations/0002.sql", ["worker", "migration", "build", "smoke", "deploy"]],
    ["visual-report/layout.test.mjs", ["visual"]],
    ["browser-tests/browser-evidence.mjs", ["visual", "build", "smoke"]],
    ["browser-tests/sanitize-browser-trace.py", ["visual", "build", "smoke"]],
    ["scripts/run-browser-tests.mjs", ["visual", "build", "smoke"]],
    ["scripts/verify-score-schema-migration.mjs", ["migration"]],
  ]);

  for (const [name, enabled] of expectedByPath) {
    repo.git("reset", "--hard", repo.base);
    repo.put(name, "updated\n");
    repo.commit();
    const scope = repo.scope();
    assert.equal(scope.full, true, name);
    for (const check of ["client", "worker", "visual", "pwa", "performance", "migration", "build", "deploy", "smoke", "renderer"]) {
      assert.equal(scope[check], enabled.includes(check), `${name}: ${check}`);
    }
  }
});

test("test and CI changes run checks without deploying product code", (t) => {
  const repo = repository(t);
  for (const [name, enabled] of [
    ["src/client/app.test.tsx", ["client"]],
    ["src/shared/annotations.test.ts", ["client"]],
    ["src/test/setup.ts", ["client"]],
    ["worker/index.test.ts", ["worker"]],
    [".github/workflows/ci.yml", ["client", "worker", "visual", "pwa", "performance", "migration", "build"]],
  ]) {
    repo.git("reset", "--hard", repo.base);
    repo.put(name, "updated\n");
    repo.commit();
    const scope = repo.scope();
    assert.equal(scope.full, true, name);
    assert.equal(scope.deploy, false, name);
    for (const check of enabled) assert.equal(scope[check], true, `${name}: ${check}`);
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
  assert.equal(
    readFileSync(output, "utf8"),
    "full=false\nclient=false\nworker=false\nvisual=false\npwa=false\nperformance=false\nmigration=false\nbuild=false\ndeploy=false\nsmoke=false\nrenderer=false\nbrowserGroup=all\n",
  );
  rmSync(output);
  repo.put("docs/change.md", "bad whitespace \t\n");
  repo.commit();
  const result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /trailing whitespace/);
});

test("shared test infrastructure selects its actual browser, PWA, performance and artifact consumers without deployment", (t) => {
  const repo = repository(t);
  for (const name of ["scripts/vite-server.mjs", "scripts/process-lifecycle.mjs", "scripts/deployment-identity.mjs", "scripts/release-artifact.mjs", "scripts/new-shared-helper.mjs"]) {
    repo.git("reset", "--hard", repo.base);
    repo.put(name); repo.commit();
    const scope = repo.scope();
    for (const check of ["client", "visual", "pwa", "performance", "build", "smoke"]) assert.equal(scope[check], true, `${name}: ${check}`);
    assert.equal(scope.deploy, false, name);
  }
});

test("documentation mixed with verification changes does not trigger deployment", (t) => {
  const repo = repository(t);
  repo.put("README.md", "docs updated"); repo.put("scripts/release-admission.mjs"); repo.commit();
  assert.equal(repo.scope().deploy, false);
});

// These real review artifacts previously made unrelated reader PRs run PWA,
// migrations and native packaging. Executable or unknown docs still fail closed.
test("review evidence does not widen a reader PR or deploy an evidence-only push", (t) => {
  const repo = repository(t);
  repo.put("docs/operations/issue-142/390-menu.png");
  repo.put("docs/operations/issue-142/evidence.json", "{}\n");
  repo.commit();
  assert.equal(repo.scope("push", { before: repo.base }).full, false);
  repo.put("src/client/reader/reader-ux.css");
  repo.commit();
  const scope = repo.scope();
  for (const check of ["client", "visual", "build", "smoke"]) assert.equal(scope[check], true, check);
  for (const check of ["worker", "pwa", "migration", "renderer"]) assert.equal(scope[check], false, check);
});

test("native changes validate packaging and runtime consumers without unrelated UI suites", (t) => {
  const repo = repository(t);
  repo.put("renderer/server.py"); repo.commit();
  const scope = repo.scope();
  for (const check of ["renderer", "build", "smoke", "deploy"]) assert.equal(scope[check], true, check);
  for (const check of ["client", "worker", "visual", "pwa", "migration"]) assert.equal(scope[check], false, check);
});


test("audited library leaves select entry/storage consumers; mixed shared changes widen to all", t => {
  const repo = repository(t);
  repo.put("src/client/score-library/drive-settings-dialog.tsx"); repo.commit();
  assert.equal(repo.scope().browserGroup, "library");
  assert.equal(repo.scope().performance, false);
  for (const key of ["client", "visual", "smoke", "build", "deploy"]) assert.equal(repo.scope()[key], true);
  for (const file of ["src/client/reader/reader-session.ts", "src/client/auth/application-identity.tsx", "src/client/offline/offline-score.ts", "src/client/styles.css", "new-path", "package-lock.json"]) {
    repo.put(file); repo.commit();
    assert.equal(repo.scope().browserGroup, "all", file);
    assert.equal(repo.scope().smoke, true, file);
  }
  assert.equal(repo.scope("push", {}).browserGroup, "all");
});

test("changes to the selector itself receive full verification", t => {
  const repo = repository(t);
  repo.put("scripts/ci-scope.mjs"); repo.commit();
  for (const key of ["client", "worker", "visual", "smoke", "renderer", "pwa", "migration", "performance", "build"]) assert.equal(repo.scope()[key], true, key);
});

test("the workflow gate rejects failure, cancellation and unexpected skips of selected jobs", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const script = workflow.match(/node --input-type=module <<'JS'\n([\s\S]*?)\n\s*JS/)[1];
  // Execute the actual gate body in-process; dozens of Node startups would
  // make this safety check itself an avoidable CI cost.
  const gate = new Function("assert", "process", script.replace(/import assert from 'node:assert\/strict';/, ""));
  const run = jobs => {
    try { gate(assert, { env: { RESULTS: JSON.stringify(jobs) } }); return 0; }
    catch { return 1; }
  };
  for (const outputs of [
    { full: "false" },
    { full: "true", client: "true" },
    { full: "true", visual: "true", smoke: "true", build: "true", browserGroup: "library" },
    { full: "true", visual: "true", renderer: "true", pwa: "true", browserGroup: "all" },
  ]) {
    const jobs = {
      scope: { result: "success", outputs },
      checks: { result: outputs.full === "true" ? "success" : "skipped" },
      visual: { result: outputs.visual === "true" ? "success" : "skipped" },
      integration: { result: outputs.smoke || outputs.renderer ? "success" : "skipped" },
    };
    assert.equal(run(jobs), 0);
    for (const [name, job] of Object.entries(jobs)) {
      for (const result of ["failure", "cancelled", job.result === "success" ? "skipped" : "success"]) {
        assert.notEqual(run({ ...jobs, [name]: { ...job, result } }), 0, `${name}/${result}`);
      }
    }
  }
});
