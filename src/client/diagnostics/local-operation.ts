import type { DiagnosticStep } from "../../shared/diagnostics";
import { LocalWorkspaceOwnerChangedError } from "../platform/local-workspace";
import { diagnosticErrorType, diagnosticScope } from "./diagnostics";

// Keep raw exceptions with the caller. Only fixed classifications enter reports.
export async function diagnoseLocalOperation<T>(step: DiagnosticStep, action: () => Promise<T>, options: { report?: ReturnType<typeof diagnosticScope>; signal?: AbortSignal } = {}): Promise<T> {
  const report = options.report ?? diagnosticScope();
  try { return await action(); }
  catch (error) {
    if (!options.signal?.aborted && !(error instanceof LocalWorkspaceOwnerChangedError) && diagnosticErrorType(error) !== "AbortError") {
      report({ operation: step.startsWith("offline-") ? "storage" : "sync", category: "internal",
        stage: step === "sync-push" ? "push" : "prepare", step, errorType: diagnosticErrorType(error) });
    }
    throw error;
  }
}
