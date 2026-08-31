import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { authClient } from "../auth/auth-client";
import { activateAuthenticatedLocalOwner } from "./local-workspace";
import { LocalIdentityObserver } from "./local-identity-observer";

const observerState = vi.hoisted(() => ({
  userId: "user-a" as string | undefined,
  mounts: vi.fn(),
}));

vi.mock("../auth/auth-client", () => ({
  authClient: {
    useSession: vi.fn(() => ({
      data: observerState.userId
        ? { user: { id: observerState.userId } }
        : null,
      isPending: false,
    })),
  },
}));

vi.mock("./local-workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./local-workspace")>();
  return { ...actual, activateAuthenticatedLocalOwner: vi.fn() };
});

vi.mock("../annotations/outbox-recovery-coordinator", async () => {
  const { useEffect } = await import("react");
  return {
    OutboxRecoveryCoordinator: () => {
      useEffect(() => {
        observerState.mounts();
      }, []);
      return null;
    },
  };
});

describe("LocalIdentityObserver", () => {
  beforeEach(() => {
    observerState.userId = "user-a";
    observerState.mounts.mockReset();
    vi.mocked(authClient.useSession).mockClear();
    vi.mocked(activateAuthenticatedLocalOwner).mockReset();
  });

  it("waits for a fresh activation when the same user returns", async () => {
    type OwnerKey = Awaited<
      ReturnType<typeof activateAuthenticatedLocalOwner>
    >;
    const ownerKey = "user:user-a" as OwnerKey;
    let releaseSecondActivation!: (ownerKey: OwnerKey) => void;
    vi.mocked(activateAuthenticatedLocalOwner)
      .mockResolvedValueOnce(ownerKey)
      .mockReturnValueOnce(
        new Promise((resolve) => {
          releaseSecondActivation = resolve;
        }),
      );
    const view = render(<LocalIdentityObserver />);
    await vi.waitFor(() => expect(observerState.mounts).toHaveBeenCalledTimes(1));

    observerState.userId = undefined;
    view.rerender(<LocalIdentityObserver />);
    observerState.userId = "user-a";
    view.rerender(<LocalIdentityObserver />);
    await vi.waitFor(() =>
      expect(activateAuthenticatedLocalOwner).toHaveBeenCalledTimes(2),
    );
    expect(observerState.mounts).toHaveBeenCalledTimes(1);

    releaseSecondActivation(ownerKey);
    await vi.waitFor(() => expect(observerState.mounts).toHaveBeenCalledTimes(2));
  });
});
