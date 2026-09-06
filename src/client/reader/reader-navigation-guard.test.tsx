import { act, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { expect, it } from "vitest";
import { ReaderNavigationGuard } from "./reader-navigation-guard";

it("blocks history navigation until the editor can preserve its contents", async () => {
  const router = createMemoryRouter([
    { path: "/library", element: <h1>云盘</h1> },
    { path: "/reader", element: <><ReaderNavigationGuard editing /><textarea aria-label="未保存文字" defaultValue="待重试草稿" /></> },
  ], { initialEntries: ["/library", "/reader"], initialIndex: 1 });
  render(<RouterProvider router={router} />);
  await act(async () => { await router.navigate(-1); });
  expect(await screen.findByRole("dialog", { name: "请先完成编辑" })).toBeInTheDocument();
  expect(router.state.location.pathname).toBe("/reader");
  fireEvent.click(screen.getByRole("button", { name: "返回编辑器" }));
  expect(screen.getByRole("textbox", { name: "未保存文字" })).toHaveValue("待重试草稿");
});
