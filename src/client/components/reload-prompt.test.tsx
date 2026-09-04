import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import {
  registrationUpdateMock,
  setRegistrationWaiting,
  setShouldNeedRefresh,
  updateServiceWorkerMock,
} from "../../test/pwa-register-mock";
import { ReloadPrompt } from "./reload-prompt";

describe("ReloadPrompt", () => {
  beforeEach(() => {
    setShouldNeedRefresh(true);
    setRegistrationWaiting(true);
    updateServiceWorkerMock.mockClear();
    registrationUpdateMock.mockClear();
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: true,
    });
  });

  it("offers an explicit update action when a new service worker is waiting", () => {
    render(<ReloadPrompt />);

    expect(screen.getByText("有新版本可用")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "更新" }));
    expect(updateServiceWorkerMock).toHaveBeenCalledWith(true);
    expect(screen.getByText("正在更新…")).toBeInTheDocument();
  });

  it("keeps the old build usable when the device goes offline", () => {
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: false,
    });

    render(<ReloadPrompt />);
    fireEvent.click(screen.getByRole("button", { name: "更新" }));

    expect(updateServiceWorkerMock).not.toHaveBeenCalled();
    expect(screen.getByText("当前离线，联网后可重试更新")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });

  it("recovers when the waiting service worker is no longer available", async () => {
    setRegistrationWaiting(false);

    render(<ReloadPrompt />);
    fireEvent.click(screen.getByRole("button", { name: "更新" }));

    expect(updateServiceWorkerMock).not.toHaveBeenCalled();
    expect(await screen.findByText("更新尚未准备好，请重试")).toBeInTheDocument();
  });

  it("checks for an update after registration and when returning to the foreground", async () => {
    setShouldNeedRefresh(false);
    let visibilityState: DocumentVisibilityState = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibilityState,
    });

    render(<ReloadPrompt />);
    await waitFor(() => expect(registrationUpdateMock).toHaveBeenCalledTimes(1));

    visibilityState = "hidden";
    fireEvent(document, new Event("visibilitychange"));
    expect(registrationUpdateMock).toHaveBeenCalledTimes(1);

    visibilityState = "visible";
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(registrationUpdateMock).toHaveBeenCalledTimes(2));
  });

  it("shows a recoverable status when the background update check fails", async () => {
    setShouldNeedRefresh(false);
    registrationUpdateMock.mockRejectedValueOnce(new Error("offline"));

    render(<ReloadPrompt />);

    expect(
      await screen.findByText("更新检查失败，请稍后重试"),
    ).toBeInTheDocument();
    registrationUpdateMock.mockResolvedValueOnce(undefined);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(registrationUpdateMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("更新检查失败，请稍后重试")).not.toBeInTheDocument();
  });
});
