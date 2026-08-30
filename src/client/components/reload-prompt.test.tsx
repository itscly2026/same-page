import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import {
  setShouldNeedRefresh,
  updateServiceWorkerMock,
} from "../../test/pwa-register-mock";
import { ReloadPrompt } from "./reload-prompt";

describe("ReloadPrompt", () => {
  beforeEach(() => {
    setShouldNeedRefresh(true);
    updateServiceWorkerMock.mockClear();
  });

  it("offers an explicit update action when a new service worker is waiting", () => {
    render(<ReloadPrompt />);

    expect(screen.getByText("有新版本可用")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "更新" }));
    expect(updateServiceWorkerMock).toHaveBeenCalledWith(true);
  });
});
