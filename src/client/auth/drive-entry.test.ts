import { afterEach, expect, it, vi } from "vitest";
import { enterDrive, joinDrive, resumeDriveEntry, openDriveAdmission } from "./drive-entry";
const choir = { id: "drive", name: "排练", guestAdmissionMode: "open" as const };
afterEach(() => vi.unstubAllGlobals());
function service({ authenticated = true, preview = false, member = false } = {}) {
  let guest = false, joined = member, unavailable = false;
  const api = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/guest/choirs/drive") return Response.json({ choir, entryKind: preview ? "preview" : "admission" });
    if (url === "/api/guest/session") {
      if (init?.method === "POST") guest = true;
      if (init?.method === "DELETE") { guest = false; return new Response(null, { status: 204 }); }
      return guest ? Response.json({ choir, entryKind: preview ? "preview" : "admission" }) : new Response(null, { status: 404 });
    }
    if (unavailable) return new Response(null, { status: 503 });
    if (url === "/api/choirs/current-guest/join-state") return guest && authenticated ? Response.json({ choir, status: joined ? "joined" : "display-name-required" }) : new Response(null, { status: 401 });
    if (url === "/api/choirs/join-current-guest" || url === "/api/choirs/join") { joined = true; return Response.json({ choir }); }
    throw new Error("unexpected request");
  });
  vi.stubGlobal("fetch", api);
  return { api, hasGuest: () => guest, isMember: () => joined, unavailable: (value: boolean) => { unavailable = value; } };
}
it("retains read-only guest intent through login, then asks for a name before membership", async () => {
  const api = service();
  expect(await enterDrive({ admission: "open", choirId: "drive" }, false)).toEqual({ kind: "enter", choir });
  expect(api.isMember()).toBe(false);
  expect(await resumeDriveEntry()).toEqual({ kind: "display-name", choir });
  expect(await joinDrive({ kind: "guest", choirId: "drive" }, "小花")).toMatchObject({ kind: "enter" });
  expect(api.isMember()).toBe(true);
  expect(api.hasGuest()).toBe(false);
});
it.each([{ member: true }, { preview: true }])("enters an existing membership or preview without creating a membership", async options => {
  const api = service(options);
  expect(await enterDrive({ admission: "open", choirId: "drive" }, true)).toEqual({ kind: "enter", choir });
  expect(api.isMember()).toBe(Boolean(options.member));
  expect(api.hasGuest()).toBe(false);
});
it("preserves continuation through a temporary failure and supports retry", async () => {
  const api = service();
  await enterDrive({ admission: "open", choirId: "drive" }, false);
  api.unavailable(true);
  expect(await resumeDriveEntry()).toMatchObject({ kind: "failed", restart: false });
  expect(api.hasGuest()).toBe(true);
  api.unavailable(false);
  expect(await resumeDriveEntry()).toEqual({ kind: "display-name", choir });
});
it("does not create a guest session for authenticated ordinary open admission", async () => {
  const api = service();
  expect(await openDriveAdmission("drive", true, new AbortController().signal)).toEqual({ kind: "display-name", choir });
  expect(api.hasGuest()).toBe(false);
  expect(api.isMember()).toBe(false);
});
