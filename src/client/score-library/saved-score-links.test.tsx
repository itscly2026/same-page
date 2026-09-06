import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { expect, it } from "vitest";
import { localDatabase } from "../platform/local-database";
import { activateAuthenticatedLocalOwner, authenticatedLocalOwnerKey, createLocalWorkspace } from "../platform/local-workspace";
import { SavedScoreLinks } from "./saved-score-links";

it("offers only the active user's saved files as recovery links, without claiming membership or verified availability", async () => {
  await activateAuthenticatedLocalOwner("a");
  for (const id of ["a", "b"]) {
    await localDatabase.offlineScores.put({ key: id, ...createLocalWorkspace(authenticatedLocalOwnerKey(id), "drive", "score"),
      versionId: "version", fileName: `${id}.pdf`, sha256: "unverified", pageCount: 1, blob: new Blob(["unverified"]), active: 1, verifiedAt: 1, annotationSnapshot: { layers: [], annotations: [], cursor: 0, verifiedAt: 1 } });
  }
  const view = render(<MemoryRouter><SavedScoreLinks userId="a" /></MemoryRouter>);
  expect(await screen.findByRole("link", { name: "a.pdf" })).toHaveAttribute("href", "/choirs/drive/scores/score");
  expect(screen.queryByText("b.pdf")).not.toBeInTheDocument();
  expect(screen.queryByText("可离线使用")).not.toBeInTheDocument();
  view.rerender(<MemoryRouter><SavedScoreLinks userId="b" /></MemoryRouter>);
  expect(screen.queryByText("a.pdf")).not.toBeInTheDocument();
  expect(screen.queryByText("b.pdf")).not.toBeInTheDocument();
  await activateAuthenticatedLocalOwner("b");
  await waitFor(() => expect(screen.getByRole("link", { name: "b.pdf" })).toBeInTheDocument());
  expect(screen.queryByText("a.pdf")).not.toBeInTheDocument();
});
