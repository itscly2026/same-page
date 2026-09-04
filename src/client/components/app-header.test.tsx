import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, it } from "vitest";

import DiagnosticsPage from "../diagnostics/diagnostics-page";
import { clearDiagnostics, recordFailure } from "../diagnostics/diagnostics";
import { AppHeader } from "./app-header";

afterEach(clearDiagnostics);

it("opens diagnostics from help without losing the current session's records", async () => {
  render(
    <MemoryRouter>
      <Routes>
        <Route path="/" element={<AppHeader />} />
        <Route path="/diagnostics" element={<DiagnosticsPage />} />
      </Routes>
    </MemoryRouter>,
  );
  recordFailure({ operation: "pdf", category: "network" });
  expect(screen.queryByRole("link", { name: "故障诊断" })).not.toBeInTheDocument();
  expect(screen.queryByText("隐私政策")).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "帮助与关于" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "故障诊断" }));

  const report = await screen.findByRole<HTMLTextAreaElement>("textbox", {
    name: "可发送给支持人员的诊断内容",
  });
  expect(JSON.parse(report.value).records).toEqual([
    expect.objectContaining({ operation: "pdf", category: "network" }),
  ]);
});
