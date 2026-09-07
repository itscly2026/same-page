import { RECOVERY_PERIOD_MS } from "../lifecycle/cleanup";

export async function cleanupSharedLayers(db: D1Database, now = Date.now()) {
  // Expiry is checked by the same DELETE that triggers all dependent cleanup.
  await db.prepare(`DELETE FROM choir_shared_layer_settings WHERE (choir_id, slot) IN (
    SELECT choir_id, slot FROM choir_shared_layer_settings
    WHERE deleted_at IS NOT NULL AND deleted_at <= ? ORDER BY deleted_at LIMIT 100
  ) AND deleted_at IS NOT NULL AND deleted_at <= ?`)
    .bind(now - RECOVERY_PERIOD_MS, now - RECOVERY_PERIOD_MS).run();
}
