import type { Env } from "../env";

const ABANDONED_UPLOAD_MS = 60 * 60 * 1000;

interface CleanupCandidate {
  id: string;
  score_id: string;
  object_key: string;
  state: "pending" | "ready";
}

export async function cleanupScoreStorage(
  env: Env,
  now = Date.now(),
): Promise<number> {
  const expiredScores = await env.DB.prepare(
    `SELECT id FROM scores
     WHERE trashed_at IS NOT NULL AND trash_expires_at <= ?
     ORDER BY trash_expires_at
     LIMIT 100`,
  )
    .bind(now)
    .all<{ id: string }>();
  let removedScores = 0;
  for (const score of expiredScores.results) {
    const deletion = await env.DB.prepare(
      "DELETE FROM scores WHERE id = ? AND trashed_at IS NOT NULL AND trash_expires_at <= ?",
    )
      .bind(score.id, now)
      .run();
    removedScores += deletion.meta.changes;
  }

  const result = await env.DB.prepare(
    `SELECT versions.id, versions.score_id, versions.object_key, versions.state
     FROM score_versions AS versions
     INNER JOIN scores ON scores.id = versions.score_id
     WHERE versions.id <> COALESCE(scores.current_version_id, '')
       AND (
         (versions.state = 'ready' AND versions.retention_expires_at IS NOT NULL
          AND versions.retention_expires_at <= ?
          AND (scores.trashed_at IS NULL OR scores.trash_expires_at <= ?))
         OR
         (versions.state = 'pending' AND versions.created_at <= ?)
       )
     LIMIT 100`,
  )
    .bind(now, now, now - ABANDONED_UPLOAD_MS)
    .all<CleanupCandidate>();

  let removed = 0;
  for (const candidate of result.results) {
    const deletion = await env.DB.prepare(
      `DELETE FROM score_versions
       WHERE id = ?
         AND id <> COALESCE(
           (SELECT current_version_id FROM scores WHERE id = ?),
           ''
         )`,
    )
      .bind(candidate.id, candidate.score_id)
      .run();
    if (deletion.meta.changes > 0) {
      removed += 1;
    }
  }

  await env.DB.prepare(
    `UPDATE scores
     SET replacement_lock_id = NULL, replacement_lock_expires_at = NULL
     WHERE replacement_lock_expires_at IS NOT NULL
       AND replacement_lock_expires_at <= ?`,
  )
    .bind(now)
    .run();

  await env.DB.prepare(
    `DELETE FROM scores
     WHERE current_version_id IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM score_versions WHERE score_versions.score_id = scores.id
       )`,
  ).run();

  const queued = await env.DB.prepare(
    "SELECT id, object_key FROM score_object_deletions ORDER BY created_at LIMIT 100",
  ).all<{ id: string; object_key: string }>();
  for (const item of queued.results) {
    await env.SCORES_BUCKET.delete(item.object_key);
    await env.DB.prepare("DELETE FROM score_object_deletions WHERE id = ?")
      .bind(item.id)
      .run();
  }

  return removedScores + removed;
}
