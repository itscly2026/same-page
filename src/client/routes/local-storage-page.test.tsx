import * as localFiles from "../offline/local-files";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { activateVerifiedOfflineScore, localDatabase } from "../platform/local-database";
import { resolveLocalWorkspace } from "../platform/local-workspace";
import { listLocalFiles } from "../offline/local-files";
import LocalStoragePage from "./local-storage-page";
import { NavigationProvider } from "../navigation/navigation";

beforeEach(async () => { await localDatabase.open(); });
afterEach(() => vi.restoreAllMocks());
it("offers cancellation then clears this device's file and updates its space", async () => {
  const workspace = await resolveLocalWorkspace({ authenticatedUserId: "storage-user", choirId: "drive", scoreId: "score" });
  await activateVerifiedOfflineScore({ ...workspace, key: "stored-file", versionId: "v1", fileName: "排练.pdf", sha256: "a".repeat(64), pageCount: 1, blob: new Blob([new Uint8Array(1024)]), annotationSnapshot: { layers: [], annotations: [], cursor: 0, verifiedAt: 1 } });
  render(<MemoryRouter initialEntries={["/choirs/drive/storage"]}><NavigationProvider><Routes><Route path="/choirs/:choirId/storage" element={<LocalStoragePage />} /></Routes></NavigationProvider></MemoryRouter>);
  expect(await screen.findByText(/副本不可用，需重新下载/)).toBeInTheDocument();
  fireEvent.click(await screen.findByRole("button", { name: "移除 排练 的离线副本" }));
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(await listLocalFiles()).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "移除 排练 的离线副本" }));
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "确认清理" })); });
  expect(await screen.findByText(/已清理 .* 本机谱面文件/)).toBeInTheDocument();
  expect(await listLocalFiles()).toEqual([]);
  await waitFor(() => expect(screen.queryByRole("button", { name: "移除 排练 的离线副本" })).not.toBeInTheDocument());
});

it("keeps failed files and retries only unfinished batch cleanup", async () => {
  for (const scoreId of ["first", "second"]) {
    const workspace = await resolveLocalWorkspace({ authenticatedUserId: "batch-user", choirId: "batch", scoreId });
    await activateVerifiedOfflineScore({ ...workspace, key: scoreId, versionId: "v1", fileName: `${scoreId}.pdf`, sha256: "a".repeat(64), pageCount: 1, blob: new Blob([new Uint8Array(1024)]), annotationSnapshot: { layers: [], annotations: [], cursor: 0, verifiedAt: 1 } });
  }
  const realClear = localFiles.clearLocalFiles;
  let fail = true;
  const clear = vi.spyOn(localFiles, "clearLocalFiles").mockImplementation(scope => {
    if (scope.scoreId === "second" && fail) { fail = false; return Promise.reject(new Error("storage unavailable")); }
    return realClear(scope);
  });
  render(<MemoryRouter initialEntries={["/choirs/batch/storage"]}><NavigationProvider><Routes><Route path="/choirs/:choirId/storage" element={<LocalStoragePage />} /></Routes></NavigationProvider></MemoryRouter>);
  fireEvent.click(await screen.findByRole("button", { name: /清理全部/ }));
  fireEvent.click(screen.getByRole("button", { name: "确认清理" }));
  await screen.findByText(/1 项未完成/);
  expect(await listLocalFiles()).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "重试未完成清理" }));
  fireEvent.click(screen.getByRole("button", { name: "确认清理" }));
  await screen.findByText(/已清理 .* 本机谱面文件/);
  expect(await listLocalFiles()).toEqual([]);
  expect(clear.mock.calls.map(([scope]) => scope.scoreId)).toEqual(["first", "second", "second"]);
});
