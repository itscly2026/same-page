import { beforeEach, expect, it } from "vitest";
import { LocalWorkspaceOwnerChangedError } from "../platform/local-workspace";
import { clearDiagnostics, exportDiagnostics } from "./diagnostics";
import { diagnoseLocalOperation } from "./local-operation";

beforeEach(clearDiagnostics);
it("preserves the exception and reports only its safe type and operation step", async () => {
  const error = new DOMException("private database details", "UnknownError");
  await expect(diagnoseLocalOperation("sync-apply", async () => { throw error; })).rejects.toBe(error);
  expect(JSON.parse(exportDiagnostics()).records).toEqual([expect.objectContaining({ step: "sync-apply", errorType: "UnknownError", operation: "sync" })]);
  expect(exportDiagnostics()).not.toContain("private");
});
it("ignores cancellation, owner changes and late failures after diagnostic reset", async () => {
  for (const error of [new DOMException("cancelled", "AbortError"), new LocalWorkspaceOwnerChangedError()]) {
    await expect(diagnoseLocalOperation("sync-retry", async () => { throw error; })).rejects.toBe(error);
  }
  let reject!: (error: unknown) => void;
  const pending = diagnoseLocalOperation("offline-read", () => new Promise((_, fail) => { reject = fail; }));
  clearDiagnostics();
  reject(new Error("old owner's data"));
  await expect(pending).rejects.toThrow();
  expect(JSON.parse(exportDiagnostics()).records).toEqual([]);
});
