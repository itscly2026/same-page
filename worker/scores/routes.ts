import { and, eq, isNull } from "drizzle-orm";
import { type Context, Hono } from "hono";

import {
  MAX_PDF_BYTES,
  SCORE_TRASH_RETENTION_DAYS,
  scoreFileNameKey,
  scoreFileNameSchema,
  scoreRenameRequestSchema,
} from "../../src/shared/scores";
import { requireChoirAdmin } from "../auth/authorization";
import { resolveContextChoirReadAccess } from "../auth/choir-read-access";
import { resolveContextPrincipal } from "../auth/context-principal";
import { createDatabase } from "../db/database";
import { scores } from "../db/schema";
import type { AppEnvironment } from "../env";
import { measureServerTiming } from "../performance/server-timing";
import { PdfValidationError, inspectPdf } from "./pdf-validation";
import {
  ConcurrentReplacementError,
  createScoreVersion,
  FilenameConflictError,
  isFilenameConflictError,
  replaceScoreVersion,
  StorageQuotaError,
} from "./storage";

const TRASH_RETENTION_MS = SCORE_TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const fileNameCollator = new Intl.Collator("zh-CN", {
  numeric: true,
  sensitivity: "base",
});

export const scoreRoutes = new Hono<AppEnvironment>();

scoreRoutes.get("/choirs/:choirId/bootstrap", async (context) => {
  const choirId = context.req.param("choirId");
  const access = await resolveChoirAccess(context, choirId);
  const search = context.req.query("q")?.trim().slice(0, 120) ?? "";
  const pattern = `%${escapeLike(scoreFileNameKey(search))}%`;
  const rows = await measureServerTiming(context, "d1", () =>
    context.env.DB.prepare(
      `SELECT choirs.id AS drive_id, choirs.name AS drive_name,
              choirs.guest_admission_mode, choirs.storage_used_bytes,
              choirs.storage_limit_bytes,
              scores.id AS score_id, scores.choir_id, scores.file_name,
              scores.updated_at, versions.id AS version_id,
              versions.version_number, versions.size_bytes, versions.sha256,
              versions.etag, versions.page_count,
              versions.created_at AS version_created_at
       FROM choirs
       LEFT JOIN scores
         ON scores.choir_id = choirs.id AND scores.trashed_at IS NULL
        AND (? = '' OR scores.file_name_key LIKE ? ESCAPE '\\')
       LEFT JOIN score_versions AS versions
         ON versions.id = scores.current_version_id AND versions.state = 'ready'
       WHERE choirs.id = ?`,
    )
      .bind(search, pattern, choirId)
      .all<DriveBootstrapRow>());
  const drive = rows.results[0];
  if (!drive) return context.json({ error: "not_found" }, 404);
  const serialized = rows.results
    .filter((row): row is DriveBootstrapScoreRow =>
      row.score_id !== null && row.version_id !== null)
    .map((row) => serializeScoreRow({
      id: row.score_id,
      choir_id: row.choir_id,
      file_name: row.file_name,
      updated_at: row.updated_at,
      version_id: row.version_id,
      version_number: row.version_number,
      size_bytes: row.size_bytes,
      sha256: row.sha256,
      etag: row.etag,
      page_count: row.page_count,
      version_created_at: row.version_created_at,
    }))
    .sort((left, right) => fileNameCollator.compare(left.fileName, right.fileName));

  return context.json({
    choir: {
      id: drive.drive_id,
      name: drive.drive_name,
      guestAdmissionMode: drive.guest_admission_mode,
    },
    scores: serialized,
    storage: {
      usedBytes: drive.storage_used_bytes,
      limitBytes: drive.storage_limit_bytes,
    },
    permissions: {
      canManage: access.canManage,
      access: access.kind,
    },
  });
});

scoreRoutes.get("/choirs/:choirId/scores", async (context) => {
  const choirId = context.req.param("choirId");
  const access = await resolveChoirAccess(context, choirId);
  const search = context.req.query("q")?.trim().slice(0, 120) ?? "";
  const pattern = `%${escapeLike(scoreFileNameKey(search))}%`;
  const result = await measureServerTiming(context, "d1", () => context.env.DB.prepare(
    `SELECT scores.id, scores.choir_id, scores.file_name, scores.updated_at,
            versions.id AS version_id, versions.version_number,
            versions.size_bytes, versions.sha256, versions.etag,
            versions.page_count, versions.created_at AS version_created_at
     FROM scores
     INNER JOIN score_versions AS versions
       ON versions.id = scores.current_version_id AND versions.state = 'ready'
     WHERE scores.choir_id = ? AND scores.trashed_at IS NULL
       AND (? = '' OR scores.file_name_key LIKE ? ESCAPE '\\')`,
  )
    .bind(choirId, search, pattern)
    .all<ScoreRow>());
  const storage = await measureServerTiming(context, "d1", () =>
    loadStorage(context, choirId));
  const serialized = result.results
    .map(serializeScoreRow)
    .sort((left, right) => fileNameCollator.compare(left.fileName, right.fileName));

  return context.json({
    scores: serialized,
    storage,
    permissions: { canManage: access.canManage },
  });
});

scoreRoutes.get("/choirs/:choirId/scores/trash", async (context) => {
  const choirId = context.req.param("choirId");
  await requireAdmin(context, choirId);
  const result = await context.env.DB.prepare(
    `SELECT scores.id, scores.choir_id, scores.file_name, scores.updated_at,
            scores.trashed_at, scores.trash_expires_at,
            versions.id AS version_id, versions.version_number,
            versions.size_bytes, versions.sha256, versions.etag,
            versions.page_count, versions.created_at AS version_created_at
     FROM scores
     INNER JOIN score_versions AS versions
       ON versions.id = scores.current_version_id AND versions.state = 'ready'
     WHERE scores.choir_id = ? AND scores.trashed_at IS NOT NULL`,
  )
    .bind(choirId)
    .all<TrashedScoreRow>();
  const serialized = result.results
    .map(serializeTrashedScoreRow)
    .sort((left, right) => fileNameCollator.compare(left.fileName, right.fileName));
  return context.json({ scores: serialized, storage: await loadStorage(context, choirId) });
});

scoreRoutes.get("/choirs/:choirId/scores/:scoreId/status", async (context) => {
  const choirId = context.req.param("choirId");
  const scoreId = context.req.param("scoreId");
  await resolveChoirAccess(context, choirId);
  const row = await measureServerTiming(context, "d1", () =>
    context.env.DB.prepare(
      "SELECT trashed_at, trash_expires_at FROM scores WHERE id = ? AND choir_id = ?",
    )
      .bind(scoreId, choirId)
      .first<{ trashed_at: number | null; trash_expires_at: number | null }>());
  if (!row) return context.json({ error: "score_not_found" }, 404);
  return context.json(
    row.trashed_at === null
      ? { state: "active" as const }
      : { state: "trashed" as const, trashExpiresAt: row.trash_expires_at ?? undefined },
  );
});

scoreRoutes.get("/choirs/:choirId/scores/:scoreId/bootstrap", async (context) => {
  const choirId = context.req.param("choirId");
  const scoreId = context.req.param("scoreId");
  const access = await resolveChoirAccess(context, choirId);
  const row = await measureServerTiming(context, "d1", () =>
    context.env.DB.prepare(
      `SELECT scores.id, scores.choir_id, scores.file_name, scores.updated_at,
            scores.trashed_at, scores.trash_expires_at,
            versions.id AS version_id, versions.version_number,
            versions.size_bytes, versions.sha256, versions.etag,
            versions.page_count, versions.created_at AS version_created_at
     FROM scores
     INNER JOIN score_versions AS versions
       ON versions.id = scores.current_version_id AND versions.state = 'ready'
     WHERE scores.id = ? AND scores.choir_id = ?
       LIMIT 1`,
    )
      .bind(scoreId, choirId)
      .first<TrashedScoreRow>());
  if (!row) return context.json({ error: "score_not_found" }, 404);
  if (row.trashed_at !== null) {
    return context.json({
      state: "trashed" as const,
      trashExpiresAt: row.trash_expires_at ?? undefined,
    });
  }
  return context.json({
    state: "active" as const,
    score: serializeScoreRow(row),
    permissions: { canManage: access.canManage },
  });
});

scoreRoutes.post("/choirs/:choirId/scores", async (context) => {
  const choirId = context.req.param("choirId");
  const { membership } = await requireAdmin(context, choirId);
  const parsed = await parsePdfUpload(context);
  if (parsed instanceof Response) return parsed;

  try {
    const inspected = await inspectPdf(parsed.data);
    const created = await createScoreVersion({
      env: context.env,
      choirId,
      membershipId: membership.id,
      fileName: parsed.fileName,
      fileNameKey: scoreFileNameKey(parsed.fileName),
      pdf: {
        data: parsed.data,
        sizeBytes: parsed.data.byteLength,
        ...inspected,
      },
    });
    return context.json(
      {
        score: {
          id: created.scoreId,
          choirId,
          fileName: parsed.fileName,
          currentVersion: created.version,
          updatedAt: Date.now(),
        },
      },
      201,
    );
  } catch (error) {
    return uploadError(context, error);
  }
});

scoreRoutes.post("/choirs/:choirId/scores/:scoreId/versions", async (context) => {
  const choirId = context.req.param("choirId");
  const scoreId = context.req.param("scoreId");
  const { membership } = await requireAdmin(context, choirId);
  const parsed = await parsePdfUpload(context);
  if (parsed instanceof Response) return parsed;

  const database = createDatabase(context.env.DB);
  const score = await database.query.scores.findFirst({
    where: and(
      eq(scores.id, scoreId),
      eq(scores.choirId, choirId),
      isNull(scores.trashedAt),
    ),
  });
  if (!score?.currentVersionId) {
    return context.json({ error: "score_not_found" }, 404);
  }

  try {
    const inspected = await inspectPdf(parsed.data);
    const version = await replaceScoreVersion({
      env: context.env,
      choirId,
      scoreId,
      currentVersionId: score.currentVersionId,
      membershipId: membership.id,
      pdf: {
        data: parsed.data,
        sizeBytes: parsed.data.byteLength,
        ...inspected,
      },
    });
    return context.json({ version }, 201);
  } catch (error) {
    return uploadError(context, error);
  }
});

scoreRoutes.patch("/choirs/:choirId/scores/:scoreId", async (context) => {
  const choirId = context.req.param("choirId");
  const scoreId = context.req.param("scoreId");
  await requireAdmin(context, choirId);
  const parsed = scoreRenameRequestSchema.safeParse(
    await context.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return context.json({ error: "invalid_file_name" }, 400);
  }

  try {
    const updated = await context.env.DB.prepare(
      `UPDATE scores SET file_name = ?, file_name_key = ?, updated_at = ?
       WHERE id = ? AND choir_id = ? RETURNING id, trashed_at`,
    )
      .bind(
        parsed.data.fileName,
        scoreFileNameKey(parsed.data.fileName),
        Date.now(),
        scoreId,
        choirId,
      )
      .first<{ id: string; trashed_at: number | null }>();
    if (!updated) return context.json({ error: "score_not_found" }, 404);
    return context.json({
      score: {
        id: updated.id,
        fileName: parsed.data.fileName,
        trashed: updated.trashed_at !== null,
      },
    });
  } catch (error) {
    if (isFilenameConflictError(error)) {
      return context.json({ error: "filename_conflict" }, 409);
    }
    throw error;
  }
});

scoreRoutes.delete("/choirs/:choirId/scores/:scoreId", async (context) => {
  const choirId = context.req.param("choirId");
  const scoreId = context.req.param("scoreId");
  await requireAdmin(context, choirId);
  const now = Date.now();
  const moved = await context.env.DB.prepare(
    `UPDATE scores SET trashed_at = ?, trash_expires_at = ?, updated_at = ?
     WHERE id = ? AND choir_id = ? AND trashed_at IS NULL`,
  )
    .bind(now, now + TRASH_RETENTION_MS, now, scoreId, choirId)
    .run();
  if (moved.meta.changes !== 1) {
    return context.json({ error: "score_not_found" }, 404);
  }
  return context.body(null, 204);
});

scoreRoutes.post("/choirs/:choirId/scores/:scoreId/restore", async (context) => {
  const choirId = context.req.param("choirId");
  const scoreId = context.req.param("scoreId");
  await requireAdmin(context, choirId);
  try {
    const restored = await context.env.DB.prepare(
      `UPDATE scores
       SET trashed_at = NULL, trash_expires_at = NULL, updated_at = ?
       WHERE id = ? AND choir_id = ? AND trashed_at IS NOT NULL`,
    )
      .bind(Date.now(), scoreId, choirId)
      .run();
    if (restored.meta.changes !== 1) {
      return context.json({ error: "score_not_found" }, 404);
    }
    return context.body(null, 204);
  } catch (error) {
    if (isFilenameConflictError(error)) {
      return context.json({ error: "filename_conflict" }, 409);
    }
    throw error;
  }
});

scoreRoutes.on(["GET", "HEAD"], "/choirs/:choirId/scores/:scoreId/pdf", (context) =>
  serveScorePdf(context),
);

scoreRoutes.on(
  ["GET", "HEAD"],
  "/choirs/:choirId/scores/:scoreId/versions/:versionId/pdf",
  (context) => serveScorePdf(context, context.req.param("versionId")),
);

async function serveScorePdf(
  context: Context<AppEnvironment>,
  requestedVersionId?: string,
) {
  const choirId = context.req.param("choirId") ?? "";
  const scoreId = context.req.param("scoreId") ?? "";
  await resolveChoirAccess(context, choirId);
  const row = await measureServerTiming(context, "d1", () => context.env.DB.prepare(
    `SELECT scores.current_version_id, versions.id AS version_id,
            versions.object_key, versions.size_bytes, versions.etag,
            versions.sha256
     FROM scores
     INNER JOIN score_versions AS versions
       ON versions.score_id = scores.id AND versions.state = 'ready'
     WHERE scores.id = ? AND scores.choir_id = ? AND scores.trashed_at IS NULL
       AND versions.id = COALESCE(?, scores.current_version_id)
     LIMIT 1`,
  )
    .bind(scoreId, choirId, requestedVersionId ?? null)
    .first<PdfRow>());
  if (!row || !row.etag) {
    return context.json({ error: "score_not_found" }, 404);
  }

  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-cache",
    "Content-Type": "application/pdf",
    ETag: row.etag,
    "X-Content-SHA256": row.sha256,
    "X-Content-Type-Options": "nosniff",
    "X-Score-Version": row.version_id,
  });
  const rangeHeader = context.req.header("Range");
  const ifRange = context.req.header("If-Range");
  const useRange = rangeHeader && (!ifRange || ifRange === row.etag);
  const range = useRange ? parseRange(rangeHeader, row.size_bytes) : null;
  if (useRange && !range) {
    headers.set("Content-Range", `bytes */${row.size_bytes}`);
    return new Response(null, { status: 416, headers });
  }

  const noneMatch = context.req.header("If-None-Match")?.split(/\s*,\s*/);
  if (!range && (noneMatch?.includes(row.etag) || noneMatch?.includes("*"))) {
    return new Response(null, { status: 304, headers });
  }

  if (range) {
    headers.set("Content-Length", String(range.length));
    headers.set(
      "Content-Range",
      `bytes ${range.offset}-${range.offset + range.length - 1}/${row.size_bytes}`,
    );
  } else {
    headers.set("Content-Length", String(row.size_bytes));
  }
  const status = range ? 206 : 200;
  if (context.req.method === "HEAD") {
    return new Response(null, { status, headers });
  }

  const object = await measureServerTiming(context, "r2", () =>
    context.env.SCORES_BUCKET.get(row.object_key, {
      ...(range ? { range } : {}),
    }));
  if (!object || !("body" in object)) {
    return context.json({ error: "score_file_unavailable" }, 503);
  }
  return new Response(object.body, { status, headers });
}

async function resolveChoirAccess(
  context: Context<AppEnvironment>,
  choirId: string,
) {
  const { access } = await resolveContextChoirReadAccess(context, choirId);
  return {
    kind: access.kind,
    canManage: access.kind === "membership" && access.membership.role === "admin",
  };
}

async function requireAdmin(context: Context<AppEnvironment>, choirId: string) {
  const principal = await resolveContextPrincipal(context);
  const membership = await requireChoirAdmin(
    createDatabase(context.env.DB),
    principal,
    choirId,
  );
  return { membership };
}

async function loadStorage(context: Context<AppEnvironment>, choirId: string) {
  const choir = await context.env.DB.prepare(
    "SELECT storage_used_bytes, storage_limit_bytes FROM choirs WHERE id = ?",
  )
    .bind(choirId)
    .first<{ storage_used_bytes: number; storage_limit_bytes: number }>();
  return {
    usedBytes: choir?.storage_used_bytes ?? 0,
    limitBytes: choir?.storage_limit_bytes ?? 1,
  };
}

async function parsePdfUpload(
  context: Context<AppEnvironment>,
): Promise<Response | { data: ArrayBuffer; fileName: string }> {
  const contentLength = Number(context.req.header("Content-Length") ?? 0);
  if (contentLength > MAX_PDF_BYTES + 1024 * 1024) {
    return context.json({ error: "pdf_too_large" }, 413);
  }
  const form = await context.req.formData().catch(() => null);
  if (!form) return context.json({ error: "invalid_upload" }, 400);
  const file = form.get("file");
  if (!(file instanceof File)) {
    return context.json({ error: "pdf_required" }, 400);
  }
  if (file.size > MAX_PDF_BYTES) {
    return context.json({ error: "pdf_too_large" }, 413);
  }
  if (file.type && file.type !== "application/pdf") {
    return context.json({ error: "pdf_required" }, 415);
  }
  const fileName = scoreFileNameSchema.safeParse(file.name);
  if (!fileName.success) {
    return context.json({ error: "invalid_file_name" }, 400);
  }
  return { data: await file.arrayBuffer(), fileName: fileName.data };
}

function uploadError(context: Context<AppEnvironment>, error: unknown) {
  if (error instanceof PdfValidationError) {
    const status = error.code === "pdf_too_large" ? 413 : 422;
    return context.json({ error: error.code }, status);
  }
  if (error instanceof StorageQuotaError) {
    return context.json({ error: "storage_quota_exceeded" }, 409);
  }
  if (error instanceof FilenameConflictError) {
    return context.json({ error: "filename_conflict" }, 409);
  }
  if (error instanceof ConcurrentReplacementError) {
    return context.json({ error: "replacement_in_progress" }, 409);
  }
  throw error;
}

function parseRange(
  value: string,
  size: number,
): { offset: number; length: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    requestedEnd < start ||
    start >= size
  ) {
    return null;
  }
  const end = Math.min(requestedEnd, size - 1);
  return { offset: start, length: end - start + 1 };
}

function escapeLike(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

interface ScoreRow {
  id: string;
  choir_id: string;
  file_name: string;
  updated_at: number;
  version_id: string;
  version_number: number;
  size_bytes: number;
  sha256: string;
  etag: string;
  page_count: number;
  version_created_at: number;
}

interface TrashedScoreRow extends ScoreRow {
  trashed_at: number;
  trash_expires_at: number;
}

function serializeScoreRow(row: ScoreRow) {
  return {
    id: row.id,
    choirId: row.choir_id,
    fileName: row.file_name,
    updatedAt: row.updated_at,
    currentVersion: {
      id: row.version_id,
      versionNumber: row.version_number,
      sizeBytes: row.size_bytes,
      sha256: row.sha256,
      etag: row.etag,
      pageCount: row.page_count,
      createdAt: row.version_created_at,
    },
  };
}

function serializeTrashedScoreRow(row: TrashedScoreRow) {
  return {
    ...serializeScoreRow(row),
    trashedAt: row.trashed_at,
    trashExpiresAt: row.trash_expires_at,
  };
}

interface PdfRow {
  current_version_id: string;
  version_id: string;
  object_key: string;
  size_bytes: number;
  etag: string | null;
  sha256: string;
}

interface DriveBootstrapRow {
  drive_id: string;
  drive_name: string;
  guest_admission_mode: "invite" | "open";
  storage_used_bytes: number;
  storage_limit_bytes: number;
  score_id: string | null;
  choir_id: string | null;
  file_name: string | null;
  updated_at: number | null;
  version_id: string | null;
  version_number: number | null;
  size_bytes: number | null;
  sha256: string | null;
  etag: string | null;
  page_count: number | null;
  version_created_at: number | null;
}

interface DriveBootstrapScoreRow extends DriveBootstrapRow {
  score_id: string;
  choir_id: string;
  file_name: string;
  updated_at: number;
  version_id: string;
  version_number: number;
  size_bytes: number;
  sha256: string;
  etag: string;
  page_count: number;
  version_created_at: number;
}
