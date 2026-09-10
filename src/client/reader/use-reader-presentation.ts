import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useSyncExternalStore } from "react";
import type { ScoreDocument } from "./image-document";
import type { ReaderPresentation, PresentationSnapshot } from "./reader-presentation";

export const ReaderPresentationContext = createContext<{
  presentation: ReaderPresentation | null;
  currentPage: number;
  snapshot: PresentationSnapshot;
} | null>(null);
const subscribeNone = () => () => {};
const empty: PresentationSnapshot = { document: null, status: "pending" };
const pending = () => empty;

export function useReaderPresentation(presentation: ReaderPresentation | null, document: ScoreDocument | null, currentPage: number, editing: boolean) {
  useLayoutEffect(() => presentation?.select({ document, page: currentPage, editing }), [presentation, document, currentPage, editing]);
  const snapshot = useSyncExternalStore(presentation?.subscribe ?? subscribeNone, presentation?.getSnapshot ?? pending);
  return { status: snapshot.document === document ? snapshot.status : "pending", context: { presentation, currentPage, snapshot } };
}

// Canvas adapters report bitmap identity, not document-load completion. Changing
// the current page rechecks an already painted bitmap without redrawing it.
export function usePagePresentation(document: ScoreDocument, pageNumber: number,
  painted: { document: ScoreDocument; pageNumber: number } | null, error: boolean, enabled: boolean) {
  const context = useContext(ReaderPresentationContext);
  const presentation = enabled ? context?.presentation : null;
  const currentPage = context?.currentPage;
  const snapshot = context?.snapshot;
  useEffect(() => {
    if (!error && painted?.document === document && painted.pageNumber === pageNumber) {
      presentation?.ready(painted.document, painted.pageNumber);
    }
  }, [presentation, currentPage, snapshot, document, pageNumber, painted, error]);
  return useCallback((reason: unknown) => presentation?.failed(document, pageNumber, reason), [presentation, document, pageNumber]);
}
