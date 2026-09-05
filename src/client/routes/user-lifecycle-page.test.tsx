import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveAnnotationDraft, visibleLocalAnnotations } from "../annotations/annotation-state";
import { activateAuthenticatedLocalOwner, createLocalWorkspace, currentLocalOwnerKey } from "../platform/local-workspace";
import UserLifecyclePage from "./user-lifecycle-page";

const identity = vi.hoisted(() => ({ id: "user-a" }));
vi.mock("../auth/auth-client", () => ({ authClient: {
  useSession: () => ({ data: { user: { id: identity.id } }, isPending: false }),
  getSession: vi.fn().mockResolvedValue({ data: null }),
} }));
beforeEach(() => { identity.id = "user-a"; });
afterEach(() => vi.unstubAllGlobals());
function api() {
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => init?.method === "POST"
    ? new Response(null, { status: 204 })
    : Response.json({ userId: identity.id, deletion: null, reauthenticated: true, methods: ["credential"], memberships: [] }));
  vi.stubGlobal("fetch", fetch); return fetch;
}
const page = () => <MemoryRouter><UserLifecyclePage /></MemoryRouter>;

describe("user deletion confirmation and local drafts", () => {
  it("preserves the original user's draft while disconnecting identity and isolates a subsequent user", async () => {
    const fetch = api();
    const owner = await activateAuthenticatedLocalOwner("user-a");
    const a = createLocalWorkspace(owner, "drive", "score");
    await saveAnnotationDraft(a, { id: "draft", layerId: "personal-a", payload: { kind: "text", pageNumber: 1, x: 0.1, y: 0.2, fontScale: 0.024, text: "未同步草稿" } });
    render(page());
    fireEvent.click(await screen.findByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "确认删除用户" }));
    await screen.findByText(/用户已停用。本机未同步草稿仍保留/);
    expect(await currentLocalOwnerKey()).toBeNull();
    expect(fetch).toHaveBeenCalledWith("/api/user/lifecycle/delete", expect.objectContaining({ body: JSON.stringify({ confirm: true, expectedUserId: "user-a" }) }));
    const b = createLocalWorkspace(await activateAuthenticatedLocalOwner("user-b"), "drive", "score");
    expect(await visibleLocalAnnotations(b)).toEqual([]);
    await activateAuthenticatedLocalOwner("user-a");
    expect(await visibleLocalAnnotations(a)).toMatchObject([{ state: "draft", payload: { text: "未同步草稿" } }]);
  });

  it("requires new consent after switching users", async () => {
    api(); const view = render(page());
    fireEvent.click(await screen.findByRole("checkbox"));
    expect(screen.getByRole("button", { name: "确认删除用户" })).not.toBeDisabled();
    identity.id = "user-b";
    view.rerender(page());
    await waitFor(() => expect(screen.getByRole("button", { name: "确认删除用户" })).toBeDisabled());
    expect(screen.getByRole("checkbox")).not.toBeChecked();
  });
});
