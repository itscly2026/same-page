import { noCapabilities, effectiveCapabilities, emptyPermissions } from "../../shared/drive-permissions";
import { useLayoutEffect, useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { clearDriveLibraryCache, rememberDriveLibrary } from "./drive-library-cache";
import { readLibraryView, rememberLibraryView } from "./library-view-state";
import { useDriveLibrary } from "./use-drive-library";
import { LocalIdentityObserver } from "../platform/local-identity-observer";

const observerState = vi.hoisted(() => ({ userId: undefined as string | undefined }));
vi.mock("../auth/auth-client", () => ({
  authClient: { useSession: () => ({ data: observerState.userId ? { user: { id: observerState.userId } } : null }) },
}));
vi.mock("../platform/local-workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../platform/local-workspace")>();
  return { ...actual, activateAuthenticatedLocalOwner: vi.fn(async (userId: string) => `user:${userId}` as const) };
});
vi.mock("../annotations/outbox-recovery-coordinator", () => ({ OutboxRecoveryCoordinator: () => null }));

const owner = "guest:drive-one";
const drive = "drive-one";

afterEach(() => { clearDriveLibraryCache(); vi.unstubAllGlobals(); });

it("detaches the departing library before the next route resets document scroll", async () => {
  clearDriveLibraryCache();
  window.sessionStorage.clear();
  rememberLibraryView(owner, drive, { search: "", sort: "name", scrollTop: 320 });
  rememberDriveLibrary(owner, drive, {
    choir: { id: drive, name: "排练云盘", guestAdmissionMode: "open" },
    result: { scores: [], storage: { usedBytes: 0, limitBytes: 1000 }, permissions: { capabilities: noCapabilities() } },
  });
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
  vi.stubGlobal("scrollY", 320);

  function Library({ leave }: { leave(): void }) {
    const { library, snapshot } = useDriveLibrary(owner, drive, false, true);
    return snapshot.access.kind === "opened"
      ? <button onClick={() => { library.prepareScoreOpen(window.scrollY); leave(); }}>打开乐谱</button>
      : <p>正在加载</p>;
  }
  function Navigation() {
    const [inLibrary, setInLibrary] = useState(true);
    // App's RouteScrollReset runs in the new route's layout phase. Dispatching
    // the scroll here pins the browser event before passive-effect cleanup.
    useLayoutEffect(() => {
      if (inLibrary) return;
      vi.stubGlobal("scrollY", 0);
      window.dispatchEvent(new Event("scroll"));
    }, [inLibrary]);
    return inLibrary ? <Library leave={() => setInLibrary(false)} /> : <p>阅读器</p>;
  }

  render(<Navigation />);
  await screen.findByRole("button", { name: "打开乐谱" });
  await waitFor(() => expect(document.documentElement.scrollTop).toBe(320));
  fireEvent.click(screen.getByRole("button", { name: "打开乐谱" }));
  expect(screen.getByText("阅读器")).toBeInTheDocument();
  expect(readLibraryView(owner, drive).scrollTop).toBe(320);
});


it("starts the new owner's library after the identity observer clears previous caches", async () => {
  clearDriveLibraryCache();
  observerState.userId = undefined;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    if (String(input).endsWith("/api/guest/session")) return new Response(null, { status: 204 });
    return Response.json({
      choir: { id: drive, name: "排练云盘", guestAdmissionMode: "open" },
      scores: [], storage: { usedBytes: 0, limitBytes: 1000 },
      permissions: { capabilities: effectiveCapabilities(Boolean(observerState.userId), emptyPermissions(), emptyPermissions()), access: observerState.userId ? "membership" : "guest" },
    });
  }));
  function Library() {
    const signedIn = Boolean(observerState.userId);
    const { library, snapshot } = useDriveLibrary(signedIn ? "user:one" : owner, drive, signedIn, true);
    return <>
      <p>{snapshot.access.kind === "opened" ? snapshot.access.isMember ? "成员文件库" : "访客文件库" : "正在加载"}</p>
      <input aria-label="搜索乐谱" value={snapshot.view.search} onChange={event => library.setSearch(event.target.value)} />
    </>;
  }
  function App() { return <><LocalIdentityObserver /><Library /></>; }
  const view = render(<App />);
  await screen.findByText("访客文件库");
  observerState.userId = "one";
  view.rerender(<App />);
  await screen.findByText("成员文件库");
  fireEvent.change(screen.getByRole("textbox", { name: "搜索乐谱" }), { target: { value: "秋日" } });
  expect(readLibraryView("user:one", drive).search).toBe("秋日");
});

it("shares an unfinished library read across a route handoff and fences a same-user replacement session", async () => {
  const { act } = await import("@testing-library/react");
  const { observeNavigationSession } = await import("../settings/navigation-events");
  observeNavigationSession("one:session-one");
  let finish!: (response: Response) => void;
  const fetch = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
  vi.stubGlobal("fetch", fetch);
  function Library({ sessionId }: { sessionId: string }) {
    const { snapshot } = useDriveLibrary("user:one", drive, true, true, sessionId);
    return <p>{snapshot.access.kind === "opened" && snapshot.access.isMember ? snapshot.access.choir.name : "pending"}</p>;
  }
  const one = render(<Library sessionId="session-one" />);
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  one.unmount();
  const two = render(<Library sessionId="session-one" />);
  expect(fetch).toHaveBeenCalledTimes(1);
  const oldResponse = finish;
  act(() => observeNavigationSession("one:session-two"));
  two.rerender(<Library sessionId="session-two" />);
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  const payload = (name: string) => Response.json({ choir: { id: drive, name, guestAdmissionMode: "open" }, scores: [], storage: { usedBytes: 0, limitBytes: 1000 }, permissions: { capabilities: noCapabilities(), access: "membership" } });
  await act(async () => { oldResponse(payload("old session")); });
  expect(screen.queryByText("old session")).not.toBeInTheDocument();
  await act(async () => { finish(payload("new session")); });
  await screen.findByText("new session");
});

it("does not let a departing lifetime stop a library retained after an identity reset", async () => {
  const { sharedDriveLibrary, retainDriveLibrary } = await import("./shared-drive-library");
  const { resetNavigation } = await import("../settings/navigation-events");
  resetNavigation();
  const pending: Array<(response: Response) => void> = [];
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => pending.push(resolve))));
  const library = sharedDriveLibrary("user:one", drive, "session");
  library.setAuthenticated(true);
  const leave = retainDriveLibrary(library);
  await waitFor(() => expect(pending).toHaveLength(1));
  leave();
  // A layout reset can occur after render selected this instance, before mount.
  resetNavigation();
  const release = retainDriveLibrary(library);
  await waitFor(() => expect(pending).toHaveLength(2));
  pending[0](Response.json({}));
  await Promise.resolve(); await Promise.resolve();
  pending[1](Response.json({ choir: { id: drive, name: "current", guestAdmissionMode: "open" }, scores: [], storage: { usedBytes: 0, limitBytes: 1000 }, permissions: { capabilities: noCapabilities(), access: "membership" } }));
  await library.whenSettled();
  expect(library.getSnapshot().access).toMatchObject({ kind: "opened", choir: { name: "current" } });
  release();
});
