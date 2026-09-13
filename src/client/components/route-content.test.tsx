import { lazy } from "react";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { RouteContent } from "./route-content";

it("keeps route-specific navigation reachable while preferences load", () => {
  const Pending = lazy(() => new Promise<{ default: () => null }>(() => {}));
  render(<MemoryRouter initialEntries={["/choirs/drive/preferences"]}><RouteContent><Pending /></RouteContent></MemoryRouter>);
  expect(screen.getByRole("heading", { name: "阅读偏好" })).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("正在加载阅读偏好");
  expect(screen.getByRole("link", { name: "返回云盘" })).toHaveAttribute("href", "/choirs/drive");
  expect(screen.queryByRole("button", { name: "重新加载页面" })).not.toBeInTheDocument();
  expect(screen.queryByText("正在打开乐谱…")).not.toBeInTheDocument();
});

it("offers exit and retry when the route module rejects", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const Failed = lazy(() => Promise.reject(new Error("chunk unavailable")));
  try {
    render(<MemoryRouter initialEntries={["/choirs/drive/preferences"]}><RouteContent><Failed /></RouteContent></MemoryRouter>);
    expect(await screen.findByRole("alert")).toHaveTextContent("阅读偏好加载失败");
    expect(screen.getByRole("link", { name: "返回云盘" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新加载页面" })).toBeInTheDocument();
  } finally { error.mockRestore(); }
});

it("shows only the content-first reader shell while the module loads", () => {
  const Pending = lazy(() => new Promise<{ default: () => null }>(() => {}));
  render(<MemoryRouter initialEntries={["/choirs/drive/scores/score"]}><RouteContent><Pending /></RouteContent></MemoryRouter>);
  expect(screen.getByRole("status")).toHaveTextContent("正在打开乐谱");
  expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  expect(screen.queryByText("重新加载页面")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "返回云盘" })).toBeInTheDocument();
});

it("records render failures without serializing private messages or component stacks", async () => {
  const { clearDiagnostics, exportDiagnostics } = await import("../diagnostics/diagnostics");
  clearDiagnostics();
  const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
  function Failed(): never { throw new RangeError("private score name and points"); }
  try {
    render(<MemoryRouter initialEntries={["/choirs/drive/scores/score"]}><RouteContent><Failed /></RouteContent></MemoryRouter>);
    expect(screen.getByRole("alert")).toHaveTextContent("乐谱阅读器加载失败");
    const report = exportDiagnostics();
    expect(report).toContain('"route-render"');
    expect(report).toContain('"RangeError"');
    expect(report).not.toMatch(/private score|points|Failed|\/choirs/);
  } finally { quiet.mockRestore(); clearDiagnostics(); }
});
