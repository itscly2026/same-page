import { afterEach, describe, expect, it, vi } from "vitest";

import { clearPreviewGuestSession } from "./preview-guest-session";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("preview guest session lifecycle", () => {
  it("clears preview access when returning home or opening another choir", async () => {
    const fetchMock = vi.fn().mockImplementation((_input: string, init?: RequestInit) =>
      Promise.resolve(
        init?.method === "DELETE"
          ? new Response(null, { status: 204 })
          : previewSessionResponse(),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(clearPreviewGuestSession()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("/api/guest/session", { method: "DELETE" });

    fetchMock.mockClear();
    await expect(
      clearPreviewGuestSession({ keepForChoirId: "member-choir" }),
    ).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("/api/guest/session", { method: "DELETE" });
  });

  it("keeps preview access while opening the same preview choir", async () => {
    const fetchMock = vi.fn().mockResolvedValue(previewSessionResponse());
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      clearPreviewGuestSession({ keepForChoirId: "preview-choir" }),
    ).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

function previewSessionResponse() {
  return Response.json({
    choir: {
      id: "preview-choir",
      name: "公开体验云盘",
      guestAdmissionMode: "open",
    },
    entryKind: "preview",
  });
}
