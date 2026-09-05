import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function github({ repository, token, fetchImpl = fetch }) {
  assert.match(repository, /^[\w.-]+\/[\w.-]+$/);
  assert.ok(token, "GitHub token is required");
  return async (suffix, body) => {
    const response = await fetchImpl(`https://api.github.com/repos/${repository}/deployments${suffix}`, {
      method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json", "X-GitHub-Api-Version": "2022-11-28" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    assert.ok(response.ok, `GitHub release record failed: HTTP ${response.status}`);
    return response.json();
  };
}

// The caller must hold the same production lock across admission, migration,
// deployment and verification. The record is durable even if the runner dies.
export async function admitRelease({ cwd, sha, runId, ...options }) {
  assert.match(sha, /^[a-f0-9]{40}$/);
  const api = github(options);
  const records = await api("?environment=production-release&per_page=1");
  assert.ok(Array.isArray(records), "invalid release history");
  let previous = records[0]?.sha;
  if (!previous) {
    const response = await (options.fetchImpl ?? fetch)("https://samepage.clyapps.com/api/health", { signal: AbortSignal.timeout(15_000), redirect: "error" });
    assert.ok(response.ok, "cannot establish initial production version");
    previous = (await response.json()).buildId;
  }
  assert.match(previous, /^[a-f0-9]{40}$/, "previous production source must be known");
  const isAncestor = (ancestor, descendant) => {
    const result = spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd });
    assert.ok(result.status === 0 || result.status === 1, "release history unavailable; fetch full history");
    return result.status === 0;
  };
  if (previous !== sha && isAncestor(sha, previous)) return { proceed: false, previous };
  assert.ok(isAncestor(previous, sha), "divergent release history requires a forward recovery commit");
  const record = await api("", {
    ref: sha, environment: "production-release", auto_merge: false, required_contexts: [],
    production_environment: true, description: `Verified source ${sha}`,
    payload: { runId, artifact: `release-${sha}` },
  });
  assert.ok(Number.isSafeInteger(record.id), "release record was not created");
  return { proceed: true, deploymentId: record.id, previous };
}

export async function recordReleaseStatus({ deploymentId, state, runId, ...options }) {
  assert.match(String(deploymentId), /^\d+$/);
  assert.ok(["in_progress", "success", "failure"].includes(state));
  return github(options)(`/${deploymentId}/statuses`, {
    state, auto_inactive: false, environment_url: "https://samepage.clyapps.com",
    log_url: `https://github.com/${options.repository}/actions/runs/${runId}`,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = { cwd: process.cwd(), sha: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, repository: process.env.GITHUB_REPOSITORY, token: process.env.GITHUB_TOKEN };
  if (process.argv[2] === "admit") {
    assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), options.sha);
    const result = await admitRelease(options);
    appendFileSync(process.env.GITHUB_OUTPUT, `proceed=${result.proceed}\ndeployment_id=${result.deploymentId ?? ""}\n`);
    console.log(result.proceed ? `Admitted ${options.sha}` : `Skipped ancestor of ${result.previous}`);
    if (result.proceed) await recordReleaseStatus({ ...options, deploymentId: result.deploymentId, state: "in_progress" });
  } else {
    await recordReleaseStatus({ ...options, deploymentId: process.env.DEPLOYMENT_ID, state: process.argv[2] });
  }
}
