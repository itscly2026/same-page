import { verifyAuthSchema } from "./verify-auth-schema.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeD1 } from "./backfill-score-file-names.mjs";

const root = mkdtempSync(join(tmpdir(), "same-page-auth-migration-"));
const targetArgs = ["--local", "--persist-to", root];
const query = (command) => executeD1({ command, targetArgs }).map((r) => r.results);
const migration = readFileSync(new URL("../migrations/0026_auth_provider_identity.sql", import.meta.url), "utf8");
function apply(sql) {
  const file = join(root, "migration.sql");
  writeFileSync(file, sql);
  return executeD1({ file, targetArgs });
}
try {
  apply(readFileSync(new URL("../migrations/0001_auth_and_choirs.sql", import.meta.url), "utf8"));
  query(`INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES
    ('u1','Existing','existing@example.test',1,100,200),
    ('u2','Other','other@example.test',1,100,200);
    INSERT INTO session(id,expires_at,token,created_at,updated_at,user_id) VALUES ('s1',9999999999999,'fixture-token',100,200,'u1');
    INSERT INTO account VALUES
    ('a1','local:credential','u1','credential','u1',NULL,NULL,NULL,NULL,NULL,NULL,'fixture-hash',100,200),
    ('a2','https://accounts.google.com','google-sub','google','u1','fixture-access','fixture-refresh',NULL,300,400,'openid email',NULL,100,200),
    ('a3','other-issuer','google-sub','google','u2',NULL,NULL,NULL,NULL,NULL,NULL,NULL,100,200);`);
  const [before] = query("SELECT * FROM account ORDER BY id");
  assert.throws(() => apply(migration), "Duplicate identities must stop migration");
  assert.deepEqual(query("SELECT * FROM account ORDER BY id")[0], before);
  assert.equal(query("SELECT name FROM sqlite_master WHERE name IN ('account_compat','account_provider_accountId_preflight')")[0].length, 0);
  query("DELETE FROM account WHERE id = 'a3'");
  const snapshotSql = "SELECT * FROM account ORDER BY id; SELECT * FROM user ORDER BY id; SELECT * FROM session ORDER BY id";
  const snapshot = query(snapshotSql);
  verifyAuthSchema("before", targetArgs);
  apply(migration);
  verifyAuthSchema("after", targetArgs);
  assert.deepEqual(query(snapshotSql), snapshot, "Migration must preserve every stored field");
  assert.equal(query("PRAGMA table_info(account)")[0].find((c) => c.name === "issuer").notnull, 0);
  assert.equal(query("PRAGMA foreign_key_check")[0].length, 0);
  // Old and new writers coexist; distinct providers may have identical subjects.
  query(`INSERT INTO account(id,issuer,account_id,provider_id,user_id,password,updated_at)
    VALUES ('old-write','local:credential','u2','credential','u2','old-hash',200);
    INSERT INTO account(id,account_id,provider_id,user_id,updated_at)
    VALUES ('new-write','u2','google','u2',200);`);
  assert.throws(() => query(`INSERT INTO account(id,account_id,provider_id,user_id,updated_at)
    VALUES ('duplicate','u2','google','u1',200)`));
  assert.equal(query("SELECT issuer FROM account WHERE id='new-write'")[0][0].issuer, null);
  const rollback = readFileSync(new URL("./sql/auth-1.7.2-rollback.sql", import.meta.url), "utf8");
  query("INSERT INTO account(id,account_id,provider_id,user_id,updated_at) VALUES ('unsupported','subject','unsupported','u2',200)");
  const beforeRollback = query("SELECT * FROM account ORDER BY id")[0];
  assert.throws(() => apply(rollback), "Unknown providers must stop rollback without partial updates");
  assert.deepEqual(query("SELECT * FROM account ORDER BY id")[0], beforeRollback);
  query("DELETE FROM account WHERE id='unsupported'");
  const rollbackSnapshot = query(snapshotSql);
  apply(rollback);
  const afterRollback = query(snapshotSql);
  assert.deepEqual(afterRollback[0].map((row) => ({ ...row, issuer: null })), rollbackSnapshot[0].map((row) => ({ ...row, issuer: null })));
  assert.deepEqual(afterRollback.slice(1), rollbackSnapshot.slice(1));
  assert.equal(query("SELECT COUNT(*) AS count FROM account WHERE issuer IS NULL")[0][0].count, 0);
  apply(rollback);
  assert.deepEqual(query(snapshotSql), afterRollback, "Rollback preparation must be idempotent");
  query("DELETE FROM user WHERE id='u2'");
  assert.equal(query("SELECT id FROM account WHERE user_id='u2'")[0].length, 0);
  assert.equal(query("PRAGMA foreign_key_check")[0].length, 0);
  console.log("Auth migration verified in local D1: conflict rollback, exact data preservation, old/new writes, uniqueness and cascade.");
} finally {
  rmSync(root, { recursive: true, force: true });
}
