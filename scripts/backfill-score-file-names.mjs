import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

import { canonicalScoreFileNameKey } from "../src/shared/score-file-name-key.mjs";

const databaseName = "same-page-production";
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const wranglerBin = fileURLToPath(
  new URL("../node_modules/.bin/wrangler", import.meta.url),
);
const maxFileNameLength = 255;

export function planLegacyScoreFileNames(rows) {
  const sortedRows = [...rows].sort(compareLegacyRows);
  const usedKeysByChoir = new Map();

  for (const row of sortedRows) {
    if (needsLegacyBackfill(row)) continue;
    const usedKeys = usedKeysByChoir.get(row.choir_id) ?? new Set();
    usedKeys.add(row.file_name_key);
    usedKeysByChoir.set(row.choir_id, usedKeys);
  }

  return sortedRows.filter(needsLegacyBackfill).map((row) => {
    const usedKeys = usedKeysByChoir.get(row.choir_id) ?? new Set();
    usedKeysByChoir.set(row.choir_id, usedKeys);

    let copyNumber = 1;
    let fileName;
    let fileNameKey;
    do {
      fileName = legacyPdfFileName(row.file_name, copyNumber);
      fileNameKey = canonicalScoreFileNameKey(fileName);
      copyNumber += 1;
    } while (usedKeys.has(fileNameKey));

    usedKeys.add(fileNameKey);
    return { id: row.id, choirId: row.choir_id, fileName, fileNameKey };
  });
}

export function executeD1({ command, file, targetArgs }) {
  const operationArgs = file ? ["--file", file] : ["--command", command];
  const output = execFileSync(
    wranglerBin,
    ["d1", "execute", databaseName, ...targetArgs, ...operationArgs, "--json"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const result = JSON.parse(output);
  if (!Array.isArray(result) || result.some((entry) => !entry.success)) {
    throw new Error("D1 command failed");
  }
  return result;
}

export function backfillLegacyScoreFileNames(targetArgs) {
  const rows = firstResults(
    executeD1({
      command:
        "SELECT id, choir_id, file_name, file_name_key, created_at FROM scores " +
        "ORDER BY choir_id, created_at, id",
      targetArgs,
    }),
  );
  const planned = planLegacyScoreFileNames(rows);
  if (planned.length === 0) return 0;

  const occupiedKeys = new Set([
    ...rows.map((row) => row.file_name_key),
    ...planned.map((row) => row.fileNameKey),
  ]);
  let temporaryPrefix;
  do {
    temporaryPrefix = `score-filename-migration:${randomUUID()}:`;
  } while (rows.some((row) => occupiedKeys.has(temporaryPrefix + row.id)));

  for (const chunk of chunks(planned, 50)) {
    const ids = chunk.map((row) => sqlLiteral(row.id)).join(", ");
    executeD1({
      command:
        `UPDATE scores SET file_name_key = ${sqlLiteral(temporaryPrefix)} || id ` +
        `WHERE id IN (${ids})`,
      targetArgs,
    });
  }

  for (const chunk of chunks(planned, 50)) {
    executeD1({ command: updateCommand(chunk), targetArgs });
  }

  const migratedRows = firstResults(
    executeD1({
      command: "SELECT id, choir_id, file_name, file_name_key FROM scores",
      targetArgs,
    }),
  );
  verifyBackfill(migratedRows, planned);
  return planned.length;
}

function legacyPdfFileName(rawFileName, copyNumber) {
  const normalized = String(rawFileName ?? "").normalize("NFC").trim();
  const validName = normalized && normalized !== "." && normalized !== ".."
    ? normalized
    : "Untitled";
  const hasPdfExtension = canonicalScoreFileNameKey(validName).endsWith(".pdf");
  const rawStem = hasPdfExtension ? validName.slice(0, -4).trimEnd() : validName;
  const stem = rawStem || "Untitled";
  const suffix = copyNumber === 1 ? "" : ` (${copyNumber})`;
  const maximumStemLength = maxFileNameLength - suffix.length - 4;
  return `${truncateUtf16(stem, maximumStemLength)}${suffix}.pdf`;
}

function truncateUtf16(value, maximumLength) {
  let truncated = value.slice(0, maximumLength);
  const lastCodeUnit = truncated.charCodeAt(truncated.length - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
    truncated = truncated.slice(0, -1);
  }
  return truncated || "Untitled".slice(0, maximumLength);
}

function compareLegacyRows(left, right) {
  if (left.choir_id !== right.choir_id) return compareText(left.choir_id, right.choir_id);
  if (left.created_at !== right.created_at) return left.created_at - right.created_at;
  return compareText(left.id, right.id);
}

function needsLegacyBackfill(row) {
  return (
    row.file_name_key === `legacy-score:${row.id}` ||
    (row.file_name_key.startsWith("score-filename-migration:") &&
      row.file_name_key.endsWith(`:${row.id}`))
  );
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function updateCommand(rows) {
  const fileNameCases = rows
    .map((row) => `WHEN ${sqlLiteral(row.id)} THEN ${sqlLiteral(row.fileName)}`)
    .join(" ");
  const keyCases = rows
    .map((row) => `WHEN ${sqlLiteral(row.id)} THEN ${sqlLiteral(row.fileNameKey)}`)
    .join(" ");
  const ids = rows.map((row) => sqlLiteral(row.id)).join(", ");
  return (
    `UPDATE scores SET file_name = CASE id ${fileNameCases} ELSE file_name END, ` +
    `file_name_key = CASE id ${keyCases} ELSE file_name_key END ` +
    `WHERE id IN (${ids})`
  );
}

function verifyBackfill(rows, planned) {
  const actualById = new Map(rows.map((row) => [row.id, row]));
  const activeKeys = new Set();
  for (const expected of planned) {
    const actual = actualById.get(expected.id);
    if (
      !actual ||
      actual.file_name !== expected.fileName ||
      actual.file_name_key !== expected.fileNameKey
    ) {
      throw new Error("score filename backfill did not persist its plan");
    }
    const uniqueKey = `${actual.choir_id}\0${actual.file_name_key}`;
    if (activeKeys.has(uniqueKey)) {
      throw new Error("score filename backfill produced a duplicate key");
    }
    activeKeys.add(uniqueKey);
  }
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function firstResults(result) {
  return result[0]?.results ?? [];
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function parseTargetArgs(arguments_) {
  const isLocal = arguments_.includes("--local");
  const isRemote = arguments_.includes("--remote");
  if (isLocal === isRemote) {
    throw new Error("pass exactly one of --local or --remote");
  }
  return arguments_;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const count = backfillLegacyScoreFileNames(parseTargetArgs(process.argv.slice(2)));
  process.stdout.write(`Backfilled ${count} score filename${count === 1 ? "" : "s"}.\n`);
}
