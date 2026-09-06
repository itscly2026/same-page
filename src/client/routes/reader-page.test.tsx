import Dexie from "dexie";
import type { AnnotationLayerSummary } from "../../shared/annotations";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  createMemoryRouter,
  MemoryRouter,
  Route,
  RouterProvider,
  Routes,
} from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  activateVerifiedOfflineScore,
  localDatabase,
} from "../platform/local-database";
import {
  activateAuthenticatedLocalOwner,
  authenticatedLocalOwnerKey,
  createLocalWorkspace,
  localWorkspaceRecordKey,
} from "../platform/local-workspace";
import { loadPdfDocument } from "../reader/pdf-document";
import { clearReaderDocumentCache } from "../reader/reader-document-cache";
import {
  clearReaderScoreCache,
  rememberReaderScore,
} from "../reader/reader-score-cache";
import { findVerifiedOfflineScore } from "../offline/offline-score-verification";
import ReaderPage from "./reader-page";
import { clearDiagnostics, exportDiagnostics } from "../diagnostics/diagnostics";

// Navigation blocking is exercised with the production data router in
// reader-navigation-guard.test.tsx and the browser status flow.
vi.mock("../reader/reader-navigation-guard", () => ({ ReaderNavigationGuard: () => null }));

const readerAuthState = vi.hoisted(() => ({ signedIn: true, pending: false }));

const virtualTestState = vi.hoisted(() => ({
  itemSize: 100,
  scrollToIndex: vi.fn(),
}));

const localWorkspace = createLocalWorkspace(
  authenticatedLocalOwnerKey("user-1"),
  "choir-1",
  "score-1",
);

const scoreSummary = {
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
};

// API fixtures use the complete current layer model; each case overrides only
// the subscriptions, identities and permissions relevant to its interaction.
function completeReaderLayers(overrides: AnnotationLayerSummary[] = []): AnnotationLayerSummary[] {
  const shared = (["E", "S", "A", "T", "B"] as const).map((slot, index): AnnotationLayerSummary => ({
    id: `00000000-0000-4000-8000-00000000000${index}`,
    kind: "shared", sharedSlot: slot,
    name: ({ E: "Ensemble", S: "Soprano", A: "Alto", T: "Tenor", B: "Bass" })[slot],
    sortOrder: index, subscribed: true, subscriptionSource: "product",
    displayColor: "#a12652", colorSource: "product", adminDefaultColor: "#a12652",
    driveSubscribed: null, driveColorOverride: null, scoreSubscriptionOverride: null, canEdit: false,
  }));
  const personal: AnnotationLayerSummary = {
    id: "00000000-0000-4000-8000-000000000006", kind: "personal", sharedSlot: null,
    name: "Personal", sortOrder: 10000, subscribed: true, subscriptionSource: "personal",
    displayColor: "#6750a4", colorSource: "product", adminDefaultColor: "#6750a4",
    driveSubscribed: null, driveColorOverride: null, scoreSubscriptionOverride: null, canEdit: false,
  };
  return [...shared, personal].map((layer) => overrides.find((override) =>
    override.kind === layer.kind && override.sharedSlot === layer.sharedSlot,
  ) ?? layer);
}

function activeBootstrapResponse() {
  return Response.json({
    state: "active",
    score: scoreSummary,
    permissions: { canManage: false },
  });
}

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
    useSession: () => ({ data: readerAuthState.signedIn ? { user: { id: "user-1" } } : null, isPending: readerAuthState.pending }),
  },
}));

vi.mock("../reader/pdf-document", () => ({
  loadPdfDocument: vi.fn((_source, versionId) => ({
    promise: Promise.resolve({
      document: {
        numPages: 3,
        getPage: vi.fn().mockResolvedValue({
          getViewport: () => ({ width: 600, height: 800 }),
        }),
      },
      versionId: versionId ?? "version-1",
    }),
    destroy: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("../reader/pdf-page", async () => {
  const { useContext, useEffect, useLayoutEffect, useRef } = await import("react");
  const { DisplayRecovery } = await import("../reader/display-recovery");
  return {
    PdfPageCanvas: ({
      pageNumber,
      onRenderStart,
    }: {
      pageNumber: number;
      onRenderStart?(page: number): { ready(): void; cancel(): void };
    }) => {
      const recovery = useContext(DisplayRecovery);
      const recoveryRef = useRef(recovery);
      recoveryRef.current = recovery;
      const leaseRef = useRef<ReturnType<NonNullable<typeof onRenderStart>>>(null);
      useLayoutEffect(() => {
        const lease = onRenderStart?.(pageNumber);
        leaseRef.current = lease ?? null;
        return () => {
          if (leaseRef.current === lease) leaseRef.current = null;
          lease?.cancel();
        };
      }, [onRenderStart, pageNumber]);
      useEffect(() => { leaseRef.current?.ready(); recoveryRef.current?.ready(pageNumber); }, [onRenderStart, pageNumber]);
      return <div aria-label={`渲染第 ${pageNumber} 页`} />;
    },
  };
});

vi.mock("../platform/local-database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../platform/local-database")>();
  return {
    ...actual,
    activateVerifiedOfflineScore: vi.fn(),
  };
});

vi.mock("../offline/offline-score-verification", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../offline/offline-score-verification")>();
  return { ...actual, findVerifiedOfflineScore: vi.fn().mockResolvedValue(null) };
});

// These reader cases provide verified copies through the lookup boundary above.
// Reactive storage verification is exercised with its own real IndexedDB fixtures.
vi.mock("../offline/use-offline-score", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../offline/use-offline-score")>();
  return { ...actual, useOfflineScore: () => undefined };
});

vi.mock("../annotations/annotation-state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../annotations/annotation-state")>();
  return {
    ...actual,
    queueScoreDrafts: vi.fn().mockResolvedValue(0),
  };
});

describe("ReaderPage", () => {
it("can leave during authentication without starting a reader afterwards", async () => {
  readerAuthState.pending = true;

  render(<MemoryRouter initialEntries={["/choirs/choir-1/scores/score-1"]}><Routes><Route path="/choirs/:choirId/scores/:scoreId" element={<ReaderPage />} /><Route path="/choirs/:choirId" element={<h1>乐谱列表</h1>} /></Routes></MemoryRouter>);
  expect(screen.getByRole("status")).toHaveTextContent("正在打开乐谱");
  fireEvent.click(screen.getByRole("link", { name: "返回云盘" }));
  expect(await screen.findByRole("heading", { name: "乐谱列表" })).toBeVisible();
  readerAuthState.pending = false;
  await act(() => new Promise(resolve => setTimeout(resolve, 30)));
  expect(findVerifiedOfflineScore).not.toHaveBeenCalled();
});

it("lets a failed local storage open retry without losing the return link", async () => {
  vi.spyOn(localDatabase.system, "get").mockRejectedValueOnce(new DOMException("unavailable", "UnknownError"));
  render(<MemoryRouter initialEntries={["/choirs/choir-1/scores/score-1"]}><Routes><Route path="/choirs/:choirId/scores/:scoreId" element={<ReaderPage />} /></Routes></MemoryRouter>);
  expect(await screen.findByRole("alert")).toHaveTextContent("本机工作区暂时无法打开");
  expect(screen.getByRole("link", { name: "返回云盘" })).toBeVisible();
  const retry = screen.getByRole("button", { name: "重试打开工作区" });
  fireEvent.keyDown(retry, { key: "Enter", code: "Enter" });
  fireEvent.keyUp(retry, { key: "Enter", code: "Enter" });
  expect(await screen.findByLabelText("翻页阅读")).toBeInTheDocument();
});

it("keeps a single exit while the PDF never settles", async () => {
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
  vi.mocked(loadPdfDocument).mockReturnValue({ promise: new Promise(() => {}), destroy: vi.fn().mockResolvedValue(undefined) });
  render(<MemoryRouter initialEntries={["/choirs/choir-1/scores/score-1"]}><Routes><Route path="/choirs/:choirId/scores/:scoreId" element={<ReaderPage />} /><Route path="/choirs/:choirId" element={<h1>乐谱列表</h1>} /></Routes></MemoryRouter>);
  expect(screen.queryByRole("button", { name: "取消加载" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "图片兼容模式" })).not.toBeInTheDocument();
  fireEvent.click(await screen.findByRole("link", { name: "返回云盘" }));
  expect(await screen.findByRole("heading", { name: "乐谱列表" })).toBeVisible();
});


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

  const finishPageTurn = async () => {
    await waitFor(() =>
      expect(document.querySelector(".page-reader__pager-track")).toHaveAttribute(
        "data-page-turn-phase",
        "settling",
      ),
    );
    expect(vi.mocked(fetch).mock.calls.map(([input]) => String(input))).not.toContain(
      "/api/choirs/choir-1/scores",
    );
    const track = document.querySelector<HTMLElement>(".page-reader__pager-track");
    if (!track) throw new Error("page turn track unavailable");
    fireEvent.transitionEnd(track, { propertyName: "transform" });
  };

  const currentRenderedPage = () =>
    document
      .querySelector<HTMLElement>(".page-reader__sheet[data-page-turn-current]")
      ?.getAttribute("data-page-number");

  beforeEach(async () => {
    readerAuthState.signedIn = true;
    readerAuthState.pending = false;
    clearDiagnostics();
    clearReaderDocumentCache();
    clearReaderScoreCache();
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
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      media: "(prefers-reduced-motion: reduce)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: string) =>
        Promise.resolve(
          input.includes("/layers")
            ? Response.json({ layers: completeReaderLayers(), permissions: { canManageLayers: false } })
            : input.includes("/versions/")
            ? new Response(new Uint8Array([1, 2, 3]), {
                headers: { "content-type": "application/pdf" },
              })
            : input.includes("/annotations?") ? Response.json({ cursor: 0, objects: [] })
            : activeBootstrapResponse(),
        ),
      ),
    );
    vi.clearAllMocks();
    vi.mocked(loadPdfDocument).mockReset().mockImplementation((_source, versionId) =>
      ({
        promise: Promise.resolve({
          document: {
            numPages: 3,
            getPage: vi.fn().mockResolvedValue({
              getViewport: () => ({ width: 600, height: 800 }),
            }),
          },
          versionId: versionId ?? "version-1",
        }),
        destroy: vi.fn().mockResolvedValue(undefined),
      }) as never,
    );
  });

  it("reuses the library summary while the document and bootstrap are pending", async () => {
    rememberReaderScore("user-1", scoreSummary);
    vi.mocked(loadPdfDocument).mockReturnValueOnce({
      promise: new Promise(() => {}),
      destroy: vi.fn().mockResolvedValue(undefined),
    } as never);
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

    render(
      <MemoryRouter initialEntries={["/choirs/choir-1/scores/score-1"]}>
        <Routes>
          <Route path="/choirs/:choirId/scores/:scoreId" element={<ReaderPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText("练声曲.pdf")).toBeInTheDocument();
    expect(screen.getByLabelText("正在加载乐谱")).toBeInTheDocument();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("starts the confirmed cloud PDF when local verification stalls", async () => {
    vi.mocked(findVerifiedOfflineScore).mockReturnValueOnce(
      new Promise(() => {}) as never,
    );

    render(
      <MemoryRouter initialEntries={["/choirs/choir-1/scores/score-1"]}>
        <Routes>
          <Route path="/choirs/:choirId/scores/:scoreId" element={<ReaderPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(loadPdfDocument).toHaveBeenCalledWith(
        "/api/choirs/choir-1/scores/score-1/versions/version-1/pdf",
        "version-1",
      ),
    );
  });

  it("prefers a verified offline copy only when its immutable version matches", async () => {
    rememberReaderScore("user-1", scoreSummary);
    vi.mocked(findVerifiedOfflineScore).mockResolvedValueOnce({
      key: "offline-1",
      ...localWorkspace,
      versionId: "version-1",
      fileName: "练声曲.pdf",
      sha256: "a".repeat(64),
      pageCount: 3,
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: "application/pdf" }),
      active: 1,
      verifiedAt: 1,
      annotationSnapshot: { layers: [], annotations: [], cursor: 0, verifiedAt: 1 },
    });
    vi.mocked(loadPdfDocument).mockReturnValueOnce({
      promise: Promise.resolve({
        document: {
          numPages: 3,
          getPage: vi.fn().mockResolvedValue({
            getViewport: () => ({ width: 600, height: 800 }),
          }),
        },
        versionId: "version-1",
      }),
      destroy: vi.fn().mockResolvedValue(undefined),
    } as never);

    render(
      <MemoryRouter initialEntries={["/choirs/choir-1/scores/score-1"]}>
        <Routes>
          <Route path="/choirs/:choirId/scores/:scoreId" element={<ReaderPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByLabelText("翻页阅读");
    await waitFor(() => expect(loadPdfDocument).toHaveBeenCalledWith(
      expect.any(ArrayBuffer),
      "version-1",
    ));
  });

  it("keeps a ready matching offline document when bootstrap arrives later", async () => {
    rememberReaderScore("user-1", scoreSummary);
    vi.mocked(findVerifiedOfflineScore).mockResolvedValueOnce({
      key: "offline-delayed-bootstrap",
      ...localWorkspace,
      versionId: "version-1",
      fileName: "练声曲.pdf",
      sha256: "a".repeat(64),
      pageCount: 3,
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: "application/pdf" }),
      active: 1,
      verifiedAt: 1,
      annotationSnapshot: { layers: [], annotations: [], cursor: 0, verifiedAt: 1 },
    });
    let releaseBootstrap!: (response: Response) => void;
    const delayedBootstrap = new Promise<Response>((resolve) => {
      releaseBootstrap = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: string) =>
        input.endsWith("/bootstrap")
          ? delayedBootstrap
          : Promise.resolve(
              Response.json({ layers: completeReaderLayers(), permissions: { canManageLayers: false } }),
            ),
      ),
    );

    render(
      <MemoryRouter initialEntries={["/choirs/choir-1/scores/score-1"]}>
        <Routes>
          <Route path="/choirs/:choirId/scores/:scoreId" element={<ReaderPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByLabelText("翻页阅读");
    expect(loadPdfDocument).toHaveBeenCalledWith(expect.any(ArrayBuffer), "version-1");
    releaseBootstrap(activeBootstrapResponse());
    await waitFor(() =>
      expect(
        vi.mocked(fetch).mock.calls.some(([input]) =>
          String(input).endsWith("/scores/score-1/layers"),
        ),
      ).toBe(true),
    );
    expect(screen.queryByLabelText("正在加载乐谱")).not.toBeInTheDocument();
  });

  it("keeps the rendered document during same-version online revalidation", async () => {
    render(
      <MemoryRouter initialEntries={["/choirs/choir-1/scores/score-1"]}>
        <Routes>
          <Route path="/choirs/:choirId/scores/:scoreId" element={<ReaderPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByLabelText("翻页阅读");
    const loadCount = vi.mocked(loadPdfDocument).mock.calls.length;
    await waitFor(() =>
      expect(
        vi.mocked(fetch).mock.calls.some(([input]) =>
          String(input).endsWith("/scores/score-1/layers"),
        ),
      ).toBe(true),
    );
    let releaseRevalidation!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          releaseRevalidation = resolve;
        }),
    );
    fireEvent(window, new Event("online"));
    await waitFor(() => {
      const bootstrapCalls = vi.mocked(fetch).mock.calls.filter(([input]) =>
        String(input).endsWith("/scores/score-1/bootstrap"),
      );
      expect(bootstrapCalls).toHaveLength(2);
    });
    await act(async () => releaseRevalidation(activeBootstrapResponse()));
    expect(loadPdfDocument).toHaveBeenCalledTimes(loadCount);
    expect(screen.getByLabelText("翻页阅读")).toBeInTheDocument();
    expect(screen.queryByLabelText("正在加载乐谱")).not.toBeInTheDocument();
  });

  it("does not let an older bootstrap response roll back a newer version", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const versionTwoScore = {
      ...scoreSummary,
      fileName: "新版练声曲.pdf",
      updatedAt: 2,
      currentVersion: {
        ...scoreSummary.currentVersion,
        id: "version-2",
        versionNumber: 2,
        createdAt: 2,
      },
    };
    let releaseInitialBootstrap!: (response: Response) => void;
    let bootstrapCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: string) => {
        if (input.endsWith("/bootstrap")) {
          bootstrapCalls += 1;
          if (bootstrapCalls === 1) {
            return new Promise<Response>((resolve) => {
              releaseInitialBootstrap = resolve;
            });
          }
          return Promise.resolve(
            Response.json({
              state: "active",
              score: versionTwoScore,
              permissions: { canManage: false },
            }),
          );
        }
        return Promise.resolve(
          Response.json({ layers: completeReaderLayers(), permissions: { canManageLayers: false } }),
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

    await waitFor(() => expect(bootstrapCalls).toBe(1));
    await waitFor(() => expect(loadPdfDocument).toHaveBeenCalled());
    fireEvent(window, new Event("online"));
    await waitFor(() => expect(bootstrapCalls).toBe(2));
    await waitFor(() =>
      expect(loadPdfDocument).toHaveBeenCalledWith(
        "/api/choirs/choir-1/scores/score-1/versions/version-2/pdf",
        "version-2",
      ),
    );
    expect(document.body).toHaveTextContent("新版练声曲.pdf");

    await act(async () =>
      releaseInitialBootstrap(
        Response.json({
          state: "active",
          score: { ...scoreSummary, fileName: "旧版练声曲.pdf" },
          permissions: { canManage: false },
        }),
      ),
    );
    expect(document.body).toHaveTextContent("新版练声曲.pdf");
    expect(document.body).not.toHaveTextContent("旧版练声曲.pdf");
    expect(loadPdfDocument).not.toHaveBeenCalledWith(
      "/api/choirs/choir-1/scores/score-1/versions/version-1/pdf",
      "version-1",
    );
  });

  it("uses delayed matching offline data after revalidation on a direct link", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const versionTwoScore = {
      ...scoreSummary,
      fileName: "直达新版.pdf",
      updatedAt: 2,
      currentVersion: {
        ...scoreSummary.currentVersion,
        id: "version-2",
        versionNumber: 2,
        createdAt: 2,
      },
    };
    let releaseLocal!: (record: Awaited<ReturnType<typeof findVerifiedOfflineScore>>) => void;
    vi.mocked(findVerifiedOfflineScore).mockReturnValueOnce(
      new Promise((resolve) => {
        releaseLocal = resolve;
      }) as never,
    );
    let bootstrapCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: string) => {
        if (input.endsWith("/bootstrap")) {
          bootstrapCalls += 1;
          if (bootstrapCalls === 1) return new Promise<Response>(() => {});
          return Promise.resolve(
            Response.json({
              state: "active",
              score: versionTwoScore,
              permissions: { canManage: false },
            }),
          );
        }
        return Promise.resolve(
          Response.json({ layers: completeReaderLayers(), permissions: { canManageLayers: false } }),
        );
      }),
    );
    vi.mocked(loadPdfDocument).mockImplementation((source, versionId) => {
      if (source instanceof ArrayBuffer) {
        return {
          promise: Promise.resolve({
            document: {
              numPages: 3,
              getPage: vi.fn().mockResolvedValue({
                getViewport: () => ({ width: 600, height: 800 }),
              }),
            },
            versionId: versionId ?? "version-2",
          }),
          destroy: vi.fn().mockResolvedValue(undefined),
        } as never;
      }
      const failedCloud = Promise.reject(new Error("cloud PDF unavailable"));
      void failedCloud.catch(() => undefined);
      return {
        promise: failedCloud,
        destroy: vi.fn().mockResolvedValue(undefined),
      } as never;
    });

    render(
      <MemoryRouter initialEntries={["/choirs/choir-1/scores/score-1"]}>
        <Routes>
          <Route path="/choirs/:choirId/scores/:scoreId" element={<ReaderPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(bootstrapCalls).toBe(1));
    await waitFor(() => expect(loadPdfDocument).toHaveBeenCalled());
    fireEvent(window, new Event("online"));
    await waitFor(() => expect(bootstrapCalls).toBe(2));
    await waitFor(() => expect(document.body).toHaveTextContent("直达新版.pdf"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await act(async () =>
      releaseLocal({
        key: "direct-link-offline-v2",
        ...localWorkspace,
        versionId: "version-2",
        fileName: "直达新版.pdf",
        sha256: "a".repeat(64),
        pageCount: 3,
        blob: new Blob([new Uint8Array([1, 2, 3])], { type: "application/pdf" }),
        active: 1,
        verifiedAt: 2,
        annotationSnapshot: { layers: [], annotations: [], cursor: 0, verifiedAt: 2 },
      }),
    );

    await waitFor(() =>
      expect(loadPdfDocument).toHaveBeenCalledWith(expect.any(ArrayBuffer), "version-2"),
    );
    expect(await screen.findByLabelText("翻页阅读")).toBeInTheDocument();
  });

  it("replaces a ready cloud document with delayed offline data after permission denial", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    rememberReaderScore("user-1", scoreSummary);
    let releaseLocal!: (record: Awaited<ReturnType<typeof findVerifiedOfflineScore>>) => void;
    vi.mocked(findVerifiedOfflineScore).mockReturnValueOnce(
      new Promise((resolve) => {
        releaseLocal = resolve;
      }) as never,
    );
    let bootstrapCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: string) => {
        if (input.endsWith("/bootstrap")) {
          bootstrapCalls += 1;
          return bootstrapCalls === 1
            ? new Promise<Response>(() => {})
            : Promise.resolve(new Response(null, { status: 403 }));
        }
        return Promise.resolve(
          Response.json({ layers: completeReaderLayers(), permissions: { canManageLayers: false } }),
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

    await waitFor(() => expect(bootstrapCalls).toBe(1));
    await screen.findByLabelText("翻页阅读");
    fireEvent(window, new Event("online"));
    await waitFor(() => expect(bootstrapCalls).toBe(2));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await act(async () =>
      releaseLocal({
        key: "direct-link-offline-after-permission-denial",
        ...localWorkspace,
        versionId: "version-1",
        fileName: "回收站离线谱.pdf",
        sha256: "a".repeat(64),
        pageCount: 3,
        blob: new Blob([new Uint8Array([1, 2, 3])], { type: "application/pdf" }),
        active: 1,
        verifiedAt: 2,
        annotationSnapshot: { layers: [], annotations: [], cursor: 0, verifiedAt: 2 },
      }),
    );

    await waitFor(() =>
      expect(loadPdfDocument).toHaveBeenCalledWith(expect.any(ArrayBuffer), "version-1"),
    );
    expect(await screen.findByLabelText("翻页阅读")).toBeInTheDocument();
    expect(screen.getByText("回收站离线谱.pdf")).toBeInTheDocument();
  });

  it("switches a ready cloud document to settled offline data after trashing", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    rememberReaderScore("user-1", scoreSummary);
    let releaseLocal!: (record: Awaited<ReturnType<typeof findVerifiedOfflineScore>>) => void;
    vi.mocked(findVerifiedOfflineScore).mockReturnValueOnce(
      new Promise((resolve) => {
        releaseLocal = resolve;
      }) as never,
    );
    let bootstrapCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: string) => {
        if (input.endsWith("/bootstrap")) {
          bootstrapCalls += 1;
          return Promise.resolve(
            bootstrapCalls === 1
              ? activeBootstrapResponse()
              : Response.json({ state: "trashed" }),
          );
        }
        return Promise.resolve(
          Response.json({ layers: completeReaderLayers(), permissions: { canManageLayers: false } }),
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

    await screen.findByLabelText("翻页阅读");
    await act(async () =>
      releaseLocal({
        key: "settled-offline-before-trash",
        ...localWorkspace,
        versionId: "version-1",
        fileName: "回收站离线谱.pdf",
        sha256: "a".repeat(64),
        pageCount: 3,
        blob: new Blob([new Uint8Array([1, 2, 3])], { type: "application/pdf" }),
        active: 1,
        verifiedAt: 2,
        annotationSnapshot: { layers: [], annotations: [], cursor: 0, verifiedAt: 2 },
      }),
    );
    expect(
      vi.mocked(loadPdfDocument).mock.calls.some(([source]) => source instanceof ArrayBuffer),
    ).toBe(false);

    fireEvent(window, new Event("online"));
    await waitFor(() => expect(bootstrapCalls).toBe(2));
    await waitFor(() =>
      expect(loadPdfDocument).toHaveBeenCalledWith(expect.any(ArrayBuffer), "version-1"),
    );
    expect(await screen.findByLabelText("翻页阅读")).toBeInTheDocument();
    expect(screen.getByText("回收站离线谱.pdf")).toBeInTheDocument();
  });

  it("reacquires the same cloud version after a stale denial invalidates it", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    rememberReaderScore("user-1", scoreSummary);
    let releaseLocal!: (record: Awaited<ReturnType<typeof findVerifiedOfflineScore>>) => void;
    vi.mocked(findVerifiedOfflineScore).mockReturnValueOnce(
      new Promise((resolve) => {
        releaseLocal = resolve;
      }) as never,
    );
    let releaseOfflineData!: (data: ArrayBuffer) => void;
    const deferredBlob = new Blob([new Uint8Array([1, 2, 3])], {
      type: "application/pdf",
    });
    vi.spyOn(deferredBlob, "arrayBuffer").mockReturnValue(
      new Promise((resolve) => {
        releaseOfflineData = resolve;
      }),
    );
    let bootstrapCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: string) => {
        if (input.endsWith("/bootstrap")) {
          bootstrapCalls += 1;
          if (bootstrapCalls === 2) {
            return Promise.resolve(new Response(null, { status: 403 }));
          }
          return Promise.resolve(activeBootstrapResponse());
        }
        return Promise.resolve(
          Response.json({ layers: completeReaderLayers(), permissions: { canManageLayers: false } }),
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

    await screen.findByLabelText("翻页阅读");
    await act(async () =>
      releaseLocal({
        key: "settled-offline-before-stale-denial",
        ...localWorkspace,
        versionId: "version-1",
        fileName: "离线练声曲.pdf",
        sha256: "a".repeat(64),
        pageCount: 3,
        blob: deferredBlob,
        active: 1,
        verifiedAt: 2,
        annotationSnapshot: { layers: [], annotations: [], cursor: 0, verifiedAt: 2 },
      }),
    );
    fireEvent(window, new Event("online"));
    await waitFor(() => expect(deferredBlob.arrayBuffer).toHaveBeenCalled());

    fireEvent(window, new Event("online"));
    await waitFor(() => expect(bootstrapCalls).toBe(3));
    await waitFor(() => {
      const versionedCloudLoads = vi.mocked(loadPdfDocument).mock.calls.filter(
        ([source, versionId]) =>
          source ===
            "/api/choirs/choir-1/scores/score-1/versions/version-1/pdf" &&
          versionId === "version-1",
      );
      expect(versionedCloudLoads).toHaveLength(2);
    });

    await act(async () => releaseOfflineData(new Uint8Array([4, 5, 6]).buffer));
    expect(
      vi.mocked(loadPdfDocument).mock.calls.some(([source]) => source instanceof ArrayBuffer),
    ).toBe(false);
    expect(screen.getByLabelText("翻页阅读")).toBeInTheDocument();
  });

  it("clears a stale denial while a same-version reacquire is pending", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    rememberReaderScore("user-1", scoreSummary);
    let bootstrapCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: string) => {
        if (input.endsWith("/bootstrap")) {
          bootstrapCalls += 1;
          if (bootstrapCalls === 2) {
            return Promise.resolve(new Response(null, { status: 403 }));
          }
          return Promise.resolve(activeBootstrapResponse());
        }
        return Promise.resolve(
          Response.json({ layers: completeReaderLayers(), permissions: { canManageLayers: false } }),
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

    await screen.findByLabelText("翻页阅读");
    fireEvent(window, new Event("online"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "当前账号没有访问这份乐谱的权限",
    );
    expect(exportDiagnostics()).toContain('"category": "permission"');

    let rejectReacquire!: (error: Error) => void;
    const pendingReacquire = new Promise<never>((_resolve, reject) => {
      rejectReacquire = reject;
    });
    void pendingReacquire.catch(() => undefined);
    vi.mocked(loadPdfDocument).mockReturnValueOnce({
      promise: pendingReacquire,
      destroy: vi.fn().mockResolvedValue(undefined),
    } as never);
    fireEvent(window, new Event("online"));
    await waitFor(() => expect(bootstrapCalls).toBe(3));
    expect(await screen.findByLabelText("正在加载乐谱")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await act(async () => rejectReacquire(new Error("PDF parse failed")));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "PDF 无法解析或文件暂时不可用",
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent("当前账号没有访问");
  });

  it("ignores an old same-version failure while its replacement is pending", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    rememberReaderScore("user-1", scoreSummary);
    let rejectOldLoad!: (error: Error) => void;
    const oldLoad = new Promise<never>((_resolve, reject) => {
      rejectOldLoad = reject;
    });
    void oldLoad.catch(() => undefined);
    let resolveNewLoad!: (value: {
      document: { numPages: number; getPage: ReturnType<typeof vi.fn> };
      versionId: string;
    }) => void;
    const newLoad = new Promise((resolve) => {
      resolveNewLoad = resolve;
    });
    let pdfLoadCalls = 0;
    vi.mocked(loadPdfDocument).mockImplementation(() => {
      pdfLoadCalls += 1;
      return {
        promise: pdfLoadCalls === 1 ? oldLoad : newLoad,
        destroy: vi.fn().mockResolvedValue(undefined),
      } as never;
    });
    let bootstrapCalls = 0;
    let releaseActiveRevalidation!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: string) => {
        if (input.endsWith("/bootstrap")) {
          bootstrapCalls += 1;
          if (bootstrapCalls === 2) {
            return Promise.resolve(new Response(null, { status: 403 }));
          }
          if (bootstrapCalls === 3) {
            return new Promise<Response>((resolve) => {
              releaseActiveRevalidation = resolve;
            });
          }
          return Promise.resolve(activeBootstrapResponse());
        }
        return Promise.resolve(
          Response.json({ layers: completeReaderLayers(), permissions: { canManageLayers: false } }),
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

    await waitFor(() => expect(pdfLoadCalls).toBe(1));
    fireEvent(window, new Event("online"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "当前账号没有访问这份乐谱的权限",
    );
    fireEvent(window, new Event("online"));
    await waitFor(() => expect(bootstrapCalls).toBe(3));
    await act(async () => {
      releaseActiveRevalidation(activeBootstrapResponse());
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      rejectOldLoad(new Error("old task failed"));
      await Promise.resolve();
    });
    await waitFor(() => expect(pdfLoadCalls).toBe(2));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByLabelText("正在加载乐谱")).toBeInTheDocument();

    await act(async () =>
      resolveNewLoad({
        document: {
          numPages: 3,
          getPage: vi.fn().mockResolvedValue({
            getViewport: () => ({ width: 600, height: 800 }),
          }),
        },
        versionId: "version-1",
      }),
    );
    expect(await screen.findByLabelText("翻页阅读")).toBeInTheDocument();
  });

  it("does not forget an active version after a newer network failure", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const versionTwoScore = {
      ...scoreSummary,
      currentVersion: {
        ...scoreSummary.currentVersion,
        id: "version-2",
        versionNumber: 2,
        createdAt: 2,
      },
    };
    let releaseLocal!: (record: Awaited<ReturnType<typeof findVerifiedOfflineScore>>) => void;
    vi.mocked(findVerifiedOfflineScore).mockReturnValueOnce(
      new Promise((resolve) => {
        releaseLocal = resolve;
      }) as never,
    );
    let bootstrapCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: string) => {
        if (!input.endsWith("/bootstrap")) {
          return Promise.resolve(
            Response.json({ layers: completeReaderLayers(), permissions: { canManageLayers: false } }),
          );
        }
        bootstrapCalls += 1;
        if (bootstrapCalls === 1) return new Promise<Response>(() => {});
        if (bootstrapCalls === 2) {
          return Promise.resolve(
            Response.json({
              state: "active",
              score: versionTwoScore,
              permissions: { canManage: false },
            }),
          );
        }
        return Promise.reject(new TypeError("network unavailable"));
      }),
    );

    render(
      <MemoryRouter initialEntries={["/choirs/choir-1/scores/score-1"]}>
        <Routes>
          <Route path="/choirs/:choirId/scores/:scoreId" element={<ReaderPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(bootstrapCalls).toBe(1));
    await waitFor(() => expect(loadPdfDocument).toHaveBeenCalled());
    fireEvent(window, new Event("online"));
    await waitFor(() => expect(bootstrapCalls).toBe(2));
    await waitFor(() =>
      expect(loadPdfDocument).toHaveBeenCalledWith(
        "/api/choirs/choir-1/scores/score-1/versions/version-2/pdf",
        "version-2",
      ),
    );
    fireEvent(window, new Event("online"));
    await waitFor(() => expect(bootstrapCalls).toBe(3));

    await act(async () => {
      releaseLocal({
        key: "stale-offline-v1",
        ...localWorkspace,
        versionId: "version-1",
        fileName: "旧离线谱.pdf",
        sha256: "a".repeat(64),
        pageCount: 3,
        blob: new Blob([new Uint8Array([1, 2, 3])], { type: "application/pdf" }),
        active: 1,
        verifiedAt: 1,
        annotationSnapshot: { layers: [], annotations: [], cursor: 0, verifiedAt: 1 },
      });
      await Promise.resolve();
    });

    expect(
      vi.mocked(loadPdfDocument).mock.calls.some(([source]) => source instanceof ArrayBuffer),
    ).toBe(false);
  });

  it("keeps a remembered version constraint through a network failure", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const rememberedVersionTwo = {
      ...scoreSummary,
      currentVersion: {
        ...scoreSummary.currentVersion,
        id: "version-2",
        versionNumber: 2,
        createdAt: 2,
      },
    };
    rememberReaderScore("user-1", rememberedVersionTwo);
    let releaseLocal!: (record: Awaited<ReturnType<typeof findVerifiedOfflineScore>>) => void;
    vi.mocked(findVerifiedOfflineScore).mockReturnValueOnce(
      new Promise((resolve) => {
        releaseLocal = resolve;
      }) as never,
    );
    let bootstrapCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: string) => {
        if (!input.endsWith("/bootstrap")) {
          return Promise.resolve(
            Response.json({ layers: completeReaderLayers(), permissions: { canManageLayers: false } }),
          );
        }
        bootstrapCalls += 1;
        return bootstrapCalls === 1
          ? new Promise<Response>(() => {})
          : Promise.reject(new TypeError("network unavailable"));
      }),
    );

    render(
      <MemoryRouter initialEntries={["/choirs/choir-1/scores/score-1"]}>
        <Routes>
          <Route path="/choirs/:choirId/scores/:scoreId" element={<ReaderPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(bootstrapCalls).toBe(1));
    await screen.findByLabelText("翻页阅读");
    fireEvent(window, new Event("online"));
    await waitFor(() => expect(bootstrapCalls).toBe(2));
    await act(async () => {
      releaseLocal({
        key: "remembered-v2-stale-offline-v1",
        ...localWorkspace,
        versionId: "version-1",
        fileName: "旧离线谱.pdf",
        sha256: "a".repeat(64),
        pageCount: 3,
        blob: new Blob([new Uint8Array([1, 2, 3])], { type: "application/pdf" }),
        active: 1,
        verifiedAt: 1,
        annotationSnapshot: { layers: [], annotations: [], cursor: 0, verifiedAt: 1 },
      });
      await Promise.resolve();
    });

    expect(
      vi.mocked(loadPdfDocument).mock.calls.some(([source]) => source instanceof ArrayBuffer),
    ).toBe(false);
    expect(screen.getByLabelText("翻页阅读")).toBeInTheDocument();
  });

  it("keeps a remembered version constraint when initial bootstrap fails", async () => {
    const rememberedVersionTwo = {
      ...scoreSummary,
      currentVersion: {
        ...scoreSummary.currentVersion,
        id: "version-2",
        versionNumber: 2,
        createdAt: 2,
      },
    };
    rememberReaderScore("user-1", rememberedVersionTwo);
    let releaseLocal!: (record: Awaited<ReturnType<typeof findVerifiedOfflineScore>>) => void;
    vi.mocked(findVerifiedOfflineScore).mockReturnValueOnce(
      new Promise((resolve) => {
        releaseLocal = resolve;
      }) as never,
    );
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network unavailable")));

    render(
      <MemoryRouter initialEntries={["/choirs/choir-1/scores/score-1"]}>
        <Routes>
          <Route path="/choirs/:choirId/scores/:scoreId" element={<ReaderPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByLabelText("翻页阅读");
    await act(async () =>
      releaseLocal({
        key: "initial-network-stale-offline-v1",
        ...localWorkspace,
        versionId: "version-1",
        fileName: "旧离线谱.pdf",
        sha256: "a".repeat(64),
        pageCount: 3,
        blob: new Blob([new Uint8Array([1, 2, 3])], { type: "application/pdf" }),
        active: 1,
        verifiedAt: 1,
        annotationSnapshot: { layers: [], annotations: [], cursor: 0, verifiedAt: 1 },
      }),
    );

    await waitFor(() => expect(findVerifiedOfflineScore).toHaveBeenCalled());
    expect(
      vi.mocked(loadPdfDocument).mock.calls.some(([source]) => source instanceof ArrayBuffer),
    ).toBe(false);
    expect(screen.getByLabelText("翻页阅读")).toBeInTheDocument();
  });

  it("does not substitute an offline copy from a different version", async () => {
    rememberReaderScore("user-1", scoreSummary);
    vi.mocked(findVerifiedOfflineScore).mockResolvedValueOnce({
      key: "offline-old",
      ...localWorkspace,
      versionId: "version-old",
      fileName: "旧版.pdf",
      sha256: "b".repeat(64),
      pageCount: 3,
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: "application/pdf" }),
      active: 1,
      verifiedAt: 1,
      annotationSnapshot: { layers: [], annotations: [], cursor: 0, verifiedAt: 1 },
    });
    vi.mocked(loadPdfDocument).mockReturnValueOnce({
      promise: new Promise(() => {}),
      destroy: vi.fn().mockResolvedValue(undefined),
    } as never);

    render(
      <MemoryRouter initialEntries={["/choirs/choir-1/scores/score-1"]}>
        <Routes>
          <Route path="/choirs/:choirId/scores/:scoreId" element={<ReaderPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(findVerifiedOfflineScore).toHaveBeenCalled());
    await waitFor(() =>
      expect(vi.mocked(fetch)).toHaveBeenCalledWith(
        "/api/choirs/choir-1/scores/score-1/bootstrap", expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    expect(loadPdfDocument).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("正在加载乐谱")).toBeInTheDocument();
  });

  it("does not apply an old route's deferred offline blob", async () => {
    rememberReaderScore("user-1", scoreSummary);
    let releaseBlob!: (value: ArrayBuffer) => void;
    const deferredBlob = new Blob([new Uint8Array([1])], { type: "application/pdf" });
    vi.spyOn(deferredBlob, "arrayBuffer").mockReturnValue(
      new Promise((resolve) => {
        releaseBlob = resolve;
      }),
    );
    vi.mocked(findVerifiedOfflineScore)
      .mockResolvedValueOnce({
        key: "old-route-offline",
        ...localWorkspace,
        versionId: "version-1",
        fileName: "旧路由.pdf",
        sha256: "a".repeat(64),
        pageCount: 3,
        blob: deferredBlob,
        active: 1,
        verifiedAt: 1,
        annotationSnapshot: { layers: [], annotations: [], cursor: 0, verifiedAt: 1 },
      })
      .mockResolvedValueOnce(null);
    const router = createMemoryRouter(
      [
        {
          path: "/choirs/:choirId/scores/:scoreId",
          element: <ReaderPage />,
        },
      ],
      { initialEntries: ["/choirs/choir-1/scores/score-1"] },
    );
    render(<RouterProvider router={router} />);
    await waitFor(() => expect(deferredBlob.arrayBuffer).toHaveBeenCalled());

    await act(() => router.navigate("/choirs/choir-1/scores/score-2"));
    const staleData = new Uint8Array([9, 9, 9]).buffer;
    releaseBlob(staleData);
    await waitFor(() =>
      expect(vi.mocked(fetch)).toHaveBeenCalledWith(
        "/api/choirs/choir-1/scores/score-2/bootstrap", expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );

    expect(
      vi.mocked(loadPdfDocument).mock.calls.some(([source]) => source === staleData),
    ).toBe(false);
  });

  it("reports a corrupt offline fallback instead of loading forever", async () => {
    vi.mocked(findVerifiedOfflineScore).mockResolvedValueOnce({
      key: "corrupt-offline",
      ...localWorkspace,
      versionId: "version-1",
      fileName: "损坏的离线副本.pdf",
      sha256: "a".repeat(64),
      pageCount: 3,
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: "application/pdf" }),
      active: 1,
      verifiedAt: 1,
      annotationSnapshot: { layers: [], annotations: [], cursor: 0, verifiedAt: 1 },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ state: "trashed" })),
    );
    const corruptPdf = Promise.reject(new Error("corrupt offline PDF"));
    void corruptPdf.catch(() => undefined);
    vi.mocked(loadPdfDocument).mockReturnValue({
      promise: corruptPdf,
      destroy: vi.fn().mockResolvedValue(undefined),
    } as never);

    render(
      <MemoryRouter initialEntries={["/choirs/choir-1/scores/score-1"]}>
        <Routes>
          <Route path="/choirs/:choirId/scores/:scoreId" element={<ReaderPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "本机离线副本无法解析，现有批注仍然保留",
    );
  });

  it("stops after a persistent mismatch from the same versioned source", async () => {
    rememberReaderScore("user-1", scoreSummary);
    vi.mocked(loadPdfDocument).mockImplementation(() => ({
      promise: Promise.resolve({
        document: {
          numPages: 3,
          getPage: vi.fn().mockResolvedValue({
            getViewport: () => ({ width: 600, height: 800 }),
          }),
        },
        versionId: "unexpected-version",
      }),
      destroy: vi.fn().mockResolvedValue(undefined),
    }) as never);

    render(
      <MemoryRouter initialEntries={["/choirs/choir-1/scores/score-1"]}>
        <Routes>
          <Route path="/choirs/:choirId/scores/:scoreId" element={<ReaderPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "PDF 无法解析或文件暂时不可用",
    );
    expect(loadPdfDocument).toHaveBeenCalledTimes(1);
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
          Response.json({ layers: completeReaderLayers(), permissions: { canManageLayers: false } }),
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

    expect(await screen.findByText("正在打开乐谱…")).toBeInTheDocument();
    await waitFor(() =>
      expect(loadPdfDocument).toHaveBeenCalledWith(
        "/api/choirs/choir-1/scores/score-1/pdf",
        undefined,
      ),
    );
    expect(screen.queryByRole("heading", { name: "无法打开" })).not.toBeInTheDocument();
    releaseLookup(activeBootstrapResponse());
    expect(await screen.findByText("练声曲.pdf")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByLabelText("翻页阅读")).toBeInTheDocument();
    });
  });

  it("distinguishes permission, network, and PDF parsing failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 403 })));
    const permissionView = render(
      <MemoryRouter initialEntries={["/choirs/choir-1/scores/score-1"]}>
        <Routes>
          <Route path="/choirs/:choirId/scores/:scoreId" element={<ReaderPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "当前账号没有访问这份乐谱的权限",
    );
    permissionView.unmount();

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    const networkView = render(
      <MemoryRouter initialEntries={["/choirs/choir-1/scores/score-1"]}>
        <Routes>
          <Route path="/choirs/:choirId/scores/:scoreId" element={<ReaderPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("网络暂时不可用");
    expect(exportDiagnostics()).toContain('"category": "network"');
    networkView.unmount();

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: string) =>
        Promise.resolve(
          input.endsWith("/scores/score-1/bootstrap")
            ? Response.json({ error: "not_found" }, { status: 404 })
            : Response.json({ layers: completeReaderLayers(), permissions: { canManageLayers: false } }),
        ),
      ),
    );
    const missingView = render(
      <MemoryRouter initialEntries={["/choirs/choir-1/scores/score-1"]}>
        <Routes>
          <Route path="/choirs/:choirId/scores/:scoreId" element={<ReaderPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "这份乐谱不存在或已经被永久移除",
    );
    missingView.unmount();

    clearReaderDocumentCache();

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: string) =>
        Promise.resolve(
          input.includes("/layers")
            ? Response.json({ layers: completeReaderLayers(), permissions: { canManageLayers: false } })
            : input.includes("/annotations?") ? Response.json({ cursor: 0, objects: [] })
            : activeBootstrapResponse(),
        ),
      ),
    );
    const invalidPdf = Promise.reject(new Error("invalid pdf"));
    void invalidPdf.catch(() => undefined);
    vi.mocked(loadPdfDocument).mockReturnValueOnce({
      promise: invalidPdf,
      destroy: vi.fn().mockResolvedValue(undefined),
    } as never);
    const parsingView = render(
      <MemoryRouter initialEntries={["/choirs/choir-1/scores/score-1"]}>
        <Routes>
          <Route path="/choirs/:choirId/scores/:scoreId" element={<ReaderPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "PDF 无法解析或文件暂时不可用",
    );
    parsingView.unmount();
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

    await screen.findByLabelText("翻页阅读");
    expect(screen.getByText("练声曲.pdf")).toBeInTheDocument();
    expect(screen.queryByLabelText("阅读器控制")).not.toBeInTheDocument();
    expect(
      within(screen.getByLabelText("翻页阅读")).getByLabelText("渲染第 1 页"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await finishPageTurn();
    expect(currentRenderedPage()).toBe("2");

    toggleChrome();
    expect(screen.queryByLabelText("页面缩略图")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "页面位置" }));
    const pageStrip = screen.getByLabelText("页面缩略图");
    expect(screen.getByRole("button", { name: "前往第 2 页" })).toHaveAttribute(
      "data-current",
    );
    expect(within(pageStrip).getByText("2 / 3")).toBeInTheDocument();
    expect(virtualTestState.scrollToIndex).toHaveBeenCalledWith(1, {
      align: "auto",
    });
    fireEvent.click(screen.getByRole("button", { name: "前往第 3 页" }));
    await finishPageTurn();
    expect(currentRenderedPage()).toBe("3");
    expect(screen.queryByLabelText("页面缩略图")).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    await finishPageTurn();
    expect(currentRenderedPage()).toBe("2");
    fireEvent.keyDown(window, { key: "ArrowRight" });
    await finishPageTurn();
    expect(currentRenderedPage()).toBe("3");
    fireEvent.click(screen.getByRole("button", { name: "看哪些批注" }));
    expect(screen.getByRole("dialog", { name: "看哪些批注" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭批注显示" }));
    fireEvent.click(screen.getByRole("button", { name: "更多" }));
    expect(screen.queryByText("尚未同步批注")).not.toBeInTheDocument();
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

  it("keeps editing discoverable and retries when layer preparation fails", async () => {
    let layerAttempts = 0;
    vi.mocked(fetch).mockImplementation((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/layers")) {
        layerAttempts += 1;
        if (layerAttempts === 1) {
          return Promise.resolve(new Response("unavailable", { status: 503 }));
        }
        return Promise.resolve(Response.json({
          layers: completeReaderLayers([
            {
              id: "11111111-1111-4111-8111-111111111111",
              kind: "personal",
              sharedSlot: null,
              name: "Personal",
              sortOrder: 10_000,
              subscribed: true,
              subscriptionSource: "personal",
              displayColor: "#b4235a",
              colorSource: "product",
              adminDefaultColor: "#b4235a",
              driveSubscribed: null,
              driveColorOverride: null,
              scoreSubscriptionOverride: null,
              canEdit: true,
            },
          ]),
          permissions: { canManageLayers: false },
        }));
      }
      return Promise.resolve(activeBootstrapResponse());
    });

    render(
      <MemoryRouter initialEntries={["/choirs/choir-1/scores/score-1"]}>
        <Routes>
          <Route path="/choirs/:choirId/scores/:scoreId" element={<ReaderPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByLabelText("翻页阅读");
    toggleChrome();
    const editButton = await screen.findByRole("button", { name: /^(编辑|完成编辑)$/ });
    await waitFor(() => expect(editButton).toHaveAttribute("data-state", "failed"));
    expect(exportDiagnostics()).toContain('"operation": "layers"');
    expect(screen.getByText("编辑准备失败，点按铅笔重试")).toHaveAttribute(
      "role",
      "status",
    );
    expect(
      Array.from(
        document.querySelectorAll<HTMLButtonElement>(".reader-chrome__actions button"),
        (button) => button.getAttribute("aria-label"),
      ),
    ).toEqual(["编辑", "看哪些批注", "更多"]);

    fireEvent.click(editButton);
    await waitFor(() => {
      expect(editButton).toHaveAttribute("data-state", "ready");
    });
    expect(layerAttempts).toBe(2);

    fireEvent.click(editButton);
    expect(editButton).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText(/编辑模式/)).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "文本" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("distinguishes layer preparation from a confirmed read-only score", async () => {
    let resolveLayers!: (response: Response) => void;
    const layerResponse = new Promise<Response>((resolve) => {
      resolveLayers = resolve;
    });
    vi.mocked(fetch).mockImplementation((input: string | URL | Request) =>
      String(input).includes("/layers")
        ? layerResponse
        : Promise.resolve(activeBootstrapResponse()),
    );

    render(
      <MemoryRouter initialEntries={["/choirs/choir-1/scores/score-1"]}>
        <Routes>
          <Route path="/choirs/:choirId/scores/:scoreId" element={<ReaderPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByLabelText("翻页阅读");
    toggleChrome();
    expect(screen.getByRole("button", { name: /^(编辑|完成编辑)$/ })).toHaveAttribute(
      "data-state",
      "preparing",
    );
    expect(screen.getByText("正在准备编辑…")).toHaveAttribute("role", "status");
    expect(screen.getByRole("button", { name: /^(编辑|完成编辑)$/ })).toBeDisabled();

    await act(async () => {
      resolveLayers(Response.json({
        layers: completeReaderLayers([]),
        permissions: { canManageLayers: false },
      }));
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^(编辑|完成编辑)$/ })).toHaveAttribute(
        "data-state",
        "read-only",
      );
    });
    expect(screen.getByRole("button", { name: /^(编辑|完成编辑)$/ })).toBeDisabled();
    expect(screen.getByText("此乐谱为只读状态")).toHaveAttribute("role", "status");
  });

  it("keeps the score layer panel focused on read subscriptions and effective colors", async () => {
    vi.mocked(fetch).mockImplementation((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/layers")) {
        return Promise.resolve(Response.json({
          layers: completeReaderLayers([
            ...(["E", "S", "A", "T", "B"] as const).map((slot, index): AnnotationLayerSummary => ({
              id: `00000000-0000-4000-8000-00000000000${index}`,
              kind: "shared" as const,
              sharedSlot: slot,
              name: ({ E: "Ensemble", S: "Soprano", A: "Alto", T: "Tenor", B: "Bass" })[slot],
              sortOrder: index,
              subscribed: slot === "E" || slot === "B",
              subscriptionSource: slot === "B" ? "score" : "drive",
              displayColor: index === 0 ? "#a12652" : "#3157a4",
              colorSource: "drive",
              adminDefaultColor: "#a12652",
              driveSubscribed: slot === "E",
              driveColorOverride: index === 0 ? "#a12652" : null,
              scoreSubscriptionOverride: slot === "B" ? true : null,
              canEdit: slot === "E",
            })),
            {
              id: "11111111-1111-4111-8111-111111111111",
              kind: "personal",
              sharedSlot: null,
              name: "Personal",
              sortOrder: 10000,
              subscribed: true,
              subscriptionSource: "product",
              displayColor: "#b4235a",
              colorSource: "product",
              adminDefaultColor: "#b4235a",
              driveSubscribed: null,
              driveColorOverride: null,
              scoreSubscriptionOverride: null,
              canEdit: true,
            },
          ]),
          permissions: { canManageLayers: true },
        }));
      }
      return Promise.resolve(activeBootstrapResponse());
    });
    render(
      <MemoryRouter initialEntries={["/choirs/choir-1/scores/score-1"]}>
        <Routes>
          <Route path="/choirs/:choirId/scores/:scoreId" element={<ReaderPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByLabelText("翻页阅读");
    toggleChrome();
    fireEvent.click(screen.getByRole("button", { name: "看哪些批注" }));
    const panel = screen.getByRole("dialog", { name: "看哪些批注" });

    await within(panel).findByText("全体");
    expect(panel).toHaveTextContent("E·全体");
    expect(panel).toHaveTextContent("P·我的笔记");
    expect(within(panel).getAllByRole("checkbox")).toHaveLength(5);
    expect(within(panel).getByText("我的笔记")).toBeInTheDocument();
    expect(within(panel).getByText("本谱")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "使用云盘默认" })).toBeInTheDocument();
    expect(within(panel).getByText(/始终显示/)).toBeInTheDocument();
    expect(within(panel).queryByText("Preferences")).not.toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: /只读/ })).not.toBeInTheDocument();
    expect(panel.querySelector('input[type="color"]')).toBeNull();
  });

  it("identifies a persisted object conflict by page, layer and summary", async () => {
    await localDatabase.annotationConflicts.put({
      opId: "conflict-op",
      ...localWorkspace,
      annotationId: "annotation-1",
      layerId: "11111111-1111-4111-8111-111111111111",
      localPayload: {
        kind: "text",
        pageNumber: 2,
        x: 0.2,
        y: 0.3,
        fontScale: 0.024,
        text: "第二页力度轻一些",
      },
      localDeleted: false,
      canonical: null,
      createdAt: 1,
    });
    vi.mocked(fetch).mockImplementation((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/layers")) {
        return Promise.resolve(
          Response.json({
            layers: completeReaderLayers([
              {
                id: "11111111-1111-4111-8111-111111111111",
                kind: "shared",
                sharedSlot: "E",
                name: "Ensemble",
                sortOrder: 0,
                subscribed: true,
                subscriptionSource: "product",
                displayColor: "#a12652",
                colorSource: "product",
                adminDefaultColor: "#a12652",
                driveSubscribed: null,
                driveColorOverride: null,
                scoreSubscriptionOverride: null,
                canEdit: false,
              },
            ]),
            permissions: { canManageLayers: false },
          }),
        );
      }
      return Promise.resolve(activeBootstrapResponse());
    });

    const view = render(
      <MemoryRouter initialEntries={["/choirs/choir-1/scores/score-1"]}>
        <Routes>
          <Route path="/choirs/:choirId/scores/:scoreId" element={<ReaderPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(
      await screen.findByText("仍有 1 项本机冲突待处理"),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("第 2 页 · 全体 · 第二页力度轻一些"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "前往第 2 页" }));
    expect(
      within(screen.getByLabelText("翻页阅读")).getByLabelText("渲染第 2 页"),
    ).toBeInTheDocument();

    view.unmount();
    render(
      <MemoryRouter initialEntries={["/choirs/choir-1/scores/score-1"]}>
        <Routes>
          <Route path="/choirs/:choirId/scores/:scoreId" element={<ReaderPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(
      await screen.findByText("仍有 1 项本机冲突待处理"),
    ).toBeInTheDocument();
    await screen.findByLabelText("翻页阅读");
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
    await screen.findByLabelText("翻页阅读");
    openMoreMenu();
    expect(
      await screen.findByText("离线下载未完成，尚未确认本机副本，请重试校验。"),
    ).toBeInTheDocument();
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
    await screen.findByLabelText("翻页阅读");
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
    await finishPageTurn();
    expect(currentRenderedPage()).toBe("2");

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
    await finishPageTurn();
    expect(currentRenderedPage()).toBe("1");

    fireEvent.pointerDown(viewport, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 250,
      clientY: 100,
    });
    fireEvent.pointerMove(viewport, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 150,
      clientY: 100,
    });
    const track = document.querySelector<HTMLElement>(".page-reader__pager-track");
    expect(track).toHaveAttribute("data-page-turn-phase", "dragging");
    expect(document.querySelectorAll(".page-reader__sheet")).toHaveLength(2);
    expect(document.querySelector(".page-reader__gutter")).not.toBeNull();
    for (const page of [1, 2]) {
      const sheet = document.querySelector<HTMLElement>(
        `.page-reader__sheet[data-page-number="${page}"]`,
      );
      expect(sheet?.querySelector(`[aria-label="渲染第 ${page} 页"]`)).not.toBeNull();
      expect(sheet?.querySelector(`[aria-label="第 ${page} 页批注层"]`)).not.toBeNull();
    }
    fireEvent.pointerUp(viewport, {
      pointerId: 1,
      pointerType: "touch",
      clientX: 150,
      clientY: 100,
    });
    await finishPageTurn();
    expect(currentRenderedPage()).toBe("2");

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
    fireEvent.pointerMove(viewport, {
      pointerId: 4,
      pointerType: "touch",
      clientX: 150,
      clientY: 100,
    });
    fireEvent.pointerUp(viewport, {
      pointerId: 4,
      pointerType: "touch",
      clientX: 150,
      clientY: 100,
    });
    expect(currentRenderedPage()).toBe("2");
    expect(track).toHaveAttribute("data-page-turn-phase", "disabled");

    toggleChrome();
    fireEvent.click(screen.getByRole("button", { name: "更多" }));
    expect(screen.getByText("200%")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "更多" }));
    fireEvent.click(screen.getByRole("button", { name: "上一页" }));
    await finishPageTurn();
    expect(currentRenderedPage()).toBe("1");
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
    expect(viewport).toHaveAttribute("data-zoom", "2");
    expect(currentRenderedPage()).toBe("1");
  });

  it("keeps page input read-only until edit is explicit and defaults editing to text", async () => {
    vi.mocked(fetch).mockImplementation((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/layers")) {
        return Promise.resolve(
          Response.json({
            layers: completeReaderLayers([
              ...(["E", "S", "A", "T", "B"] as const).map((slot, index): AnnotationLayerSummary => ({
                id: `00000000-0000-4000-8000-00000000000${index}`,
                kind: "shared" as const,
                sharedSlot: slot,
                name: ({ E: "Ensemble", S: "Soprano", A: "Alto", T: "Tenor", B: "Bass" })[slot],
                sortOrder: index,
                subscribed: slot === "B",
                subscriptionSource: "product",
                displayColor: "#a12652",
                colorSource: "product",
                adminDefaultColor: "#a12652",
                driveSubscribed: null,
                driveColorOverride: null,
                scoreSubscriptionOverride: null,
                canEdit: slot === "E",
              })),
              {
                id: "11111111-1111-4111-8111-111111111111",
                kind: "personal",
                sharedSlot: null,
                name: "Personal",
                sortOrder: 10000,
                subscribed: true,
                subscriptionSource: "product",
                displayColor: "#b4235a",
                colorSource: "product",
                adminDefaultColor: "#b4235a",
                driveSubscribed: null,
                driveColorOverride: null,
                scoreSubscriptionOverride: null,
                canEdit: true,
              },
            ]),
            permissions: { canManageLayers: false },
          }),
        );
      }
      return Promise.resolve(activeBootstrapResponse());
    });
    render(
      <MemoryRouter initialEntries={["/choirs/choir-1/scores/score-1"]}>
        <Routes>
          <Route path="/choirs/:choirId/scores/:scoreId" element={<ReaderPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText("练声曲.pdf");
    await screen.findByLabelText("翻页阅读");
    const overlay = await screen.findByLabelText("第 1 页批注层");
    fireEvent.pointerDown(overlay, { clientX: 20, clientY: 20 });
    fireEvent.pointerUp(overlay, { clientX: 20, clientY: 20 });
    expect(screen.queryByLabelText("批注文本")).not.toBeInTheDocument();

    if (!screen.queryByLabelText("阅读器控制")) toggleChrome();
    expect(screen.getByText("练声曲", { selector: ".reader-chrome__title" })).toBeInTheDocument();
    expect(
      screen.queryByText("练声曲.pdf", { selector: ".reader-chrome__title" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "更多" }));
    fireEvent.click(screen.getByRole("button", { name: "连续滚动" }));
    fireEvent.click(screen.getByRole("button", { name: "更多" }));
    for (let count = 0; count < 4; count += 1) {
      fireEvent.click(screen.getByRole("button", { name: "放大" }));
    }
    expect(screen.getByText("200%")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "更多" }));
    const continuousReader = screen.getByLabelText("连续滚动阅读");
    const continuousContent = continuousReader.querySelector<HTMLElement>(
      ".continuous-reader__inner",
    );
    expect(Number.parseFloat(continuousContent?.style.width ?? "0")).toBeGreaterThan(
      continuousReader.clientWidth,
    );
    fireEvent.pointerDown(continuousReader, {
      pointerId: 1,
      clientX: 700,
      clientY: 400,
    });
    fireEvent.pointerMove(continuousReader, {
      pointerId: 1,
      clientX: 300,
      clientY: 400,
    });
    expect(continuousReader.scrollLeft).toBe(400);
    fireEvent.pointerUp(continuousReader, {
      pointerId: 1,
      clientX: 300,
      clientY: 400,
    });
    fireEvent.pointerDown(continuousReader, {
      pointerId: 2,
      clientX: 300,
      clientY: 400,
    });
    fireEvent.pointerMove(continuousReader, {
      pointerId: 2,
      clientX: 700,
      clientY: 400,
    });
    expect(continuousReader.scrollLeft).toBe(0);
    fireEvent.pointerUp(continuousReader, {
      pointerId: 2,
      clientX: 700,
      clientY: 400,
    });
    continuousReader.scrollTop = 40;
    fireEvent.scroll(continuousReader);
    const editButton = await screen.findByRole("button", { name: /^(编辑|完成编辑)$/ });
    await waitFor(() => expect(editButton).toHaveAttribute("data-state", "ready"));
    fireEvent.click(editButton);
    expect(editButton).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText(/编辑模式/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("阅读器控制")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "页面位置" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "看哪些批注" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "更多" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "更多" }));
    expect(screen.queryByRole("button", { name: "连续滚动" })).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("region", { name: "阅读帮助" })).getByRole("button", { name: "故障诊断" }));
    const report = screen.getByLabelText<HTMLTextAreaElement>("可发送给支持人员的诊断内容");
    expect(JSON.parse(report.value).reader.interactionMode).toBe("editing");
    fireEvent.click(within(screen.getByRole("dialog", { name: "故障诊断" })).getByRole("button", { name: "关闭" }));
    expect(editButton).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("dialog", { name: "更多阅读选项" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("当前页编辑")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "下一页" })).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByRole("button", { name: "页面位置" })).toHaveTextContent("1 / 3");
    expect(await screen.findByRole("button", { name: "文本" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: /当前编辑层/ }));
    expect(screen.getByRole("button", { name: "P，我的笔记" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      Array.from(
        screen
          .getByRole("dialog", { name: "写到哪里" })
          .querySelectorAll<HTMLButtonElement>(".annotation-layer-slot"),
        (button) => button.getAttribute("aria-label"),
      ),
    ).toEqual(["E，全体", "S，女高音，只读，查看权限说明", "A，女低音，只读，查看权限说明", "T，男高音，只读，查看权限说明", "B，男低音，只读，查看权限说明", "P，我的笔记"]);
    expect(
      screen.getByRole("button", { name: "S，女高音，只读，查看权限说明" }),
    ).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "S，女高音，只读，查看权限说明" }));
    expect(screen.getByRole("dialog", { name: "仅可查看" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "知道了" }));
    fireEvent.click(screen.getByRole("button", { name: "E，全体" }));
    expect(screen.getByRole("button", { name: /当前编辑层：E · 全体/ })).toBeInTheDocument();
    expect(
      await localDatabase.annotationLayers.get(
        localWorkspaceRecordKey(
          localWorkspace,
          "00000000-0000-4000-8000-000000000000",
        ),
      ),
    ).toMatchObject({
      subscribed: false,
      scoreSubscriptionOverride: null,
    });
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
    fireEvent.pointerUp(editingOverlay, { clientX: 20, clientY: 30 });
    expect(screen.getByLabelText("批注文本")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "完成" })).toHaveLength(1);
    fireEvent.click(
      within(screen.getByRole("form", { name: "文字输入" })).getByRole(
        "button",
        { name: "取消" },
      ),
    );

    // A slow/failed ink write must retain the selected target from #141,
    // while #142 prevents changing layers, tools or history before persistence.
    fireEvent.click(screen.getByRole("button", { name: "画笔" }));
    const inkOverlay = screen.getByLabelText("第 1 页批注层");
    vi.spyOn(inkOverlay, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 100, width: 100, height: 100, toJSON: () => ({}) });
    let rejectWrite!: (reason: Error) => void;
    const write = vi.spyOn(localDatabase.annotations, "put").mockImplementation(() => new Dexie.Promise((_resolve, reject) => { rejectWrite = reject; }));
    fireEvent.pointerDown(inkOverlay, { pointerId: 21, clientX: 20, clientY: 30 });
    fireEvent.pointerMove(inkOverlay, { pointerId: 21, clientX: 40, clientY: 50 });
    fireEvent.pointerUp(inkOverlay, { pointerId: 21, clientX: 40, clientY: 50 });
    await waitFor(() => expect(write).toHaveBeenCalled());
    const target = screen.getByRole("button", { name: /当前编辑层：E · 全体/ });
    expect(target).toBeVisible();
    expect(target).toBeDisabled();
    for (const name of ["文本", "画笔", "整条橡皮", "撤销", "重做"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
    rejectWrite(new DOMException("full", "QuotaExceededError"));
    await screen.findByRole("button", { name: "重试本机保存" });
    expect(target).toBeVisible();
    expect(target).toBeDisabled();
    write.mockRestore();
    fireEvent.click(screen.getByRole("button", { name: "重试本机保存" }));
    await waitFor(() => expect(target).toBeEnabled());

    fireEvent.pointerDown(inkOverlay, { pointerId: 22, clientX: 50, clientY: 60 });
    fireEvent.pointerMove(inkOverlay, { pointerId: 22, clientX: 70, clientY: 80 });
    fireEvent.pointerUp(inkOverlay, { pointerId: 22, clientX: 70, clientY: 80 });
    await waitFor(() => expect(target).toBeEnabled());

    // History writes participate in the same local-save completion condition.
    const undoWrite = vi.spyOn(localDatabase.annotations, "delete").mockImplementation(() => new Dexie.Promise((_resolve, reject) => { rejectWrite = reject; }));
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    await waitFor(() => expect(undoWrite).toHaveBeenCalled());
    expect(editButton).toBeDisabled();
    expect(target).toBeDisabled();
    expect(screen.getByRole("button", { name: "重做" })).toBeDisabled();
    rejectWrite(new DOMException("full", "QuotaExceededError"));
    await screen.findByRole("button", { name: "重试本机保存" });
    expect(editButton).toBeDisabled();
    undoWrite.mockRestore();
    fireEvent.click(screen.getByRole("button", { name: "重试本机保存" }));
    await waitFor(() => expect(editButton).toBeEnabled());

    fireEvent.click(editButton);
    expect(editButton).toHaveAttribute("aria-pressed", "false");
    const restoredReader = await screen.findByLabelText("连续滚动阅读");
    await waitFor(() => expect(restoredReader.scrollTop).toBe(40));
    expect(screen.getByLabelText("阅读器控制")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "更多" }));
    expect(screen.getByText("200%")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "更多" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^(编辑|完成编辑)$/ })).toHaveAttribute(
        "data-state",
        "ready",
      );
    });
    fireEvent.click(screen.getByRole("button", { name: /^(编辑|完成编辑)$/ }));
    expect(screen.getByRole("button", { name: /当前编辑层：E · 全体/ })).toBeInTheDocument();
  });

  it("marks an offline copy only after app shell, layer and annotation snapshot verification", async () => {
    vi.mocked(activateVerifiedOfflineScore).mockImplementationOnce(async (record) => {
      vi.mocked(findVerifiedOfflineScore).mockResolvedValueOnce({ ...record, active: 1, verifiedAt: 1 });
    });
    vi.spyOn(crypto.subtle, "digest").mockResolvedValue(
      new Uint8Array(32).fill(0xaa).buffer,
    );
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { getRegistration: vi.fn().mockResolvedValue({ active: {} }) },
    });
    vi.mocked(fetch).mockImplementation((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/layers")) {
        return Promise.resolve(
          Response.json({
            layers: completeReaderLayers([
              ...(["E", "S", "A", "T", "B"] as const).map((slot, index): AnnotationLayerSummary => ({
                id: `00000000-0000-4000-8000-00000000000${index}`,
                kind: "shared", sharedSlot: slot,
                name: ({ E: "Ensemble", S: "Soprano", A: "Alto", T: "Tenor", B: "Bass" })[slot],
                sortOrder: index, subscribed: true, subscriptionSource: "product",
                displayColor: "#a12652", colorSource: "product", adminDefaultColor: "#a12652",
                driveSubscribed: null, driveColorOverride: null, scoreSubscriptionOverride: null, canEdit: false,
              })),
              {
                id: "11111111-1111-4111-8111-111111111111", kind: "personal", sharedSlot: null,
                name: "Personal", sortOrder: 10000, subscribed: true, subscriptionSource: "personal",
                displayColor: "#6750a4", colorSource: "product", adminDefaultColor: "#6750a4",
                driveSubscribed: null, driveColorOverride: null, scoreSubscriptionOverride: null, canEdit: true,
              },
            ]),
            permissions: { canManageLayers: false },
          }),
        );
      }
      if (url.includes("/annotations?")) return Promise.resolve(Response.json({ cursor: 0, objects: [] }));
      if (url.includes("/versions/")) {
        return Promise.resolve(
          new Response(new Uint8Array([1, 2, 3]), {
            headers: { "content-type": "application/pdf" },
          }),
        );
      }
      return Promise.resolve(Response.json({
        state: "active", score: { ...scoreSummary, currentVersion: { ...scoreSummary.currentVersion, sizeBytes: 3 } },
        permissions: { canManage: false },
      }));
    });
    render(
      <MemoryRouter initialEntries={["/choirs/choir-1/scores/score-1"]}>
        <Routes>
          <Route path="/choirs/:choirId/scores/:scoreId" element={<ReaderPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText("练声曲.pdf");
    await screen.findByLabelText("翻页阅读");
    openMoreMenu();
    expect(
      await screen.findByText("离线副本已完整校验，可以离线打开。"),
    ).toBeInTheDocument();
    expect(activateVerifiedOfflineScore).toHaveBeenCalledWith(
      expect.objectContaining({
        annotationSnapshot: expect.objectContaining({
          layers: expect.arrayContaining([expect.objectContaining({ name: "Ensemble" }), expect.objectContaining({ name: "Personal" })]),
          annotations: [],
        }),
      }),
      { activeKey: null },
    );
  });

  it.each(["expired", "checking", "hanging-cloud"])("allows the last local user to edit with authentication %s", async (state) => {
    readerAuthState.signedIn = false;
    readerAuthState.pending = state === "checking";
    vi.mocked(findVerifiedOfflineScore).mockResolvedValueOnce({
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
          ...completeReaderLayers().filter((layer) => layer.kind === "shared").map((layer) => ({ ...localWorkspace, ...layer, key: localWorkspaceRecordKey(localWorkspace, layer.id) })),
          {
            key: localWorkspaceRecordKey(localWorkspace, "11111111-1111-4111-8111-111111111111"),
            ...localWorkspace,
            id: "11111111-1111-4111-8111-111111111111",
            kind: "personal",
            sharedSlot: null,
            name: "我的批注",
            sortOrder: 10000,
            subscribed: true,
            subscriptionSource: "product",
            displayColor: "#b4235a",
            colorSource: "product",
            adminDefaultColor: "#b4235a",
            driveSubscribed: null,
            driveColorOverride: null,
            scoreSubscriptionOverride: null,
            canEdit: true,
          },
        ],
        annotations: [],
        cursor: 0,
        verifiedAt: 1,
      },
    });
    if (state === "hanging-cloud") vi.mocked(fetch).mockReturnValue(new Promise<Response>(() => {}));
    else vi.mocked(fetch).mockRejectedValue(new Error("offline"));
    const view = render(
      <MemoryRouter initialEntries={["/choirs/choir-1/scores/score-1"]}>
        <Routes>
          <Route path="/choirs/:choirId/scores/:scoreId" element={<ReaderPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByLabelText("翻页阅读");
    expect(screen.getByText("离线练声曲.pdf")).toBeInTheDocument();
    toggleChrome();
    const editButton = await screen.findByRole("button", { name: /^(编辑|完成编辑)$/ });
    await waitFor(() => expect(editButton).toHaveAttribute("data-state", "ready"));
    fireEvent.click(editButton);
    expect(editButton).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText(/编辑模式/)).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "文本" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    readerAuthState.signedIn = true;
    readerAuthState.pending = false;
    view.rerender(<MemoryRouter initialEntries={["/choirs/choir-1/scores/score-1"]}><Routes><Route path="/choirs/:choirId/scores/:scoreId" element={<ReaderPage />} /></Routes></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole("button", { name: "完成编辑" })).toHaveAttribute("aria-pressed", "true"));
    expect(screen.getByLabelText("翻页阅读")).toBeInTheDocument();
  });

  it("hides A's loaded reader state as soon as another tab activates B", async () => {
    vi.mocked(findVerifiedOfflineScore).mockResolvedValueOnce({
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
    await screen.findByLabelText("翻页阅读");
    expect(screen.getByText("A 的离线乐谱.pdf")).toBeInTheDocument();

    await activateAuthenticatedLocalOwner("user-b");

    await waitFor(() => {
      expect(screen.queryByText("A 的离线乐谱.pdf")).not.toBeInTheDocument();
    });
    expect(screen.getByText("正在打开乐谱…")).toBeInTheDocument();
  });

  it("keeps a trashed score's offline copy and outbox without editing or syncing", async () => {
    vi.mocked(findVerifiedOfflineScore).mockResolvedValueOnce({
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
            sharedSlot: null,
            name: "我的批注",
            sortOrder: 10_000,
            subscribed: true,
            subscriptionSource: "product",
            displayColor: "#b4235a",
            colorSource: "product",
            adminDefaultColor: "#b4235a",
            driveSubscribed: null,
            driveColorOverride: null,
            scoreSubscriptionOverride: null,
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
      if (url.endsWith("/scores/score-1/bootstrap")) {
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

    await screen.findByLabelText("翻页阅读");
    expect(screen.getByText("离线练声曲.pdf")).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "本机离线副本和未同步批注仍保留，恢复后可继续同步",
    );
    toggleChrome();
    expect(screen.getByRole("button", { name: /^(编辑|完成编辑)$/ })).toHaveAttribute(
      "data-state",
      "trashed",
    );
    expect(screen.getByRole("button", { name: /^(编辑|完成编辑)$/ })).toBeDisabled();
    expect(screen.getByText("乐谱在回收站中，恢复后可编辑")).toHaveAttribute(
      "role",
      "status",
    );
    fireEvent.click(screen.getByRole("button", { name: "更多" }));
    expect(screen.getByRole("button", { name: "立即同步" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "下载离线副本" })).toBeDisabled();
    expect(await localDatabase.annotationOutbox.count()).toBe(1);
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).endsWith("/annotations/push"))).toBe(false);
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/choirs/choir-1/scores/score-1/bootstrap",
    ]);
  });

  it("detects trash on reconnect before draining the offline outbox", async () => {
    vi.mocked(findVerifiedOfflineScore).mockResolvedValueOnce({
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
      if (url.endsWith("/scores/score-1/bootstrap")) {
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

    await screen.findByLabelText("翻页阅读");
    expect(screen.getByText("离线练声曲.pdf")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    connected = true;
    fireEvent(window, new Event("online"));

    expect(await screen.findByRole("alert")).toHaveTextContent("乐谱已移入回收站");
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).endsWith("/annotations/push"))).toBe(false);
    expect(await localDatabase.annotationOutbox.count()).toBe(1);
  });
});
