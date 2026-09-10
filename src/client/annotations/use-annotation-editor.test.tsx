import { StrictMode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { localDatabase } from "../platform/local-database";
import { activateAuthenticatedLocalOwner, authenticatedLocalOwnerKey, captureLocalWorkspaceSession, createLocalWorkspace } from "../platform/local-workspace";
import { readScoreAnnotationState } from "./annotation-state";
import { useAnnotationEditor } from "./use-annotation-editor";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("preserves failed intent and the active edit session across an equivalent workspace refresh", async () => {
  await localDatabase.open();
  await localDatabase.delete();
  await localDatabase.open();
  await activateAuthenticatedLocalOwner("same-user");
  const workspace = await captureLocalWorkspaceSession(createLocalWorkspace(authenticatedLocalOwnerKey("same-user"), "drive", "score"));
  const view = renderHook(({ workspace }) => useAnnotationEditor(workspace), { initialProps: { workspace }, wrapper: StrictMode });
  act(() => { view.result.current.editor!.begin(); });
  vi.spyOn(localDatabase.annotations, "put").mockRejectedValueOnce(new Error("storage unavailable"));
  await act(async () => {
    expect(await view.result.current.editor!.persist({ id: "note", layerId: "personal", payload: {
      kind: "text", text: "keep this intent", pageNumber: 1, x: 0.1, y: 0.2, fontScale: 0.024,
    } })).toBe(false);
  });
  view.rerender({ workspace: { ...workspace } });
  expect(view.result.current.persistence).toBe("failed");
  await act(async () => { expect(await view.result.current.editor!.retry()).toBe(true); });
  expect((await readScoreAnnotationState(workspace)).annotations).toEqual([expect.objectContaining({ payload: expect.objectContaining({ text: "keep this intent" }) })]);
  await act(async () => { expect(await view.result.current.editor!.undo("personal")).toBe(true); });
  expect((await readScoreAnnotationState(workspace)).annotations).toEqual([]);
  await act(async () => { expect(await view.result.current.editor!.finish()).toBe("local-saved"); });
});
