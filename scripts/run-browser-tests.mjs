import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

// The library group follows the audited ChoirPage presentation consumers in
// ci-scope.mjs. Entry/identity/offline reopening still use real Worker storage.
const library = {
  visual: ["drive-settings", "drive-navigation", "drive-entry-library", "drive-library-lifecycle", "upload-queue", "responsive-navigation", "ux-refinement"],
  smoke: ["storage-smoke", "offline-entry-smoke"],
};
const [suite, group = "all"] = process.argv.slice(2);
if (!Object.hasOwn(library, suite) || !["all", "library"].includes(group)) {
  throw new Error("Expected visual|smoke and all|library; refusing an empty test selection");
}
const directory = suite === "visual" ? "visual-report" : "browser-tests";
const files = group === "all"
  ? readdirSync(directory).filter(file => file.endsWith(".test.mjs")).sort()
  : library[suite].map(name => `${name}.test.mjs`);
if (!files.length) throw new Error("No browser tests selected");
const args = ["--test", "--test-reporter=tap"];
if (suite === "visual") args.push("--test-global-setup=./visual-report/setup.mjs", "--test-concurrency=2");
console.log(`Browser suite ${suite}/${group}: ${files.join(", ")}`);
const result = spawnSync(process.execPath, [...args, ...files.map(file => `${directory}/${file}`)], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
