import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  activateVerifiedOfflineScore,
  findActiveOfflineScore,
  localDatabase,
} from "../platform/local-database";
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

vi.mock("../platform/local-database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../platform/local-database")>();
  return {
    ...actual,
    findActiveOfflineScore: vi.fn().mockResolvedValue(null),
    activateVerifiedOfflineScore: vi.fn(),
  };
});

vi.mock("../annotations/sync", () => ({
  syncAnnotations: vi.fn().mockResolvedValue({ pushed: 0, pulled: 0 }),
}));

vi.mock("../annotations/local-annotations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../annotations/local-annotations")>();
  return {
    ...actual,
    queueScoreDrafts: vi.fn().mockResolvedValue(0),
  };
});

describe("ReaderPage", () => {
  beforeEach(async () => {
    await localDatabase.open();
    await localDatabase.annotationLayers.clear();
    await localDatabase.annotations.clear();
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
          input.includes("/layers")
            ? Response.json({ layers: [], permissions: { canManageLayers: false } })
            : input.includes("/versions/")
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
    vi.restoreAllMocks();
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

  it("keeps page input read-only until edit is explicit and defaults editing to text", async () => {
    vi.mocked(fetch).mockImplementation((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/layers")) {
        return Promise.resolve(
          Response.json({
            layers: [
              {
                id: "11111111-1111-4111-8111-111111111111",
                kind: "personal",
                name: "我的批注",
                sortOrder: 10000,
                defaultColor: "#b4235a",
                colorOverride: null,
                visible: true,
                canEdit: true,
              },
            ],
            permissions: { canManageLayers: false },
          }),
        );
      }
      return Promise.resolve(
        Response.json({
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
      );
    });
    render(
      <MemoryRouter initialEntries={["/choirs/choir-1/scores/score-1"]}>
        <Routes>
          <Route path="/choirs/:choirId/scores/:scoreId" element={<ReaderPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText("阅读模式")).toBeInTheDocument();
    const overlay = screen.getByLabelText("第 1 页批注层");
    fireEvent.pointerDown(overlay, { clientX: 20, clientY: 20 });
    expect(screen.queryByLabelText("批注文本")).not.toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
    expect(screen.getByText("编辑模式")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "文本" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const editingOverlay = screen.getByLabelText("第 1 页批注层");
    vi.spyOn(editingOverlay, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 100,
      bottom: 100,
      width: 100,
      height: 100,
      toJSON: () => ({}),
    });
    fireEvent.pointerDown(editingOverlay, { clientX: 20, clientY: 30 });
    expect(screen.getByLabelText("批注文本")).toBeInTheDocument();
  });

  it("marks an offline copy only after app shell, layer and annotation snapshot verification", async () => {
    vi.spyOn(crypto.subtle, "digest").mockResolvedValue(
      new Uint8Array(32).fill(0xaa).buffer,
    );
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { ready: Promise.resolve({ active: {} }) },
    });
    vi.mocked(fetch).mockImplementation((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/layers")) {
        return Promise.resolve(
          Response.json({
            layers: [
              {
                id: "11111111-1111-4111-8111-111111111111",
                kind: "shared",
                name: "指挥",
                sortOrder: 0,
                defaultColor: "#a12652",
                colorOverride: null,
                visible: true,
                canEdit: false,
              },
            ],
            permissions: { canManageLayers: false },
          }),
        );
      }
      if (url.includes("/versions/")) {
        return Promise.resolve(
          new Response(new Uint8Array([1, 2, 3]), {
            headers: { "content-type": "application/pdf" },
          }),
        );
      }
      return Promise.resolve(
        Response.json({
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
                sizeBytes: 3,
                sha256: "a".repeat(64),
                etag: '"etag"',
                pageCount: 3,
                createdAt: 1,
              },
            },
          ],
          storage: { usedBytes: 3, limitBytes: 1_073_741_824 },
          permissions: { canManage: false },
        }),
      );
    });
    render(
      <MemoryRouter initialEntries={["/choirs/choir-1/scores/score-1"]}>
        <Routes>
          <Route path="/choirs/:choirId/scores/:scoreId" element={<ReaderPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText("练声曲");
    fireEvent.click(screen.getByRole("button", { name: "下载离线副本" }));
    expect(
      await screen.findByText("离线副本已完整校验，可以离线打开。"),
    ).toBeInTheDocument();
    expect(activateVerifiedOfflineScore).toHaveBeenCalledWith(
      expect.objectContaining({
        annotationSnapshot: expect.objectContaining({
          layers: [expect.objectContaining({ name: "指挥" })],
          annotations: [],
        }),
      }),
    );
  });

  it("allows the last authenticated user to edit a verified local copy after session expiry", async () => {
    const scopeKey = "choir-1:score-1";
    vi.mocked(findActiveOfflineScore).mockResolvedValueOnce({
      key: "offline-1",
      choirId: "choir-1",
      scoreId: "score-1",
      versionId: "version-1",
      title: "离线练声曲",
      sha256: "a".repeat(64),
      pageCount: 1,
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: "application/pdf" }),
      active: 1,
      verifiedAt: 1,
      annotationSnapshot: {
        layers: [
          {
            key: `${scopeKey}:11111111-1111-4111-8111-111111111111`,
            scopeKey,
            id: "11111111-1111-4111-8111-111111111111",
            kind: "personal",
            name: "我的批注",
            sortOrder: 10000,
            defaultColor: "#b4235a",
            colorOverride: null,
            visible: true,
            canEdit: true,
          },
        ],
        annotations: [],
        cursor: 0,
        verifiedAt: 1,
      },
    });
    vi.mocked(fetch).mockRejectedValue(new Error("offline"));
    render(
      <MemoryRouter initialEntries={["/choirs/choir-1/scores/score-1"]}>
        <Routes>
          <Route path="/choirs/:choirId/scores/:scoreId" element={<ReaderPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText("离线练声曲")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
    expect(screen.getByText("编辑模式")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "文本" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});
