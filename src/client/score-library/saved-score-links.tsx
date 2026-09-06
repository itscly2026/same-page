import { useLiveQuery } from "dexie-react-hooks";
import { Link } from "react-router-dom";
import { ACTIVE_LOCAL_OWNER_KEY, localDatabase } from "../platform/local-database";
import { authenticatedLocalOwnerKey } from "../platform/local-workspace";

// Saved files are recovery links, never membership evidence. The reader still
// verifies their bytes, annotations and local owner before allowing offline use.
export function SavedScoreLinks({ userId }: { userId: string }) {
  const saved = useLiveQuery(async () => {
    const ownerKey = authenticatedLocalOwnerKey(userId);
    try {
      return await localDatabase.transaction("r", localDatabase.system, localDatabase.offlineScores, async () => {
        if ((await localDatabase.system.get(ACTIVE_LOCAL_OWNER_KEY))?.value !== ownerKey) return null;
        const records = await localDatabase.offlineScores.where("ownerKey").equals(ownerKey).filter(record => record.active === 1).toArray();
        return { userId, scores: records.map(({ key, choirId, scoreId, fileName }) => ({ key, choirId, scoreId, fileName })) };
      });
    } catch { return null; }
  }, [userId]);
  if (saved?.userId !== userId || !saved.scores.length) return null;
  return (
    <section aria-label="本机保存的乐谱" className="saved-score-links">
      <h2>本机保存的乐谱</h2>
      <p>也可打开本机保存的乐谱，进入时会校验离线副本。云盘成员关系需联网确认。</p>
      <div className="membership-list">
        {saved.scores.map(score => <Link className="membership-row" key={score.key} to={`/choirs/${score.choirId}/scores/${score.scoreId}`}>{score.fileName}</Link>)}
      </div>
    </section>
  );
}
