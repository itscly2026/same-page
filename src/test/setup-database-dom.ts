import "@testing-library/jest-dom/vitest";
import "fake-indexeddb/auto";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { localDatabase } from "../client/platform/local-database";

// One hook owns ordering: mounted sessions must stop before storage disappears.
afterEach(async () => {
  cleanup();
  localDatabase.close();
  await localDatabase.delete();
});
