import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { authenticatedLocalOwnerKey } from "../platform/local-workspace";
import { OutboxRecoveryCoordinator } from "./outbox-recovery-coordinator";
import {
  OUTBOX_RECOVERY_REQUEST_EVENT,
  recoverAnnotationOutbox,
} from "./outbox-recovery";

vi.mock("./outbox-recovery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./outbox-recovery")>();
  return { ...actual, recoverAnnotationOutbox: vi.fn() };
});

describe("OutboxRecoveryCoordinator", () => {
  beforeEach(() => {
    vi.mocked(recoverAnnotationOutbox).mockReset();
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
  });

  it("coalesces repeated legal events without concurrent scans", async () => {
    let active = 0;
    let maximumActive = 0;
    const releases: Array<() => void> = [];
    vi.mocked(recoverAnnotationOutbox).mockImplementation(
      () =>
        new Promise((resolve) => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          releases.push(() => {
            active -= 1;
            resolve({} as Awaited<ReturnType<typeof recoverAnnotationOutbox>>);
          });
        }),
    );
    render(
      <OutboxRecoveryCoordinator
        ownerKey={authenticatedLocalOwnerKey("user-a")}
      />,
    );
    await vi.waitFor(() => expect(recoverAnnotationOutbox).toHaveBeenCalledTimes(1));

    window.dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event(OUTBOX_RECOVERY_REQUEST_EVENT));
    expect(recoverAnnotationOutbox).toHaveBeenCalledTimes(1);
    await act(async () => releases.shift()?.());
    await vi.waitFor(() => expect(recoverAnnotationOutbox).toHaveBeenCalledTimes(2));
    expect(maximumActive).toBe(1);
    await act(async () => releases.shift()?.());
  });

  it("does not scan while offline or hidden", async () => {
    Object.defineProperty(navigator, "onLine", { value: false });
    render(
      <OutboxRecoveryCoordinator
        ownerKey={authenticatedLocalOwnerKey("user-a")}
      />,
    );
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event(OUTBOX_RECOVERY_REQUEST_EVENT));
    expect(recoverAnnotationOutbox).not.toHaveBeenCalled();
  });

  it("stops scheduling the previous owner after identity changes", async () => {
    vi.mocked(recoverAnnotationOutbox).mockResolvedValue(
      {} as Awaited<ReturnType<typeof recoverAnnotationOutbox>>,
    );
    const view = render(
      <OutboxRecoveryCoordinator
        ownerKey={authenticatedLocalOwnerKey("user-a")}
      />,
    );
    await vi.waitFor(() => expect(recoverAnnotationOutbox).toHaveBeenCalledTimes(1));
    view.rerender(
      <OutboxRecoveryCoordinator
        ownerKey={authenticatedLocalOwnerKey("user-b")}
      />,
    );
    await vi.waitFor(() => expect(recoverAnnotationOutbox).toHaveBeenCalledTimes(2));
    window.dispatchEvent(new Event("online"));
    await vi.waitFor(() => expect(recoverAnnotationOutbox).toHaveBeenCalledTimes(3));
    expect(vi.mocked(recoverAnnotationOutbox).mock.calls.at(-1)?.[0]).toBe(
      authenticatedLocalOwnerKey("user-b"),
    );
  });
});
