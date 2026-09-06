import { createSharedLayerInstances } from "../annotations/shared-layer-instances";
import type { Env } from "../env";

export const PDF_CANDIDATE_LIFETIME_MS = 24 * 60 * 60 * 1000;

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

export class FilenameConflictError extends Error {
  constructor() {
    super("An active score already uses this file name");
  }
}

export function isFilenameConflictError(error: unknown) {
  return (
    error instanceof Error &&
    (error.message.includes("scores_active_filename_uidx") ||
      error.message.includes("scores.choir_id, scores.file_name_key"))
  );
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
  fileName: string;
  fileNameKey: string;
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
          (id, choir_id, file_name, file_name_key, current_version_id,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?)`,
      ).bind(
        scoreId,
        options.choirId,
        options.fileName,
        options.fileNameKey,
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
      createSharedLayerInstances(options.env.DB, { choirId: options.choirId, scoreId, membershipId: options.membershipId }),
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

export async function stageScoreVersion(options: {
  env: Env;
  choirId: string;
  scoreId: string;
  membershipId: string;
  currentVersionId: string;
  expectedRevision: number;
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
     SET replacement_lock_id = ?, replacement_lock_expires_at = ?,
         last_version_number = last_version_number + 1
     WHERE id = ?
       AND choir_id = ?
       AND current_version_id = ? AND version_revision = ? AND trashed_at IS NULL
       AND EXISTS (SELECT 1 FROM memberships WHERE id = ? AND role = 'admin' AND status = 'active')
       AND (replacement_lock_id IS NULL OR replacement_lock_expires_at <= ?)
     RETURNING last_version_number`,
  )
    .bind(
      versionId,
      now + 15 * 60 * 1000,
      options.scoreId,
      options.choirId,
      options.currentVersionId,
      options.expectedRevision,
      options.membershipId,
      now,
    )
    .first<{ last_version_number: number }>();
  if (!lock) {
    throw new ConcurrentReplacementError();
  }

  try {
    versionNumber = lock.last_version_number;
    await options.env.DB.batch([
      reserveStorage(options.env.DB, options.choirId, options.pdf.sizeBytes),
      options.env.DB.prepare(
        `INSERT INTO score_versions
          (id, choir_id, score_id, version_number, object_key, size_bytes,
           sha256, page_count, state, uploaded_by_membership_id, created_at,
           candidate_expires_at, base_revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      ).bind(versionId, options.choirId, options.scoreId, versionNumber, objectKey,
        options.pdf.sizeBytes, options.pdf.sha256, options.pdf.pageCount,
        options.membershipId, now, now + PDF_CANDIDATE_LIFETIME_MS, options.expectedRevision),
    ]);
  } catch (error) {
    await releaseReplacementLock(options.env.DB, options.scoreId, versionId);
    throw classifyReservationError(error);
  }

  try {
    const object = await putPdf(options.env.SCORES_BUCKET, objectKey, options.pdf);
    const readyAt = Date.now();
    const finalized = await options.env.DB.prepare(
      `UPDATE score_versions SET state = 'ready', etag = ?, ready_at = ?
       WHERE id = ? AND state = 'pending' AND candidate_expires_at > ?
         AND EXISTS (SELECT 1 FROM scores WHERE id = ? AND trashed_at IS NULL
           AND replacement_lock_id = ? AND version_revision = ?)`,
    ).bind(object.httpEtag, readyAt, versionId, readyAt, options.scoreId,
      versionId, options.expectedRevision).run();
    if (finalized.meta.changes !== 1) throw new ConcurrentReplacementError();
    await releaseReplacementLock(options.env.DB, options.scoreId, versionId);
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
  if (isFilenameConflictError(error)) {
    return new FilenameConflictError();
  }
  return error instanceof Error ? error : new Error("Storage reservation failed");
}
