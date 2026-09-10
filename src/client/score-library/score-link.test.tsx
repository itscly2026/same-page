import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { useOfflineScore } from "../offline/use-offline-score";
import { authenticatedLocalOwnerKey, createLocalWorkspace } from "../platform/local-workspace";
import { ScoreLink } from "./score-link";

vi.mock("../offline/use-offline-score", () => ({ useOfflineScore: vi.fn() }));
const workspace = createLocalWorkspace(authenticatedLocalOwnerKey("reader"), "drive", "score");
const row = (local: boolean) => <MemoryRouter><ScoreLink userId="reader" choirId="drive" scoreId="score" local={local} label="排练谱" description="文件大小 12 MB" onOpen={() => {}}><span>排练谱</span><span>12 MB</span></ScoreLink></MemoryRouter>;
it("keeps row text unchanged while local inspection and cloud authority resolve", () => {
  vi.mocked(useOfflineScore).mockReturnValue(undefined);
  const view = render(row(true));
  expect(view.container.textContent).toBe("排练谱12 MB");
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
  vi.mocked(useOfflineScore).mockReturnValue({ scopeKey: workspace.scopeKey, record: null, invalid: false });
  view.rerender(row(true));
  expect(view.container.textContent).toBe("排练谱12 MB");
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
  view.rerender(row(false));
  expect(view.container.textContent).toBe("排练谱12 MB");
  expect(screen.getByRole("link", { name: "排练谱" })).toHaveAttribute("href", "/choirs/drive/scores/score");
});
