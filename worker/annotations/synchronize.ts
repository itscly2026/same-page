import { annotationPayloadSchema, DEFAULT_TEXT_FONT_SCALE, type AnnotationPayload, type AnnotationObjectRecord } from "../../src/shared/annotations";

interface Operation {
  opId: string; annotationId: string; layerId: string; baseVersion: number;
  type: "upsert" | "delete"; payload: AnnotationPayload | null;
}
interface Scope { choirId: string; scoreId: string; userId: string }
export class AnnotationScopeAccessError extends Error {
  constructor(readonly status: 403 | 404) { super("annotation_scope_unavailable"); }
}

export interface PushResult {
  opId: string;
  status: "accepted" | "conflict" | "op_id_reused" | "permission_denied";
  object?: AnnotationObjectRecord | null;
}

// One row per distinct layer, evaluated inside the same D1 transaction as writes.
const inputCte = `WITH input AS (SELECT value AS op FROM json_each(?)),
  scope AS (SELECT ? AS choir, ? AS score, ? AS actor),
  permission AS MATERIALIZED (
    SELECT l.id, l.kind, l.owner_user_id,
      CASE WHEN l.kind = 'personal' THEN l.owner_user_id = scope.actor AND
        (m.id IS NOT NULL OR (c.is_preview_entry = 1 AND c.guest_admission_mode = 'open'))
      ELSE m.id IS NOT NULL AND (m.role = 'admin' OR g.id IS NOT NULL)
        AND EXISTS (SELECT 1 FROM choir_shared_layer_settings WHERE choir_id = l.choir_id AND slot = l.default_slot AND active = 1 AND deleted_at IS NULL) END AS editable
    FROM annotation_layers l JOIN scope
    JOIN choirs c ON c.id = scope.choir
    JOIN scores s ON s.id = scope.score AND s.choir_id = c.id AND s.trashed_at IS NULL
    LEFT JOIN memberships m ON m.user_id = scope.actor AND m.choir_id = c.id AND m.status = 'active'
    LEFT JOIN shared_layer_edit_grants g ON g.choir_id = c.id AND g.membership_id = m.id AND g.slot = l.default_slot
    WHERE l.choir_id = c.id AND l.score_id = s.id
      AND l.id IN (SELECT json_extract(op, '$.layerId') FROM input)
      AND NOT EXISTS (SELECT 1 FROM user_lifecycle WHERE user_id = scope.actor)
  )`;
const identity = `o.choir_id = scope.choir AND o.score_id = scope.score AND o.actor_user_id = scope.actor
 AND o.annotation_id = json_extract(i.op, '$.annotationId') AND o.layer_id = json_extract(i.op, '$.layerId')
 AND o.base_version = json_extract(i.op, '$.baseVersion') AND o.operation_type = json_extract(i.op, '$.type')
 AND o.payload_hash IN (json_extract(i.op, '$.hash'), json_extract(i.op, '$.legacyHash'))`;

export async function synchronizeOperations(db: D1Database, scope: Scope, operations: Operation[]): Promise<PushResult[]> {
  const prepared = await Promise.all(operations.map(async op => {
    const payloadJson = op.payload === null ? null : JSON.stringify(op.payload);
    const hash = await sha256(`${op.type}:${payloadJson ?? ""}`);
    const p = op.payload;
    const legacyHash = p?.kind === "text" && p.fontScale === DEFAULT_TEXT_FONT_SCALE
      ? await sha256(`${op.type}:${JSON.stringify({ pageNumber: p.pageNumber, kind: p.kind, x: p.x, y: p.y, text: p.text })}`)
      : hash;
    return { ...op, payloadJson, hash, legacyHash };
  }));
  // Independent objects share a set-based wave. Repeated object/op IDs retain request order.
  const waves: typeof prepared[] = [];
  let wave: typeof prepared = [];
  const ids = new Set<string>(); const opIds = new Set<string>();
  for (const op of prepared) {
    if (ids.has(op.annotationId) || opIds.has(op.opId)) { waves.push(wave); wave = []; ids.clear(); opIds.clear(); }
    wave.push(op); ids.add(op.annotationId); opIds.add(op.opId);
  }
  if (wave.length) waves.push(wave);
  const statements: D1PreparedStatement[] = [];
  for (const entries of waves) {
    const json = JSON.stringify(entries);
    const query = (sql: string) => db.prepare(`${inputCte} ${sql}`).bind(json, scope.choirId, scope.scoreId, scope.userId);
    statements.push(
      query(`INSERT OR IGNORE INTO annotation_sync_operations
        (op_id, choir_id, score_id, layer_id, annotation_id, actor_user_id, base_version, operation_type, payload_json, payload_hash, status, created_at)
        SELECT json_extract(i.op, '$.opId'), scope.choir, scope.score, p.id, json_extract(i.op, '$.annotationId'), scope.actor,
          json_extract(i.op, '$.baseVersion'), json_extract(i.op, '$.type'), json_extract(i.op, '$.payloadJson'), json_extract(i.op, '$.hash'), 'processing', ${Date.now()}
        FROM input i JOIN scope JOIN permission p ON p.id = json_extract(i.op, '$.layerId') WHERE p.editable = 1`),
      query(`UPDATE annotation_sync_operations AS o SET resulting_version = base_version + 1
        WHERE status = 'processing' AND EXISTS (SELECT 1 FROM input i JOIN scope WHERE o.op_id = json_extract(i.op, '$.opId') AND ${identity})
          AND ((base_version = 0 AND operation_type = 'upsert' AND NOT EXISTS (SELECT 1 FROM annotation_objects a WHERE a.id = o.annotation_id))
          OR (base_version > 0 AND EXISTS (SELECT 1 FROM annotation_objects a WHERE a.id = o.annotation_id AND a.choir_id = o.choir_id AND a.score_id = o.score_id AND a.layer_id = o.layer_id AND a.version = o.base_version)))`),
      query(`INSERT INTO annotation_objects
        (id, choir_id, score_id, layer_id, version, deleted, payload_json, created_by_user_id, created_by_display_name, updated_by_user_id, updated_by_display_name, created_at, updated_at)
        SELECT o.annotation_id, o.choir_id, o.score_id, o.layer_id, o.resulting_version, o.operation_type = 'delete', o.payload_json,
          scope.actor, COALESCE(m.display_name, ''), scope.actor, COALESCE(m.display_name, ''), o.created_at, o.created_at
        FROM annotation_sync_operations o JOIN input i ON o.op_id = json_extract(i.op, '$.opId') JOIN scope
        LEFT JOIN memberships m ON m.choir_id = scope.choir AND m.user_id = scope.actor AND m.status = 'active'
        WHERE o.status = 'processing' AND o.resulting_version IS NOT NULL AND ${identity}
        ON CONFLICT(id) DO UPDATE SET version = excluded.version, deleted = excluded.deleted, payload_json = excluded.payload_json,
          updated_by_user_id = excluded.updated_by_user_id, updated_by_display_name = excluded.updated_by_display_name, updated_at = excluded.updated_at`),
      query(`UPDATE annotation_sync_operations AS o SET status = CASE WHEN resulting_version IS NULL THEN 'conflict' ELSE 'accepted' END, payload_json = NULL
        WHERE status = 'processing' AND EXISTS (SELECT 1 FROM input i JOIN scope WHERE o.op_id = json_extract(i.op, '$.opId') AND ${identity})`),
      query(`SELECT json_extract(i.op, '$.opId') AS opId,
        CASE WHEN COALESCE(p.editable, 0) = 0 THEN 'permission_denied'
          WHEN o.op_id IS NULL OR NOT (${identity}) THEN 'op_id_reused' ELSE o.status END AS status,
        CASE WHEN p.editable = 1 AND ${identity} AND (l.kind = 'shared' OR l.owner_user_id = scope.actor)
          THEN json_object('id', a.id, 'layerId', a.layer_id, 'version', a.version, 'deleted', json(CASE WHEN a.deleted THEN 'true' ELSE 'false' END),
            'payload', json(a.payload_json), 'createdByDisplayName', a.created_by_display_name, 'updatedByDisplayName', a.updated_by_display_name, 'updatedAt', a.updated_at) END AS object_json
        FROM input i JOIN scope LEFT JOIN permission p ON p.id = json_extract(i.op, '$.layerId')
        LEFT JOIN annotation_sync_operations o ON o.op_id = json_extract(i.op, '$.opId')
        LEFT JOIN annotation_objects a ON a.id = json_extract(i.op, '$.annotationId') AND a.choir_id = scope.choir AND a.score_id = scope.score
        LEFT JOIN annotation_layers l ON l.id = a.layer_id`),
    );
  }
  statements.push(db.prepare(`SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM scores WHERE id = ? AND choir_id = ? AND trashed_at IS NULL) THEN 404
    WHEN EXISTS (SELECT 1 FROM user_lifecycle WHERE user_id = ?) THEN 403
    WHEN EXISTS (SELECT 1 FROM memberships WHERE choir_id = ? AND user_id = ? AND status = 'active')
      OR EXISTS (SELECT 1 FROM choirs WHERE id = ? AND is_preview_entry = 1 AND guest_admission_mode = 'open') THEN 200
    ELSE 403 END AS scope_status`).bind(scope.scoreId, scope.choirId, scope.userId, scope.choirId, scope.userId, scope.choirId));
  const batches = await db.batch<{ opId: string; status: PushResult["status"]; scope_status?: number; object_json: string | null }>(statements);
  const scopeStatus = batches.pop()?.results[0]?.scope_status;
  if (scopeStatus === 403 || scopeStatus === 404) throw new AnnotationScopeAccessError(scopeStatus);
  return batches.flatMap((batch, index) => index % 5 === 4 ? batch.results.map(row => {
    const object = row.object_json ? JSON.parse(row.object_json) as AnnotationObjectRecord : null;
    if (object?.payload) object.payload = annotationPayloadSchema.parse(object.payload);
    return row.status === "op_id_reused" || row.status === "permission_denied"
      ? { opId: row.opId, status: row.status }
      : { opId: row.opId, status: row.status, object };
  }) : []);
}

async function sha256(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, "0")).join("");
}
