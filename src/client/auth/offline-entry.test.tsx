import { LocalIdentityObserver } from "../platform/local-identity-observer";
import { clearPrivateLocalDataAfterLogout } from "./logout-local-data";
import { render, screen, waitFor, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { AppRoutes } from "../app";
import { authClient } from "./auth-client";
import { localDatabase } from "../platform/local-database";
import { activateAuthenticatedLocalOwner, authenticatedLocalOwnerKey, createLocalWorkspace } from "../platform/local-workspace";
import { clearDriveLibraryCache } from "../score-library/drive-library-cache";

beforeEach(async () => {
  await localDatabase.open();
  clearDriveLibraryCache();
  authClient.$store.atoms.session.set({ ...authClient.$store.atoms.session.get(), data: null, error: null, isPending: true, isRefetching: false });
});
afterEach(() => vi.unstubAllGlobals());
async function saved(userId = "a") {
  await activateAuthenticatedLocalOwner(userId);
  await localDatabase.offlineScores.put({ key: userId, ...createLocalWorkspace(authenticatedLocalOwnerKey(userId), "drive", "score"),
    versionId: "version", fileName: `${userId}.pdf`, sha256: "verify-on-open", pageCount: 1, blob: new Blob(["verify-on-open"]), active: 1, verifiedAt: 1,
    annotationSnapshot: { layers: [], annotations: [], cursor: 0, verifiedAt: 1 } });
}
function open(path = "/") {
  const view = render(<MemoryRouter initialEntries={[path]}><LocalIdentityObserver /><AppRoutes /></MemoryRouter>);
  act(() => { void authClient.$store.atoms.session.get().refetch(); });
  return view;
}

it("offers the last local user's saved score after a cold-start network failure", async () => {
  await saved();
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
  open();
  expect(await screen.findByRole("link", { name: /a.pdf/ })).toHaveAttribute("href", "/choirs/drive/scores/score");
  await screen.findByText(/暂时无法连接/);
  expect(screen.queryByRole("heading", { name: "Harmony begins on the Same Page" })).not.toBeInTheDocument();
});

it("opens saved content at a drive deep link while authentication is still pending", async () => {
  await saved();
  let finish!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
  open("/choirs/drive");
  expect(await screen.findByRole("link", { name: /a.pdf/ })).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "登录或注册" })).not.toBeInTheDocument();
  await waitFor(() => expect(finish).toBeDefined());
  await act(async () => finish(Response.json(null)));
});

function authenticatedResponse(userId = "a") {
  return Response.json({ user: { id: userId, name: "Singer", email: "singer@example.test", emailVerified: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    session: { id: "test-session", userId, token: "test-only", expiresAt: new Date(Date.now() + 3600000).toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } });
}
const bootstrap = { choir: { id: "drive", name: "排练云盘", guestAdmissionMode: "invite" },
  scores: [{ id: "remote", choirId: "drive", fileName: "cloud.pdf", updatedAt: 1, currentVersion: { id: "v", versionNumber: 1, sizeBytes: 1, sha256: "sha", etag: "etag", pageCount: 1, createdAt: 1 } }],
  storage: { usedBytes: 1, limitBytes: 1000 }, permissions: { access: "membership", canManage: true } };
it("retains navigation metadata across a cold start without claiming cloud files are downloaded", async () => {
  await saved();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("get-session")) return authenticatedResponse();
    if (url.endsWith("/bootstrap")) return Response.json(bootstrap);
    return Response.json({});
  }));
  const view = open("/choirs/drive");
  await screen.findByRole("heading", { name: "排练云盘" });
  view.unmount();
  clearDriveLibraryCache();
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
  authClient.$store.atoms.session.set({ ...authClient.$store.atoms.session.get(), data: null, isPending: true });
  open("/choirs/drive");
  await screen.findByText("cloud.pdf");
  expect(screen.queryByRole("link", { name: /cloud.pdf/ })).not.toBeInTheDocument();
  expect(screen.getByText("需联网下载")).toBeInTheDocument();
  expect(await screen.findByRole("link", { name: /a.pdf/ })).toBeInTheDocument();
});

it.each([503, 401, 200])("keeps local files when cold-start authentication returns %s", async status => {
  await saved();
  vi.stubGlobal("fetch", vi.fn(async () => status === 200 ? Response.json(null) : Response.json({ message: "unavailable" }, { status })));
  open();
  await screen.findByRole("link", { name: /a.pdf/ });
  await screen.findByText(status === 503 ? /暂时无法连接/ : /重新登录后同步/);
  expect(screen.queryByRole("heading", { name: "Harmony begins on the Same Page" })).not.toBeInTheDocument();
});

it("rechecks the same user on reconnect and keeps the drive route", async () => {
  await saved();
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
  open("/choirs/drive");
  await screen.findByText(/暂时无法连接/);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).includes("get-session")) return authenticatedResponse();
    if (String(input).endsWith("/bootstrap")) return Response.json(bootstrap);
    return Response.json({ memberships: [] });
  }));
  act(() => window.dispatchEvent(new Event("offline")));
  act(() => window.dispatchEvent(new Event("online")));
  await screen.findByRole("heading", { name: "排练云盘" });
  expect(screen.getByRole("link", { name: /cloud.pdf/ })).toHaveAttribute("href", "/choirs/drive/scores/remote");
});

it("does not reveal the former user's saved list when another user authenticates", async () => {
  await saved();
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
  open();
  await screen.findByRole("link", { name: /a.pdf/ });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).includes("get-session") ? authenticatedResponse("b") : Response.json({ memberships: [] })));
  await act(async () => { await authClient.$store.atoms.session.get().refetch(); });
  await screen.findByText(/还没有已加入的云盘/);
  expect(screen.queryByText("a.pdf")).not.toBeInTheDocument();
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
  await act(async () => { await authClient.$store.atoms.session.get().refetch(); });
  await screen.findByText(/本机尚未保存/);
  expect(screen.queryByText("a.pdf")).not.toBeInTheDocument();
});

it("does not recover the previous user's directory after explicit local logout cleanup", async () => {
  await saved();
  await clearPrivateLocalDataAfterLogout();
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(null)));
  open();
  await screen.findByRole("heading", { name: "Harmony begins on the Same Page" });
  expect(screen.queryByText("a.pdf")).not.toBeInTheDocument();
});
