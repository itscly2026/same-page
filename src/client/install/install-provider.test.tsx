import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NavigationProvider } from "../navigation/navigation";
import { InstallProvider } from "./install-provider";
import { InstallButton, InstallSuggestion } from "./install-entry";
import { detectInstallGuide } from "./install-context";

function mount() {
  return render(<MemoryRouter><NavigationProvider><InstallProvider><InstallButton /><InstallSuggestion /></InstallProvider></NavigationProvider></MemoryRouter>);
}
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), clear: () => values.clear() });
});
afterEach(() => { window.localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("keeps manual help available without a native prompt, and copies no invite or auth data", () => {
  mount();
  fireEvent.click(screen.getByRole("button", { name: "安装合谱" }));
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "已了解，打开安装提示" })).not.toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "合谱网址" })).toHaveValue(`${location.origin}/`);
});

it("consumes a deferred prompt once and keeps help after cancellation", async () => {
  mount();
  const prompt = vi.fn().mockResolvedValue({ outcome: "dismissed" });
  const event = new Event("beforeinstallprompt", { cancelable: true });
  Object.defineProperty(event, "prompt", { value: prompt });
  act(() => { window.dispatchEvent(event); });
  expect(event.defaultPrevented).toBe(true);
  expect(prompt).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "安装合谱" }));
  await act(async () => {});
  expect(prompt).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("status")).toHaveTextContent("已取消安装");
  expect(screen.queryByRole("button", { name: "已了解，打开安装提示" })).not.toBeInTheDocument();
  act(() => { window.dispatchEvent(new Event("appinstalled")); });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "安装合谱" })).not.toBeInTheDocument();
});

it("remembers dismissed suggestions while preserving the manual entry", () => {
  window.localStorage.setItem("install-seen-score", "yes");
  const view = mount();
  fireEvent.click(screen.getByRole("button", { name: "暂时不用，关闭安装建议" }));
  view.unmount();
  mount();
  expect(screen.queryByRole("complementary", { name: "安装建议" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "安装合谱" })).toBeInTheDocument();
});

it("hides promotion in the manifest fullscreen display mode", () => {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(display-mode: fullscreen)", addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  mount();
  expect(screen.queryByRole("button", { name: "安装合谱" })).not.toBeInTheDocument();
});

it("recognizes iPad desktop UA, iOS Chrome and embedded browsers independently", () => {
  expect(detectInstallGuide("Macintosh Safari", 5)).toBe("safari");
  expect(detectInstallGuide("iPhone CriOS Safari", 5)).toBe("ios-chrome");
  expect(detectInstallGuide("iPhone MicroMessenger", 5)).toBe("ios-external");
  expect(detectInstallGuide("Android; wv)", 5)).toBe("android-external");
});


it.each(["iPhone MicroMessenger", "Android MicroMessenger"])("only shows WeChat guidance after an install click in %s", (userAgent) => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
  window.localStorage.setItem("install-seen-score", "yes");
  mount();
  expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  expect(screen.queryByText(/微信内无法完成/)).not.toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  const prompt = vi.fn();
  const event = new Event("beforeinstallprompt", { cancelable: true });
  Object.defineProperty(event, "prompt", { value: prompt });
  act(() => { window.dispatchEvent(event); });
  fireEvent.click(screen.getByRole("button", { name: "安装合谱" }));
  expect(screen.getByText(/微信内无法完成/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "复制合谱网址" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "已了解，打开安装提示" })).not.toBeInTheDocument();
  expect(prompt).not.toHaveBeenCalled();
});

it("opens the native prompt directly and keeps actionable Android guidance after cancellation", async () => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Android Chrome");
  mount();
  const prompt = vi.fn().mockResolvedValue({ outcome: "dismissed" });
  const event = new Event("beforeinstallprompt", { cancelable: true });
  Object.defineProperty(event, "prompt", { value: prompt });
  act(() => { window.dispatchEvent(event); });
  fireEvent.click(screen.getByRole("button", { name: "安装合谱" }));
  expect(prompt).toHaveBeenCalledTimes(1);
  await act(async () => {});
  const advice = screen.getByRole("region", { name: "Android 安装前说明" });
  expect(advice).toHaveTextContent("安装前，请检查当前浏览器是否已获准创建桌面快捷方式");
  expect(advice).toHaveTextContent("手机提供此权限项时，请确保已开启");
  expect(advice).toHaveTextContent("权限 / 其他权限");
  expect(screen.getByText(/安装后，请从桌面合谱图标打开/)).toHaveTextContent("外部链接");
});

it("recovers from a failed prompt with manual help and consumes a newly offered event", async () => {
  mount();
  const failed = vi.fn().mockRejectedValue(new Error("unavailable"));
  const event = new Event("beforeinstallprompt", { cancelable: true });
  Object.defineProperty(event, "prompt", { value: failed });
  act(() => window.dispatchEvent(event));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "安装合谱" })));
  expect(screen.getByRole("status")).toHaveTextContent("暂时无法打开安装窗口");
  expect(screen.queryByRole("button", { name: "安装合谱" })).not.toBeInTheDocument();
  const accepted = vi.fn().mockResolvedValue({ outcome: "accepted" });
  const next = new Event("beforeinstallprompt", { cancelable: true });
  Object.defineProperty(next, "prompt", { value: accepted });
  act(() => window.dispatchEvent(next));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "安装合谱" })));
  expect(failed).toHaveBeenCalledTimes(1);
  expect(accepted).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  act(() => window.dispatchEvent(new Event("appinstalled")));
  expect(screen.queryByRole("button", { name: "安装合谱" })).not.toBeInTheDocument();
});
