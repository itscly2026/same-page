import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearDiagnostics, recordFailure } from "./diagnostics";
import { captureDiagnosticReport, diagnosticEnvironment, getDiagnosticSubmission, sendDiagnosticReport, setDiagnosticDescription } from "./diagnostic-submission";

beforeEach(() => { clearDiagnostics(); vi.spyOn(navigator, "onLine", "get").mockReturnValue(true); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("captures only parsed environment tokens and fixed reader state, never raw UA/URLs", () => {
  const environment = diagnosticEnvironment("private-identity Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) Version/18.1 Mobile Safari/604.1 https://private.test/?token=secret");
  expect(environment.browser).toBe("safari");
  expect(environment.browserVersion).toBe("18.1");
  expect(environment.system).toBe("ios");
  expect(environment.systemVersion).toBe("18.1");
  expect(JSON.stringify(environment)).not.toMatch(/private|token|secret|https/);
  recordFailure({ operation: "pdf", category: "internal", stage: "decode" });
  const report = captureDiagnosticReport("optional user text", { interactionMode: "editing", pendingCount: 2, conflictCount: null });
  expect(report.records[0].operation).toBe("pdf");
  expect(report.reader?.pendingCount).toBe(2);
  expect(report.description).toBe("optional user text");
});

it("does not send until requested; uncertain retry sends the exact original report without credentials", async () => {
  const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError("offline"));
  vi.stubGlobal("fetch", fetchMock);
  setDiagnosticDescription("first incident");
  expect(fetchMock).not.toHaveBeenCalled();
  await sendDiagnosticReport(null);
  const first = getDiagnosticSubmission().report!;
  expect(getDiagnosticSubmission().phase).toBe("failed");
  recordFailure({ operation: "sync", category: "network" });
  setDiagnosticDescription("must not replace the frozen incident");
  fetchMock.mockResolvedValueOnce(Response.json({ id: first.id }));
  await sendDiagnosticReport(null);
  expect(getDiagnosticSubmission().phase).toBe("sent");
  expect(fetchMock.mock.calls[0][1].body).toBe(fetchMock.mock.calls[1][1].body);
  expect(fetchMock.mock.calls[1][1].credentials).toBe("omit");
  expect(first.records).toEqual([]);
  expect(first.description).toBe("first incident");
});

it("keeps an offline report in memory without dispatching a request", async () => {
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
  const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
  setDiagnosticDescription("cannot load");
  await sendDiagnosticReport(null);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(getDiagnosticSubmission().report?.description).toBe("cannot load");
  expect(getDiagnosticSubmission().message).toContain("当前离线");
});

it("clears the snapshot/description on identity switch and ignores a late receipt", async () => {
  let resolve!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(done => { resolve = done; })));
  setDiagnosticDescription("old identity text");
  const sending = sendDiagnosticReport(null);
  const id = getDiagnosticSubmission().report!.id;
  clearDiagnostics();
  resolve(Response.json({ id })); await sending;
  expect(getDiagnosticSubmission()).toEqual({ description: "", report: null, phase: "idle", message: "" });
});

it("times out an unconfirmed request and prevents double-click duplicate dispatch", async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  }));
  vi.stubGlobal("fetch", fetchMock);
  const sending = sendDiagnosticReport(null);
  await sendDiagnosticReport(null);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(15_000); await sending;
  expect(getDiagnosticSubmission().phase).toBe("failed");
  expect(getDiagnosticSubmission().message).toContain("尚未确认收到");
  expect(getDiagnosticSubmission().report).not.toBeNull();
});

it("handles rate limits and a mismatched receipt without claiming success", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(null, { status: 429 })).mockResolvedValueOnce(Response.json({ id: crypto.randomUUID() })));
  await sendDiagnosticReport(null);
  expect(getDiagnosticSubmission().message).toContain("过于频繁");
  await sendDiagnosticReport(null);
  expect(getDiagnosticSubmission().phase).toBe("failed");
  expect(getDiagnosticSubmission().message).toContain("尚未确认收到");
});

it("never claims non-delivery when connectivity drops after dispatch or an uncertain retry", async () => {
  const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  const fetchMock = vi.fn(async () => { online.mockReturnValue(false); throw new TypeError("response lost"); });
  vi.stubGlobal("fetch", fetchMock);
  await sendDiagnosticReport(null);
  expect(getDiagnosticSubmission().message).toContain("当前离线，尚未确认收到");
  expect(getDiagnosticSubmission().message).not.toContain("尚未发送");
  await sendDiagnosticReport(null);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(getDiagnosticSubmission().message).toContain("尚未确认收到");
});
