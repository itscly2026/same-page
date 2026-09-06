// The caller includes this statement in the transaction creating a score or a
// drive layer, so concurrent creation cannot leave either side without instances.
export function createSharedLayerInstances(db: D1Database, scope: {
  choirId: string; scoreId?: string; slot?: string; membershipId?: string;
}) {
  return db.prepare(`INSERT INTO annotation_layers
    (id, choir_id, score_id, kind, default_slot, name, sort_order, default_color, created_by_membership_id, created_at, updated_at)
    SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-8' || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))),
      scores.choir_id, scores.id, 'shared', settings.slot, settings.name, settings.sort_order, settings.default_color, ?, ?, ?
    FROM scores JOIN choir_shared_layer_settings settings ON settings.choir_id = scores.choir_id
    WHERE scores.choir_id = ? AND (? IS NULL OR scores.id = ?) AND (? IS NULL OR settings.slot = ?)`)
    .bind(scope.membershipId ?? null, Date.now(), Date.now(), scope.choirId,
      scope.scoreId ?? null, scope.scoreId ?? null, scope.slot ?? null, scope.slot ?? null);
}
