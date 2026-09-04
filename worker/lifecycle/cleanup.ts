import type { Env } from "../env";
export const RECOVERY_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

export async function cleanupLifecycles(env: Env, now = Date.now()) {
  // Each conditional DELETE and its cascades are atomic, so restoration wins or
  // deletion wins; an earlier selection cannot authorize a later stale deletion.
  await env.DB.prepare(`DELETE FROM user WHERE id IN (
    SELECT user_id FROM user_lifecycle WHERE expires_at <= ? ORDER BY expires_at LIMIT 100
  )`).bind(now).run();
  const removed = await env.DB.prepare(`SELECT id FROM memberships
    WHERE status = 'removed' AND removed_at <= ? AND removed_for_deletion_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM user_lifecycle WHERE user_id = memberships.user_id)
      AND NOT EXISTS (SELECT 1 FROM choirs WHERE id = memberships.choir_id AND is_preview_entry = 1)
    ORDER BY removed_at LIMIT 100`).bind(now - RECOVERY_PERIOD_MS).all<{ id: string }>();
  for (const member of removed.results) {
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM annotation_layers WHERE kind = 'personal'
        AND EXISTS (SELECT 1 FROM memberships WHERE id = ? AND status = 'removed'
          AND removed_at <= ? AND removed_for_deletion_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM user_lifecycle WHERE user_id = memberships.user_id)
          AND user_id = annotation_layers.owner_user_id AND choir_id = annotation_layers.choir_id
          AND NOT EXISTS (SELECT 1 FROM choirs WHERE id = memberships.choir_id AND is_preview_entry = 1))`)
        .bind(member.id, now - RECOVERY_PERIOD_MS),
      env.DB.prepare(`DELETE FROM user_drive_layer_preferences WHERE EXISTS (
        SELECT 1 FROM memberships WHERE id = ? AND status = 'removed' AND removed_at <= ?
          AND removed_for_deletion_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM user_lifecycle WHERE user_id = memberships.user_id) AND user_id = user_drive_layer_preferences.user_id
          AND choir_id = user_drive_layer_preferences.choir_id
          AND NOT EXISTS (SELECT 1 FROM choirs WHERE id = memberships.choir_id AND is_preview_entry = 1))`)
        .bind(member.id, now - RECOVERY_PERIOD_MS),
      env.DB.prepare(`DELETE FROM user_score_layer_preferences WHERE EXISTS (
        SELECT 1 FROM memberships WHERE id = ? AND status = 'removed' AND removed_at <= ?
          AND removed_for_deletion_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM user_lifecycle WHERE user_id = memberships.user_id) AND user_id = user_score_layer_preferences.user_id
          AND choir_id = user_score_layer_preferences.choir_id
          AND NOT EXISTS (SELECT 1 FROM choirs WHERE id = memberships.choir_id AND is_preview_entry = 1))`)
        .bind(member.id, now - RECOVERY_PERIOD_MS),
      env.DB.prepare(`DELETE FROM memberships WHERE id = ? AND status = 'removed'
        AND removed_at <= ? AND removed_for_deletion_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM user_lifecycle WHERE user_id = memberships.user_id)
        AND NOT EXISTS (SELECT 1 FROM choirs WHERE id = memberships.choir_id AND is_preview_entry = 1)`)
        .bind(member.id, now - RECOVERY_PERIOD_MS),
    ]);
  }
  await env.DB.prepare("DELETE FROM verification WHERE expires_at <= ?").bind(now).run();
  await env.DB.prepare("DELETE FROM lifecycle_reauthentication WHERE expires_at <= ?").bind(now).run();
}
