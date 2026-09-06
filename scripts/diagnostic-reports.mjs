import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const statuses = ["new", "investigating", "resolved"];
const categories = ["permission", "validation", "conflict", "not-found", "rate-limit", "network", "internal"];
const quote = value => `'${value.replaceAll("'", "''")}'`;

export function diagnosticInboxQuery(argv, now = Date.now()) {
  const [action, ...args] = argv;
  if (!["list", "show", "mark"].includes(action)) throw new Error("Usage: diagnostics:inbox -- list|show|mark --local|--remote [--id UUID] [--status new|investigating|resolved] [--build SHA] [--category CATEGORY]");
  const options = new Map();
  let mode;
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === "--local" || key === "--remote") {
      if (mode) throw new Error("Choose exactly one of --local or --remote");
      mode = key;
    } else {
      if (!["--id", "--status", "--build", "--category"].includes(key) || options.has(key) || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error("Invalid argument");
      options.set(key, args[++i]);
    }
  }
  if (!mode) throw new Error("Explicit --local or --remote is required");
  const id = options.get("--id");
  const status = options.get("--status");
  const build = options.get("--build");
  const category = options.get("--category");
  if (id && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new Error("Invalid report id");
  if (status && !statuses.includes(status)) throw new Error("Invalid status");
  if (build && !/^(?:[0-9a-f]{7,40}|development)$/.test(build)) throw new Error("Invalid build");
  if (category && !categories.includes(category)) throw new Error("Invalid category");
  const where = [`expires_at > ${Math.trunc(now)}`];
  if (action === "list") {
    if (id) throw new Error("Use show for one report");
    if (status) where.push(`status = ${quote(status)}`);
    if (build) where.push(`client_build = ${quote(build)}`);
    if (category) where.push(`EXISTS (SELECT 1 FROM json_each(diagnostic_reports.payload, '$.records') AS record WHERE json_extract(record.value, '$.category') = ${quote(category)})`);
    return { mode, sql: `SELECT id, client_build, status, created_at, expires_at FROM diagnostic_reports WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT 100` };
  }
  if (!id || build || category || (action === "show" && status)) throw new Error("show requires only --id; mark requires --id and --status");
  where.push(`id = ${quote(id)}`);
  if (action === "show") return { mode, sql: `SELECT id, status, created_at, expires_at, payload FROM diagnostic_reports WHERE ${where.join(" AND ")}` };
  if (!status) throw new Error("mark requires --status");
  return { mode, sql: `UPDATE diagnostic_reports SET status = ${quote(status)} WHERE ${where.join(" AND ")} RETURNING id, status` };
}

export function runDiagnosticInbox(argv = process.argv.slice(2)) {
  const { mode, sql } = diagnosticInboxQuery(argv);
  const result = spawnSync("npx", ["wrangler", "d1", "execute", "same-page-production", mode, "--command", sql, "--json"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error("Unable to query diagnostic inbox. Check Cloudflare authorization and applied migrations.");
  const output = JSON.parse(result.stdout);
  const rows = output.flatMap(item => item.results ?? []);
  // JSON escapes control characters from user text; never interpret report content as terminal markup or commands.
  process.stdout.write(`${JSON.stringify(rows.map(row => ({ ...row, ...(row.payload ? { payload: JSON.parse(row.payload) } : {}) })), null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { runDiagnosticInbox(); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
