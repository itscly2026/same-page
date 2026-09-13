import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { localDatabase } from "../platform/local-database";
beforeEach(async () => { await localDatabase.open(); });
import { useReaderWorkspace } from "./use-reader-workspace";

it("opens a known local identity while cloud authentication is unreachable", async () => {
  const { result } = renderHook(() => useReaderWorkspace({
    choirId: "choir", scoreId: "score", experience: false,
    identity: { localUserId: "alice", restoring: false, onlineState: "unreachable" },
  }));
  await waitFor(() => expect(result.current.state.status).toBe("ready"));
  if (result.current.state.status === "ready") expect(result.current.state.workspace.ownerKey).toBe("user:alice");
});


afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("bounds identity waiting without renewing the deadline on rerender, then retries", async () => {
  vi.useFakeTimers();
  const options = { choirId: "choir", scoreId: "score", experience: false,
    identity: { localUserId: null, restoring: true, onlineState: "checking" as const } };
  const { result, rerender } = renderHook(() => useReaderWorkspace({ ...options }));
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  expect(result.current.state.status).toBe("opening");
  rerender();
  await act(() => vi.advanceTimersByTimeAsync(15_000));
  expect(result.current.state.status).toBe("failed");
  act(() => result.current.retry());
  expect(result.current.state.status).toBe("opening");
});

it("withdraws ready on epoch revocation and captures a fresh session only for the active owner", async () => {
  const { localDatabase, ACTIVE_LOCAL_OWNER_KEY } = await import("../platform/local-database");
  const { result } = renderHook(() => useReaderWorkspace({ choirId: "choir", scoreId: "score", experience: false,
    identity: { localUserId: "alice", restoring: false, onlineState: "authenticated" } }));
  await waitFor(() => expect(result.current.state.status).toBe("ready"));
  const old = result.current.state;
  await act(async () => { await localDatabase.system.put({ key: "local-workspace:epoch", value: "new-epoch" }); });
  await waitFor(() => {
    expect(result.current.state.status).toBe("ready");
    if (result.current.state.status === "ready") expect(result.current.state.workspace.sessionEpoch).toBe("new-epoch");
  });
  expect(result.current.state).not.toBe(old);
  await act(async () => { await localDatabase.system.put({ key: ACTIVE_LOCAL_OWNER_KEY, value: "user:bob" }); });
  await waitFor(() => expect(result.current.state.status).toBe("opening"));
  expect((await localDatabase.system.get(ACTIVE_LOCAL_OWNER_KEY))?.value).toBe("user:bob");
});

it("keeps the ready workspace object across online reconfirmation and switches local targets", async () => {
  const initial = { choirId: "choir", scoreId: "score", experience: false,
    identity: { localUserId: "alice", restoring: false, onlineState: "unreachable" as "unreachable" | "authenticated" | "checking" } };
  const { result, rerender } = renderHook(options => useReaderWorkspace(options), { initialProps: initial });
  await waitFor(() => expect(result.current.state.status).toBe("ready"));
  const ready = result.current.state;
  for (const onlineState of ["checking", "authenticated", "unreachable"] as const) {
    rerender({ ...initial, identity: { ...initial.identity, onlineState } });
    expect(result.current.state).toBe(ready);
  }
  for (const changes of [{ scoreId: "other-score" }, { choirId: "other-choir" }, { experience: true },
    { identity: { ...initial.identity, localUserId: "bob" } }]) {
    const options = { ...initial, ...changes };
    rerender(options);
    expect(result.current.state.status).toBe("opening");
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    if (result.current.state.status === "ready") {
      expect(result.current.state.workspace).toMatchObject({ choirId: options.choirId, scoreId: options.scoreId,
        ownerKey: `${options.experience ? "experience:" : ""}user:${options.identity.localUserId}` });
    }
  }
});

it("never republishes a revoked capture even when the same owner returns with the same epoch", async () => {
  const { ACTIVE_LOCAL_OWNER_KEY } = await import("../platform/local-database");
  const { result } = renderHook(() => useReaderWorkspace({ choirId: "choir", scoreId: "score", experience: false,
    identity: { localUserId: "alice", restoring: false, onlineState: "authenticated" } }));
  await waitFor(() => expect(result.current.state.status).toBe("ready"));
  const original = result.current.state.status === "ready" ? result.current.state.workspace : null;
  await act(async () => { await localDatabase.system.put({ key: ACTIVE_LOCAL_OWNER_KEY, value: "user:bob" }); });
  await waitFor(() => expect(result.current.state.status).toBe("opening"));
  await act(async () => { await localDatabase.system.put({ key: ACTIVE_LOCAL_OWNER_KEY, value: "user:alice" }); });
  await waitFor(() => expect(result.current.state.status).toBe("ready"));
  if (result.current.state.status === "ready") expect(result.current.state.workspace).not.toBe(original);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const alice = { choirId: "choir", scoreId: "score", experience: false,
  identity: { localUserId: "alice", restoring: false, onlineState: "unreachable" as const } };

it.each(["resolve", "capture", "cleanup"] as const)("ignores late %s after timeout and retry", async stage => {
  const platform = await import("../platform/local-workspace");
  const annotations = await import("../annotations/annotation-state");
  const gate = deferred<void>();
  const entered = deferred<void>();
  const method = stage === "resolve" ? "resolveLocalWorkspace" : "captureLocalWorkspaceSession";
  if (stage === "cleanup") {
    vi.spyOn(annotations, "cleanupUncreatedDeleteConflicts").mockImplementationOnce(async () => {
      entered.resolve(); await gate.promise; return 0;
    });
  } else if (method === "resolveLocalWorkspace") {
    const original = platform.resolveLocalWorkspace;
    vi.spyOn(platform, method).mockImplementationOnce(async options => {
      const workspace = await original(options);
      entered.resolve(); await gate.promise; return workspace;
    });
  } else {
    const original = platform.captureLocalWorkspaceSession;
    vi.spyOn(platform, method).mockImplementationOnce(async workspace => {
      const captured = await original(workspace);
      entered.resolve(); await gate.promise; return captured;
    });
  }
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { result } = renderHook(() => useReaderWorkspace(alice));
  await act(async () => { await entered.promise; });
  await act(() => vi.advanceTimersByTimeAsync(45_000));
  expect(result.current.state.status).toBe("failed");
  act(() => result.current.retry());
  vi.useRealTimers();
  await waitFor(() => expect(result.current.state.status).toBe("ready"));
  const ready = result.current.state;
  await act(async () => { gate.resolve(); await gate.promise; });
  expect(result.current.state).toBe(ready);
});

it("starts a fresh preparation deadline after identity waiting and keeps failure until explicit retry", async () => {
  const annotations = await import("../annotations/annotation-state");
  const gate = deferred<void>();
  const entered = deferred<void>();
  vi.spyOn(annotations, "cleanupUncreatedDeleteConflicts").mockImplementationOnce(async () => {
    entered.resolve(); await gate.promise; return 0;
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const initial = { ...alice, identity: { localUserId: null, restoring: true, onlineState: "checking" as "checking" | "signed-out" } };
  const { result, rerender } = renderHook(options => useReaderWorkspace(options), { initialProps: initial });
  await act(() => vi.advanceTimersByTimeAsync(40_000));
  expect(await localDatabase.system.count()).toBe(0);
  rerender({ ...initial, identity: { ...initial.identity, restoring: false, onlineState: "signed-out" } });
  await act(async () => { await entered.promise; });
  await act(() => vi.advanceTimersByTimeAsync(40_000));
  expect(result.current.state.status).toBe("opening");
  await act(() => vi.advanceTimersByTimeAsync(5_000));
  expect(result.current.state.status).toBe("failed");
  rerender(initial);
  rerender({ ...initial, identity: { ...initial.identity, restoring: false, onlineState: "signed-out" } });
  expect(result.current.state.status).toBe("failed");
  await act(async () => { gate.resolve(); });
  expect(result.current.state.status).toBe("failed");
  act(() => result.current.retry());
  vi.useRealTimers();
  await waitFor(() => expect(result.current.state.status).toBe("ready"));
});

it.each(["resolve", "capture"] as const)("does not start cleanup after unmount during %s", async stage => {
  const platform = await import("../platform/local-workspace");
  const annotations = await import("../annotations/annotation-state");
  const cleanup = vi.spyOn(annotations, "cleanupUncreatedDeleteConflicts");
  const gate = deferred<void>();
  const entered = deferred<void>();
  if (stage === "resolve") {
    const original = platform.resolveLocalWorkspace;
    vi.spyOn(platform, "resolveLocalWorkspace").mockImplementationOnce(async options => {
      const workspace = await original(options);
      entered.resolve(); await gate.promise; return workspace;
    });
  } else {
    const original = platform.captureLocalWorkspaceSession;
    vi.spyOn(platform, "captureLocalWorkspaceSession").mockImplementationOnce(async workspace => {
      const captured = await original(workspace);
      entered.resolve(); await gate.promise; return captured;
    });
  }
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { result, unmount } = renderHook(() => useReaderWorkspace(alice));
  await act(async () => { await entered.promise; });
  unmount();
  await act(async () => { gate.resolve(); await gate.promise; });
  expect(result.current.state.status).toBe("opening");
  expect(cleanup).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("tolerates cleanup rejection and preserves local content on retry", async () => {
  const annotations = await import("../annotations/annotation-state");
  vi.spyOn(annotations, "cleanupUncreatedDeleteConflicts").mockRejectedValueOnce(new Error("storage unavailable"));
  const { result } = renderHook(() => useReaderWorkspace(alice));
  await waitFor(() => expect(result.current.state.status).toBe("ready"));
  if (result.current.state.status !== "ready") throw new Error("expected workspace");
  const workspace = result.current.state.workspace;
  const payload = { kind: "text" as const, pageNumber: 1, x: .2, y: .3, fontScale: .024, text: "保留" };
  await annotations.saveAnnotationDraft(workspace, { id: "queued", layerId: "personal", payload });
  await annotations.queueScoreDrafts(workspace);
  await annotations.saveAnnotationDraft(workspace, { id: "draft", layerId: "personal", payload });
  await localDatabase.annotationConflicts.put({ ...workspace, opId: "conflict", annotationId: "queued",
    layerId: "personal", localPayload: payload, localDeleted: false, canonical: null, createdAt: 1 });
  const before = await annotations.readScoreAnnotationState(workspace);
  act(() => result.current.retry());
  await waitFor(() => expect(result.current.state.status).toBe("ready"));
  if (result.current.state.status !== "ready") throw new Error("expected workspace");
  expect(await annotations.readScoreAnnotationState(result.current.state.workspace)).toEqual(before);
});

it.each(["resolveLocalWorkspace", "captureLocalWorkspaceSession"] as const)("exposes %s failure and can retry", async method => {
  const platform = await import("../platform/local-workspace");
  vi.spyOn(platform, method).mockRejectedValueOnce(new Error("storage unavailable"));
  const { result, rerender } = renderHook(() => useReaderWorkspace({ ...alice }));
  await waitFor(() => expect(result.current.state.status).toBe("failed"));
  rerender();
  expect(result.current.state.status).toBe("failed");
  act(() => result.current.retry());
  await waitFor(() => expect(result.current.state.status).toBe("ready"));
});

it("ignores old rejection after a target change", async () => {
  const platform = await import("../platform/local-workspace");
  const gate = deferred<Awaited<ReturnType<typeof platform.resolveLocalWorkspace>>>();
  vi.spyOn(platform, "resolveLocalWorkspace").mockReturnValueOnce(gate.promise);
  const { result, rerender } = renderHook(options => useReaderWorkspace(options), { initialProps: alice });
  rerender({ ...alice, scoreId: "other-score" });
  await waitFor(() => expect(result.current.state.status).toBe("ready"));
  const ready = result.current.state;
  await act(async () => { gate.reject(new Error("late failure")); });
  expect(result.current.state).toBe(ready);
});
