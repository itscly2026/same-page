import type { Transaction } from "dexie";
// Only called by the IndexedDB version upgrade. Runtime accepts one format.
export function upgradeBrushContent(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  let changed = false;
  if (record.kind === "ink" && record.brush === undefined) {
    record.brush = record.strokeWidth === 0.018 ? "highlighter" : "pen";
    record.pressureMode = "uniform";
    changed = true;
  }
  for (const child of Object.values(record)) changed = upgradeBrushContent(child) || changed;
  return changed;
}
export async function migrateBrushStyles(transaction: Transaction) {
  const replacements = new Map<string, string>();
  const outbox = transaction.table("annotationOutbox");
  for (const record of await outbox.toArray()) {
    if (!upgradeBrushContent(record.payload)) continue;
    // An attempted operation's content hash cannot be changed under the same ID.
    // Preserve baseVersion: if it was already accepted, normal OCC reconciliation
    // protects the canonical object and retains the local variant.
    const oldId = record.opId;
    record.opId = crypto.randomUUID(); record.attemptedAt = null;
    replacements.set(oldId, record.opId);
    await outbox.delete(oldId); await outbox.put(record);
  }
  for (const name of ["annotations", "annotationConflicts", "offlineSnapshots"]) {
    await transaction.table(name).toCollection().modify((record: Record<string, unknown>) => {
      upgradeBrushContent(record);
      if (typeof record.lastOpId === "string" && replacements.has(record.lastOpId)) record.lastOpId = replacements.get(record.lastOpId);
    });
  }
}
