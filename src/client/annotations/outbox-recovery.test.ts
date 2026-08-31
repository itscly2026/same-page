import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_TEXT_FONT_SCALE } from "../../shared/annotations";
import { localDatabase } from "../platform/local-database";
import {
  activateAuthenticatedLocalOwner,
  authenticatedLocalOwnerKey,
  createLocalWorkspace,
} from "../platform/local-workspace";
import {
  OUTBOX_RECOVERY_LIMITS,
  recoverAnnotationOutbox,
} from "./outbox-recovery";
import { pushPendingAnnotations } from "./sync";

vi.mock("./sync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sync")>();
  return { ...actual, pushPendingAnnotations: vi.fn() };
});

describe("application outbox recovery", () => {
  beforeEach(async () => {
    await localDatabase.open();
    await activateAuthenticatedLocalOwner("user-a");
    vi.mocked(pushPendingAnnotations).mockReset();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        Promise.resolve(Response.json({ state: "active" })),
      ),
    );
  });

  it("recovers multiple scores independently and preserves a failed operation", async () => {
    const a = await seedOperation("user-a", "choir-1", "score-a", "op-a");
    const b = await seedOperation("user-a", "choir-1", "score-b", "op-b");
    vi.mocked(pushPendingAnnotations).mockImplementation(async (workspace) => {
      if (workspace.scoreId === "score-a") throw new Error("network failed");
      const count = await localDatabase.annotationOutbox
        .where("scopeKey")
        .equals(workspace.scopeKey)
        .count();
      await localDatabase.annotationOutbox
        .where("scopeKey")
        .equals(workspace.scopeKey)
        .delete();
      return count;
    });

    const summary = await recoverAnnotationOutbox(a.ownerKey, "online");

    expect(summary.results).toEqual([
      expect.objectContaining({ scoreId: "score-a", outcome: "failed" }),
      expect.objectContaining({ scoreId: "score-b", outcome: "pushed", pushed: 1 }),
    ]);
    expect(await localDatabase.annotationOutbox.get("op-a")).toMatchObject({
      opId: "op-a",
      scopeKey: a.scopeKey,
      payload: { text: "op-a" },
    });
    expect(await localDatabase.annotationOutbox.get("op-b")).toBeUndefined();
    expect(summary.remainingOperations).toBe(1);
    expect(fetch).toHaveBeenCalledWith(
      `/api/choirs/${b.choirId}/scores/${b.scoreId}/status`,
    );
  });

  it("keeps operations for trash, revoked access, and an invalid session", async () => {
    const ownerKey = authenticatedLocalOwnerKey("user-a");
    await Promise.all([
      seedOperation("user-a", "choir-1", "trashed", "op-trash"),
      seedOperation("user-a", "choir-1", "revoked", "op-revoked"),
      seedOperation("user-a", "choir-1", "expired", "op-expired"),
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/trashed/")) {
          return Promise.resolve(Response.json({ state: "trashed" }));
        }
        if (url.includes("/revoked/")) {
          return Promise.resolve(Response.json({}, { status: 403 }));
        }
        return Promise.resolve(Response.json({}, { status: 401 }));
      }),
    );

    const summary = await recoverAnnotationOutbox(ownerKey, "foreground");

    expect(
      summary.results.map(({ scoreId, outcome }) => [scoreId, outcome]),
    ).toEqual(
      expect.arrayContaining([
        ["trashed", "trashed"],
        ["revoked", "permission-revoked"],
        ["expired", "session-invalid"],
      ]),
    );
    expect(pushPendingAnnotations).not.toHaveBeenCalled();
    expect(await localDatabase.annotationOutbox.count()).toBe(3);
  });

  it("scans only the current owner and stops a late response after identity changes", async () => {
    const a = await seedOperation("user-a", "choir-1", "score-a", "op-a");
    await seedOperation("user-b", "choir-1", "score-b", "op-b");
    let releaseStatus!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            releaseStatus = resolve;
          }),
      ),
    );

    const recovery = recoverAnnotationOutbox(a.ownerKey, "startup");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await activateAuthenticatedLocalOwner("user-b");
    releaseStatus(Response.json({ state: "active" }));
    const summary = await recovery;

    expect(summary.results).toEqual([
      expect.objectContaining({ scoreId: "score-a", outcome: "owner-changed" }),
    ]);
    expect(pushPendingAnnotations).not.toHaveBeenCalled();
    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).not.toContain("score-b");
    expect(await localDatabase.annotationOutbox.count()).toBe(2);
  });

  it("bounds scope discovery and work per trigger", async () => {
    const ownerKey = authenticatedLocalOwnerKey("user-a");
    for (let index = 0; index < OUTBOX_RECOVERY_LIMITS.scopes + 1; index += 1) {
      await seedOperation(
        "user-a",
        "choir-1",
        `score-${index}`,
        `op-${index}`,
      );
    }
    vi.mocked(pushPendingAnnotations).mockResolvedValue(0);

    const summary = await recoverAnnotationOutbox(ownerKey, "manual");

    expect(summary.results).toHaveLength(OUTBOX_RECOVERY_LIMITS.scopes);
    expect(summary.discoveryLimitReached).toBe(true);
    expect(pushPendingAnnotations).toHaveBeenCalledTimes(
      OUTBOX_RECOVERY_LIMITS.scopes,
    );
    expect(vi.mocked(pushPendingAnnotations).mock.calls[0]?.[1]).toEqual({
      maxOperations: OUTBOX_RECOVERY_LIMITS.operationsPerScope,
    });
  });
});

async function seedOperation(
  userId: string,
  choirId: string,
  scoreId: string,
  opId: string,
) {
  const workspace = createLocalWorkspace(
    authenticatedLocalOwnerKey(userId),
    choirId,
    scoreId,
  );
  await localDatabase.annotationOutbox.put({
    opId,
    ...workspace,
    annotationId: `${opId}-annotation`,
    layerId: `${opId}-layer`,
    baseVersion: 0,
    type: "upsert",
    payload: {
      kind: "text",
      pageNumber: 1,
      x: 0.1,
      y: 0.2,
      fontScale: DEFAULT_TEXT_FONT_SCALE,
      text: opId,
    },
    attemptedAt: null,
    createdAt: Number(opId.replace(/\D/g, "")) || Date.now(),
  });
  return workspace;
}
