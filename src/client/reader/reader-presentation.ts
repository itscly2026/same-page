import type { PDFDocumentProxy } from "./pdf-document";

type Target = { document: PDFDocumentProxy | null; page: number; editing: boolean };
export type PresentationSnapshot = { document: PDFDocumentProxy | null; status: "pending" | "visible" | "failed" };

// Owns the distinction between a loaded document, the current painted page and
// a previously presented document that the session may retain during recovery.
export class ReaderPresentation {
  private presented: PDFDocumentProxy | null = null;
  private disposed = false;
  private target: Target | null = null;
  private snapshot: PresentationSnapshot = { document: null, status: "pending" };
  private listeners = new Set<() => void>();

  constructor(private readonly effects: { confirmed(): boolean; recover(reason: unknown): void }) {}

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(status: PresentationSnapshot["status"], document = this.snapshot.document) {
    if (this.snapshot.status === status && this.snapshot.document === document) return;
    this.snapshot = { document, status };
    this.listeners.forEach(listener => listener());
  }

  load(document: PDFDocumentProxy | null) {
    if (this.disposed) return;
    this.publish(this.hasPresented(document) ? "visible" : "pending", document);
  }
  hasPresented(document: PDFDocumentProxy | null) {
    return document !== null && document === this.presented;
  }
  // The mounted reader supplies its committed target. A late render can only
  // acknowledge its own document/page, never whichever target replaced it.
  select(target: Target) {
    if (this.disposed) return () => {};
    this.target = target;
    return () => { if (this.target === target) this.target = null; };
  }
  private matches(document: PDFDocumentProxy, page: number) {
    return !this.disposed && document === this.snapshot.document && document === this.target?.document && page === this.target.page;
  }
  ready(document: PDFDocumentProxy, page: number) {
    if (!this.matches(document, page) || !this.effects.confirmed()) return;
    this.presented = document;
    this.publish("visible");
  }
  failed(document: PDFDocumentProxy, page: number, reason: unknown) {
    if (!this.matches(document, page)) return;
    this.publish("failed");
    if (!this.target?.editing) this.effects.recover(reason);
  }
  dispose() {
    this.disposed = true;
    this.target = null;
    this.listeners.clear();
  }
}
