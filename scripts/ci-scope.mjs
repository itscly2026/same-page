import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const rootDocuments = new Set(["README.md", "CONTEXT.md", "AGENTS.md"]);
const checkNames = [
  "client",
  "worker",
  "visual",
  "pwa",
  "performance",
  "migration",
  "build",
  "deploy",
  "smoke",
];

const checks = (enabled = []) => Object.fromEntries(
  checkNames.map((name) => [name, enabled.includes(name)]),
);
const allChecks = () => checks(checkNames);

export function determineCiScope({ cwd, eventName, event }) {
  const full = (reason) => ({ full: true, ...allChecks(), reason });
  const baseSha = eventName === "pull_request"
    ? event?.pull_request?.base?.sha
    : eventName === "push" ? event?.before : undefined;
  if (!/^[a-f0-9]{40}$/.test(baseSha ?? "") || /^0+$/.test(baseSha)) {
    return full("No reliable comparison base; running all checks.");
  }

  const git = (...args) => execFileSync("git", args, {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    // PRs compare the entire change against the common ancestor. Pushes compare
    // the entire before/after range, including multi-commit and force pushes.
    const base = eventName === "pull_request"
      ? git("merge-base", baseSha, "HEAD").trim()
      : baseSha;
    // Disabling rename detection includes both paths. A code -> docs rename
    // must not hide the removed code. NUL delimiters also handle unusual names.
    const files = git("diff", "--name-only", "--no-renames", "-z", base, "HEAD", "--")
      .split("\0").filter(Boolean);
    if (files.length === 0) return full("No changed paths; running all checks.");
    const onlyDocuments = files.every((file) => rootDocuments.has(file)
      || (file.startsWith("docs/") && file.endsWith(".md")));
    if (onlyDocuments) {
      return {
        full: false,
        ...checks(),
        base,
        reason: "Only Markdown documentation changed; checking patch whitespace.",
      };
    }
    const selected = selectChecks(files);
    if (selected.deploy) selected.build = true;
    return {
      full: true,
      ...selected,
      base,
      reason: `Selected checks for: ${files.join(", ")}`,
    };
  } catch {
    return full("Comparison history unavailable; running all checks.");
  }
}

function selectChecks(files) {
  const selected = new Set();
  for (const file of files) {
    const pathChecks = checksForPath(file);
    if (!pathChecks) return allChecks();
    for (const name of pathChecks) selected.add(name);
  }
  return checks([...selected]);
}

function checksForPath(file) {
  if (rootDocuments.has(file) || (file.startsWith("docs/") && file.endsWith(".md"))) return [];
  if (file.startsWith(".github/")) {
    return checkNames.filter((name) => name !== "deploy");
  }
  if (["package.json", "package-lock.json", ".nvmrc", "vite.config.ts", "wrangler.jsonc"].includes(file)) {
    return checkNames;
  }
  if (file === "eslint.config.js" || file === "tsconfig.node.json") return [];
  if (file === "tsconfig.app.json") return ["client", "build", "deploy"];
  if (file === "tsconfig.worker.json") return ["worker", "build", "smoke", "deploy"];
  if (file === "tsconfig.json") return ["client", "worker", "build", "deploy"];
  if (["vitest.client.config.ts", "vitest.node.config.ts"].includes(file)) return ["client"];
  if (["vitest.worker.config.ts", "vitest.worker-unit.config.ts"].includes(file)) return ["worker"];

  if (file.startsWith("src/shared/")) {
    if (isTestPath(file)) return ["client"];
    return ["client", "worker", "visual", "performance", "build", "smoke", "deploy"];
  }
  if (file.startsWith("src/test/")) return ["client"];
  if (file.startsWith("src/client/")) {
    if (isTestPath(file)) return ["client"];
    const selected = ["client", "visual", "performance", "build", "smoke", "deploy"];
    if (
      file === "src/client/main.tsx"
      || file.startsWith("src/client/components/reload-prompt")
      || file.startsWith("src/client/pwa-navigation")
    ) selected.push("pwa");
    return selected;
  }
  if (file.startsWith("worker/")) {
    return isTestPath(file) || file.startsWith("worker/test/")
      ? ["worker"]
      : ["worker", "build", "smoke", "deploy"];
  }
  if (file.startsWith("migrations/")) return ["worker", "migration", "build", "smoke", "deploy"];
  if (file.startsWith("browser-tests/")) return ["smoke", "build"];
  if (file.startsWith("visual-report/")) return ["visual", "performance", "build", "smoke"];
  if (file.startsWith("public/") || file === "index.html") {
    return ["visual", "pwa", "performance", "build", "smoke", "deploy"];
  }
  if (file.startsWith("scripts/")) {
    if (file.startsWith("scripts/ci-scope.")) return [];
    if (file.startsWith("scripts/verify-pwa-update.")) return ["client", "pwa"];
    if (
      file.startsWith("scripts/measure-loading-performance.")
      || file.startsWith("scripts/loading-performance-")
    ) return ["client", "performance", "build"];
    if (file.startsWith("scripts/generate-visual-report.")) {
      return ["client", "visual"];
    }
    if (file.startsWith("scripts/backfill-score-file-names.")) {
      return ["client", "migration", "deploy"];
    }
    if (file.startsWith("scripts/verify-score-schema-migration.")) {
      return ["migration"];
    }
    // Shared or unknown verification tools fail closed without publishing product code.
    return checkNames.filter((name) => name !== "deploy");
  }
  return null;
}

function isTestPath(file) {
  return /(?:^|\/)\w[\w.-]*\.test\.[cm]?[jt]sx?$/.test(file);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let event = {};
  try {
    event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  } catch {
    // Missing or malformed event data must never suppress full verification.
  }
  const scope = determineCiScope({ cwd: process.cwd(), eventName: process.env.GITHUB_EVENT_NAME, event });
  if (!scope.full) {
    execFileSync("git", ["diff", "--check", scope.base, "HEAD", "--"], { stdio: "inherit" });
  }
  console.log(scope.reason);
  if (process.env.GITHUB_OUTPUT) {
    const output = ["full", ...checkNames]
      .map((name) => `${name}=${scope[name]}`)
      .join("\n");
    appendFileSync(process.env.GITHUB_OUTPUT, `${output}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const selected = checkNames.filter((name) => scope[name]);
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `CI scope: ${scope.full ? selected.join(", ") || "fast checks" : "documentation"}. ${scope.reason}\n`,
    );
  }
}
