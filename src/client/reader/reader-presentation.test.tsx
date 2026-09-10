import { act, render, screen, waitFor } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { noCapabilities } from "../../shared/drive-permissions";
import { localDatabase } from "../platform/local-database";
import { resolveLocalWorkspace } from "../platform/local-workspace";
import { clearReaderDocumentCache } from "./reader-document-cache";
import { loadPdfDocument, type PDFDocumentProxy } from "./pdf-document";
import { PdfPageCanvas } from "./pdf-page";
import { ReaderSession } from "./reader-session";
import { ReaderPresentationContext, useReaderPresentation } from "./use-reader-presentation";

// Only the PDF engine and network are substituted. Canvas presentation, target
// selection, document leases and session recovery use the production modules.
vi.mock("./pdf-document", () => ({ loadPdfDocument: vi.fn() }));
let version: string;
const sessions: ReaderSession[] = [];
beforeEach(async () => {
  await localDatabase.open();
  version = "v1";
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
  vi.stubGlobal("fetch", vi.fn(async (input: string) => input.endsWith("/bootstrap")
    ? Response.json({ state: "active", permissions: { capabilities: noCapabilities() }, score: {
      id: "score", choirId: "presentation", fileName: "谱.pdf", updatedAt: 1,
      currentVersion: { id: version, versionNumber: 1, sizeBytes: 10, sha256: "a".repeat(64), etag: version, pageCount: 2, createdAt: 1 },
    } }) : new Response(null, { status: 503 })));
});
afterEach(() => {
  sessions.splice(0).forEach(session => session.dispose());
  clearReaderDocumentCache();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function pdf() {
  const finishes: Array<() => void> = [];
  const renderPage = vi.fn(() => ({ promise: new Promise<void>(resolve => finishes.push(resolve)), cancel: vi.fn() }));
  const document = { numPages: 2, getPage: vi.fn().mockResolvedValue({
    getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }), render: renderPage,
  }) } as unknown as PDFDocumentProxy;
  return { document, finishes, renderPage };
}
function supply(document: PDFDocumentProxy) {
  vi.mocked(loadPdfDocument).mockImplementation(() => ({
    promise: Promise.resolve({ document, versionId: version }), destroy: vi.fn().mockResolvedValue(undefined),
  }));
}
async function open(document: PDFDocumentProxy) {
  supply(document);
  const workspace = await resolveLocalWorkspace({ authenticatedUserId: null, choirId: "presentation", scoreId: "score" });
  const session = new ReaderSession(workspace, null);
  sessions.push(session);
  session.open();
  await vi.waitFor(() => expect(session.getSnapshot().document).toBe(document));
  return session;
}
function Scene({ session, currentPage = 1, page = 1, editing = false, thumbnail = false, canvasDocument }: {
  session: ReaderSession; currentPage?: number; page?: number; editing?: boolean; thumbnail?: boolean; canvasDocument?: PDFDocumentProxy;
}) {
  const { document } = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const presentation = useReaderPresentation(session.presentation, document, currentPage, editing);
  return <ReaderPresentationContext.Provider value={presentation.context}>
    <output aria-label="谱面呈现">{presentation.status}</output>
    {document && <PdfPageCanvas document={canvasDocument ?? document} pageNumber={page} width={600} presentation={!thumbnail} />}
  </ReaderPresentationContext.Provider>;
}
const status = () => screen.getByLabelText("谱面呈现");

it("a prefetched page confirms the session and hides loading when selected, without redrawing", async () => {
  const source = pdf();
  const session = await open(source.document);
  const view = render(<Scene session={session} currentPage={2} />);
  await waitFor(() => expect(source.finishes).toHaveLength(1));
  await act(async () => source.finishes[0]());
  expect(status()).toHaveTextContent("pending");
  expect(session.presentation.hasPresented(source.document)).toBe(false);
  view.rerender(<Scene session={session} currentPage={1} />);
  await waitFor(() => expect(status()).toHaveTextContent("visible"));
  expect(session.presentation.hasPresented(source.document)).toBe(true);
  expect(source.renderPage).toHaveBeenCalledTimes(1);
});

it("neither a retained bitmap nor a late old-document render confirms a replacement", async () => {
  const previous = pdf();
  const next = pdf();
  const session = await open(previous.document);
  const view = render(<Scene session={session} currentPage={2} />);
  await waitFor(() => expect(previous.finishes).toHaveLength(1));
  await act(async () => previous.finishes[0]());
  version = "v2";
  supply(next.document);
  await act(async () => { await session.refresh(); });
  await waitFor(() => expect(next.finishes).toHaveLength(1));
  view.rerender(<Scene session={session} />);
  expect(status()).toHaveTextContent("pending");
  expect(session.presentation.hasPresented(next.document)).toBe(false);
  // Even a still-mounted old canvas reporting after replacement cannot win.
  act(() => session.presentation.ready(previous.document, 1));
  expect(status()).toHaveTextContent("pending");
  await act(async () => next.finishes[0]());
  await waitFor(() => expect(status()).toHaveTextContent("visible"));
  expect(session.presentation.hasPresented(next.document)).toBe(true);
});

it("thumbnail paint cannot acknowledge the current page even with the normal canvas class", async () => {
  const source = pdf();
  const session = await open(source.document);
  render(<Scene session={session} thumbnail />);
  await waitFor(() => expect(source.finishes).toHaveLength(1));
  await act(async () => source.finishes[0]());
  expect(status()).toHaveTextContent("pending");
  expect(session.presentation.hasPresented(source.document)).toBe(false);
});

it("editing shows a drawing failure without changing display mode, and a page retry clears it", async () => {
  const source = pdf();
  source.renderPage.mockImplementationOnce(() => ({ promise: Promise.reject(new Error("draw failed")), cancel: vi.fn() }))
    .mockImplementationOnce(() => ({ promise: Promise.reject(new Error("draw failed")), cancel: vi.fn() }));
  const session = await open(source.document);
  render(<Scene session={session} editing />);
  await waitFor(() => expect(status()).toHaveTextContent("failed"));
  expect(session.getSnapshot().mode).toBe("pdf");
  act(() => screen.getByRole("button", { name: "重试本页" }).click());
  await waitFor(() => expect(source.finishes).toHaveLength(1));
  await act(async () => source.finishes[0]());
  await waitFor(() => expect(status()).toHaveTextContent("visible"));
});

it("a classified current-page drawing failure uses the existing one-shot image recovery", async () => {
  const source = pdf();
  source.renderPage.mockImplementation(() => ({ promise: Promise.reject(new Error("draw failed")), cancel: vi.fn() }));
  const session = await open(source.document);
  render(<Scene session={session} />);
  await waitFor(() => expect(session.getSnapshot().mode).toBe("images"));
  expect(session.presentation.hasPresented(source.document)).toBe(false);
});

it("unmount and disposal reject late display events", async () => {
  const source = pdf();
  const session = await open(source.document);
  const view = render(<Scene session={session} />);
  view.unmount();
  session.presentation.ready(source.document, 1);
  session.presentation.failed(source.document, 1, Object.assign(new Error(), { name: "PdfPageRenderError" }));
  expect(session.presentation.hasPresented(source.document)).toBe(false);
  expect(session.getSnapshot().mode).toBe("pdf");
  session.dispose();
  session.presentation.select({ document: source.document, page: 1, editing: false });
  session.presentation.ready(source.document, 1);
  expect(session.presentation.hasPresented(source.document)).toBe(false);
});
