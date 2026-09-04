import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearDiagnostics, diagnosticFetch, diagnosticScope, exportDiagnostics, parseDiagnosticResponse, pdfFailureCategory, recordFailure } from "./diagnostics";
import { driveBootstrapResponseSchema } from "../../shared/scores";

beforeEach(() => clearDiagnostics());
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("private diagnostics", () => {
  it.each(["not JSON", '{"secret":"private annotation"}'])("records malformed successful responses at decode without retaining content", async (body) => {
    const requestId = crypto.randomUUID();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { headers: { "X-Same-Page-Request-Id": requestId } })));
    const response = await diagnosticFetch("/api/choirs/private/bootstrap");
    await expect(parseDiagnosticResponse(response, driveBootstrapResponseSchema)).rejects.toThrow("invalid_server_response");
    expect(exportDiagnostics()).toContain(requestId);
    expect(exportDiagnostics()).toContain('"stage": "decode"');
    expect(exportDiagnostics()).not.toContain("private");
  });

  it("ignores old async scopes and response decoding after identity reset", async () => {
    const report = diagnosticScope();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("invalid")));
    const response = await diagnosticFetch("/api/choirs/private/bootstrap");
    clearDiagnostics();
    report({ operation: "sync", category: "internal" });
    await expect(parseDiagnosticResponse(response, driveBootstrapResponseSchema)).rejects.toThrow();
    expect(JSON.parse(exportDiagnostics()).records).toHaveLength(0);
  });

  it.each([[{ name: "ResponseException", status: 403 }, "permission"], [{ name: "ResponseException", status: 404 }, "not-found"], [{ name: "ResponseException", status: 0 }, "network"], [{ name: "InvalidPDFException" }, "validation"], [new TypeError("secret"), "network"], [new Error("secret"), "internal"]])("classifies PDF.js failures without retaining errors", (error, category) => {
    expect(pdfFailureCategory(error)).toBe(category);
  });
  it("correlates HTTP failures without consuming responses or retaining sensitive input", async () => {
    const requestId = crypto.randomUUID();
    const response = Response.json({ error: "secret-response-body" }, { status: 503, headers: {
      "X-Same-Page-Request-Id": requestId, "X-Same-Page-Build": "abcdef1234567",
    } });
    const transport = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", transport);
    const options = { method: "POST", headers: { authorization: "secret-token" }, body: "secret-annotation" };
    expect(await diagnosticFetch("/api/choirs/secret-drive/scores/secret-score/annotations/push?code=secret-code", options)).toBe(response);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledWith(expect.any(String), options);
    expect(await response.json()).toEqual({ error: "secret-response-body" });
    expect(exportDiagnostics()).toContain(requestId);
    expect(exportDiagnostics()).toContain('"operation": "sync"');
    expect(exportDiagnostics()).not.toContain("secret");
  });

  it.each([[403, "permission"], [409, "conflict"], [422, "validation"], [429, "rate-limit"], [500, "internal"]])("classifies HTTP %s as %s", async (status, category) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: Number(status) })));
    await diagnosticFetch("/api/choirs/private/bootstrap");
    expect(exportDiagnostics()).toContain(`"category": "${category}"`);
  });

  it("rethrows network errors unchanged without exporting their message and ignores cancellation", async () => {
    const error = new TypeError("secret-email@example.com secret-IP secret-OTP");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error));
    await expect(diagnosticFetch("/api/auth/flow")).rejects.toBe(error);
    expect(exportDiagnostics()).toContain('"category": "network"');
    expect(exportDiagnostics()).not.toContain("secret");
    clearDiagnostics();
    vi.mocked(fetch).mockRejectedValue(new DOMException("secret", "AbortError"));
    await expect(diagnosticFetch("/api/guest/session")).rejects.toThrow();
    expect(JSON.parse(exportDiagnostics()).records).toHaveLength(0);
  });

  it("validates runtime fields and drops unknown fields and malformed correlation headers", () => {
    const input = { operation: "pdf" as const, category: "internal" as const, requestId: "secret-token", serverBuild: "secret-email", error: new Error("secret-body"), cookie: "secret-cookie" };
    recordFailure(input);
    expect(exportDiagnostics()).not.toContain("secret");
    expect(exportDiagnostics()).not.toContain("cookie");
  });

  it("coalesces repeated failures, bounds history, expires it, and clears without persistent storage", () => {
    vi.useFakeTimers();
    for (let index = 0; index < 100; index += 1) recordFailure({ operation: "sync", category: "network" });
    expect(JSON.parse(exportDiagnostics()).records).toHaveLength(1);
    expect(JSON.parse(exportDiagnostics()).records[0].count).toBe(100);
    for (let index = 0; index < 60; index += 1) {
      vi.advanceTimersByTime(30_001);
      recordFailure({ operation: "sync", category: "network" });
    }
    expect(JSON.parse(exportDiagnostics()).records).toHaveLength(50);
    vi.advanceTimersByTime(30 * 60_000);
    expect(JSON.parse(exportDiagnostics()).records).toHaveLength(0);
    recordFailure({ operation: "pdf", category: "internal", stage: "decode" });
    clearDiagnostics();
    expect(JSON.parse(exportDiagnostics()).records).toHaveLength(0);
  });

  it("does not leak late failures across identity changes", async () => {
    let resolve!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((done) => { resolve = done; })));
    const pending = diagnosticFetch("/api/choirs/private/bootstrap");
    clearDiagnostics();
    resolve(new Response(null, { status: 500 }));
    await pending;
    expect(JSON.parse(exportDiagnostics()).records).toHaveLength(0);
  });

  it("does not let unavailable diagnostics break the transport", async () => {
    vi.spyOn(crypto, "randomUUID").mockImplementation(() => { throw new Error("unavailable"); });
    const response = new Response(null, { status: 503 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    expect(await diagnosticFetch("/api/choirs/private/bootstrap")).toBe(response);
  });
});
