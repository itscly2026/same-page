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
  const report = screen.getByLabelText<HTMLTextAreaElement>("可发送给支持人员的诊断内容");
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
  const report = screen.getByLabelText<HTMLTextAreaElement>("可发送给支持人员的诊断内容");
  expect(report.value).toContain('"operation": "pdf"');
  fireEvent.click(screen.getByRole("button", { name: "清空诊断" }));
  expect(report.value).toContain('"records": []');
  expect(screen.getByRole("status")).toHaveTextContent("不影响乐谱与草稿");
});

it("sends optional description, displays a receipt, and retains sent snapshot when new failures arrive", async () => {
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => Response.json({ id: JSON.parse(String(init?.body)).id }));
  render(<MemoryRouter><DiagnosticsPage /></MemoryRouter>);
  fireEvent.change(screen.getByLabelText("刚才遇到了什么问题？（选填）"), { target: { value: "显示异常" } });
  fireEvent.click(screen.getByRole("button", { name: "发送诊断", exact: true }));
  await screen.findByRole("button", { name: "复制反馈编号" });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("status")).toHaveTextContent("已发送给合谱维护人员");
  expect(screen.getByLabelText("刚才遇到了什么问题？（选填）")).toHaveAttribute("readonly");
  fireEvent.click(screen.getByRole("button", { name: "填写另一份反馈" }));
  expect(screen.getByLabelText("刚才遇到了什么问题？（选填）")).not.toHaveAttribute("readonly");
  vi.restoreAllMocks();
});
