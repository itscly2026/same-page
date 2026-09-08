import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { beforeEach, expect, it } from "vitest";
import { activateVerifiedOfflineScore, localDatabase } from "../platform/local-database";
import { resolveLocalWorkspace } from "../platform/local-workspace";
import { listLocalFiles } from "../offline/local-files";
import LocalStoragePage from "./local-storage-page";
import { NavigationProvider } from "../navigation/navigation";

beforeEach(async () => { await localDatabase.open(); });
it("offers cancellation then clears this device's file and updates its space", async () => {
  const workspace = await resolveLocalWorkspace({ authenticatedUserId: "storage-user", choirId: "drive", scoreId: "score" });
  await activateVerifiedOfflineScore({ ...workspace, key: "stored-file", versionId: "v1", fileName: "排练.pdf", sha256: "a".repeat(64), pageCount: 1, blob: new Blob([new Uint8Array(1024)]), annotationSnapshot: { layers: [], annotations: [], cursor: 0, verifiedAt: 1 } });
  render(<MemoryRouter initialEntries={["/choirs/drive/storage"]}><NavigationProvider><Routes><Route path="/choirs/:choirId/storage" element={<LocalStoragePage />} /></Routes></NavigationProvider></MemoryRouter>);
  fireEvent.click(await screen.findByRole("button", { name: "移除 排练 的离线副本" }));
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(await listLocalFiles()).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "移除 排练 的离线副本" }));
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "确认清理" })); });
  expect(await screen.findByText(/已清理 .* 本机谱面文件/)).toBeInTheDocument();
  expect(await listLocalFiles()).toEqual([]);
  await waitFor(() => expect(screen.queryByRole("button", { name: "移除 排练 的离线副本" })).not.toBeInTheDocument());
});
