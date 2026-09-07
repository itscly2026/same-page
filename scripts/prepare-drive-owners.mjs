import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { executeD1 } from "./backfill-score-file-names.mjs";

export function prepareDriveOwners(targetArgs, mapping = {}) {
  const query = command => executeD1({ command, targetArgs })[0]?.results ?? [];
  const columns = query("PRAGMA table_info(memberships)");
  if (!columns.some(column => column.name === "role")) return;
  const stored = query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'drive_owner_mapping'").length
    ? Object.fromEntries(query("SELECT choir_id, user_id FROM drive_owner_mapping").map(row => [row.choir_id, row.user_id])) : {};
  mapping = { ...stored, ...mapping };
  const rows = query(`SELECT c.id AS choirId, m.id AS membershipId, m.user_id AS userId, m.role
    FROM choirs c LEFT JOIN memberships m ON m.choir_id = c.id AND m.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM user_lifecycle WHERE user_id = m.user_id)`);
  const choices = [];
  for (const choirId of new Set(rows.map(row => row.choirId))) {
    const members = rows.filter(row => row.choirId === choirId && row.membershipId);
    const admins = members.filter(row => row.role === "admin");
    const target = Object.hasOwn(mapping, choirId) ? members.find(row => row.userId === mapping[choirId]) : admins.length === 1 ? admins[0] : null;
    if (!target) throw new Error(`Drive ${choirId}: provide an explicit valid active member in --mapping; no unique owner can be inferred.`);
    choices.push([choirId, target.userId]);
  }
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  executeD1({ targetArgs, command: [
    "CREATE TABLE IF NOT EXISTS drive_owner_mapping (choir_id TEXT PRIMARY KEY, user_id TEXT NOT NULL)",
    ...choices.map(([choir, user]) => `INSERT INTO drive_owner_mapping VALUES (${quote(choir)}, ${quote(user)}) ON CONFLICT(choir_id) DO UPDATE SET user_id = excluded.user_id`),
  ].join(";\n") });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    const index = args.indexOf("--mapping");
    const mapping = index === -1 ? {} : JSON.parse(readFileSync(args[index + 1], "utf8"));
    if (!mapping || Array.isArray(mapping) || typeof mapping !== "object" || Object.values(mapping).some(value => typeof value !== "string")) throw new Error("Mapping must be a JSON object of drive IDs to user IDs.");
    if (index !== -1) args.splice(index, 2);
    prepareDriveOwners(args.length ? args : ["--local"], mapping);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
