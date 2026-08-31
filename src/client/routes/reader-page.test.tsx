import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  activateVerifiedOfflineScore,
  findActiveOfflineScore,
  localDatabase,
} from "../platform/local-database";
import {
  activateAuthenticatedLocalOwner,
  authenticatedLocalOwnerKey,
  createLocalWorkspace,
  localWorkspaceRecordKey,
} from "../platform/local-workspace";
import { syncAnnotations } from "../annotations/sync";
import ReaderPage from "./reader-page";

const virtualTestState = vi.hoisted(() => ({
  itemSize: 100,
  scrollToIndex: vi.fn(),
}));

const localWorkspace = createLocalWorkspace(
  authenticatedLocalOwnerKey("user-1"),
  "choir-1",
  "score-1",
);

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (options: { count: number }) => ({
    getTotalSize: () => options.count * virtualTestState.itemSize,
    getVirtualItems: () =>
      Array.from({ length: options.count }, (_, index) => ({
        index,
        key: index,
        start: index * virtualTestState.itemSize,
        end: index * virtualTestState.itemSize + virtualTestState.itemSize,
        size: virtualTestState.itemSize,
      })),
    measureElement: vi.fn(),
    scrollToIndex: virtualTestState.scrollToIndex,
  }),
}));

vi.mock("../auth/auth-client", () => ({
  authClient: {
    useSession: () => ({ data: null, isPending: false }),
  },
}));

vi.mock("../reader/pdf-document", () => ({
  loadPdfDocument: vi.fn().mockResolvedValue({
    document: {
      numPages: 3,
      getPage: vi.fn().mockResolvedValue({
        getViewport: () => ({ width: 600, height: 800 }),
      }),
    },
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
  const getPageViewport = () => {
    const viewport = screen
      .getByLabelText("翻页阅读")
      .querySelector<HTMLElement>(".page-reader__viewport");
    if (!viewport) throw new Error("page viewport unavailable");
    return viewport;
  };

  const toggleChrome = () => {
    const viewport = getPageViewport();
    fireEvent.pointerDown(viewport, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 500,
      clientY: 100,
    });
    fireEvent.pointerUp(viewport, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 500,
      clientY: 100,
    });
  };

  const openMoreMenu = () => {
    toggleChrome();
    fireEvent.click(screen.getByRole("button", { name: "更多" }));
  };

  beforeEach(async () => {
    virtualTestState.itemSize = 100;
    await localDatabase.open();
    await localDatabase.annotationLayers.clear();
    await localDatabase.annotations.clear();
    await localDatabase.annotationOutbox.clear();
    await localDatabase.annotationConflicts.clear();
    await activateAuthenticatedLocalOwner("user-1");
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
              fileName: "练声曲.pdf",
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

  it("keeps a delayed cloud lookup in a loading state without flashing an error", async () => {
    let releaseLookup!: (response: Response) => void;
    const delayedLookup = new Promise<Response>((resolve) => {
      releaseLookup = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: string) => {
        if (input.includes("/scores") && !input.includes("/layers")) {
          return delayedLookup;
        }
        return Promise.resolve(
          Response.json({ layers: [], permissions: { canManageLayers: false } }),
        );
      }),
    );

    render(
      <MemoryRouter initialEntries={["/choirs/choir-1/scores/score-1"]}>
        <Routes>
          <Route path="/choirs/:choirId/scores/:scoreId" element={<ReaderPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText("正在加载乐谱…")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "无法打开" })).not.toBeInTheDocument();
    releaseLookup(
      Response.json({
        scores: [
          {
            id: "score-1",
            choirId: "choir-1",
            fileName: "练声曲.pdf",
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
    expect(await screen.findByText("练声曲.pdf")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByLabelText("翻页阅读")).toBeInTheDocument();
    });
  });

  it("opens with score-only chrome and switches layouts without entering edit mode", async () => {
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

    expect(await screen.findByText("练声曲.pdf")).toBeInTheDocument();
    expect(screen.queryByLabelText("阅读器控制")).not.toBeInTheDocument();
    expect(
      within(screen.getByLabelText("翻页阅读")).getByLabelText("渲染第 1 页"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(
      within(screen.getByLabelText("翻页阅读")).getByLabelText("渲染第 2 页"),
    ).toBeInTheDocument();

    toggleChrome();
    expect(screen.getByRole("link", { name: "返回云盘" }).querySelector("svg")).not.toBeNull();
    expect(screen.getByRole("button", { name: "图层" }).querySelector("svg")).not.toBeNull();
    expect(screen.getByRole("button", { name: "更多" }).querySelector("svg")).not.toBeNull();
    expect(screen.queryByLabelText("页面缩略图")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "页面位置" }));
    const pageStrip = screen.getByLabelText("页面缩略图");
    expect(pageStrip).toHaveClass("page-preview-strip");
    expect(screen.getByRole("button", { name: "前往第 2 页" })).toHaveAttribute(
      "data-current",
    );
    expect(within(pageStrip).getByText("2 / 3")).toHaveClass(
      "page-preview-strip__position",
    );
    expect(virtualTestState.scrollToIndex).toHaveBeenCalledWith(1, {
      align: "auto",
    });
    fireEvent.click(screen.getByRole("button", { name: "前往第 3 页" }));
    expect(
      within(screen.getByLabelText("翻页阅读")).getByLabelText("渲染第 3 页"),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("页面缩略图")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "图层" }));
    expect(screen.getByLabelText("图层显示与颜色")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭页面与图层" }));
    fireEvent.click(screen.getByRole("button", { name: "更多" }));
    expect(screen.getByRole("button", { name: "翻页" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "连续滚动" }));
    expect(screen.getByLabelText("连续滚动阅读")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "页面位置" })).toHaveTextContent("3 / 3");
    expect(
      screen.getByText("轻点页面中央显示控制，上下滑动连续浏览"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("轻点页面中央显示控制，点按两侧或左右滑动翻页"),
    ).not.toBeInTheDocument();
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

    await screen.findByText("练声曲.pdf");
    openMoreMenu();
    fireEvent.click(screen.getByRole("button", { name: "下载离线副本" }));
    expect(
      await screen.findByText("离线下载未完成，现有离线版本没有切换。"),
    ).toHaveClass("reader-more-menu__status");
    expect(activateVerifiedOfflineScore).not.toHaveBeenCalled();
  });

  it("swipes between fitted pages and pans instead of turning after pinch zoom", async () => {
    render(
      <MemoryRouter initialEntries={["/choirs/choir-1/scores/score-1"]}>
        <Routes>
          <Route path="/choirs/:choirId/scores/:scoreId" element={<ReaderPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText("练声曲.pdf");
    const viewport = getPageViewport();
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 1000,
      bottom: 800,
      width: 1000,
      height: 800,
      toJSON: () => ({}),
    });

    fireEvent.pointerDown(viewport, {
      pointerId: 9,
      pointerType: "touch",
      clientX: 20,
      clientY: 100,
    });
    fireEvent.pointerUp(viewport, {
      pointerId: 9,
      pointerType: "touch",
      clientX: 20,
      clientY: 100,
    });
    expect(screen.getByLabelText("渲染第 1 页")).toBeInTheDocument();
    expect(screen.queryByLabelText("阅读器控制")).not.toBeInTheDocument();

    fireEvent.pointerDown(viewport, {
      pointerId: 10,
      pointerType: "touch",
      clientX: 980,
      clientY: 100,
    });
    fireEvent.pointerUp(viewport, {
      pointerId: 10,
      pointerType: "touch",
      clientX: 980,
      clientY: 100,
    });
    expect(screen.getByLabelText("渲染第 2 页")).toBeInTheDocument();

    fireEvent.pointerDown(viewport, {
      pointerId: 11,
      pointerType: "touch",
      clientX: 20,
      clientY: 100,
    });
    fireEvent.pointerUp(viewport, {
      pointerId: 11,
      pointerType: "touch",
      clientX: 20,
      clientY: 100,
    });
    expect(screen.getByLabelText("渲染第 1 页")).toBeInTheDocument();

    fireEvent.pointerDown(viewport, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 250,
      clientY: 100,
    });
    fireEvent.pointerUp(viewport, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 150,
      clientY: 100,
    });
    expect(screen.getByLabelText("渲染第 2 页")).toBeInTheDocument();

    fireEvent.pointerDown(viewport, {
      pointerId: 2,
      pointerType: "touch",
      clientX: 20,
      clientY: 100,
    });
    fireEvent.pointerDown(viewport, {
      pointerId: 3,
      pointerType: "touch",
      clientX: 120,
      clientY: 100,
    });
    fireEvent.pointerMove(viewport, {
      pointerId: 3,
      pointerType: "touch",
      clientX: 220,
      clientY: 100,
    });
    fireEvent.pointerUp(viewport, { pointerId: 3, pointerType: "touch" });
    fireEvent.pointerUp(viewport, { pointerId: 2, pointerType: "touch" });

    fireEvent.pointerDown(viewport, {
      pointerId: 4,
      pointerType: "touch",
      clientX: 250,
      clientY: 100,
    });
    fireEvent.pointerUp(viewport, {
      pointerId: 4,
      pointerType: "touch",
      clientX: 150,
      clientY: 100,
    });
    expect(screen.getByLabelText("渲染第 2 页")).toBeInTheDocument();

    toggleChrome();
    fireEvent.click(screen.getByRole("button", { name: "更多" }));
    expect(screen.getByText("200%")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "更多" }));
    fireEvent.click(screen.getByRole("button", { name: "上一页" }));
    fireEvent.pointerDown(viewport, {
      pointerId: 12,
      pointerType: "touch",
      clientX: 20,
      clientY: 100,
    });
    fireEvent.pointerDown(viewport, {
      pointerId: 13,
      pointerType: "touch",
      clientX: 120,
      clientY: 100,
    });
    fireEvent.pointerMove(viewport, {
      pointerId: 13,
      pointerType: "touch",
      clientX: 220,
      clientY: 100,
    });
    fireEvent.pointerUp(viewport, { pointerId: 13, pointerType: "touch" });
    fireEvent.pointerUp(viewport, { pointerId: 12, pointerType: "touch" });
    fireEvent.pointerDown(viewport, {
      pointerId: 14,
      pointerType: "touch",
      clientX: 20,
      clientY: 100,
    });
    fireEvent.pointerUp(viewport, {
      pointerId: 14,
      pointerType: "touch",
      clientX: 20,
      clientY: 100,
    });
    fireEvent.click(screen.getByRole("button", { name: "更多" }));
    expect(screen.getByText("200%")).toBeInTheDocument();
  });

  it("keeps page input read-only until edit is explicit and defaults editing to text", async () => {
    vi.mocked(fetch).mockImplementation((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/layers")) {
        return Promise.resolve(
          Response.json({
            layers: [
              ...(["G", "S", "A", "T", "B"] as const).map((slot, index) => ({
                id: `00000000-0000-4000-8000-00000000000${index}`,
                kind: "shared" as const,
                defaultSlot: slot,
                name: slot,
                sortOrder: index,
                defaultColor: "#a12652",
                colorOverride: null,
                visible: slot === "G" || slot === "B",
                canEdit: slot === "G",
              })),
              {
                id: "33333333-3333-4333-8333-333333333333",
                kind: "shared",
                defaultSlot: null,
                name: "指挥提示",
                sortOrder: 5,
                defaultColor: "#6b3fa0",
                colorOverride: null,
                visible: false,
                canEdit: true,
              },
              {
                id: "11111111-1111-4111-8111-111111111111",
                kind: "personal",
                defaultSlot: null,
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
              fileName: "练声曲.pdf",
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

    await screen.findByText("练声曲.pdf");
    const overlay = screen.getByLabelText("第 1 页批注层");
    fireEvent.pointerDown(overlay, { clientX: 20, clientY: 20 });
    fireEvent.pointerUp(overlay, { clientX: 20, clientY: 20 });
    expect(screen.queryByLabelText("批注文本")).not.toBeInTheDocument();

    if (!screen.queryByLabelText("阅读器控制")) toggleChrome();
    fireEvent.click(screen.getByRole("button", { name: "更多" }));
    fireEvent.click(screen.getByRole("button", { name: "连续滚动" }));
    fireEvent.click(screen.getByRole("button", { name: "更多" }));
    for (let count = 0; count < 4; count += 1) {
      fireEvent.click(screen.getByRole("button", { name: "放大" }));
    }
    expect(screen.getByText("200%")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "更多" }));
    const continuousReader = screen.getByLabelText("连续滚动阅读");
    continuousReader.scrollTop = 40;
    fireEvent.scroll(continuousReader);
    fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
    expect(screen.getByText(/编辑模式/)).toBeInTheDocument();
    expect(screen.getByLabelText("翻页阅读")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "下一页" })).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByText("编辑模式 · 第 1 页")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "文本" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "文本" }).querySelector("svg")).not.toBeNull();
    expect(screen.getByRole("button", { name: "画笔" }).querySelector("svg")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "整条橡皮" }).querySelector("svg"),
    ).not.toBeNull();
    expect(screen.getByRole("button", { name: "U，我的批注" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      Array.from(
        screen
          .getByLabelText("编辑层")
          .querySelectorAll<HTMLButtonElement>(".annotation-layer-slot"),
        (button) => button.textContent,
      ),
    ).toEqual(["G", "S", "A", "T", "B", "U"]);
    expect(
      screen.getByRole("button", { name: "S，女高音共享层，只读" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "G，共同关注共享层" }));
    expect(
      screen.getByRole("button", { name: "G，共同关注共享层" }),
    ).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("combobox", { name: "其他编辑层" })).toHaveValue("");
    expect(screen.getByRole("option", { name: "指挥提示" })).toBeInTheDocument();
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
    expect(screen.getAllByRole("button", { name: "完成" })).toHaveLength(1);
    fireEvent.click(
      within(screen.getByRole("form", { name: "文字输入" })).getByRole(
        "button",
        { name: "取消" },
      ),
    );

    virtualTestState.itemSize = 200;
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    const restoredReader = await screen.findByLabelText("连续滚动阅读");
    await waitFor(() => expect(restoredReader.scrollTop).toBe(80));
    fireEvent.pointerDown(restoredReader, {
      pointerId: 8,
      pointerType: "touch",
      clientX: 100,
      clientY: 100,
    });
    fireEvent.pointerUp(restoredReader, {
      pointerId: 8,
      pointerType: "touch",
      clientX: 100,
      clientY: 100,
    });
    fireEvent.click(screen.getByRole("button", { name: "更多" }));
    expect(screen.getByText("200%")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "更多" }));
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    expect(
      screen.getByRole("button", { name: "G，共同关注共享层" }),
    ).toHaveAttribute("aria-pressed", "true");
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
                defaultSlot: null,
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
              fileName: "练声曲.pdf",
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

    await screen.findByText("练声曲.pdf");
    openMoreMenu();
    fireEvent.click(screen.getByRole("button", { name: "下载离线副本" }));
    expect(
      await screen.findByText("离线副本已完整校验，可以离线打开。"),
    ).toHaveClass("reader-more-menu__status");
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
    vi.mocked(findActiveOfflineScore).mockResolvedValueOnce({
      key: "offline-1",
      ...localWorkspace,
      versionId: "version-1",
      fileName: "离线练声曲.pdf",
      sha256: "a".repeat(64),
      pageCount: 1,
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: "application/pdf" }),
      active: 1,
      verifiedAt: 1,
      annotationSnapshot: {
        layers: [
          {
            key: localWorkspaceRecordKey(localWorkspace, "11111111-1111-4111-8111-111111111111"),
            ...localWorkspace,
            id: "11111111-1111-4111-8111-111111111111",
            kind: "personal",
            defaultSlot: null,
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

    expect(await screen.findByText("离线练声曲.pdf")).toBeInTheDocument();
    toggleChrome();
    fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
    expect(screen.getByText(/编辑模式/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "文本" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("hides A's loaded reader state as soon as another tab activates B", async () => {
    vi.mocked(findActiveOfflineScore).mockResolvedValueOnce({
      key: "offline-a",
      ...localWorkspace,
      versionId: "version-a",
      fileName: "A 的离线乐谱.pdf",
      sha256: "a".repeat(64),
      pageCount: 1,
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: "application/pdf" }),
      active: 1,
      verifiedAt: 1,
      annotationSnapshot: { layers: [], annotations: [], cursor: 0, verifiedAt: 1 },
    });
    vi.mocked(fetch).mockRejectedValue(new Error("offline"));
    render(
      <MemoryRouter initialEntries={["/choirs/choir-1/scores/score-1"]}>
        <Routes>
          <Route path="/choirs/:choirId/scores/:scoreId" element={<ReaderPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText("A 的离线乐谱.pdf")).toBeInTheDocument();

    await activateAuthenticatedLocalOwner("user-b");

    await waitFor(() => {
      expect(screen.queryByText("A 的离线乐谱.pdf")).not.toBeInTheDocument();
    });
    expect(screen.getByText("正在打开本机工作区…")).toBeInTheDocument();
  });

  it("keeps a trashed score's offline copy and outbox without editing or syncing", async () => {
    vi.mocked(findActiveOfflineScore).mockResolvedValueOnce({
      key: "offline-1",
      ...localWorkspace,
      versionId: "version-1",
      fileName: "离线练声曲.pdf",
      sha256: "a".repeat(64),
      pageCount: 1,
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: "application/pdf" }),
      active: 1,
      verifiedAt: 1,
      annotationSnapshot: {
        layers: [
          {
            key: localWorkspaceRecordKey(localWorkspace, "11111111-1111-4111-8111-111111111111"),
            ...localWorkspace,
            id: "11111111-1111-4111-8111-111111111111",
            kind: "personal",
            defaultSlot: null,
            name: "我的批注",
            sortOrder: 10_000,
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
    await localDatabase.annotationOutbox.put({
      opId: "pending-op",
      ...localWorkspace,
      annotationId: "annotation-1",
      layerId: "11111111-1111-4111-8111-111111111111",
      baseVersion: 0,
      type: "upsert",
      payload: {
        kind: "text",
        pageNumber: 1,
        x: 0.1,
        y: 0.1, fontScale: 0.024,
        text: "待恢复后同步",
      },
      attemptedAt: null,
      createdAt: 1,
    });
    const fetchMock = vi.fn().mockImplementation((input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/scores")) {
        return Promise.resolve(
          Response.json({
            scores: [],
            storage: { usedBytes: 329, limitBytes: 1_073_741_824 },
            permissions: { canManage: false },
          }),
        );
      }
      if (url.endsWith("/scores/score-1/status")) {
        return Promise.resolve(Response.json({ state: "trashed" }));
      }
      return Promise.reject(new Error(`unexpected request: ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter initialEntries={["/choirs/choir-1/scores/score-1"]}>
        <Routes>
          <Route path="/choirs/:choirId/scores/:scoreId" element={<ReaderPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText("离线练声曲.pdf")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "本机离线副本和未同步批注仍保留，恢复后可继续同步",
    );
    toggleChrome();
    expect(screen.queryByRole("button", { name: "编辑" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "更多" }));
    expect(screen.getByRole("button", { name: "立即同步" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "下载离线副本" })).toBeDisabled();
    expect(await localDatabase.annotationOutbox.count()).toBe(1);
    expect(syncAnnotations).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/choirs/choir-1/scores",
      "/api/choirs/choir-1/scores/score-1/status",
    ]);
  });

  it("detects trash on reconnect before draining the offline outbox", async () => {
    vi.mocked(findActiveOfflineScore).mockResolvedValueOnce({
      key: "offline-1",
      ...localWorkspace,
      versionId: "version-1",
      fileName: "离线练声曲.pdf",
      sha256: "a".repeat(64),
      pageCount: 1,
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: "application/pdf" }),
      active: 1,
      verifiedAt: 1,
      annotationSnapshot: { layers: [], annotations: [], cursor: 0, verifiedAt: 1 },
    });
    await localDatabase.annotationOutbox.put({
      opId: "pending-reconnect-op",
      ...localWorkspace,
      annotationId: "annotation-1",
      layerId: "11111111-1111-4111-8111-111111111111",
      baseVersion: 0,
      type: "upsert",
      payload: {
        kind: "text",
        pageNumber: 1,
        x: 0.1,
        y: 0.1, fontScale: 0.024,
        text: "待恢复后同步",
      },
      attemptedAt: null,
      createdAt: 1,
    });
    let connected = false;
    const fetchMock = vi.fn().mockImplementation((input: string | URL | Request) => {
      const url = String(input);
      if (!connected) return Promise.reject(new Error("offline"));
      if (url.endsWith("/scores")) {
        return Promise.resolve(
          Response.json({
            scores: [],
            storage: { usedBytes: 329, limitBytes: 1_073_741_824 },
            permissions: { canManage: false },
          }),
        );
      }
      if (url.endsWith("/scores/score-1/status")) {
        return Promise.resolve(Response.json({ state: "trashed" }));
      }
      return Promise.reject(new Error(`unexpected request: ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter initialEntries={["/choirs/choir-1/scores/score-1"]}>
        <Routes>
          <Route path="/choirs/:choirId/scores/:scoreId" element={<ReaderPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText("离线练声曲.pdf")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    connected = true;
    fireEvent(window, new Event("online"));

    expect(await screen.findByRole("alert")).toHaveTextContent("乐谱已移入回收站");
    expect(syncAnnotations).not.toHaveBeenCalled();
    expect(await localDatabase.annotationOutbox.count()).toBe(1);
  });
});
