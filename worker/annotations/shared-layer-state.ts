// D1 batch provides one snapshot for score-specific rows and drive lifecycle
// metadata. Reading a newer revision separately could mislabel stale rows.
export async function readSharedLayerSnapshot<Row>(db: D1Database, choirId: string, query: D1PreparedStatement) {
  const results = await db.batch<Record<string, unknown>>([query, sharedLayerStateQuery(db, choirId)]);
  return { rows: results[0].results as Row[], ...serializeState(results[1].results[0]) };
}

function sharedLayerStateQuery(db: D1Database, choirId: string) {
  return db.prepare(`SELECT shared_layer_revision AS revision,
    (SELECT json_group_array(slot) FROM choir_shared_layer_settings WHERE choir_id = choirs.id AND active = 1 AND deleted_at IS NULL) AS active_slots
    FROM choirs WHERE id = ?`).bind(choirId);
}

export async function readSharedLayerAvailability(db: D1Database, choirId: string) {
  return serializeState((await sharedLayerStateQuery(db, choirId).first())!);
}

function serializeState(state: Record<string, unknown>) {
  return {
    sharedLayerRevision: Number(state.revision),
    activeSharedSlots: JSON.parse(String(state.active_slots)) as string[],
  };
}
