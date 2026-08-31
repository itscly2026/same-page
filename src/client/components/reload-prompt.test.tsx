import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import {
  registrationUpdateMock,
  setShouldNeedRefresh,
  updateServiceWorkerMock,
} from "../../test/pwa-register-mock";
import { ReloadPrompt } from "./reload-prompt";

describe("ReloadPrompt", () => {
  beforeEach(() => {
    setShouldNeedRefresh(true);
    updateServiceWorkerMock.mockClear();
    registrationUpdateMock.mockClear();
  });

  it("offers an explicit update action when a new service worker is waiting", () => {
    render(<ReloadPrompt />);

    expect(screen.getByText("有新版本可用")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "更新" }));
    expect(updateServiceWorkerMock).toHaveBeenCalledWith(true);
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
});
