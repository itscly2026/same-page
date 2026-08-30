import "@testing-library/jest-dom/vitest";
import "fake-indexeddb/auto";

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

import { localDatabase } from "../client/platform/local-database";

afterEach(async () => {
  cleanup();
  localDatabase.close();
  await localDatabase.delete();
});
