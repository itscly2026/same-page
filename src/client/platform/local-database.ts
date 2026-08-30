import Dexie, { type EntityTable } from "dexie";

export interface SystemRecord {
  key: string;
  value: string;
}

class SamePageDatabase extends Dexie {
  system!: EntityTable<SystemRecord, "key">;

  constructor() {
    super("same-page");
    this.version(1).stores({
      system: "&key",
    });
  }
}

export const localDatabase = new SamePageDatabase();

export async function verifyLocalDatabase(): Promise<void> {
  await localDatabase.open();
}
