import { afterEach, expect, it, vi } from "vitest";
import { driveLibraryTransport } from "./drive-library-transport";
afterEach(() => vi.unstubAllGlobals());
it("does not turn confirmed removed membership into an open admission form", async () => {
  const fetch = vi.fn(async (url: string) => url.endsWith("/bootstrap")
    ? Response.json({ error: "membership_requires_admin" }, { status: 403 })
    : Response.json({ choir: { id: "drive", name: "排练", guestAdmissionMode: "open" }, entryKind: "admission" }));
  vi.stubGlobal("fetch", fetch);
  expect(await driveLibraryTransport("drive").load(new AbortController().signal, true, true)).toMatchObject({ kind: "denied" });
});
it("keeps an expired authenticated session distinct from confirmed access revocation", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "authentication_required" }, { status: 403 })));
  expect(await driveLibraryTransport("drive").load(new AbortController().signal, true, true)).toEqual({ kind: "failed", authenticationRequired: true });
});
