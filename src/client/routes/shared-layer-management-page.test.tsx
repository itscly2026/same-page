import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { effectiveCapabilities, emptyPermissions } from "../../shared/drive-permissions";
import SharedLayerManagementPage from "./shared-layer-management-page";
vi.mock("../auth/auth-client", () => ({ authClient: { useSession: () => ({ data: { user: { id: "owner" } }, isPending: false }) } }));
afterEach(() => vi.unstubAllGlobals());
it("keeps warm layer rows and retries the failed authority read before reenabling mutations", async () => {
  let failAccess = false;
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async input => {
    if (String(input).endsWith("/management")) return failAccess ? new Response(null, { status: 503 }) : Response.json({ name: "云盘", guestAdmissionMode: "open", capabilities: effectiveCapabilities(true, emptyPermissions(), emptyPermissions()), layers: [] });
    return Response.json({ drive: { id: "drive", name: "云盘" }, sharedLayerRevision: 0, activeSharedSlots: ["E"], layers: [{ slot: "E", name: "Ensemble", defaultColor: "#dc2626", grantedMemberCount: 0, sortOrder: 0, active: true, revision: 0, deletedAt: null, recoverUntil: null }] });
  }));
  const view = () => <MemoryRouter initialEntries={["/choirs/drive/shared-layers"]}><Routes><Route path="/choirs/:choirId/shared-layers" element={<SharedLayerManagementPage />} /></Routes></MemoryRouter>;
  const first = render(view());
  await waitFor(() => expect(screen.getByRole("button", { name: "删除 Ensemble" })).toBeEnabled());
  first.unmount(); failAccess = true;
  render(view());
  await screen.findByText("无法更新共享层，请重试。");
  expect(screen.getByRole("link", { name: /Ensemble/ })).toBeVisible();
  expect(screen.getByRole("button", { name: "删除 Ensemble" })).toBeDisabled();
  failAccess = false;
  fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "删除 Ensemble" })).toBeEnabled());
});
