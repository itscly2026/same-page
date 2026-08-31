import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_TEXT_FONT_SCALE } from "../../shared/annotations";
import { localDatabase } from "../platform/local-database";
import {
  activateAuthenticatedLocalOwner,
  authenticatedLocalOwnerKey,
  createLocalWorkspace,
} from "../platform/local-workspace";
import { pushPendingAnnotations } from "./sync";

const workspace = createLocalWorkspace(
  authenticatedLocalOwnerKey("user-1"),
  "choir-1",
  "score-1",
);
const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");

describe("bounded annotation push", () => {
  beforeEach(async () => {
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        request: (_name: string, action: () => Promise<unknown>) => action(),
      },
    });
    await localDatabase.open();
    await activateAuthenticatedLocalOwner("user-1");
  });

  afterEach(() => {
    if (originalLocks) {
      Object.defineProperty(navigator, "locks", originalLocks);
    } else {
      Object.defineProperty(navigator, "locks", {
        configurable: true,
        value: undefined,
      });
    }
  });

  it("leaves work beyond the application recovery limit for a later trigger", async () => {
    await localDatabase.annotationOutbox.bulkPut(
      Array.from({ length: 101 }, (_, index) => ({
        opId: `op-${index}`,
        ...workspace,
        annotationId: `annotation-${index}`,
        layerId: "layer-1",
        baseVersion: 0,
        type: "upsert" as const,
        payload: {
          kind: "text" as const,
          pageNumber: 1,
          x: 0.1,
          y: 0.2,
          fontScale: DEFAULT_TEXT_FONT_SCALE,
          text: String(index),
        },
        attemptedAt: null,
        createdAt: index,
      })),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_input, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          operations: Array<{ opId: string }>;
        };
        return Response.json({
          results: body.operations.map(({ opId }) => ({
            opId,
            status: "op_id_reused",
          })),
        });
      }),
    );

    await expect(
      pushPendingAnnotations(workspace, { maxOperations: 100 }),
    ).resolves.toBe(100);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await localDatabase.annotationOutbox.count()).toBe(1);
  });
});
