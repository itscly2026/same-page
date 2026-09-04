import { StrictMode, useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UploadDialog } from "./upload-dialog";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

function pdf(name: string) { return new File(["%PDF-1.7 test"], name, { type: "application/pdf" }); }
function success(name: string, choirId = "drive") {
  return Response.json({ score: { id: name, choirId, fileName: name, updatedAt: 1,
    currentVersion: { id: name, versionNumber: 1, sizeBytes: 10, sha256: "hash", etag: "etag", pageCount: 1, createdAt: 1 } } }, { status: 201 });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function select(...files: File[]) {
  fireEvent.change(screen.getByLabelText("选择 PDF 文件"), { target: { files } });
}
function row(name: string) {
  const result = screen.getByText(name).closest("li");
  if (!result) throw new Error("Upload row missing");
  return result;
}
function Harness({ owner = "user", choirId = "drive", onComplete = () => {}, onQuotaChange = () => {}, onInspect = () => {} }: {
  owner?: string; choirId?: string; onComplete?: () => void | Promise<void>;
  onQuotaChange?: (blocked: boolean) => void; onInspect?: (name: string) => void;
}) {
  const [open, setOpen] = useState(true);
  return <><button onClick={() => setOpen(true)}>重新打开</button>
    <UploadDialog key={`${owner}:${choirId}`} choirId={choirId} isOpen={open} onOpenChange={setOpen}
      onComplete={onComplete} onQuotaChange={onQuotaChange} onInspect={onInspect} /></>;
}

describe("serial PDF uploads", () => {
  it("uses one FIFO pump across repeated selection and drop, including StrictMode", async () => {
    const responses = [deferred<Response>(), deferred<Response>(), deferred<Response>()];
    let active = 0; let peak = 0;
    const names: string[] = [];
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => {
      names.push((init.body as FormData).get("file") instanceof File ? ((init.body as FormData).get("file") as File).name : "missing");
      peak = Math.max(peak, ++active);
      return responses[names.length - 1].promise.finally(() => active--);
    }));
    render(<StrictMode><Harness /></StrictMode>);
    select(pdf("a.pdf"), pdf("b.pdf"));
    fireEvent.drop(screen.getByLabelText("选择 PDF 文件").closest(".upload-dropzone")!, { dataTransfer: { files: [pdf("c.pdf")] } });
    expect(names).toEqual(["a.pdf"]);
    expect(row("b.pdf")).toHaveAttribute("data-status", "queued");
    await act(async () => responses[0].resolve(success("a.pdf")));
    expect(names).toEqual(["a.pdf", "b.pdf"]);
    await act(async () => responses[1].resolve(success("b.pdf")));
    expect(names).toEqual(["a.pdf", "b.pdf", "c.pdf"]);
    await act(async () => responses[2].resolve(success("c.pdf")));
    expect(peak).toBe(1);
    expect(within(screen.getByRole("list", { name: "上传状态" })).getAllByText("上传完成")).toHaveLength(3);
  });

  it("isolates invalid files and retries only the selected failed item", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ error: "invalid_pdf" }, { status: 422 }))
      .mockResolvedValueOnce(success("good.pdf")).mockResolvedValueOnce(success("bad.pdf"));
    vi.stubGlobal("fetch", fetchMock);
    render(<Harness />);
    select(new File(["not PDF"], "text.txt"), pdf("bad.pdf"), pdf("good.pdf"));
    await waitFor(() => expect(row("good.pdf")).toHaveAttribute("data-status", "success"));
    expect(row("text.txt")).toHaveTextContent("只接受 PDF");
    expect(screen.queryByRole("button", { name: "重试 good.pdf" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试 bad.pdf" }));
    await waitFor(() => expect(row("bad.pdf")).toHaveAttribute("data-status", "success"));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([401, 403, 429])("pauses all batches on %s and resumes only waiting files explicitly", async (status) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ error: "forbidden" }, { status }))
      .mockResolvedValueOnce(success("b.pdf"));
    vi.stubGlobal("fetch", fetchMock);
    render(<Harness />);
    select(pdf("a.pdf"), pdf("b.pdf"));
    await screen.findByRole("alert");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(row("b.pdf")).toHaveAttribute("data-status", "queued");
    fireEvent.click(screen.getByRole("button", { name: "继续等待项" }));
    await waitFor(() => expect(row("b.pdf")).toHaveAttribute("data-status", "success"));
    expect(row("a.pdf")).toHaveAttribute("data-status", "error");
  });

  it("stops on quota exhaustion and signals a storage refresh", async () => {
    const quota = vi.fn(); const refresh = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ error: "storage_quota_exceeded" }, { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<Harness onQuotaChange={quota} onComplete={refresh} />);
    select(pdf("a.pdf"), pdf("b.pdf"), pdf("c.pdf"));
    await screen.findByRole("alert");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(quota).toHaveBeenCalledTimes(1);
    expect(quota).toHaveBeenCalledWith(true);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it.each(["network", "server", "malformed"])("never retries an uncertain %s outcome and offers library verification", async (kind) => {
    const fetchMock = vi.fn();
    if (kind === "network") fetchMock.mockRejectedValue(new TypeError("private server detail"));
    else fetchMock.mockResolvedValue(kind === "server" ? new Response(null, { status: 503 }) : Response.json({ unexpected: true }));
    vi.stubGlobal("fetch", fetchMock);
    const inspect = vi.fn();
    render(<Harness onInspect={inspect} />);
    select(pdf("a.pdf"), pdf("b.pdf"));
    await waitFor(() => expect(row("a.pdf")).toHaveAttribute("data-status", "unknown"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "重试 a.pdf" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "核对 a.pdf" }));
    expect(inspect).toHaveBeenCalledWith("a.pdf");
    fireEvent.click(screen.getByRole("button", { name: "重新打开" }));
    expect(row("b.pdf")).toHaveAttribute("data-status", "cancelled");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops waiting files on close, lets the active file finish, and keeps one pump on reopen", async () => {
    const first = deferred<Response>(); const third = deferred<Response>();
    const fetchMock = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(third.promise);
    vi.stubGlobal("fetch", fetchMock);
    const refresh = vi.fn();
    render(<Harness onComplete={refresh} />);
    select(pdf("a.pdf"), pdf("b.pdf"));
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    fireEvent.click(screen.getByRole("button", { name: "重新打开" }));
    select(pdf("c.pdf"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(row("b.pdf")).toHaveAttribute("data-status", "cancelled");
    await act(async () => first.resolve(success("a.pdf")));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => third.resolve(success("c.pdf")));
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it.each(["owner", "drive"])("aborts on %s changes and ignores late old results", async (change) => {
    const old = deferred<Response>(); const refresh = vi.fn();
    const fetchMock = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(success("new.pdf", change === "drive" ? "other" : "drive"));
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<Harness onComplete={refresh} />);
    select(pdf("old.pdf"), pdf("waiting.pdf"));
    const signal = fetchMock.mock.calls[0][1].signal;
    view.rerender(<Harness owner={change === "owner" ? "other" : "user"} choirId={change === "drive" ? "other" : "drive"} onComplete={refresh} />);
    expect(signal.aborted).toBe(true);
    await act(async () => old.resolve(success("old.pdf")));
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.queryByText("old.pdf")).not.toBeInTheDocument();
    select(pdf("new.pdf"));
    await waitFor(() => expect(row("new.pdf")).toHaveAttribute("data-status", "success"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("keeps successful uploads successful if refresh fails or hangs", async () => {
    const refresh = vi.fn().mockRejectedValueOnce(new Error("refresh failed")).mockReturnValue(new Promise(() => {}));
    const fetchMock = vi.fn().mockResolvedValueOnce(success("a.pdf")).mockResolvedValueOnce(success("b.pdf")).mockResolvedValueOnce(success("c.pdf"));
    vi.stubGlobal("fetch", fetchMock);
    render(<Harness onComplete={refresh} />);
    select(pdf("a.pdf"), pdf("b.pdf"), pdf("c.pdf"));
    await waitFor(() => expect(row("c.pdf")).toHaveAttribute("data-status", "success"));
    expect(screen.getByRole("alert")).toHaveTextContent("列表暂未刷新");
    expect(screen.queryByRole("button", { name: "重试 a.pdf" })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("bounds a stalled upload and keeps its uncertain result out of retries", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);
    render(<Harness />);
    select(pdf("stalled.pdf"), pdf("waiting.pdf"));
    await act(async () => { await vi.advanceTimersByTimeAsync(120_001); });
    expect(row("stalled.pdf")).toHaveAttribute("data-status", "unknown");
    expect(row("waiting.pdf")).toHaveAttribute("data-status", "queued");
    expect(screen.queryByRole("button", { name: "重试 stalled.pdf" })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
