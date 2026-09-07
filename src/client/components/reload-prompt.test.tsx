import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { registrationUpdateMock, setRegistrationWaiting, setShouldNeedRefresh, updateServiceWorkerMock } from "../../test/pwa-register-mock";
import { ReloadPrompt, UpdateDetails } from "./reload-prompt";

describe("background updates", () => {
  beforeEach(() => {
    setShouldNeedRefresh(true); setRegistrationWaiting(true);
    updateServiceWorkerMock.mockClear(); registrationUpdateMock.mockClear();
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  });
  it("prepares silently and exposes prepared versus running state only in update details", async () => {
    const view = render(<MemoryRouter><ReloadPrompt /></MemoryRouter>);
    await waitFor(() => expect(registrationUpdateMock).toHaveBeenCalled());
    expect(screen.queryByText("有新版本可用")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    view.rerender(<MemoryRouter><ReloadPrompt /><UpdateDetails /></MemoryRouter>);
    expect(screen.getByText("新版本已准备，将在安全时应用")).toBeInTheDocument();
    expect(updateServiceWorkerMock).not.toHaveBeenCalled();
  });
  it("keeps the current build while offline and lets a failed check be retried", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    render(<MemoryRouter><ReloadPrompt /><UpdateDetails /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
    expect(screen.getByText("当前离线，继续使用当前版本")).toBeInTheDocument();
    expect(updateServiceWorkerMock).not.toHaveBeenCalled();
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    registrationUpdateMock.mockRejectedValueOnce(new Error("network"));
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
    expect(await screen.findByText("更新检查失败，请稍后重试")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
    expect(await screen.findByText("新版本已准备，将在安全时应用")).toBeInTheDocument();
  });
});
