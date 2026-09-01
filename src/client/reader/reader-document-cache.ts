import type { LocalWorkspaceOwnerKey } from "../platform/local-workspace";
import {
  loadPdfDocument,
  type PDFDocumentProxy,
} from "./pdf-document";
import { onReaderIdentityChange } from "./reader-cache-events";

const RELEASE_DELAY_MS = 15_000;

interface CachedDocument {
  ownerKey: LocalWorkspaceOwnerKey;
  choirId: string;
  scoreId: string;
  sourceKind: "cloud" | "offline";
  load: {
    task: ReturnType<typeof loadPdfDocument>;
    destroyed: boolean;
  };
  promise: Promise<PDFDocumentProxy>;
  version: {
    expected: string | null;
    actual: string | null;
  };
  references: number;
  releaseTimer: number | null;
}

const documents = new Map<string, CachedDocument>();
let activeOwner: LocalWorkspaceOwnerKey | null = null;

onReaderIdentityChange(clearReaderDocumentCache);

export interface ReaderDocumentLease {
  promise: Promise<PDFDocumentProxy>;
  release(): void;
}

export class ReaderDocumentVersionMismatchError extends Error {
  constructor(readonly expectedVersionId: string) {
    super("reader_document_version_mismatch");
  }
}

export type ReaderDocumentVersionConfirmation =
  | "missing"
  | "match"
  | "mismatch";

export function acquireReaderDocument(options: {
  ownerKey: LocalWorkspaceOwnerKey;
  choirId: string;
  scoreId: string;
  source: string | ArrayBuffer;
  sourceKind: "cloud" | "offline";
  versionId?: string;
}): ReaderDocumentLease {
  activateReaderDocumentOwner(options.ownerKey);
  const key = documentKey(options);
  let cached = documents.get(key);
  if (
    cached &&
    options.versionId &&
    ((cached.version.actual && cached.version.actual !== options.versionId) ||
      (cached.version.expected && cached.version.expected !== options.versionId))
  ) {
    evict(key, cached);
    cached = undefined;
  }
  if (!cached) {
    const task = loadPdfDocument(options.source, options.versionId);
    const load = { task, destroyed: false };
    const version = {
      expected: options.versionId ?? null,
      actual: null as string | null,
    };
    const promise = task.promise
      .then((opened) => {
        version.actual = opened.versionId;
        if (version.expected && opened.versionId !== version.expected) {
          throw new ReaderDocumentVersionMismatchError(version.expected);
        }
        return opened.document;
      })
      .catch((error) => {
        destroyLoad(load);
        throw error;
      });
    const entry: CachedDocument = {
      ownerKey: options.ownerKey,
      choirId: options.choirId,
      scoreId: options.scoreId,
      sourceKind: options.sourceKind,
      load,
      promise,
      version,
      references: 0,
      releaseTimer: null,
    };
    cached = entry;
    documents.set(key, entry);
  } else if (options.versionId && !cached.version.expected) {
    cached.version.expected = options.versionId;
  }
  cached.references += 1;
  if (cached.releaseTimer !== null) {
    window.clearTimeout(cached.releaseTimer);
    cached.releaseTimer = null;
  }
  let released = false;
  return {
    promise: cached.promise.catch((error) => {
        if (documents.get(key) === cached) documents.delete(key);
        throw error;
      }),
    release: () => {
      if (released) return;
      released = true;
      release(key, cached!);
    },
  };
}

export function confirmReaderDocumentVersion(options: {
  ownerKey: LocalWorkspaceOwnerKey;
  choirId: string;
  scoreId: string;
  sourceKind: "cloud" | "offline";
  versionId: string;
}): ReaderDocumentVersionConfirmation {
  const key = documentKey(options);
  const cached = documents.get(key);
  if (!cached) return "missing";
  cached.version.expected = options.versionId;
  if (!cached.version.actual) {
    return "match";
  }
  if (cached.version.actual === options.versionId) return "match";
  evict(key, cached);
  return "mismatch";
}

export function invalidateReaderDocument(options: {
  ownerKey: LocalWorkspaceOwnerKey;
  choirId: string;
  scoreId: string;
  sourceKind?: "cloud" | "offline";
}) {
  for (const [key, cached] of documents) {
    if (
      cached.ownerKey === options.ownerKey &&
      cached.choirId === options.choirId &&
      cached.scoreId === options.scoreId &&
      (!options.sourceKind || cached.sourceKind === options.sourceKind)
    ) {
      evict(key, cached);
    }
  }
}

export function activateReaderDocumentOwner(ownerKey: LocalWorkspaceOwnerKey) {
  if (activeOwner === ownerKey) return;
  clearReaderDocumentCache();
  activeOwner = ownerKey;
}

export function clearReaderDocumentCache() {
  for (const [key, cached] of documents) evict(key, cached);
  documents.clear();
  activeOwner = null;
}

function documentKey(options: {
  ownerKey: LocalWorkspaceOwnerKey;
  choirId: string;
  scoreId: string;
  sourceKind: "cloud" | "offline";
}) {
  return JSON.stringify([
    options.ownerKey,
    options.choirId,
    options.scoreId,
    options.sourceKind,
  ]);
}

function release(key: string, cached: CachedDocument) {
  cached.references = Math.max(0, cached.references - 1);
  if (cached.references > 0 || documents.get(key) !== cached) return;
  cached.releaseTimer = window.setTimeout(() => evict(key, cached), RELEASE_DELAY_MS);
}

function evict(key: string, cached: CachedDocument) {
  if (documents.get(key) === cached) documents.delete(key);
  if (cached.releaseTimer !== null) window.clearTimeout(cached.releaseTimer);
  cached.releaseTimer = null;
  destroyLoad(cached.load);
}

function destroyLoad(load: CachedDocument["load"]) {
  if (load.destroyed) return;
  load.destroyed = true;
  void load.task.destroy().catch(() => undefined);
}
