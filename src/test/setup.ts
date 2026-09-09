import { clearReadingIntents } from "../client/reader/reading-preference-intents";
import { clearReadResources } from "../client/settings/read-resource";
import "@testing-library/jest-dom/vitest";
import "fake-indexeddb/auto";

import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

import { localDatabase } from "../client/platform/local-database";

beforeEach(() => {
  // JSDOM has no media queries or viewport layout. Route tests keep artwork
  // outside the viewport; real animation behavior is covered separately.
  vi.stubGlobal("matchMedia", (media: string) => Object.assign(new EventTarget(), {
    matches: false,
    media,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
  }));
  vi.stubGlobal("IntersectionObserver", class {
    observe() {}
    disconnect() {}
  });
});

afterEach(async () => {
  cleanup();
  clearReadResources();
  clearReadingIntents();
  localDatabase.close();
  await localDatabase.delete();
});
