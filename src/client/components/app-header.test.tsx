import HelpPage from "../routes/help-page";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, it } from "vitest";

import DiagnosticsPage from "../diagnostics/diagnostics-page";
import { clearDiagnostics, recordFailure } from "../diagnostics/diagnostics";
import { AppFooter } from "./app-footer";
import { AppHeader } from "./app-header";

afterEach(clearDiagnostics);

it("opens diagnostics through help from the footer without losing the current session's records", async () => {
  render(
    <MemoryRouter>
      <Routes>
        <Route path="/" element={<><AppHeader /><AppFooter /></>} />
        <Route path="/help" element={<HelpPage />} />
        <Route path="/diagnostics" element={<DiagnosticsPage />} />
      </Routes>
    </MemoryRouter>,
  );
  recordFailure({ operation: "pdf", category: "network" });
  expect(within(screen.getByRole("banner")).queryByRole("button", { name: "帮助与关于" })).not.toBeInTheDocument();
  expect(within(screen.getByRole("banner")).queryByRole("link", { name: "故障诊断" })).not.toBeInTheDocument();
  fireEvent.click(within(screen.getByRole("contentinfo")).getByRole("link", { name: "帮助" }));
  fireEvent.click(await screen.findByRole("link", { name: "故障诊断" }));

  const report = await screen.findByRole<HTMLTextAreaElement>("textbox", {
    name: "可发送给支持人员的诊断内容",
  });
  expect(JSON.parse(report.value).records).toEqual([
    expect.objectContaining({ operation: "pdf", category: "network" }),
  ]);
});
