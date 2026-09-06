import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { OfflineScoreControl } from "./offline-score-control";
import { useOfflineScore } from "../offline/use-offline-score";
import { prepareOfflineScore } from "../offline/offline-score";
import { authenticatedLocalOwnerKey, createLocalWorkspace } from "../platform/local-workspace";
import type { OfflineScoreRecord } from "../platform/local-database";

vi.mock("dexie-react-hooks", () => ({ useLiveQuery: () => "user:user" }));
vi.mock("../offline/use-offline-score", async (original) => ({
  ...await original<typeof import("../offline/use-offline-score")>(), useOfflineScore: vi.fn(),
}));
vi.mock("../offline/offline-score", () => ({ prepareOfflineScore: vi.fn() }));
vi.mock("../platform/local-workspace", async (original) => {
  const actual = await original<typeof import("../platform/local-workspace")>();
  return { ...actual, resolveLocalWorkspace: async () => actual.createLocalWorkspace(actual.authenticatedLocalOwnerKey("user"), "drive", "score") };
});

const workspace = createLocalWorkspace(authenticatedLocalOwnerKey("user"), "drive", "score");
const score = { id: "score", choirId: "drive", fileName: "Long rehearsal score.pdf", updatedAt: 1,
  currentVersion: { id: "v2", versionNumber: 2, sizeBytes: 100, sha256: "hash", etag: "etag", pageCount: 1, createdAt: 1 } };
function verified(versionId = "v2"): OfflineScoreRecord {
  return { key: "record", ...workspace, versionId, fileName: score.fileName, sha256: "hash", pageCount: 1,
    blob: new Blob(), active: 1, verifiedAt: 1, annotationSnapshot: { layers: [], annotations: [], cursor: 0, verifiedAt: 1 } };
}
function state(record: OfflineScoreRecord | null, invalid = false) {
  vi.mocked(useOfflineScore).mockReturnValue({ scopeKey: workspace.scopeKey, record, invalid });
}
beforeEach(() => { vi.clearAllMocks(); state(null); vi.mocked(prepareOfflineScore).mockResolvedValue(verified()); });

it("downloads once and does not claim offline availability before verified data arrives", async () => {
  let finish!: () => void;
  vi.mocked(prepareOfflineScore).mockImplementation(() => new Promise<OfflineScoreRecord>((resolve) => { finish = () => resolve(verified()); }));
  const view = render(<OfflineScoreControl score={score} authenticatedUserId="user" />);
  fireEvent.click(screen.getByRole("button", { name: /下载离线副本：/ }));
  await waitFor(() => expect(prepareOfflineScore).toHaveBeenCalledTimes(1));
  expect(screen.getByRole("status")).toHaveTextContent("正在下载并校验");
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /离线副本：.*正在下载/ }));
  expect(prepareOfflineScore).toHaveBeenCalledTimes(1);
  await act(async () => finish());
  expect(screen.getByRole("status")).not.toHaveTextContent("可离线使用");
  state(verified());
  view.rerender(<OfflineScoreControl score={score} authenticatedUserId="user" />);
  expect(screen.getByRole("status")).toHaveTextContent("可离线使用");
});

it("opens ready details on tap without downloading again", async () => {
  state(verified());
  render(<OfflineScoreControl score={score} authenticatedUserId="user" />);
  fireEvent.click(screen.getByRole("button", { name: /离线副本：.*可离线使用/ }));
  const dialog = await screen.findByRole("dialog", { name: "离线副本" });
  expect(within(dialog).getByText("已保存在这台设备上，断网也能打开。")).toBeInTheDocument();
  expect(prepareOfflineScore).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
});

it.each(["stale", "invalid"])("makes a %s copy downloadable without a ready mark", async (kind) => {
  state(kind === "stale" ? verified("v1") : null, kind === "invalid");
  const { container } = render(<OfflineScoreControl score={score} authenticatedUserId="user" />);
  expect(container.querySelector('[data-state="ready"]')).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /下载.*离线副本：/ }));
  await waitFor(() => expect(prepareOfflineScore).toHaveBeenCalledTimes(1));
});

it("exposes download failure and allows retry inside the details", async () => {
  vi.mocked(prepareOfflineScore).mockRejectedValueOnce(new Error("network"));
  render(<OfflineScoreControl score={score} authenticatedUserId="user" />);
  fireEvent.click(screen.getByRole("button", { name: /下载离线副本：/ }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("下载未完成"));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "重试下载" }));
  await waitFor(() => expect(prepareOfflineScore).toHaveBeenCalledTimes(2));
});



it("explains that a failed update leaves only the older offline version available", async () => {
  state(verified("v1"));
  vi.mocked(prepareOfflineScore).mockRejectedValueOnce(new Error("network"));
  render(<OfflineScoreControl score={score} authenticatedUserId="user" />);
  fireEvent.click(screen.getByRole("button", { name: /下载新版离线副本：/ }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("旧版 PDF 仍可离线使用，当前版本尚未准备好"));
});

it("keeps availability unknown when download fails before inspection completes", async () => {
  vi.mocked(useOfflineScore).mockReturnValue(undefined);
  vi.mocked(prepareOfflineScore).mockRejectedValueOnce(new Error("network"));
  const view = render(<OfflineScoreControl score={score} authenticatedUserId="user" />);
  fireEvent.click(screen.getByRole("button", { name: /下载离线副本：/ }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("尚未确认本机副本"));
  expect(screen.getByRole("status")).not.toHaveTextContent("尚不可离线使用");
  state(verified("v1"));
  view.rerender(<OfflineScoreControl score={score} authenticatedUserId="user" />);
  expect(screen.getByRole("status")).toHaveTextContent("旧版 PDF 仍可离线使用");
});
