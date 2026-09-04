import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import DiagnosticsPage from "./diagnostics-page";
import { clearDiagnostics, recordFailure } from "./diagnostics";

beforeEach(clearDiagnostics);
afterEach(() => vi.useRealTimers());

it("removes displayed reports on identity reset and expiration", () => {
  vi.useFakeTimers();
  recordFailure({ operation: "pdf", category: "internal" });
  render(<MemoryRouter><DiagnosticsPage /></MemoryRouter>);
  const report = screen.getByRole<HTMLTextAreaElement>("textbox");
  act(() => clearDiagnostics());
  expect(report.value).toContain('"records": []');
  act(() => { recordFailure({ operation: "pdf", category: "internal" }); vi.advanceTimersByTime(1000); });
  expect(report.value).toContain('"operation": "pdf"');
  act(() => vi.advanceTimersByTime(30 * 60_000));
  expect(report.value).toContain('"records": []');
});

it("lets the user inspect and clear a safe report without touching drafts", () => {
  recordFailure({ operation: "pdf", category: "internal", stage: "decode" });
  render(<MemoryRouter><DiagnosticsPage /></MemoryRouter>);
  const report = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "可发送给支持人员的诊断内容" });
  expect(report.value).toContain('"operation": "pdf"');
  fireEvent.click(screen.getByRole("button", { name: "清空诊断" }));
  expect(report.value).toContain('"records": []');
  expect(screen.getByRole("status")).toHaveTextContent("不影响乐谱与草稿");
});
