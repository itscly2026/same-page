import Dexie, { type EntityTable } from "dexie";

export interface SystemRecord {
  key: string;
  value: string;
}

export interface OfflineScoreRecord {
  key: string;
  choirId: string;
  scoreId: string;
  versionId: string;
  title: string;
  sha256: string;
  pageCount: number;
  blob: Blob;
  active: 0 | 1;
  verifiedAt: number;
}

class SamePageDatabase extends Dexie {
  system!: EntityTable<SystemRecord, "key">;
  offlineScores!: EntityTable<OfflineScoreRecord, "key">;

  constructor() {
    super("same-page");
    this.version(1).stores({
      system: "&key",
    });
    this.version(2).stores({
      system: "&key",
      offlineScores: "&key,[choirId+scoreId],versionId,active,verifiedAt",
    });
  }
}

export const localDatabase = new SamePageDatabase();

export async function verifyLocalDatabase(): Promise<void> {
  await localDatabase.open();
}

export async function activateVerifiedOfflineScore(
  record: Omit<OfflineScoreRecord, "active" | "verifiedAt">,
) {
  await localDatabase.transaction("rw", localDatabase.offlineScores, async () => {
    const existing = await localDatabase.offlineScores
      .where("[choirId+scoreId]")
      .equals([record.choirId, record.scoreId])
      .toArray();
    await Promise.all(
      existing.map((entry) =>
        localDatabase.offlineScores.update(entry.key, { active: 0 }),
      ),
    );
    await localDatabase.offlineScores.put({
      ...record,
      active: 1,
      verifiedAt: Date.now(),
    });
  });
}

export function findActiveOfflineScore(choirId: string, scoreId: string) {
  return localDatabase.offlineScores
    .where("[choirId+scoreId]")
    .equals([choirId, scoreId])
    .filter((record) => record.active === 1)
    .first();
}
