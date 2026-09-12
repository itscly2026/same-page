import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { uploadPdf, type UploadProgress } from "./upload-transport";
import { PdfVersionDialog } from "./pdf-version-dialog";

vi.mock("./upload-transport", async (importOriginal) => ({
  ...await importOriginal<typeof import("./upload-transport")>(),
  uploadPdf: vi.fn((url: string, form: FormData, signal: AbortSignal) => fetch(url, { method: "POST", body: form, signal })),
}));
const identity = vi.hoisted(() => ({ id: "admin", pending: false }));
vi.mock("../auth/auth-client", () => ({ authClient: { useSession: () => ({ data: { user: { id: identity.id } }, isPending: identity.pending }) } }));
vi.mock("./pdf-version-preview", () => ({ PdfVersionPreview: ({ onReady }: { onReady(ready: boolean): void }) =>
  <button onClick={() => onReady(true)}>预览渲染完成</button> }));
const original = { id: "original", versionNumber: 1, sizeBytes: 300, sha256: "hash", etag: "etag", pageCount: 3, createdAt: 1 };
const candidate = { ...original, id: "candidate", versionNumber: 2, pageCount: 2 };
const score = { id: "score", choirId: "drive", fileName: "练习.pdf", currentVersion: original, updatedAt: 1 };
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); identity.id = "admin"; identity.pending = false; });

function mockApi() {
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    if (input.endsWith("/publish")) return new Response(null, { status: 204 });
    if (init?.method === "POST") return Response.json({ version: candidate });
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    return Response.json({ currentVersionId: original.id, revision: 7, versions: [{ ...original, retentionExpiresAt: null }, { ...candidate, retentionExpiresAt: Date.now() + 10000 }] });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("PDF replacement confirmation", () => {
  it("requires a rendered preview and explicit acceptance before publishing the selected revision", async () => {
    const fetch = mockApi(); const complete = vi.fn();
    render(<PdfVersionDialog choirId="drive" score={score} historyOnly={false} onClose={() => {}} onComplete={complete} />);
    const input = screen.getByLabelText("新的 PDF（最多 20 MB、500 页）");
    await waitFor(() => expect(input).not.toBeDisabled());
    fireEvent.change(input, { target: { files: [new File(["pdf"], "新谱.pdf", { type: "application/pdf" })] } });
    const publish = await screen.findByRole("button", { name: "确认替换" });
    expect(publish).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("页数减少");
    expect(fetch.mock.calls.some(([url]) => url.endsWith("/publish"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "预览渲染完成" }));
    expect(publish).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(publish);
    await waitFor(() => expect(complete).toHaveBeenCalledOnce());
    expect(fetch).toHaveBeenCalledWith("/api/choirs/drive/scores/score/versions/candidate/publish", expect.objectContaining({ body: JSON.stringify({ expectedRevision: 7 }) }));
  });

  it("queues cancellation on close without publishing", async () => {
    const fetch = mockApi();
    const view = render(<PdfVersionDialog choirId="drive" score={score} historyOnly={false} onClose={() => {}} onComplete={() => {}} />);
    const input = screen.getByLabelText("新的 PDF（最多 20 MB、500 页）");
    await waitFor(() => expect(input).not.toBeDisabled());
    fireEvent.change(input, { target: { files: [new File(["pdf"], "新谱.pdf")] } });
    await screen.findByRole("button", { name: "确认替换" });
    view.unmount();
    expect(fetch).toHaveBeenCalledWith("/api/choirs/drive/scores/score/versions/candidate", expect.objectContaining({ method: "DELETE" }));
    expect(fetch.mock.calls.some(([url]) => url.endsWith("/publish"))).toBe(false);
  });

  it("offers retained original upload numbers for rollback", async () => {
    const fetch = mockApi();
    render(<PdfVersionDialog choirId="drive" score={score} historyOnly onClose={() => {}} onComplete={() => {}} />);
    await screen.findByRole("option", { name: /版本 2/ });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "candidate" } });
    fireEvent.click(screen.getByRole("button", { name: "预览渲染完成" }));
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "确认回滚" }));
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => url.endsWith("/candidate/publish"))).toBe(true));
  });
});


it("shows replacement transfer progress but waits for the confirmed candidate", async () => {
  mockApi();
  let report!: (progress: UploadProgress) => void;
  let finish!: (response: Response) => void;
  vi.mocked(uploadPdf).mockImplementationOnce((_url, _form, _signal, progress) => {
    report = progress;
    return new Promise(resolve => { finish = resolve; });
  });
  render(<PdfVersionDialog choirId="drive" score={score} historyOnly={false} onClose={() => {}} onComplete={() => {}} />);
  const input = screen.getByLabelText("新的 PDF（最多 20 MB、500 页）");
  await waitFor(() => expect(input).not.toBeDisabled());
  fireEvent.change(input, { target: { files: [new File(["pdf"], "new.pdf")] } });
  act(() => report({ percent: 50, bytesPerSecond: 1024, processing: false }));
  expect(screen.getByRole("progressbar")).toHaveAttribute("value", "50");
  expect(screen.getByText(/平均.*KB\/s/)).toBeInTheDocument();
  act(() => report({ percent: 100, bytesPerSecond: 0, processing: true }));
  expect(screen.getByText("传输完成，正在保存…")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "确认替换" })).not.toBeInTheDocument();
  await act(async () => finish(Response.json({ version: candidate })));
  expect(screen.getByRole("button", { name: "确认替换" })).toBeDisabled();
  expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
});

it.each([503, 200])("blocks another candidate POST after an unconfirmed %s response", async (status) => {
  const fetch = mockApi();
  vi.mocked(uploadPdf).mockResolvedValueOnce(Response.json({}, { status }));
  render(<PdfVersionDialog choirId="drive" score={score} historyOnly={false} onClose={() => {}} onComplete={() => {}} />);
  const input = screen.getByLabelText("新的 PDF（最多 20 MB、500 页）");
  await waitFor(() => expect(input).not.toBeDisabled());
  fireEvent.change(input, { target: { files: [new File(["pdf"], "new.pdf")] } });
  await screen.findByText(/未能确认候选 PDF/);
  expect(input).toBeDisabled();
  expect(fetch.mock.calls.some(([url]) => url.endsWith("/publish"))).toBe(false);
});


it("bounds a stalled replacement without allowing a second upload", async () => {
  mockApi();
  vi.mocked(uploadPdf).mockImplementationOnce((_url, _form, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  }));
  render(<PdfVersionDialog choirId="drive" score={score} historyOnly={false} onClose={() => {}} onComplete={() => {}} />);
  const input = screen.getByLabelText("新的 PDF（最多 20 MB、500 页）");
  await waitFor(() => expect(input).not.toBeDisabled());
  vi.useFakeTimers();
  fireEvent.change(input, { target: { files: [new File(["pdf"], "new.pdf")] } });
  await act(async () => { await vi.advanceTimersByTimeAsync(600_001); });
  expect(screen.getByText(/未能确认候选 PDF/)).toBeInTheDocument();
  expect(input).toBeDisabled();
});

it("aborts replacement on identity changes and ignores the old completion", async () => {
  const fetch = mockApi();
  let finish!: (response: Response) => void;
  let signal!: AbortSignal;
  vi.mocked(uploadPdf).mockImplementationOnce((_url, _form, activeSignal) => {
    signal = activeSignal;
    return new Promise(resolve => { finish = resolve; });
  });
  const props = { choirId: "drive", score, historyOnly: false, onClose: () => {}, onComplete: vi.fn() };
  const view = render(<PdfVersionDialog {...props} />);
  const input = screen.getByLabelText("新的 PDF（最多 20 MB、500 页）");
  await waitFor(() => expect(input).not.toBeDisabled());
  fireEvent.change(input, { target: { files: [new File(["pdf"], "new.pdf")] } });
  identity.id = "another-user";
  view.rerender(<PdfVersionDialog {...props} />);
  expect(signal.aborted).toBe(true);
  await act(async () => finish(Response.json({ version: candidate })));
  expect(screen.queryByRole("button", { name: "确认替换" })).not.toBeInTheDocument();
  expect(fetch.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
});
