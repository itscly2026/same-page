import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

export type PageTurnRequest = number | "previous" | "next";

export interface PageTurnSample {
  sessionId: number;
  x: number;
  y: number;
  time: number;
  extent: number;
}

export interface PageTurnGesture {
  begin(sample: PageTurnSample): void;
  move(sample: PageTurnSample): boolean;
  end(sample: PageTurnSample): boolean;
  cancel(sessionId: number, immediate?: boolean): boolean;
}

export interface PagedReaderItem {
  page: number;
  position: -1 | 0 | 1;
}

export interface PagedReader {
  anchorPage: number;
  targetPage: number | null;
  phase: "idle" | "preparing" | "dragging" | "settling";
  progress: number;
  items: PagedReaderItem[];
  request(target: PageTurnRequest): void;
  gesture: PageTurnGesture;
  beginPageRender(page: number): PageRenderLease;
  finishTransition(): void;
  failedPage: number | null;
  retryPage(): void;
  renderKey(page: number): string;
}

export interface PageRenderLease {
  ready(): void;
  failed(): void;
  cancel(): void;
}

interface PagerView {
  anchorPage: number;
  targetPage: number | null;
  phase: PagedReader["phase"];
  progress: number;
  commitOnFinish: boolean;
}

interface DragSession {
  sessionId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastTime: number;
  velocity: number;
  progress: number;
  axis: "pending" | "horizontal" | "vertical";
  extent: number;
}

const DRAG_LOCK_PX = 8;
const COMMIT_PROGRESS = 0.22;
const COMMIT_VELOCITY_PX_PER_MS = 0.55;

export function usePagedReader({
  currentPage,
  pageCount,
  documentKey,
  enabled,
  onPageChange,
  beforePageChange,
  canCompletePage,
}: {
  currentPage: number;
  pageCount: number;
  documentKey: string;
  enabled: boolean;
  onPageChange(page: number): void;
  beforePageChange?(): Promise<boolean>;
  canCompletePage?(): boolean;
}): PagedReader {
  const initialPage = clampPage(currentPage, pageCount);
  const [view, setView] = useState<PagerView>(() => idleView(initialPage));
  const viewRef = useRef(view);
  const [failure, setFailure] = useState<{ documentKey: string; page: number } | null>(null);
  const [retry, setRetry] = useState({ page: 0, attempt: 0 });
  const failedPages = useRef(new Map<string, Set<number>>());
  const drag = useRef<DragSession | null>(null);
  const readyPages = useRef(new Map<string, Set<number>>());
  const renderGenerations = useRef(new Map<string, Map<number, number>>());
  const queuedTarget = useRef<number | null>(null);
  const frame = useRef<number | null>(null);
  const startRequestRef = useRef<(targetPage: number) => void>(() => {});
  const pageCountRef = useRef(pageCount);
  const currentPageRef = useRef(currentPage);
  const enabledRef = useRef(enabled);
  const reducedMotion = usePrefersReducedMotion();
  const reducedMotionRef = useRef(reducedMotion);
  const onPageChangeRef = useRef(onPageChange);
  const admission = useRef({ beforePageChange, canCompletePage });
  const admissionGeneration = useRef(0);

  useLayoutEffect(() => {
    pageCountRef.current = pageCount;
    currentPageRef.current = currentPage;
    enabledRef.current = enabled;
    reducedMotionRef.current = reducedMotion;
    onPageChangeRef.current = onPageChange;
    admission.current = { beforePageChange, canCompletePage };
  }, [beforePageChange, canCompletePage, currentPage, enabled, onPageChange, pageCount, reducedMotion]);

  const updateView = useCallback((next: PagerView) => {
    viewRef.current = next;
    setView(next);
  }, []);

  const cancelFrame = useCallback(() => {
    if (frame.current === null) return;
    cancelAnimationFrame(frame.current);
    frame.current = null;
  }, []);

  const continueQueuedRequest = useCallback((anchorPage: number) => {
    const queued = queuedTarget.current;
    queuedTarget.current = null;
    if (queued === null || queued === anchorPage) return;
    startRequestRef.current(queued);
  }, []);

  const completePage = useCallback((page: number) => {
    if (admission.current.canCompletePage?.() === false) {
      queuedTarget.current = null;
      updateView(idleView(viewRef.current.anchorPage));
      return;
    }
    const nextPage = clampPage(page, pageCountRef.current);
    updateView(idleView(nextPage));
    onPageChangeRef.current(nextPage);
    continueQueuedRequest(nextPage);
  }, [continueQueuedRequest, updateView]);

  const schedulePreparedTransition = useCallback((targetPage: number) => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const current = viewRef.current;
      if (current.phase !== "preparing" || current.targetPage !== targetPage) return;
      if (!readyPages.current.get(documentKey)?.has(targetPage)) return;
      const generation = ++admissionGeneration.current;
      const proceed = (allowed: boolean) => {
        if (generation !== admissionGeneration.current || viewRef.current !== current) return;
        if (!allowed || admission.current.canCompletePage?.() === false || !readyPages.current.get(documentKey)?.has(targetPage)) {
          queuedTarget.current = null;
          updateView(Math.abs(current.progress) > 0.001 && !reducedMotionRef.current
            ? { ...current, phase: "settling", progress: 0, commitOnFinish: false } : idleView(current.anchorPage));
          return;
        }
        if (reducedMotionRef.current) { completePage(targetPage); return; }
        updateView({ ...current, phase: "settling",
          progress: targetPage > current.anchorPage ? -1 : 1, commitOnFinish: true });
      };
      const check = admission.current.beforePageChange;
      if (check) void check().then(proceed, () => proceed(false));
      else proceed(true);
    });
  }, [completePage, documentKey, updateView]);

  const startRequest = useCallback((targetPage: number) => {
    const current = viewRef.current;
    const target = clampPage(targetPage, pageCountRef.current);
    if (!enabledRef.current || target === current.anchorPage) return;
    if (failedPages.current.get(documentKey)?.has(target)) {
      setFailure({ documentKey, page: target });
      return;
    }
    setFailure(null);
    updateView({
      anchorPage: current.anchorPage,
      targetPage: target,
      phase: "preparing",
      progress: 0,
      commitOnFinish: true,
    });
    if (readyPages.current.get(documentKey)?.has(target)) {
      schedulePreparedTransition(target);
    }
  }, [documentKey, schedulePreparedTransition, updateView]);

  useLayoutEffect(() => {
    startRequestRef.current = startRequest;
  }, [startRequest]);

  const request = useCallback((target: PageTurnRequest) => {
    if (!enabledRef.current) return;
    const current = viewRef.current;
    const projectedPage = queuedTarget.current ?? (
      current.commitOnFinish && current.targetPage !== null ? current.targetPage : current.anchorPage
    );
    const targetPage = clampPage(
      typeof target === "number"
        ? target
        : projectedPage + (target === "next" ? 1 : -1),
      pageCountRef.current,
    );
    if (targetPage === projectedPage) return;
    if (current.phase !== "idle") {
      queuedTarget.current = targetPage;
      return;
    }
    startRequest(targetPage);
  }, [startRequest]);

  const finishTransition = useCallback(() => {
    const current = viewRef.current;
    if (current.phase !== "settling") return;
    const committedPage =
      current.commitOnFinish && current.targetPage !== null &&
      readyPages.current.get(documentKey)?.has(current.targetPage) &&
      admission.current.canCompletePage?.() !== false
        ? current.targetPage
        : current.anchorPage;
    if (current.commitOnFinish && committedPage === current.anchorPage) {
      queuedTarget.current = null;
      updateView({ ...current, progress: 0, commitOnFinish: false });
      return;
    }
    updateView(idleView(committedPage));
    if (committedPage !== current.anchorPage) {
      onPageChangeRef.current(committedPage);
    }
    continueQueuedRequest(committedPage);
  }, [continueQueuedRequest, documentKey, updateView]);

  const beginPageRender = useCallback((page: number): PageRenderLease => {
    const generations = renderGenerations.current.get(documentKey) ?? new Map();
    const pages = readyPages.current.get(documentKey) ?? new Set();
    const generation = (generations.get(page) ?? 0) + 1;
    generations.set(page, generation);
    pages.delete(page);
    renderGenerations.current.set(documentKey, generations);
    readyPages.current.set(documentKey, pages);
    let active = true;
    return {
      ready() {
        if (
          !active ||
          renderGenerations.current.get(documentKey)?.get(page) !== generation
        ) return;
        failedPages.current.get(documentKey)?.delete(page);
        readyPages.current.get(documentKey)?.add(page);
        const current = viewRef.current;
        if (current.targetPage !== page) return;
        if (current.phase === "preparing") schedulePreparedTransition(page);
        else if (current.phase === "dragging" && drag.current) updateView({ ...current, progress: drag.current.progress });
      },
      failed() {
        if (!active || renderGenerations.current.get(documentKey)?.get(page) !== generation) return;
        const failures = failedPages.current.get(documentKey) ?? new Set<number>();
        failures.add(page);
        failedPages.current.set(documentKey, failures);
        readyPages.current.get(documentKey)?.delete(page);
        if (viewRef.current.targetPage === page) {
          cancelFrame();
          drag.current = null;
          admissionGeneration.current++;
          queuedTarget.current = null;
          updateView(idleView(viewRef.current.anchorPage));
          setFailure({ documentKey, page });
        }
      },
      cancel() {
        if (!active) return;
        active = false;
        const currentGenerations = renderGenerations.current.get(documentKey);
        if (!currentGenerations || currentGenerations.get(page) !== generation) return;
        readyPages.current.get(documentKey)?.delete(page);
        currentGenerations.set(page, generation + 1);
      },
    };
  }, [documentKey, schedulePreparedTransition, cancelFrame, updateView]);

  const settleDrag = useCallback((commit: boolean) => {
    const current = viewRef.current;
    const target = current.targetPage;
    if (commit && target !== null) {
      updateView({ ...current, phase: "preparing", commitOnFinish: true });
      if (readyPages.current.get(documentKey)?.has(target)) schedulePreparedTransition(target);
      return;
    }
    if (reducedMotionRef.current || Math.abs(current.progress) < 0.001) {
      updateView(idleView(current.anchorPage));
      continueQueuedRequest(current.anchorPage);
      return;
    }
    updateView({
      ...current,
      phase: "settling",
      progress: 0,
      commitOnFinish: false,
    });
  }, [continueQueuedRequest, documentKey, schedulePreparedTransition, updateView]);

  const gesture = useMemo<PageTurnGesture>(() => ({
    begin(sample) {
      if (!enabledRef.current || viewRef.current.phase !== "idle") return;
      drag.current = {
        sessionId: sample.sessionId,
        startX: sample.x,
        startY: sample.y,
        lastX: sample.x,
        lastTime: sample.time,
        velocity: 0,
        progress: 0,
        axis: "pending",
        extent: Math.max(1, sample.extent),
      };
    },
    move(sample) {
      const session = drag.current;
      if (!session || session.sessionId !== sample.sessionId) return false;
      const deltaX = sample.x - session.startX;
      const deltaY = sample.y - session.startY;
      if (session.axis === "pending") {
        if (Math.max(Math.abs(deltaX), Math.abs(deltaY)) < DRAG_LOCK_PX) return false;
        session.axis = Math.abs(deltaX) > Math.abs(deltaY) ? "horizontal" : "vertical";
      }
      if (session.axis === "vertical") return false;
      const elapsed = Math.max(1, sample.time - session.lastTime);
      session.velocity = (sample.x - session.lastX) / elapsed;
      session.lastX = sample.x;
      session.lastTime = sample.time;
      session.extent = Math.max(1, sample.extent);
      const anchorPage = viewRef.current.anchorPage;
      const requestedTarget = anchorPage + (deltaX < 0 ? 1 : -1);
      const targetPage =
        requestedTarget >= 1 && requestedTarget <= pageCountRef.current
          ? requestedTarget
          : null;
      if (targetPage !== null && failedPages.current.get(documentKey)?.has(targetPage)) {
        drag.current = null;
        updateView(idleView(anchorPage));
        setFailure({ documentKey, page: targetPage });
        return true;
      }
      const gestureProgress = targetPage === null
        ? clamp(deltaX / session.extent, -0.08, 0.08)
        : clamp(deltaX / session.extent, -1, 1);
      session.progress = gestureProgress;
      const progress = targetPage !== null && !readyPages.current.get(documentKey)?.has(targetPage)
        ? 0
        : gestureProgress;
      updateView({
        anchorPage,
        targetPage,
        phase: "dragging",
        progress,
        commitOnFinish: false,
      });
      return true;
    },
    end(sample) {
      const session = drag.current;
      if (!session || session.sessionId !== sample.sessionId) return false;
      drag.current = null;
      if (session.axis !== "horizontal") return false;
      const current = viewRef.current;
      if (sample.time - session.lastTime > 100) session.velocity = 0;
      const sameDirection =
        Math.sign(session.velocity) === Math.sign(session.progress);
      const shouldCommit =
        current.targetPage !== null &&
        (Math.abs(session.progress) >= COMMIT_PROGRESS ||
          (sameDirection && Math.abs(session.velocity) >= COMMIT_VELOCITY_PX_PER_MS));
      settleDrag(shouldCommit);
      return true;
    },
    cancel(sessionId, immediate = false) {
      const session = drag.current;
      if (!session || session.sessionId !== sessionId) return false;
      drag.current = null;
      if (session.axis !== "horizontal") return true;
      if (immediate) {
        queuedTarget.current = null;
        updateView(idleView(viewRef.current.anchorPage));
      } else {
        settleDrag(false);
      }
      return true;
    },
  }), [documentKey, settleDrag, updateView]);

  useLayoutEffect(() => {
    for (const key of readyPages.current.keys()) {
      if (key !== documentKey) readyPages.current.delete(key);
    }
    for (const key of renderGenerations.current.keys()) {
      if (key !== documentKey) renderGenerations.current.delete(key);
    }
    admissionGeneration.current++;
    queuedTarget.current = null;
    drag.current = null;
    cancelFrame();
    updateView(idleView(clampPage(currentPageRef.current, pageCount)));
  }, [cancelFrame, documentKey, pageCount, updateView]);

  useLayoutEffect(() => {
    const nextPage = clampPage(currentPage, pageCount);
    const current = viewRef.current;
    if (!enabled || (current.phase === "idle" && current.anchorPage !== nextPage)) {
      queuedTarget.current = null;
      drag.current = null;
      cancelFrame();
      updateView(idleView(nextPage));
    }
  }, [cancelFrame, currentPage, enabled, pageCount, updateView]);

  useEffect(() => () => cancelFrame(), [cancelFrame]);
  useEffect(() => {
    if (view.phase !== "settling") return;
    // Resize, browser interruption or a zero-distance transition may suppress
    // transitionend. The same final gate still owns completion.
    const timeout = setTimeout(finishTransition, 320);
    return () => clearTimeout(timeout);
  }, [finishTransition, view]);

  return {
    anchorPage: view.anchorPage,
    targetPage: view.targetPage,
    phase: view.phase,
    progress: view.progress,
    items: pageWindow(view, pageCount),
    request,
    gesture,
    beginPageRender,
    finishTransition,
    failedPage: failure?.documentKey === documentKey ? failure.page : null,
    retryPage: () => {
      if (!failure || failure.documentKey !== documentKey) return;
      failedPages.current.get(documentKey)?.delete(failure.page);
      setRetry(value => ({ page: failure.page, attempt: value.attempt + 1 }));
      startRequest(failure.page);
    },
    renderKey: (page: number) => `${page}:${retry.page === page ? retry.attempt : 0}`,
  };
}

function pageWindow(view: PagerView, pageCount: number): PagedReaderItem[] {
  const pages = new Map<-1 | 0 | 1, number>();
  if (view.anchorPage > 1) pages.set(-1, view.anchorPage - 1);
  pages.set(0, view.anchorPage);
  if (view.anchorPage < pageCount) pages.set(1, view.anchorPage + 1);
  if (view.targetPage !== null && Math.abs(view.targetPage - view.anchorPage) > 1) {
    pages.set(view.targetPage > view.anchorPage ? 1 : -1, view.targetPage);
  }
  return [...pages.entries()]
    .sort(([first], [second]) => first - second)
    .map(([position, page]) => ({ page, position }));
}

function idleView(page: number): PagerView {
  return {
    anchorPage: page,
    targetPage: null,
    phase: "idle",
    progress: 0,
    commitOnFinish: false,
  };
}

function clampPage(page: number, pageCount: number) {
  return Math.min(Math.max(1, pageCount), Math.max(1, page));
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(
    () => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
  );
  useEffect(() => {
    const query = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    const update = () => setReduced(query.matches);
    query.addEventListener("change", update);
    update();
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}
