import { act, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, Link, Outlet, RouterProvider } from "react-router-dom";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import { NavigationProvider } from "./navigation";
import { useAppNavigation, useExitLayer } from "./navigation-context";
import { Dialog } from "./overlays";
import { Modal, ModalOverlay } from "react-aria-components";

function Page({ save }: { save: () => Promise<boolean> }) {
  const [editing, edit] = useState(true);
  const [open, setOpen] = useState(true);
  useExitLayer(editing, "editing", async () => { if (!await save()) return false; edit(false); return true; });
  const navigation = useAppNavigation();
  return <><button onClick={() => navigation.back("/library")}>返回</button><p>{editing ? "编辑中" : "阅读中"}</p><Link to="/settings">个人设置</Link>
    <ModalOverlay isOpen={open} onOpenChange={setOpen}><Modal><Dialog aria-label="图层">图层<Link to="/settings">打开设置</Link></Dialog></Modal></ModalOverlay></>;
}
function setup(save: () => Promise<boolean>) {
  const router = createMemoryRouter([{ element: <NavigationProvider><Outlet /></NavigationProvider>, children: [
    { path: "/library", element: <h1>云盘</h1> }, { path: "/reader", element: <Page save={save} /> }, { path: "/settings", element: <h1>设置</h1> },
  ] }], { initialEntries: ["/library", "/reader"], initialIndex: 1 });
  render(<RouterProvider router={router} />); return router;
}
it("consumes one overlay then durable editing before history leaves the score", async () => {
  const save = vi.fn(async () => true); const router = setup(save);
  await act(() => router.navigate(-1));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument(); expect(save).not.toHaveBeenCalled();
  await act(() => router.navigate(-1));
  expect(screen.getByText("阅读中")).toBeInTheDocument(); expect(save).toHaveBeenCalledTimes(1);
  await act(() => router.navigate(-1)); expect(screen.getByRole("heading", { name: "云盘" })).toBeInTheDocument();
});
it("keeps the explicit internal target after closing a dialog and saving", async () => {
  const save = vi.fn(async () => true); setup(save);
  fireEvent.click(screen.getByRole("link", { name: "打开设置" }));
  expect(await screen.findByRole("heading", { name: "设置" })).toBeInTheDocument(); expect(save).toHaveBeenCalledTimes(1);
});
it("retains editing and retries when local persistence fails", async () => {
  const save = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true); const router = setup(save);
  await act(() => router.navigate(-1)); await act(() => router.navigate(-1));
  expect(screen.getByText("编辑中")).toBeInTheDocument(); expect(screen.getByRole("alert")).toHaveTextContent("本机保存未完成");
  fireEvent.click(screen.getByRole("button", { name: "重试" })); expect(await screen.findByText("阅读中")).toBeInTheDocument();
});

it("uses the latest explicit destination while one local save is pending", async () => {
  let complete!: (ok: boolean) => void;
  const save = vi.fn(() => new Promise<boolean>(resolve => { complete = resolve; }));
  const router = setup(save);
  await act(() => router.navigate(-1));
  await act(async () => { void router.navigate("/settings"); });
  await act(async () => { void router.navigate("/library"); });
  await act(async () => complete(true));
  expect(await screen.findByRole("heading", { name: "云盘" })).toBeInTheDocument();
  expect(save).toHaveBeenCalledTimes(1);
});

it("retries the original internal destination after a failed save", async () => {
  const save = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true); setup(save);
  fireEvent.click(screen.getByRole("link", { name: "打开设置" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  expect(await screen.findByRole("heading", { name: "设置" })).toBeInTheDocument();
  expect(save).toHaveBeenCalledTimes(2);
});
