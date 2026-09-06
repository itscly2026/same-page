import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { ContinueReading } from "./continue-reading";
import { recordScoreOpened } from "./library-view-state";

const membership = { id: "membership", role: "member" as const, displayName: "团员", choir: { id: "drive", name: "周末排练", guestAdmissionMode: "invite" as const } };
const score = { id: "score", choirId: "drive", fileName: "当前文件名.pdf", updatedAt: 1, currentVersion: { id: "v2", versionNumber: 2, sizeBytes: 100, sha256: "a".repeat(64), etag: "etag", pageCount: 2, createdAt: 1 } };
beforeEach(() => {
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) });
});
afterEach(() => vi.unstubAllGlobals());
it("shows the current accessible score and clamps the saved page to the current version", async () => {
  recordScoreOpened("user:alice", "drive", "score");
  localStorage.setItem("reader-preferences:alice:drive:score", JSON.stringify({ page: 8, layout: "page" }));
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ state: "active", score, permissions: { canManage: false } })));
  render(<MemoryRouter><ContinueReading userId="alice" memberships={[membership]} /></MemoryRouter>);
  expect(await screen.findByRole("link", { name: /当前文件名.pdf/ })).toHaveAttribute("href", "/choirs/drive/scores/score");
  expect(screen.getByText(/周末排练 · 第 2 页/)).toBeInTheDocument();
});
it("does not carry the previous user's late response into another user's home", async () => {
  recordScoreOpened("user:alice", "drive", "score");
  let finish!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
  const view = render(<MemoryRouter><ContinueReading userId="alice" memberships={[membership]} /></MemoryRouter>);
  view.rerender(<MemoryRouter><ContinueReading userId="bob" memberships={[membership]} /></MemoryRouter>);
  await act(async () => finish(Response.json({ state: "active", score, permissions: { canManage: false } })));
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
});
it("does not surface records from drives outside current memberships", () => {
  recordScoreOpened("user:alice", "drive", "score");
  render(<MemoryRouter><ContinueReading userId="alice" memberships={[]} /></MemoryRouter>);
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
});
