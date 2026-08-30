import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { activateVerifiedOfflineScore } from "../platform/local-database";
import ReaderPage from "./reader-page";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (options: { count: number }) => ({
    getTotalSize: () => options.count * 100,
    getVirtualItems: () =>
      Array.from({ length: options.count }, (_, index) => ({
        index,
        key: index,
        start: index * 100,
      })),
    measureElement: vi.fn(),
    scrollToIndex: vi.fn(),
  }),
}));

vi.mock("../auth/auth-client", () => ({
  authClient: {
    useSession: () => ({ data: null, isPending: false }),
  },
}));

vi.mock("../reader/pdf-document", () => ({
  loadPdfDocument: vi.fn().mockResolvedValue({
    document: { numPages: 3 },
    destroy: vi.fn(),
  }),
}));

vi.mock("../reader/pdf-page", () => ({
  PdfPageCanvas: ({ pageNumber }: { pageNumber: number }) => (
    <div aria-label={`渲染第 ${pageNumber} 页`} />
  ),
}));

vi.mock("../platform/local-database", () => ({
  findActiveOfflineScore: vi.fn().mockResolvedValue(null),
  activateVerifiedOfflineScore: vi.fn(),
}));

describe("ReaderPage", () => {
  beforeEach(() => {
    const stored = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
      clear: () => stored.clear(),
    });
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: string) =>
        Promise.resolve(
          input.includes("/versions/")
            ? new Response(new Uint8Array([1, 2, 3]), {
                headers: { "content-type": "application/pdf" },
              })
            : Response.json({
          scores: [
            {
              id: "score-1",
              choirId: "choir-1",
              title: "练声曲",
              composer: null,
              arranger: null,
              sortOrder: 0,
              status: "published",
              updatedAt: 1,
              currentVersion: {
                id: "version-1",
                versionNumber: 1,
                sizeBytes: 329,
                sha256: "a".repeat(64),
                etag: '"etag"',
                pageCount: 3,
                createdAt: 1,
              },
            },
          ],
          storage: { usedBytes: 329, limitBytes: 1_073_741_824 },
          permissions: { canManage: false },
              }),
        ),
      ),
    );
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens in page-reading mode and switches layouts without entering edit mode", async () => {
    render(
      <MemoryRouter
        initialEntries={["/choirs/choir-1/scores/score-1"]}
      >
        <Routes>
          <Route
            path="/choirs/:choirId/scores/:scoreId"
            element={<ReaderPage />}
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText("练声曲")).toBeInTheDocument();
    expect(screen.getByText("阅读模式")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "翻页" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      within(screen.getByLabelText("翻页阅读")).getByLabelText("渲染第 1 页"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(
      within(screen.getByLabelText("翻页阅读")).getByLabelText("渲染第 2 页"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "连续滚动" }));
    expect(screen.getByLabelText("连续滚动阅读")).toBeInTheDocument();
    expect(screen.getByRole("spinbutton")).toHaveValue(2);
    expect(screen.queryByText("编辑")).not.toBeInTheDocument();
  });

  it("keeps the existing offline selection when checksum verification fails", async () => {
    render(
      <MemoryRouter
        initialEntries={["/choirs/choir-1/scores/score-1"]}
      >
        <Routes>
          <Route
            path="/choirs/:choirId/scores/:scoreId"
            element={<ReaderPage />}
          />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText("练声曲");
    fireEvent.click(screen.getByRole("button", { name: "下载离线副本" }));
    expect(
      await screen.findByText("离线下载未完成，现有离线版本没有切换。"),
    ).toBeInTheDocument();
    expect(activateVerifiedOfflineScore).not.toHaveBeenCalled();
  });
});
