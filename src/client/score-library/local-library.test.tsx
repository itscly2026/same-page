import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { expect, it } from "vitest";
import { localDatabase } from "../platform/local-database";
import { activateAuthenticatedLocalOwner, authenticatedLocalOwnerKey, createLocalWorkspace } from "../platform/local-workspace";
import { LocalLibrary } from "./local-library";

it("offers only the active user's saved files as recovery links, without claiming membership or verified availability", async () => {
  await activateAuthenticatedLocalOwner("a");
  for (const id of ["a", "b"]) {
    await localDatabase.offlineScores.put({ key: id, ...createLocalWorkspace(authenticatedLocalOwnerKey(id), "drive", "score"),
      versionId: "version", fileName: `${id}.pdf`, sha256: "unverified", pageCount: 1, blob: new Blob(["unverified"]), active: 1, verifiedAt: 1, annotationSnapshot: { layers: [], annotations: [], cursor: 0, verifiedAt: 1 } });
  }
  const view = render(<MemoryRouter><LocalLibrary userId="a" /></MemoryRouter>);
  expect(await screen.findByRole("link", { name: /a.pdf/ })).toHaveAttribute("href", "/choirs/drive/scores/score");
  expect(screen.queryByText("b.pdf")).not.toBeInTheDocument();
  expect(screen.queryByText("可离线使用")).not.toBeInTheDocument();
  view.rerender(<MemoryRouter><LocalLibrary userId="b" /></MemoryRouter>);
  expect(screen.queryByText("a.pdf")).not.toBeInTheDocument();
  expect(screen.queryByText("b.pdf")).not.toBeInTheDocument();
  await activateAuthenticatedLocalOwner("b");
  await waitFor(() => expect(screen.getByRole("link", { name: /b.pdf/ })).toBeInTheDocument());
  expect(screen.queryByText("a.pdf")).not.toBeInTheDocument();
});

it("rejects a directory response captured before an A to B to A identity change", async () => {
  const { captureLocalWorkspaceSession } = await import("../platform/local-workspace");
  const { rememberLocalDriveDirectory } = await import("./local-drive-directory");
  await localDatabase.open();
  await activateAuthenticatedLocalOwner("a");
  const captured = await captureLocalWorkspaceSession(createLocalWorkspace(authenticatedLocalOwnerKey("a"), "drive", ""));
  await activateAuthenticatedLocalOwner("b");
  await activateAuthenticatedLocalOwner("a");
  await expect(rememberLocalDriveDirectory(captured, { id: "drive", name: "旧响应中的云盘", guestAdmissionMode: "invite" }, [], new AbortController().signal)).rejects.toThrow("local_workspace_owner_changed");
  render(<MemoryRouter><LocalLibrary userId="a" /></MemoryRouter>);
  await screen.findByText(/本机尚未保存/);
  expect(screen.queryByText("旧响应中的云盘")).not.toBeInTheDocument();
});
