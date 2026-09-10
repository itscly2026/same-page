import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LocalPdfDownload } from "./local-pdf-download";
import { activateAuthenticatedLocalOwner, captureLocalWorkspaceSession, createLocalWorkspace, authenticatedLocalOwnerKey, type LocalWorkspace } from "../platform/local-workspace";
import * as localWorkspace from "../platform/local-workspace";
import { localDatabase, type OfflineScoreRecord } from "../platform/local-database";

let workspace: LocalWorkspace;
let record: OfflineScoreRecord;
const createUrl = vi.fn<(blob: Blob) => string>(() => "blob:local-pdf");
const revokeUrl = vi.fn();
let downloads: Array<{ blobUrl: string; filename: string }>;

beforeEach(async () => {
  await localDatabase.open();
  await activateAuthenticatedLocalOwner("a");
  workspace = await captureLocalWorkspaceSession(createLocalWorkspace(authenticatedLocalOwnerKey("a"), "drive", "score"));
  record = { ...workspace, key: "pdf", versionId: "v1", fileName: "Rehearsal.pdf", sha256: "verified", pageCount: 1,
    blob: new Blob(["%PDF-1.7 original bytes"], { type: "application/pdf" }), active: 1, verifiedAt: 1,
    annotationSnapshot: { layers: [], annotations: [], cursor: 0, verifiedAt: 1 } };
  createUrl.mockClear(); revokeUrl.mockClear(); downloads = [];
  vi.stubGlobal("URL", Object.assign(class extends URL {}, { createObjectURL: createUrl, revokeObjectURL: revokeUrl }));
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("unexpected network request"); }));
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push({ blobUrl: this.href, filename: this.download });
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("downloads the exact verified Blob only on click and releases its URL on unmount", async () => {
  const view = render(<LocalPdfDownload workspace={workspace} record={record} />);
  expect(createUrl).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "下载原 PDF" }));
  await waitFor(() => expect(downloads).toEqual([{ blobUrl: "blob:local-pdf", filename: "Rehearsal.pdf" }]));
  expect(createUrl.mock.calls[0][0]).toBe(record.blob);
  expect(fetch).not.toHaveBeenCalled();
  expect(await localDatabase.annotationOutbox.count()).toBe(0);
  view.unmount();
  expect(revokeUrl).toHaveBeenCalledWith("blob:local-pdf");
});

it.each(["owner", "session", "record"])("rejects an invalid %s without creating a URL", async kind => {
  if (kind === "owner") await activateAuthenticatedLocalOwner("b");
  if (kind === "session") await localDatabase.system.put({ key: "local-workspace:epoch", value: "new-session" });
  if (kind === "record") record = { ...record, ownerKey: authenticatedLocalOwnerKey("b") };
  render(<LocalPdfDownload workspace={workspace} record={record} />);
  fireEvent.click(screen.getByRole("button", { name: "下载原 PDF" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("返回文件库重新打开");
  expect(createUrl).not.toHaveBeenCalled();
  expect(downloads).toEqual([]);
});

it.each(["unmount", "replace"])("ignores a late workspace check after %s", async change => {
  let resolve!: () => void;
  vi.spyOn(localWorkspace, "assertLocalWorkspaceActive").mockImplementation(() => new Promise<void>(done => { resolve = done; }));
  const view = render(<LocalPdfDownload workspace={workspace} record={record} />);
  fireEvent.click(screen.getByRole("button", { name: "下载原 PDF" }));
  if (change === "unmount") view.unmount();
  else view.rerender(<LocalPdfDownload workspace={{ ...workspace, sessionEpoch: "new" }} record={record} />);
  await act(async () => resolve());
  expect(createUrl).not.toHaveBeenCalled();
  expect(downloads).toEqual([]);
});

it("offers retry after a download failure", async () => {
  createUrl.mockImplementationOnce(() => { throw new Error("URL unavailable"); });
  const view = render(<LocalPdfDownload workspace={workspace} record={record} />);
  fireEvent.click(screen.getByRole("button", { name: "下载原 PDF" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("重试");
  fireEvent.click(screen.getByRole("button", { name: "下载原 PDF" }));
  await waitFor(() => expect(downloads).toHaveLength(1));
  expect(screen.queryByRole("alert")).toBeNull();
  view.unmount();
});


it("releases a successful download URL after the browser has had time to consume it", async () => {
  vi.spyOn(localWorkspace, "assertLocalWorkspaceActive").mockResolvedValue();
  vi.useFakeTimers();
  render(<LocalPdfDownload workspace={workspace} record={record} />);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "下载原 PDF" })));
  expect(downloads).toHaveLength(1);
  expect(revokeUrl).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(60_000));
  expect(revokeUrl).toHaveBeenCalledExactlyOnceWith("blob:local-pdf");
});
