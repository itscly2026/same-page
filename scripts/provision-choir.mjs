import { spawnSync } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const JOIN_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const DATABASE_NAME = process.env.SAME_PAGE_DATABASE_NAME || "same-page-production";

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
    throw new Error("The administrator must complete registration first");
  }

  const choirId = randomUUID();
  const membershipId = randomUUID();
  const joinCode = options.guestAdmission === "invite" ? generateJoinCode() : null;
  const joinCodeHash = joinCode ? hashJoinCode(joinCode, inviteSecret) : null;
  const sql = [
    `INSERT INTO choirs (id, name, guest_admission_mode, guest_session_version, is_preview_entry, join_code_hash, storage_limit_bytes) VALUES (${quote(choirId)}, ${quote(options.choirName)}, ${quote(options.guestAdmission)}, 1, ${options.previewEntry ? 1 : 0}, ${quoteNullable(joinCodeHash)}, 1073741824);`,
    `INSERT INTO memberships (id, choir_id, user_id, display_name, role, status) VALUES (${quote(membershipId)}, ${quote(choirId)}, ${quote(user.id)}, ${quote(options.adminDisplayName)}, 'admin', 'active');`,
  ].join("\n");

  const temporaryDirectory = mkdtempSync(join(tmpdir(), "same-page-provision-"));
  const sqlPath = join(temporaryDirectory, "provision.sql");
  try {
    writeFileSync(sqlPath, sql, { encoding: "utf8", mode: 0o600 });
    runWrangler([
      "d1",
      "execute",
      DATABASE_NAME,
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
    formatSuccessMessage(joinCode, options.showJoinCode, options.guestAdmission),
  );
}

function queryAdminUser(email, mode) {
  const output = runWrangler([
    "d1",
    "execute",
    DATABASE_NAME,
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

export function parseArguments(argv) {
  const values = new Map();
  let mode = "--local";
  let showJoinCode = false;
  let previewEntry = false;
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
    if (argument === "--show-join-code") {
      showJoinCode = true;
      continue;
    }
    if (argument === "--preview-entry") {
      previewEntry = true;
      continue;
    }
    if (argument.startsWith("--")) {
      values.set(argument, argv[index + 1]);
      index += 1;
    }
  }

  const adminEmail = values.get("--admin-email")?.trim().toLowerCase();
  const adminDisplayName = values.get("--admin-display-name")?.trim();
  const choirName = values.get("--choir-name")?.trim() || "小红花云盘";
  const guestAdmission = values.get("--guest-admission")?.trim() || "invite";
  if (!adminEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) {
    throw new Error("--admin-email is required");
  }
  if (!adminDisplayName || adminDisplayName.length > 40) {
    throw new Error("--admin-display-name must contain 1 to 40 characters");
  }
  if (choirName.length > 80) {
    throw new Error("--choir-name must contain at most 80 characters");
  }
  if (guestAdmission !== "invite" && guestAdmission !== "open") {
    throw new Error("--guest-admission must be invite or open");
  }
  if (previewEntry && guestAdmission !== "open") {
    throw new Error("--preview-entry requires --guest-admission open");
  }
  return {
    adminEmail,
    adminDisplayName,
    choirName,
    guestAdmission,
    mode,
    previewEntry,
    showJoinCode,
  };
}

export function formatSuccessMessage(joinCode, showJoinCode, guestAdmission) {
  if (guestAdmission === "open") {
    return "Choir created with open guest admission.\n";
  }
  if (showJoinCode) {
    return `Choir created. Invite code: ${joinCode}\n`;
  }
  return (
    "Choir created. The initial invite code was not displayed. " +
    "Sign in as the administrator and rotate it before sharing.\n"
  );
}

function quote(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function quoteNullable(value) {
  return value === null ? "NULL" : quote(value);
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
