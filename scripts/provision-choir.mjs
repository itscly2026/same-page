import { spawnSync } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const JOIN_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateJoinCode() {
  return Array.from(
    randomBytes(8),
    (value) => JOIN_CODE_ALPHABET[value & 31],
  ).join("");
}

export function hashJoinCode(code, secret) {
  return createHmac("sha256", secret)
    .update(`join-code:${code}`)
    .digest("base64url");
}

export function provisionChoirFromCli(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const inviteSecret = process.env.INVITE_SECRET;
  if (!inviteSecret || inviteSecret.length < 32) {
    throw new Error("INVITE_SECRET must be provided through the process environment");
  }

  const user = queryAdminUser(options.adminEmail, options.mode);
  if (!user) {
    throw new Error("The administrator must complete OTP registration first");
  }

  const choirId = randomUUID();
  const membershipId = randomUUID();
  const joinCode = generateJoinCode();
  const joinCodeHash = hashJoinCode(joinCode, inviteSecret);
  const sql = [
    `INSERT INTO choirs (id, name, join_code_hash, join_code_version, storage_limit_bytes) VALUES (${quote(choirId)}, ${quote(options.choirName)}, ${quote(joinCodeHash)}, 1, 1073741824);`,
    `INSERT INTO memberships (id, choir_id, user_id, display_name, role, status) VALUES (${quote(membershipId)}, ${quote(choirId)}, ${quote(user.id)}, ${quote(options.adminDisplayName)}, 'admin', 'active');`,
  ].join("\n");

  const temporaryDirectory = mkdtempSync(join(tmpdir(), "same-page-provision-"));
  const sqlPath = join(temporaryDirectory, "provision.sql");
  try {
    writeFileSync(sqlPath, sql, { encoding: "utf8", mode: 0o600 });
    runWrangler([
      "d1",
      "execute",
      "same-page",
      options.mode,
      "--file",
      sqlPath,
      "--yes",
      "--json",
    ]);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }

  process.stdout.write(
    `Choir created. Save this invite code now: ${joinCode}\n`,
  );
}

function queryAdminUser(email, mode) {
  const output = runWrangler([
    "d1",
    "execute",
    "same-page",
    mode,
    "--command",
    `SELECT id FROM user WHERE lower(email) = lower(${quote(email)}) LIMIT 1`,
    "--json",
  ]);
  const parsed = JSON.parse(output);
  return parsed?.[0]?.results?.[0] ?? null;
}

function runWrangler(arguments_) {
  const result = spawnSync("npx", ["wrangler", ...arguments_], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "Wrangler command failed");
  }
  return result.stdout;
}

function parseArguments(argv) {
  const values = new Map();
  let mode = "--local";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--remote") {
      mode = "--remote";
      continue;
    }
    if (argument === "--local") {
      mode = "--local";
      continue;
    }
    if (argument.startsWith("--")) {
      values.set(argument, argv[index + 1]);
      index += 1;
    }
  }

  const adminEmail = values.get("--admin-email")?.trim().toLowerCase();
  const adminDisplayName = values.get("--admin-display-name")?.trim();
  const choirName = values.get("--choir-name")?.trim() || "小红花合唱团";
  if (!adminEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) {
    throw new Error("--admin-email is required");
  }
  if (!adminDisplayName || adminDisplayName.length > 40) {
    throw new Error("--admin-display-name must contain 1 to 40 characters");
  }
  if (choirName.length > 80) {
    throw new Error("--choir-name must contain at most 80 characters");
  }
  return { adminEmail, adminDisplayName, choirName, mode };
}

function quote(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    provisionChoirFromCli();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Provisioning failed"}\n`,
    );
    process.exitCode = 1;
  }
}
