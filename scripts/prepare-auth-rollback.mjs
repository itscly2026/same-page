import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { executeD1 } from "./backfill-score-file-names.mjs";
import { verifyAuthSchema } from "./verify-auth-schema.mjs";

const args = process.argv.slice(2);
assert(args.length === 2 && ["--local", "--remote"].includes(args[0]) && args[1] === "--auth-writes-paused",
  "Usage: prepare-auth-rollback.mjs --local|--remote --auth-writes-paused (operator must first stop auth writes and drain in-flight requests)");
const targetArgs = [args[0]];
verifyAuthSchema("after", targetArgs);
// D1 executes the SQL file atomically. The guard rejects unsupported identities.
executeD1({ file: fileURLToPath(new URL("./sql/auth-1.7.2-rollback.sql", import.meta.url)), targetArgs });
const result = executeD1({ command: "SELECT COUNT(*) AS count FROM account WHERE issuer IS NULL", targetArgs });
assert.equal(result[0].results[0].count, 0, "Missing issuer remains; do not deploy 1.7.2");
console.log("Prepared auth identities for 1.7.2. Keep auth writes paused until rollback deployment and login verification finish.");
