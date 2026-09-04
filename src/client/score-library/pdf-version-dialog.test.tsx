import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PdfVersionDialog } from "./pdf-version-dialog";

vi.mock("../auth/auth-client", () => ({ authClient: { useSession: () => ({ data: { user: { id: "admin" } }, isPending: false }) } }));
vi.mock("./pdf-version-preview", () => ({ PdfVersionPreview: ({ onReady }: { onReady(ready: boolean): void }) =>
  <button onClick={() => onReady(true)}>预览渲染完成</button> }));
const original = { id: "original", versionNumber: 1, sizeBytes: 300, sha256: "hash", etag: "etag", pageCount: 3, createdAt: 1 };
const candidate = { ...original, id: "candidate", versionNumber: 2, pageCount: 2 };
const score = { id: "score", choirId: "drive", fileName: "练习.pdf", currentVersion: original, updatedAt: 1 };
afterEach(() => vi.unstubAllGlobals());

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
