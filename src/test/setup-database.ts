import "fake-indexeddb/auto";
import { afterEach } from "vitest";
import { localDatabase } from "../client/platform/local-database";

afterEach(async () => {
  localDatabase.close();
  await localDatabase.delete();
});
