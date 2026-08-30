import { and, eq } from "drizzle-orm";
import { type Context, Hono } from "hono";

import {
  MAX_PDF_BYTES,
  scoreMetadataSchema,
  scoreUpdateSchema,
} from "../../src/shared/scores";
import {
  requireChoirAdmin,
  requireChoirRead,
} from "../auth/authorization";
import { resolveContextPrincipal } from "../auth/context-principal";
import { createDatabase } from "../db/database";
import { scores } from "../db/schema";
import type { AppEnvironment } from "../env";
import { cleanupExpiredScoreVersions } from "./cleanup";
import { PdfValidationError, inspectPdf } from "./pdf-validation";
import {
  ConcurrentReplacementError,
  createScoreVersion,
  replaceScoreVersion,
  StorageQuotaError,
} from "./storage";

export const scoreRoutes = new Hono<AppEnvironment>();

scoreRoutes.get("/choirs/:choirId/scores", async (context) => {
  const choirId = context.req.param("choirId");
  const access = await resolveChoirAccess(context, choirId);
  const search = context.req.query("q")?.trim().slice(0, 120) ?? "";
  const pattern = `%${escapeLike(search.toLocaleLowerCase())}%`;
  const result = await context.env.DB.prepare(
    `SELECT scores.id, scores.choir_id, scores.title, scores.composer,
            scores.arranger, scores.sort_order, scores.status, scores.updated_at,
            versions.id AS version_id, versions.version_number,
            versions.size_bytes, versions.sha256, versions.etag,
            versions.page_count, versions.created_at AS version_created_at
     FROM scores
     INNER JOIN score_versions AS versions
       ON versions.id = scores.current_version_id AND versions.state = 'ready'
     WHERE scores.choir_id = ?
       AND (? = 1 OR scores.status = 'published')
       AND (
         ? = '' OR lower(scores.title) LIKE ? ESCAPE '\\'
         OR lower(COALESCE(scores.composer, '')) LIKE ? ESCAPE '\\'
         OR lower(COALESCE(scores.arranger, '')) LIKE ? ESCAPE '\\'
       )
     ORDER BY scores.sort_order ASC, scores.title COLLATE NOCASE ASC`,
  )
    .bind(
      choirId,
      access.canManage ? 1 : 0,
      search,
      pattern,
      pattern,
      pattern,
    )
    .all<ScoreRow>();
  const choir = await context.env.DB.prepare(
    `SELECT storage_used_bytes, storage_limit_bytes FROM choirs WHERE id = ?`,
  )
    .bind(choirId)
    .first<{ storage_used_bytes: number; storage_limit_bytes: number }>();

  return context.json({
    scores: result.results.map(serializeScoreRow),
    storage: {
      usedBytes: choir?.storage_used_bytes ?? 0,
      limitBytes: choir?.storage_limit_bytes ?? 0,
    },
    permissions: { canManage: access.canManage },
  });
});

scoreRoutes.post("/choirs/:choirId/scores", async (context) => {
  const choirId = context.req.param("choirId");
  const { membership } = await requireAdmin(context, choirId);
  const parsed = await parsePdfUpload(context, true);
  if (parsed instanceof Response) {
    return parsed;
  }

  try {
    const inspected = await inspectPdf(parsed.data);
    const created = await createScoreVersion({
      env: context.env,
      choirId,
      membershipId: membership.id,
      metadata: parsed.metadata,
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
          ...parsed.metadata,
          status: "draft" as const,
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

scoreRoutes.post(
  "/choirs/:choirId/scores/:scoreId/versions",
  async (context) => {
    const choirId = context.req.param("choirId");
    const scoreId = context.req.param("scoreId");
    const { membership } = await requireAdmin(context, choirId);
    const parsed = await parsePdfUpload(context, false);
    if (parsed instanceof Response) {
      return parsed;
    }

    const database = createDatabase(context.env.DB);
    const score = await database.query.scores.findFirst({
      where: and(eq(scores.id, scoreId), eq(scores.choirId, choirId)),
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
  },
);

scoreRoutes.patch(
  "/choirs/:choirId/scores/:scoreId",
  async (context) => {
    const choirId = context.req.param("choirId");
    const scoreId = context.req.param("scoreId");
    await requireAdmin(context, choirId);
    const parsed = scoreUpdateSchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success || Object.keys(parsed.data).length === 0) {
      return context.json({ error: "invalid_score_metadata" }, 400);
    }

    const database = createDatabase(context.env.DB);
    const existing = await database.query.scores.findFirst({
      where: and(eq(scores.id, scoreId), eq(scores.choirId, choirId)),
    });
    if (!existing?.currentVersionId) {
      return context.json({ error: "score_not_found" }, 404);
    }

    const now = new Date();
    const nextStatus = parsed.data.status;
    const [updated] = await database
      .update(scores)
      .set({
        ...withoutUndefined(parsed.data),
        updatedAt: now,
        ...(nextStatus === "published"
          ? { publishedAt: now, archivedAt: null }
          : nextStatus === "archived"
            ? { archivedAt: now }
            : nextStatus === "draft"
              ? { archivedAt: null }
              : {}),
      })
      .where(and(eq(scores.id, scoreId), eq(scores.choirId, choirId)))
      .returning();

    return context.json({
      score: {
        id: updated.id,
        choirId: updated.choirId,
        title: updated.title,
        composer: updated.composer,
        arranger: updated.arranger,
        sortOrder: updated.sortOrder,
        status: updated.status,
        currentVersionId: updated.currentVersionId,
        updatedAt: updated.updatedAt.getTime(),
      },
    });
  },
);

scoreRoutes.delete(
  "/choirs/:choirId/scores/:scoreId",
  async (context) => {
    const choirId = context.req.param("choirId");
    const scoreId = context.req.param("scoreId");
    await requireAdmin(context, choirId);
    const score = await context.env.DB.prepare(
      "SELECT status FROM scores WHERE id = ? AND choir_id = ?",
    )
      .bind(scoreId, choirId)
      .first<{ status: string }>();
    if (!score) return context.json({ error: "score_not_found" }, 404);
    if (score.status !== "draft") {
      return context.json({ error: "only_drafts_can_be_deleted" }, 409);
    }

    await context.env.DB.prepare(
      "DELETE FROM scores WHERE id = ? AND choir_id = ? AND status = 'draft'",
    )
      .bind(scoreId, choirId)
      .run();
    context.executionCtx.waitUntil(cleanupExpiredScoreVersions(context.env));
    return context.body(null, 204);
  },
);

scoreRoutes.on(
  ["GET", "HEAD"],
  "/choirs/:choirId/scores/:scoreId/pdf",
  (context) => serveScorePdf(context),
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
  const access = await resolveChoirAccess(context, choirId);
  const row = await context.env.DB.prepare(
    `SELECT scores.status, scores.current_version_id, versions.id AS version_id,
            versions.object_key, versions.size_bytes, versions.etag,
            versions.sha256
     FROM scores
     INNER JOIN score_versions AS versions
       ON versions.score_id = scores.id AND versions.state = 'ready'
     WHERE scores.id = ? AND scores.choir_id = ?
       AND versions.id = COALESCE(?, scores.current_version_id)
       AND (? = 1 OR scores.status = 'published')
     LIMIT 1`,
  )
    .bind(scoreId, choirId, requestedVersionId ?? null, access.canManage ? 1 : 0)
    .first<PdfRow>();
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

  const object = await context.env.SCORES_BUCKET.get(row.object_key, {
    ...(range ? { range } : {}),
  });
  if (!object || !("body" in object)) {
    return context.json({ error: "score_file_unavailable" }, 503);
  }
  return new Response(object.body, { status, headers });
}

async function resolveChoirAccess(
  context: Context<AppEnvironment>,
  choirId: string,
) {
  const principal = await resolveContextPrincipal(context);
  const database = createDatabase(context.env.DB);
  const access = await requireChoirRead(database, principal, choirId);
  return {
    access,
    canManage:
      access.kind === "membership" && access.membership.role === "admin",
  };
}

async function requireAdmin(
  context: Context<AppEnvironment>,
  choirId: string,
) {
  const principal = await resolveContextPrincipal(context);
  const database = createDatabase(context.env.DB);
  const membership = await requireChoirAdmin(database, principal, choirId);
  return { membership };
}

async function parsePdfUpload(
  context: Context<AppEnvironment>,
  includeMetadata: boolean,
): Promise<
  | Response
  | {
      data: ArrayBuffer;
      metadata: {
        title: string;
        composer: string | null;
        arranger: string | null;
        sortOrder: number;
      };
    }
> {
  const contentLength = Number(context.req.header("Content-Length") ?? 0);
  if (contentLength > MAX_PDF_BYTES + 1024 * 1024) {
    return context.json({ error: "pdf_too_large" }, 413);
  }
  const form = await context.req.formData().catch(() => null);
  if (!form) {
    return context.json({ error: "invalid_upload" }, 400);
  }
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

  const metadata = includeMetadata
    ? scoreMetadataSchema.safeParse({
        title: form.get("title"),
        composer: form.get("composer") ?? "",
        arranger: form.get("arranger") ?? "",
        sortOrder: form.get("sortOrder") ?? 0,
      })
    : scoreMetadataSchema.safeParse({
        title: "replacement",
        composer: "",
        arranger: "",
        sortOrder: 0,
      });
  if (!metadata.success) {
    return context.json({ error: "invalid_score_metadata" }, 400);
  }
  return { data: await file.arrayBuffer(), metadata: metadata.data };
}

function uploadError(context: Context<AppEnvironment>, error: unknown) {
  if (error instanceof PdfValidationError) {
    const status = error.code === "pdf_too_large" ? 413 : 422;
    return context.json({ error: error.code }, status);
  }
  if (error instanceof StorageQuotaError) {
    return context.json({ error: "storage_quota_exceeded" }, 409);
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
  if (!match || (!match[1] && !match[2])) {
    return null;
  }
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) {
      return null;
    }
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

function withoutUndefined<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}

interface ScoreRow {
  id: string;
  choir_id: string;
  title: string;
  composer: string | null;
  arranger: string | null;
  sort_order: number;
  status: "draft" | "published" | "archived";
  updated_at: number;
  version_id: string;
  version_number: number;
  size_bytes: number;
  sha256: string;
  etag: string;
  page_count: number;
  version_created_at: number;
}

function serializeScoreRow(row: ScoreRow) {
  return {
    id: row.id,
    choirId: row.choir_id,
    title: row.title,
    composer: row.composer,
    arranger: row.arranger,
    sortOrder: row.sort_order,
    status: row.status,
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

interface PdfRow {
  status: "draft" | "published" | "archived";
  current_version_id: string;
  version_id: string;
  object_key: string;
  size_bytes: number;
  etag: string | null;
  sha256: string;
}
