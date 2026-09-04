import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it } from "vitest";
import DiagnosticsPage from "./diagnostics-page";
import { clearDiagnostics, recordFailure } from "./diagnostics";

beforeEach(clearDiagnostics);

it("lets the user inspect and clear a safe report without touching drafts", () => {
  recordFailure({ operation: "pdf", category: "internal", stage: "decode" });
  render(<MemoryRouter><DiagnosticsPage /></MemoryRouter>);
  const report = screen.getByRole("textbox", { name: "可发送给支持人员的诊断内容" });
  expect(report).toHaveValue(expect.stringContaining('"operation": "pdf"'));
  fireEvent.click(screen.getByRole("button", { name: "清空诊断" }));
  expect(report).toHaveValue(expect.stringContaining('"records": []'));
  expect(screen.getByRole("status")).toHaveTextContent("不影响乐谱与草稿");
});
