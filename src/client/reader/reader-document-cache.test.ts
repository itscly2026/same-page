import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authenticatedLocalOwnerKey } from "../platform/local-workspace";
import { loadPdfDocument } from "./pdf-document";
import {
  acquireReaderDocument,
  activateReaderDocumentOwner,
  clearReaderDocumentCache,
  confirmReaderDocumentVersion,
  invalidateReaderDocument,
} from "./reader-document-cache";

vi.mock("./pdf-document", () => ({ loadPdfDocument: vi.fn() }));

describe("reader document cache", () => {
  const ownerA = authenticatedLocalOwnerKey("a");
  const ownerB = authenticatedLocalOwnerKey("b");
  const destroy = vi.fn().mockResolvedValue(undefined);
  const document = { numPages: 1 };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(loadPdfDocument).mockImplementation((_source, versionId) => ({
      promise: Promise.resolve({ document, versionId: versionId ?? "version-1" }),
      destroy,
    } as never));
  });

  afterEach(() => {
    clearReaderDocumentCache();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("keeps a replaced document alive until its last reader releases it", async () => {
    const options = { ownerKey: ownerA, choirId: "choir", scoreId: "score", source: "/score.pdf", sourceKind: "cloud" as const };
    const old = acquireReaderDocument({ ...options, versionId: "v1" });
    await old.promise;
    const next = acquireReaderDocument({ ...options, versionId: "v2" });
    await next.promise;
    expect(destroy).not.toHaveBeenCalled();
    old.release();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(await next.promise).toBe(document);
    next.release();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(destroy).toHaveBeenCalledTimes(2);
  });

  it("reuses a short reopen of the same immutable score version", async () => {
    const options = {
      ownerKey: ownerA,
      choirId: "choir",
      scoreId: "score",
      source: "/score.pdf",
      sourceKind: "cloud" as const,
      versionId: "version-1",
    };
    const first = acquireReaderDocument(options);
    await first.promise;
    first.release();
    const second = acquireReaderDocument(options);
    await second.promise;

    expect(loadPdfDocument).toHaveBeenCalledTimes(1);
    second.release();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("bounds retained PDF documents under rapid score switching", async () => {
    const leases = [];
    for (const scoreId of ["one", "two", "three"]) {
      const lease = acquireReaderDocument({
        ownerKey: ownerA,
        choirId: "choir",
        scoreId,
        source: `/${scoreId}.pdf`,
        sourceKind: "cloud",
        versionId: "version-1",
      });
      await lease.promise;
      lease.release();
      leases.push(lease);
    }

    expect(loadPdfDocument).toHaveBeenCalledTimes(3);
    expect(destroy).toHaveBeenCalledTimes(1);

    const reopened = acquireReaderDocument({
      ownerKey: ownerA,
      choirId: "choir",
      scoreId: "one",
      source: "/one.pdf",
      sourceKind: "cloud",
      versionId: "version-1",
    });
    await reopened.promise;
    expect(loadPdfDocument).toHaveBeenCalledTimes(4);
    reopened.release();
    expect(leases).toHaveLength(3);
  });

  it("does not claim a version match before a PDF task exists", () => {
    expect(
      confirmReaderDocumentVersion({
        ownerKey: ownerA,
        choirId: "choir",
        scoreId: "not-opened",
        sourceKind: "cloud",
        versionId: "version-1",
      }),
    ).toBe("missing");
  });

  it("invalidates on a version or owner change", async () => {
    const first = acquireReaderDocument({
      ownerKey: ownerA,
      choirId: "choir",
      scoreId: "score",
      source: "/score.pdf",
      sourceKind: "cloud",
    });
    await first.promise;
    expect(
      confirmReaderDocumentVersion({
        ownerKey: ownerA,
        choirId: "choir",
        scoreId: "score",
        sourceKind: "cloud",
        versionId: "version-1",
      }),
    ).toBe("match");
    expect(
      confirmReaderDocumentVersion({
        ownerKey: ownerA,
        choirId: "choir",
        scoreId: "score",
        sourceKind: "cloud",
        versionId: "version-2",
      }),
    ).toBe("mismatch");
    first.release();
    await Promise.resolve();
    expect(destroy).toHaveBeenCalledTimes(1);

    const second = acquireReaderDocument({
      ownerKey: ownerA,
      choirId: "choir",
      scoreId: "score",
      source: "/score.pdf",
      sourceKind: "cloud",
      versionId: "version-2",
    });
    await second.promise;
    activateReaderDocumentOwner(ownerB);
    await Promise.resolve();
    expect(destroy).toHaveBeenCalledTimes(2);
  });

  it("destroys a cached cloud document when access changes", async () => {
    const lease = acquireReaderDocument({
      ownerKey: ownerA,
      choirId: "choir",
      scoreId: "score",
      source: "/score.pdf",
      sourceKind: "cloud",
      versionId: "version-1",
    });
    await lease.promise;

    invalidateReaderDocument({
      ownerKey: ownerA,
      choirId: "choir",
      scoreId: "score",
      sourceKind: "cloud",
    });
    await Promise.resolve();
    expect(destroy).not.toHaveBeenCalled();
    lease.release();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("rejects when the downloaded current PDF differs from the bootstrap version", async () => {
    let resolveTask!: (value: { document: object; versionId: string }) => void;
    vi.mocked(loadPdfDocument).mockReturnValueOnce({
      promise: new Promise((resolve) => {
        resolveTask = resolve;
      }),
      destroy,
    } as never);
    const lease = acquireReaderDocument({
      ownerKey: ownerA,
      choirId: "choir",
      scoreId: "racing-replacement",
      source: "/score.pdf",
      sourceKind: "cloud",
    });
    expect(
      confirmReaderDocumentVersion({
        ownerKey: ownerA,
        choirId: "choir",
        scoreId: "racing-replacement",
        sourceKind: "cloud",
        versionId: "version-2",
      }),
    ).toBe("match");

    resolveTask({ document, versionId: "version-1" });

    await expect(lease.promise).rejects.toMatchObject({
      expectedVersionId: "version-2",
    });
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("releases a pending task without leaving a worker alive", async () => {
    vi.mocked(loadPdfDocument).mockReturnValueOnce(
      { promise: new Promise(() => {}), destroy } as never,
    );
    const lease = acquireReaderDocument({
      ownerKey: ownerA,
      choirId: "choir",
      scoreId: "pending",
      source: "/pending.pdf",
      sourceKind: "cloud",
    });

    lease.release();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("replaces a pending task when the expected immutable version changes", async () => {
    const destroyPending = vi.fn().mockResolvedValue(undefined);
    vi.mocked(loadPdfDocument)
      .mockReturnValueOnce({
        promise: new Promise(() => {}),
        destroy: destroyPending,
      } as never)
      .mockReturnValueOnce({
        promise: Promise.resolve({ document, versionId: "version-2" }),
        destroy,
      } as never);
    const first = acquireReaderDocument({
      ownerKey: ownerA,
      choirId: "choir",
      scoreId: "changing",
      source: "/version-1.pdf",
      sourceKind: "cloud",
      versionId: "version-1",
    });
    const second = acquireReaderDocument({
      ownerKey: ownerA,
      choirId: "choir",
      scoreId: "changing",
      source: "/version-2.pdf",
      sourceKind: "cloud",
      versionId: "version-2",
    });

    await expect(second.promise).resolves.toBe(document);
    expect(loadPdfDocument).toHaveBeenCalledTimes(2);
    expect(destroyPending).not.toHaveBeenCalled();
    first.release();
    expect(destroyPending).toHaveBeenCalledTimes(1);
    second.release();
  });

  it("destroys a PDF task when loading rejects naturally", async () => {
    const failedDestroy = vi.fn().mockResolvedValue(undefined);
    const failedPromise = Promise.reject(new Error("parse failed"));
    void failedPromise.catch(() => undefined);
    vi.mocked(loadPdfDocument).mockReturnValueOnce({
      promise: failedPromise,
      destroy: failedDestroy,
    } as never);
    const lease = acquireReaderDocument({
      ownerKey: ownerA,
      choirId: "choir",
      scoreId: "broken",
      source: "/broken.pdf",
      sourceKind: "cloud",
      versionId: "version-1",
    });

    await expect(lease.promise).rejects.toThrow("parse failed");
    expect(failedDestroy).toHaveBeenCalledTimes(1);
    lease.release();
  });
});
