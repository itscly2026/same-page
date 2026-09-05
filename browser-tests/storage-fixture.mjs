import { createLocalAccountIssuer } from "@better-auth/core/db";
import { hashPassword } from "better-auth/crypto";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { readD1Migrations } from "@cloudflare/vitest-plugin";
import { getPlatformProxy } from "wrangler";
import { createSampleScorePdf } from "../visual-report/fixtures.mjs";
import { startViteServer } from "../scripts/vite-server.mjs";

// Each call owns a fresh local Worker store. Bindings are disposed before Vite
// opens them, so the seed and server never contend for the same SQLite files.
export async function startStorageFixture({ authenticated = false, script = "preview", expired = false } = {}) {
  const accounts = authenticated ? [0, 1].map(() => ({ id: randomUUID(), email: `${randomUUID()}@example.test`, password: randomBytes(24).toString("hex") })) : [];
  const choirId = randomUUID(), scoreId = randomUUID(), versionId = randomUUID();
  const fileName = "本地链路测试.pdf";
  const pdf = createSampleScorePdf();
  const hash = createHash("sha256").update(pdf).digest("hex");
  const server = await startViteServer({
    script, timeoutMs: 30_000,
    prepare: async ({ statePath, configPath, signal }) => {
      const platform = await getPlatformProxy({ configPath, persist: { path: path.join(statePath, "v3") } });
      try {
        signal.throwIfAborted();
        const { DB, SCORES_BUCKET } = platform.env;
        for (const migration of await readD1Migrations(path.resolve("migrations"))) {
          signal.throwIfAborted();
          await DB.batch(migration.queries.map((query) => DB.prepare(query)));
        }
        signal.throwIfAborted();
        const objectKey = `${choirId}/${scoreId}/${versionId}.pdf`;
        const object = await SCORES_BUCKET.put(objectKey, pdf, { httpMetadata: { contentType: "application/pdf" } });
        await DB.batch([
          DB.prepare("INSERT INTO choirs (id, name, guest_admission_mode, is_preview_entry, storage_used_bytes) VALUES (?, '本地链路云盘', 'open', 1, ?)").bind(choirId, pdf.length),
          DB.prepare("INSERT INTO scores (id, choir_id, file_name, file_name_key, current_version_id) VALUES (?, ?, ?, ?, ?)").bind(scoreId, choirId, fileName, fileName, versionId),
          DB.prepare("INSERT INTO score_versions (id, choir_id, score_id, version_number, object_key, size_bytes, sha256, etag, page_count, state) VALUES (?, ?, ?, 1, ?, ?, ?, ?, 2, 'ready')").bind(versionId, choirId, scoreId, objectKey, pdf.length, hash, object.etag),
        ]);
        if (expired) {
          const now = Date.now();
          await DB.prepare("UPDATE scores SET trashed_at = ?, trash_expires_at = ? WHERE id = ?")
            .bind(now - 31 * 86400000, now - 86400000, scoreId).run();
        }
        for (const [index, account] of accounts.entries()) {
          const now = Date.now();
          await DB.batch([
            DB.prepare("INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, '本地测试用户', ?, 1, ?, ?)").bind(account.id, account.email, now, now),
            DB.prepare("INSERT INTO account (id, issuer, account_id, provider_id, user_id, password, created_at, updated_at) VALUES (?, ?, ?, 'credential', ?, ?, ?, ?)").bind(randomUUID(), createLocalAccountIssuer("credential"), account.id, account.id, await hashPassword(account.password), now, now),
            DB.prepare("INSERT INTO memberships (id, choir_id, user_id, display_name, role, status) VALUES (?, ?, ?, '本地测试成员', ?, 'active')").bind(randomUUID(), choirId, account.id, index === 0 ? "admin" : "member"),
          ]);
        }
        await DB.batch([
          ["E", "Ensemble", "#a12652"], ["S", "Soprano", "#3566a6"],
          ["A", "Alto", "#8a5a13"], ["T", "Tenor", "#52763a"], ["B", "Bass", "#75529b"],
        ].map(([slot, name, color], order) => DB.prepare("INSERT INTO annotation_layers (id, choir_id, score_id, kind, default_slot, name, sort_order, default_color) VALUES (?, ?, ?, 'shared', ?, ?, ?, ?)").bind(randomUUID(), choirId, scoreId, slot, name, order, color)));
      } finally { await platform.dispose(); }
    },
  });
  const { buildId } = JSON.parse(await readFile("dist/client/build.json", "utf8"));
  return { ...server, choirId, scoreId, versionId, fileName, pdf, buildId, accounts };
}
