import type { Env } from "../env";

const OLD_VERSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export class StorageQuotaError extends Error {
  constructor() {
    super("Storage quota exceeded");
  }
}

export class ConcurrentReplacementError extends Error {
  constructor() {
    super("Another PDF replacement is in progress");
  }
}

export interface InspectedPdf {
  data: ArrayBuffer;
  sizeBytes: number;
  pageCount: number;
  sha256: string;
}

export async function createScoreVersion(options: {
  env: Env;
  choirId: string;
  membershipId: string;
  metadata: {
    title: string;
    composer: string | null;
    arranger: string | null;
    sortOrder: number;
  };
  pdf: InspectedPdf;
}) {
  const scoreId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const objectKey = scoreObjectKey(options.choirId, scoreId, versionId);
  const now = Date.now();

  try {
    await options.env.DB.batch([
      reserveStorage(options.env.DB, options.choirId, options.pdf.sizeBytes),
      options.env.DB.prepare(
        `INSERT INTO scores
          (id, choir_id, title, composer, arranger, sort_order, status,
           current_version_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'draft', NULL, ?, ?)`,
      ).bind(
        scoreId,
        options.choirId,
        options.metadata.title,
        options.metadata.composer,
        options.metadata.arranger,
        options.metadata.sortOrder,
        now,
        now,
      ),
      options.env.DB.prepare(
        `INSERT INTO score_versions
          (id, choir_id, score_id, version_number, object_key, size_bytes,
           sha256, page_count, state, uploaded_by_membership_id, created_at)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?, 'pending', ?, ?)`,
      ).bind(
        versionId,
        options.choirId,
        scoreId,
        objectKey,
        options.pdf.sizeBytes,
        options.pdf.sha256,
        options.pdf.pageCount,
        options.membershipId,
        now,
      ),
    ]);
  } catch (error) {
    throw classifyReservationError(error);
  }

  try {
    const object = await putPdf(options.env.SCORES_BUCKET, objectKey, options.pdf);
    const readyAt = Date.now();
    const finalized = await options.env.DB.batch([
      options.env.DB.prepare(
        `UPDATE score_versions
         SET state = 'ready', etag = ?, ready_at = ?
         WHERE id = ? AND state = 'pending'`,
      ).bind(object.httpEtag, readyAt, versionId),
      options.env.DB.prepare(
        `UPDATE scores
         SET current_version_id = ?, updated_at = ?
         WHERE id = ?
           AND EXISTS (
             SELECT 1 FROM score_versions
             WHERE id = ? AND state = 'ready'
           )`,
      ).bind(versionId, readyAt, scoreId, versionId),
    ]);
    if (finalized[1].meta.changes !== 1) {
      throw new Error("PDF version finalization lost its reservation");
    }
    return {
      scoreId,
      version: {
        id: versionId,
        versionNumber: 1,
        sizeBytes: options.pdf.sizeBytes,
        sha256: options.pdf.sha256,
        etag: object.httpEtag,
        pageCount: options.pdf.pageCount,
        createdAt: now,
      },
    };
  } catch (error) {
    await releasePendingVersion(options.env, {
      scoreId,
      versionId,
      objectKey,
      removeScore: true,
    });
    await options.env.SCORES_BUCKET.delete(objectKey).catch(() => undefined);
    throw error;
  }
}

export async function replaceScoreVersion(options: {
  env: Env;
  choirId: string;
  scoreId: string;
  membershipId: string;
  currentVersionId: string;
  pdf: InspectedPdf;
}) {
  const versionId = crypto.randomUUID();
  const objectKey = scoreObjectKey(
    options.choirId,
    options.scoreId,
    versionId,
  );
  const now = Date.now();
  let versionNumber: number;

  const lock = await options.env.DB.prepare(
    `UPDATE scores
     SET replacement_lock_id = ?, replacement_lock_expires_at = ?
     WHERE id = ?
       AND choir_id = ?
       AND current_version_id = ?
       AND (replacement_lock_id IS NULL OR replacement_lock_expires_at <= ?)
     RETURNING id`,
  )
    .bind(
      versionId,
      now + 15 * 60 * 1000,
      options.scoreId,
      options.choirId,
      options.currentVersionId,
      now,
    )
    .first<{ id: string }>();
  if (!lock) {
    throw new ConcurrentReplacementError();
  }

  try {
    const results = await options.env.DB.batch([
      reserveStorage(options.env.DB, options.choirId, options.pdf.sizeBytes),
      options.env.DB.prepare(
        `INSERT INTO score_versions
          (id, choir_id, score_id, version_number, object_key, size_bytes,
           sha256, page_count, state, uploaded_by_membership_id, created_at)
         SELECT ?, ?, ?, COALESCE(MAX(version_number), 0) + 1, ?, ?, ?, ?,
                'pending', ?, ?
         FROM score_versions
         WHERE score_id = ?
         RETURNING version_number`,
      ).bind(
        versionId,
        options.choirId,
        options.scoreId,
        objectKey,
        options.pdf.sizeBytes,
        options.pdf.sha256,
        options.pdf.pageCount,
        options.membershipId,
        now,
        options.scoreId,
      ),
    ]);
    versionNumber = Number(
      (results[1].results[0] as { version_number: number }).version_number,
    );
  } catch (error) {
    await releaseReplacementLock(options.env.DB, options.scoreId, versionId);
    throw classifyReservationError(error);
  }

  try {
    const object = await putPdf(options.env.SCORES_BUCKET, objectKey, options.pdf);
    const readyAt = Date.now();
    const finalized = await options.env.DB.batch([
      options.env.DB.prepare(
        `UPDATE score_versions
         SET retention_expires_at = ?
         WHERE id = ? AND state = 'ready'`,
      ).bind(readyAt + OLD_VERSION_RETENTION_MS, options.currentVersionId),
      options.env.DB.prepare(
        `UPDATE score_versions
         SET state = 'ready', etag = ?, ready_at = ?
         WHERE id = ? AND state = 'pending'`,
      ).bind(object.httpEtag, readyAt, versionId),
      options.env.DB.prepare(
        `UPDATE scores
         SET current_version_id = ?, updated_at = ?,
             replacement_lock_id = NULL, replacement_lock_expires_at = NULL
         WHERE id = ? AND current_version_id = ? AND replacement_lock_id = ?
           AND EXISTS (
             SELECT 1 FROM score_versions
             WHERE id = ? AND state = 'ready'
           )`,
      ).bind(
        versionId,
        readyAt,
        options.scoreId,
        options.currentVersionId,
        versionId,
        versionId,
      ),
    ]);
    if (finalized[2].meta.changes !== 1) {
      throw new Error("PDF replacement lost its version lock");
    }
    return {
      id: versionId,
      versionNumber,
      sizeBytes: options.pdf.sizeBytes,
      sha256: options.pdf.sha256,
      etag: object.httpEtag,
      pageCount: options.pdf.pageCount,
      createdAt: now,
    };
  } catch (error) {
    await releasePendingVersion(options.env, {
      scoreId: options.scoreId,
      versionId,
      objectKey,
      removeScore: false,
    });
    await options.env.SCORES_BUCKET.delete(objectKey).catch(() => undefined);
    await releaseReplacementLock(options.env.DB, options.scoreId, versionId);
    throw error;
  }
}

async function releaseReplacementLock(
  binding: D1Database,
  scoreId: string,
  lockId: string,
) {
  await binding
    .prepare(
      `UPDATE scores
       SET replacement_lock_id = NULL, replacement_lock_expires_at = NULL
       WHERE id = ? AND replacement_lock_id = ?`,
    )
    .bind(scoreId, lockId)
    .run()
    .catch(() => undefined);
}

function reserveStorage(binding: D1Database, choirId: string, bytes: number) {
  return binding
    .prepare(
      `UPDATE choirs
       SET storage_used_bytes = storage_used_bytes + ?
       WHERE id = ?`,
    )
    .bind(bytes, choirId);
}

async function putPdf(
  bucket: R2Bucket,
  objectKey: string,
  pdf: InspectedPdf,
) {
  const object = await bucket.put(objectKey, pdf.data, {
    httpMetadata: {
      contentType: "application/pdf",
      cacheControl: "private, max-age=0, must-revalidate",
    },
    customMetadata: { sha256: pdf.sha256 },
    sha256: pdf.sha256,
  });
  if (!object) {
    throw new Error("PDF object was not stored");
  }
  return object;
}

async function releasePendingVersion(
  env: Env,
  options: {
    scoreId: string;
    versionId: string;
    objectKey: string;
    removeScore: boolean;
  },
) {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO score_object_deletions (id, object_key)
       VALUES (?, ?)`,
    ).bind(crypto.randomUUID(), options.objectKey),
    env.DB.prepare("DELETE FROM score_versions WHERE id = ?").bind(
      options.versionId,
    ),
    ...(options.removeScore
      ? [
          env.DB.prepare(
            "DELETE FROM scores WHERE id = ? AND current_version_id IS NULL",
          ).bind(options.scoreId),
        ]
      : []),
  ]).catch(() => undefined);
}

function scoreObjectKey(choirId: string, scoreId: string, versionId: string) {
  return `choirs/${choirId}/scores/${scoreId}/versions/${versionId}.pdf`;
}

function classifyReservationError(error: unknown): Error {
  if (
    error instanceof Error &&
    error.message.includes("choir_storage_quota_exceeded")
  ) {
    return new StorageQuotaError();
  }
  return error instanceof Error ? error : new Error("Storage reservation failed");
}
