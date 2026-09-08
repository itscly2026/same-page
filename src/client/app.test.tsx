import { effectiveCapabilities, emptyPermissions, noCapabilities } from "../shared/drive-permissions";
import { Blob as NodeBlob } from "node:buffer";
import { cacheAnnotationLayers, readAnnotationLayers, saveAnnotationDraft } from "./annotations/annotation-state";
import type { AnnotationLayerSummary } from "../shared/annotations";
import { captureOfflineAnnotationSnapshot } from "./annotations/offline-snapshot";
import { StrictMode } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, Link, MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppRoutes } from "./app";
import { authClient } from "./auth/auth-client";
import { localDatabase } from "./platform/local-database";
import {
  activateAuthenticatedLocalOwner,
  authenticatedLocalOwnerKey,
  createLocalWorkspace,
  localWorkspaceRecordKey,
} from "./platform/local-workspace";
import {
  clearReaderScoreCache,
  peekReaderScore,
} from "./reader/reader-score-cache";
import {
  clearDriveLibraryCache,
  driveCacheOwnerKey,
  rememberDriveSummary,
} from "./score-library/drive-library-cache";

const localWorkspace = createLocalWorkspace(
  authenticatedLocalOwnerKey("user-1"),
  "choir-1",
  "score-1",
);

vi.mock("./auth/auth-client", () => ({
  authClient: {
    useSession: vi.fn(),
    signOut: vi.fn(),
  },
}));

describe("AppRoutes", () => {
  beforeEach(async () => {
    clearReaderScoreCache();
    clearDriveLibraryCache();
    window.sessionStorage.clear();
    await localDatabase.open();
    vi.mocked(authClient.useSession).mockReturnValue({
      data: null,
      isPending: false,
    } as ReturnType<typeof authClient.useSession>);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: string) =>
        Promise.resolve(
          input === "/api/guest/preview-choir"
            ? Response.json({}, { status: 404 })
            : Response.json(
            input === "/api/choirs"
              ? { memberships: [] }
              : input.includes("/bootstrap")
              ? driveBootstrapBody()
              : input.includes("/scores")
              ? {
                  scores: [],
                  storage: { usedBytes: 0, limitBytes: 1_073_741_824 },
                  permissions: { capabilities: noCapabilities() },
                }
              : {
                  choir: {
                    id: "choir-1",
                    name: "小红花云盘",
                    guestAdmissionMode: "invite",
                  },
                  entryKind: "admission",
                },
            ),
        ),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens with the cloud-drive entry and keeps invitation admission focused", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppRoutes />
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole("heading", { name: "Harmony begins on the Same Page" }),
    ).toHaveAttribute("lang", "en");
    expect(screen.getByText("你的笔记我的谱")).toHaveAttribute("lang", "zh-CN");
    expect(
      screen.getByText(
        "A cloud-based score library built for choir rehearsals and shared annotations.",
      ),
    ).toHaveAttribute("lang", "en");
    expect(
      screen.getByText("为合唱排练与共享笔记打造的乐谱云盘。"),
    ).toHaveAttribute("lang", "zh-CN");
    expect(screen.getByRole("link", { name: "登录" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "隐私政策" })).toHaveAttribute(
      "href",
      "/privacy",
    );
    expect(screen.queryByLabelText("邀请码")).not.toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: "进入云盘" }));

    expect(screen.getByRole("dialog", { name: "进入云盘" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "我已加入的云盘" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "登录后查看" })).toHaveAttribute(
      "href",
      "/login",
    );
    expect(
      screen.getByRole("heading", { name: "使用邀请码进入新的云盘" }),
    ).toBeInTheDocument();
    expect(await screen.findByLabelText("邀请码")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "进入" })).toBeDisabled();
    expect(screen.queryByText("无需注册，也可以访客身份只读访问。")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("显示名")).not.toBeInTheDocument();
  });

  it("rolls back only the failed layer preference when saves overlap", async () => {
    vi.mocked(authClient.useSession).mockReturnValue({
      data: { user: { id: "user-1", email: "singer@example.test" } },
      isPending: false,
    } as ReturnType<typeof authClient.useSession>);
    let releaseEnsemble!: (response: Response) => void;
    let releaseSoprano!: (response: Response) => void;
    const ensembleSave = new Promise<Response>((resolve) => {
      releaseEnsemble = resolve;
    });
    const sopranoSave = new Promise<Response>((resolve) => {
      releaseSoprano = resolve;
    });
    vi.stubGlobal("fetch", vi.fn().mockImplementation((input: string, init?: RequestInit) => {
      if (!init?.method) {
        return Promise.resolve(Response.json({
          drive: { id: "choir-1", name: "小红花云盘" },
          layers: ["E", "S"].map((slot) => ({
            slot,
            name: slot === "E" ? "Ensemble" : "Soprano",
            subscribed: true,
            colorOverride: null,
            adminDefaultColor: slot === "E" ? "#a12652" : "#7c3aed",
            displayColor: slot === "E" ? "#a12652" : "#7c3aed",
            colorSource: "admin",
          })),
        }));
      }
      if (input.endsWith("/E/preference")) return ensembleSave;
      if (input.endsWith("/S/preference")) return sopranoSave;
      return Promise.resolve(new Response(null, { status: 404 }));
    }));

    render(
      <MemoryRouter initialEntries={["/choirs/choir-1/preferences"]}>
        <AppRoutes />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("checkbox", { name: "Ensemble 默认显示" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Soprano 默认显示" }));
    releaseEnsemble(new Response(null, { status: 500 }));
    releaseSoprano(Response.json({ preference: { subscribed: false } }));

    await waitFor(() => {
      expect(screen.getByRole("checkbox", { name: "Ensemble 默认显示" })).toBeChecked();
      expect(screen.getByRole("checkbox", { name: "Soprano 默认显示" })).not.toBeChecked();
      expect(screen.getByRole("alert")).toHaveTextContent("保存失败，修改已保留，请核对后重试。");
      expect(screen.getByRole("button", { name: "重试 Ensemble" })).toBeInTheDocument();
    });
  });

  it("separates colors from display, retains confirmed colors on failure and retries the exact change", async () => {
    vi.mocked(authClient.useSession).mockReturnValue({
      data: { user: { id: "user-1", email: "singer@example.test" } }, isPending: false,
    } as ReturnType<typeof authClient.useSession>);
    let fail = true;
    const fetchMock = vi.fn().mockImplementation((_input: string, init?: RequestInit) => {
      if (init?.method === "PUT") return Promise.resolve(fail
        ? new Response(null, { status: 503 }) : Response.json({ preference: {} }));
      return Promise.resolve(Response.json({
        drive: { id: "choir-1", name: "小红花云盘" },
        layers: [{ slot: "E", name: "Ensemble", subscribed: false, colorOverride: null,
          adminDefaultColor: "#a12652", displayColor: "#a12652", colorSource: "admin" }],
      }));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MemoryRouter initialEntries={["/choirs/choir-1/preferences"]}><AppRoutes /></MemoryRouter>);
    expect(await screen.findByRole("checkbox", { name: "Ensemble 默认显示" })).not.toBeChecked();
    expect(screen.queryByLabelText("Ensemble 笔记颜色")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "笔记颜色" }));
    expect(screen.getByRole("heading", { name: "笔记颜色" })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    const color = screen.getByLabelText("Ensemble 笔记颜色");
    expect(screen.queryByRole("button", { name: /恢复默认颜色/ })).not.toBeInTheDocument();
    fireEvent.change(color, { target: { value: "#123456" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("保存失败，修改已保留，请核对后重试。");
    expect(color).toHaveValue("#a12652");
    expect(screen.queryByText("已保存")).not.toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "重试 Ensemble" }));
    await waitFor(() => expect(color).toHaveValue("#123456"));
    expect(screen.getByText("自定义")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenLastCalledWith("/api/choirs/choir-1/shared-layers/E/preference",
      expect.objectContaining({ body: JSON.stringify({ colorOverride: "#123456" }) }));
    fireEvent.click(screen.getByRole("button", { name: "Ensemble 恢复默认颜色" }));
    await waitFor(() => expect(color).toHaveValue("#a12652"));
    expect(screen.getByText("云盘默认")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /恢复默认颜色/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "返回" }));
    expect(screen.getByRole("checkbox", { name: "Ensemble 默认显示" })).not.toBeChecked();
  });

  it.each([false, true])("applies management deletion to offline caches and recovers the original layer (lost response: %s)", async loseResponse => {
    vi.stubGlobal("Blob", NodeBlob);
    vi.mocked(authClient.useSession).mockReturnValue({ data: { user: { id: "admin-1", email: "admin@example.test" } }, isPending: false } as ReturnType<typeof authClient.useSession>);
    const layer = { slot: "E", name: "Ensemble", defaultColor: "#a12652", grantedMemberCount: 2, sortOrder: 0, active: true, revision: 0, deletedAt: null as number | null, recoverUntil: null as number | null };
    await activateAuthenticatedLocalOwner("admin-1");
    const workspace = createLocalWorkspace(authenticatedLocalOwnerKey("admin-1"), "choir-1", "downloaded-score");
    const shared: AnnotationLayerSummary = { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", kind: "shared", sharedSlot: "E", name: "Ensemble", sortOrder: 0, subscribed: true, subscriptionSource: "drive", displayColor: "#a12652", colorSource: "admin", adminDefaultColor: "#a12652", driveSubscribed: true, driveColorOverride: null, scoreSubscriptionOverride: null, canEdit: true };
    await cacheAnnotationLayers(workspace, [shared], 0);
    await saveAnnotationDraft(workspace, { id: crypto.randomUUID(), layerId: shared.id, payload: { kind: "text", pageNumber: 1, x: .2, y: .3, fontScale: .024, text: "本机未同步草稿" } });
    await localDatabase.offlineScores.put({ ...workspace, key: "management-offline", versionId: "version", fileName: "谱.pdf", sha256: "test", pageCount: 1, blob: new Blob(["PDF"]), active: 1, verifiedAt: 1, annotationSnapshot: await captureOfflineAnnotationSnapshot(workspace) });
    const actions: unknown[] = [];
    let lost = loseResponse;
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      if (input.endsWith("/lifecycle")) {
        const body = JSON.parse(String(init?.body)); actions.push(body);
        if (body.action === "delete") { layer.deletedAt = Date.now(); layer.recoverUntil = Date.now() + 30 * 86400000; }
        else { layer.deletedAt = null; layer.recoverUntil = null; }
        layer.revision++;
        if (lost) { lost = false; throw new TypeError("response_lost"); }
        return Response.json({ action: body.action, revision: layer.revision, sharedLayerRevision: layer.revision, activeSharedSlots: layer.deletedAt === null && layer.active ? ["E"] : [] });
      }
      if (input.includes("/shared-layers")) return Response.json({ drive: { id: "choir-1", name: "测试云盘" }, sharedLayerRevision: layer.revision, activeSharedSlots: layer.deletedAt === null && layer.active ? ["E"] : [], layers: input.includes("state=deleted") === (layer.deletedAt !== null) ? [layer] : [] });
      return new Response(null, { status: 404 });
    }));
    render(<MemoryRouter initialEntries={["/choirs/choir-1/shared-layers"]}><AppRoutes /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: "删除 Ensemble" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/当前云盘全部乐谱/)).toBeVisible();
    expect(within(dialog).getByText(/30 天内/)).toBeVisible();
    expect(actions).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "删除整个共享层" }));
    await screen.findByText(loseResponse ? /操作结果未确认/ : "共享层已删除，可在已删除层入口查看并恢复。");
    await waitFor(() => expect(screen.queryByRole("button", { name: "删除 Ensemble" })).not.toBeInTheDocument());
    await waitFor(async () => expect(await readAnnotationLayers(workspace)).toEqual([]));
    expect((await localDatabase.offlineScores.get("management-offline"))?.annotationSnapshot.layers).toEqual([]);
    expect((await localDatabase.offlineScores.get("management-offline"))?.blob.size).toBe(3);
    expect((await localDatabase.annotations.where("scopeKey").equals(workspace.scopeKey).toArray())[0]).toMatchObject({ state: "draft", layerId: shared.id });
    fireEvent.click(screen.getByRole("button", { name: "已删除层" }));
    expect(await screen.findByText(/恢复截止：/)).toHaveTextContent("恢复后启用");
    fireEvent.click(screen.getByRole("button", { name: /^恢复$/ }));
    await screen.findByText("原共享层已恢复，原有启用或停用状态保留。");
    expect(actions).toEqual([{ action: "delete", expectedRevision: 0 }, { action: "restore", expectedRevision: 1 }]);
    fireEvent.click(screen.getByRole("button", { name: "当前共享层" }));
    expect(await screen.findByText("已授权 2 位成员")).toBeVisible();
  });

  it("separates operation permissions from delegated scopes on the member page", async () => {
    vi.mocked(authClient.useSession).mockReturnValue({ data: { user: { id: "owner", email: "owner@example.test" } }, isPending: false } as ReturnType<typeof authClient.useSession>);
    const member = { id: "member", displayName: "小林", isOwner: 0, status: "active", removedAt: null, revision: 0, userDeleted: 0, recoverable: 0, operations: emptyPermissions(), management: emptyPermissions() };
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (input.endsWith("/permission-layers")) return Response.json({ layers: [{ slot: "S", name: "Soprano" }] });
      if (input.endsWith("/permission-changes")) return Response.json({ changes: [] });
      if (input.endsWith("/permissions") && init?.method === "PUT") return new Response(null, { status: 204 });
      if (input.endsWith("/memberships")) return Response.json({ actorId: "owner", capabilities: effectiveCapabilities(true, emptyPermissions(), emptyPermissions()), memberships: [member] });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MemoryRouter initialEntries={["/choirs/choir-1/memberships"]}><AppRoutes /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("heading", { name: "小林" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "上传文件：可以操作" }));
    expect(screen.getByRole("checkbox", { name: "上传文件：可以授权他人" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "编辑 Soprano：可以授权他人" }));
    fireEvent.click(screen.getByRole("button", { name: "保存 小林 的权限" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/choirs/choir-1/memberships/member/permissions", expect.objectContaining({ method: "PUT", body: JSON.stringify({ expectedRevision: 0, operations: { operations: ["uploadFiles"], sharedLayers: [] }, management: { operations: [], sharedLayers: ["S"] } }) })));
  });

  it("shows the public preview as the third independent signed-out entry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: string) =>
        Promise.resolve(
          input === "/api/guest/preview-choir"
            ? Response.json({
                choir: {
                  id: "preview-choir",
                  name: "公开体验云盘",
                  guestAdmissionMode: "open",
                },
              })
            : Response.json({ memberships: [] }),
        ),
      ),
    );
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppRoutes />
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole("link", { name: "先看示例" }),
    ).toHaveAttribute("href", "/choirs/preview-choir");

    fireEvent.click(await screen.findByRole("button", { name: "进入云盘" }));
    expect(screen.queryByText("公开体验云盘")).not.toBeInTheDocument();
  });

  it("never renders an internal social-provider email in signed-in headers", async () => {
    vi.mocked(authClient.useSession).mockReturnValue({
      data: {
        user: {
          id: "wechat-user",
          email: "wechat-unionid@wechat.placeholder.invalid",
        },
      },
      isPending: false,
    } as ReturnType<typeof authClient.useSession>);
    const home = render(
      <MemoryRouter initialEntries={["/"]}>
        <AppRoutes />
      </MemoryRouter>,
    );
    expect(
      screen.queryByText("wechat-unionid@wechat.placeholder.invalid"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "我的" })).toBeInTheDocument();
    home.unmount();

    render(
      <MemoryRouter initialEntries={["/choirs/choir-1"]}>
        <AppRoutes />
      </MemoryRouter>,
    );
    expect(
      screen.queryByText("wechat-unionid@wechat.placeholder.invalid"),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "登录或注册" })).not.toBeInTheDocument();
  });

  it("keeps public preview out of signed-in membership lists", async () => {
    vi.mocked(authClient.useSession).mockReturnValue({
      data: { user: { id: "user-1", email: "member@example.test" } },
      isPending: false,
    } as ReturnType<typeof authClient.useSession>);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: string) =>
        Promise.resolve(
          input === "/api/guest/preview-choir"
            ? Response.json({
                choir: {
                  id: "preview-choir",
                  name: "公开体验云盘",
                  guestAdmissionMode: "open",
                },
              })
            : Response.json({ memberships: [] }),
        ),
      ),
    );
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppRoutes />
      </MemoryRouter>,
    );

    expect(await screen.findByText(/还没有已加入的云盘/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "先看示例" })).not.toBeInTheDocument();
    expect(screen.queryByText(/或先访问公开体验/)).not.toBeInTheDocument();
  });

  it("automatically admits a linked guest once under StrictMode", async () => {
    render(<StrictMode><MemoryRouter initialEntries={["/?join=1#invite=ABCDEFGH"]}><AppRoutes /></MemoryRouter></StrictMode>);
    expect(await screen.findByRole("heading", { name: "小红花云盘" })).toBeInTheDocument();
    const admissions = vi.mocked(fetch).mock.calls.filter(([url, init]) => url === "/api/guest/session" && init?.method === "POST");
    expect(admissions).toHaveLength(1);
    expect(admissions[0][1]?.body).toBe(JSON.stringify({ admission: "invite", joinCode: "ABCDEFGH" }));
  });

  it("keeps invitation cleanup and successful entry from triggering the dialog exit guard", async () => {
    const router = createMemoryRouter([{ path: "*", element: <AppRoutes /> }], { initialEntries: ["/?join=1#invite=ABCDEFGH"] });
    render(<RouterProvider router={router} />);
    expect(await screen.findByRole("heading", { name: "小红花云盘" })).toBeInTheDocument();
    expect(router.state.location.hash).toBe("");
    expect(vi.mocked(fetch).mock.calls.filter(([url, init]) => url === "/api/guest/session" && init?.method === "POST")).toHaveLength(1);
    expect(vi.mocked(fetch).mock.calls.filter(([url, init]) => url === "/api/guest/session" && init?.method === "DELETE")).toHaveLength(0);
  });

  it("automatically admits an invitation received while the home page is already open", async () => {
    render(<MemoryRouter><Link to="/?join=1#invite=ABCDEFGH">打开测试邀请</Link><AppRoutes /></MemoryRouter>);
    await screen.findByRole("button", { name: "进入云盘" });
    fireEvent.click(screen.getByRole("link", { name: "打开测试邀请" }));
    expect(await screen.findByRole("heading", { name: "小红花云盘" })).toBeInTheDocument();
    expect(screen.queryByLabelText("显示名")).not.toBeInTheDocument();
  });

  it("admits a signed-out linked guest even when a previous local user is remembered", async () => {
    await activateAuthenticatedLocalOwner("previous-user");
    render(<MemoryRouter initialEntries={["/?join=1#invite=ABCDEFGH"]}><AppRoutes /></MemoryRouter>);
    expect(await screen.findByRole("heading", { name: "小红花云盘" })).toBeInTheDocument();
    expect(screen.queryByLabelText("显示名")).not.toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.some(([url, init]) => url === "/api/guest/session" && init?.method === "POST")).toBe(true);
  });

  it("retains the linked code after a transient admission failure so retry needs no retyping", async () => {
    const original = vi.mocked(fetch).getMockImplementation()!;
    let failed = false;
    vi.mocked(fetch).mockImplementation((input, init) => {
      if (input === "/api/guest/session" && init?.method === "POST" && !failed) {
        failed = true;
        return Promise.reject(new TypeError("network unavailable"));
      }
      return original(input, init);
    });
    render(<MemoryRouter initialEntries={["/?join=1#invite=ABCDEFGH"]}><AppRoutes /></MemoryRouter>);
    expect(await screen.findByRole("alert")).toHaveTextContent("暂时无法进入这个云盘");
    expect(screen.getByLabelText("邀请码")).toHaveValue("ABCD-EFGH");
    fireEvent.click(screen.getByRole("button", { name: "进入" }));
    expect(await screen.findByRole("heading", { name: "小红花云盘" })).toBeInTheDocument();
  });

  it("waits for session restoration before automatically admitting the linked guest", async () => {
    vi.mocked(authClient.useSession).mockReturnValue({ data: null, isPending: true } as ReturnType<typeof authClient.useSession>);
    const tree = <StrictMode><MemoryRouter initialEntries={["/?join=1#invite=ABCDEFGH"]}><AppRoutes /></MemoryRouter></StrictMode>;
    const view = render(tree);
    expect(vi.mocked(fetch).mock.calls.some(([url, init]) => url === "/api/guest/session" && init?.method === "POST")).toBe(false);
    vi.mocked(authClient.useSession).mockReturnValue({ data: null, isPending: false } as ReturnType<typeof authClient.useSession>);
    view.rerender(<StrictMode><MemoryRouter initialEntries={["/?join=1#invite=ABCDEFGH"]}><AppRoutes /></MemoryRouter></StrictMode>);
    expect(await screen.findByRole("heading", { name: "小红花云盘" })).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.filter(([url, init]) => url === "/api/guest/session" && init?.method === "POST")).toHaveLength(1);
  });

  it("keeps a malformed invitation available for manual correction", async () => {
    render(<MemoryRouter initialEntries={["/?join=1#invite=bad"]}><AppRoutes /></MemoryRouter>);
    expect(await screen.findByText("邀请链接无效，请输入当前邀请码。")).toBeInTheDocument();
    expect(await screen.findByLabelText("邀请码")).toHaveValue("");
    expect(vi.mocked(fetch).mock.calls.filter(([url, init]) => url === "/api/guest/session" && init?.method === "POST")).toHaveLength(0);
  });

  it("normalizes a grouped pasted invitation and enters as a guest", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppRoutes />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "进入云盘" }));
    fireEvent.change(await screen.findByLabelText("邀请码"), {
      target: { value: "abcd-efgh" },
    });
    expect(await screen.findByLabelText("邀请码")).toHaveValue("ABCD-EFGH");
    expect(document.querySelectorAll(".join-code-slot")).toHaveLength(8);
    fireEvent.click(screen.getByRole("button", { name: "进入" }));

    expect(
      await screen.findByRole("heading", { name: "小红花云盘" }),
    ).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith("/api/guest/session", {
      signal: expect.any(AbortSignal),
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ admission: "invite", joinCode: "ABCDEFGH" }),
    });
  });

  it("keeps invalid invitations in the entry dialog with clear feedback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: string, init?: RequestInit) =>
        Promise.resolve(
          input === "/api/guest/session" && init?.method === "POST"
            ? Response.json({}, { status: 403 })
            : Response.json({ memberships: [] }),
        ),
      ),
    );
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppRoutes />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "进入云盘" }));
    fireEvent.change(await screen.findByLabelText("邀请码"), {
      target: { value: "AAAAAAAA" },
    });
    fireEvent.click(screen.getByRole("button", { name: "进入" }));

    expect(
      await screen.findByRole("alert"),
    ).toHaveTextContent("邀请码无效或已失效。");
    expect(screen.getByRole("dialog", { name: "进入云盘" })).toBeInTheDocument();
  });

  it("explains when invitation attempts are rate limited", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: string, init?: RequestInit) =>
        Promise.resolve(
          input === "/api/guest/session" && init?.method === "POST"
            ? Response.json({}, { status: 429 })
            : Response.json({ memberships: [] }),
        ),
      ),
    );
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppRoutes />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "进入云盘" }));
    fireEvent.change(await screen.findByLabelText("邀请码"), {
      target: { value: "ABCDEFGH" },
    });
    fireEvent.click(screen.getByRole("button", { name: "进入" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "尝试次数过多，请稍后再试。",
    );
  });

  it("asks a signed-in new member for a display name only after invitation validation", async () => {
    vi.mocked(authClient.useSession).mockReturnValue({
      data: { user: { id: "user-1", email: "member@example.test" } },
      isPending: false,
    } as ReturnType<typeof authClient.useSession>);
    const targetDrive = {
      id: "choir-2",
      name: "周末云盘",
      guestAdmissionMode: "invite",
    };
    const fetchMock = vi.fn().mockImplementation(
      (input: string, init?: RequestInit) => {
        if (input === "/api/choirs") {
          return Promise.resolve(Response.json({ memberships: [] }));
        }
        if (input === "/api/guest/session" && init?.method === "POST") {
          return Promise.resolve(
            Response.json({ choir: targetDrive, entryKind: "admission" }),
          );
        }
        if (input === "/api/choirs/current-guest/join-state") {
          return Promise.resolve(
            Response.json({ status: "display-name-required", choir: targetDrive }),
          );
        }
        if (input === "/api/choirs/join-current-guest" && init?.method === "POST") {
          return Promise.resolve(Response.json({ membership: { choir: targetDrive } }));
        }
        return Promise.resolve(Response.json({}, { status: 404 }));
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <MemoryRouter initialEntries={["/?join=1#invite=ABCDEFGH"]}>
        <AppRoutes />
      </MemoryRouter>,
    );


    expect(
      await screen.findByRole("dialog", { name: "加入「周末云盘」" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("邀请码")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("显示名"), {
      target: { value: "小花" },
    });
    fireEvent.click(screen.getByRole("button", { name: "加入并进入" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/choirs/join-current-guest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: "小花" }),
      });
    });
  });

  it("waits for guest-session cleanup before accepting another invitation", async () => {
    vi.mocked(authClient.useSession).mockReturnValue({
      data: { user: { id: "user-1", email: "member@example.test" } },
      isPending: false,
    } as ReturnType<typeof authClient.useSession>);
    const targetDrive = {
      id: "choir-2",
      name: "周末云盘",
      guestAdmissionMode: "invite",
    };
    let finishDelete!: (response: Response) => void;
    const pendingDelete = new Promise<Response>((resolve) => {
      finishDelete = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((input: string, init?: RequestInit) => {
        if (input === "/api/choirs") {
          return Promise.resolve(Response.json({ memberships: [] }));
        }
        if (input === "/api/guest/session" && init?.method === "POST") {
          return Promise.resolve(
            Response.json({ choir: targetDrive, entryKind: "admission" }),
          );
        }
        if (input === "/api/choirs/current-guest/join-state") {
          return Promise.resolve(
            Response.json({ status: "display-name-required", choir: targetDrive }),
          );
        }
        if (input === "/api/guest/session" && init?.method === "DELETE") {
          return pendingDelete;
        }
        return Promise.resolve(Response.json({}, { status: 404 }));
      }),
    );
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppRoutes />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "加入新云盘" }));
    fireEvent.change(await screen.findByLabelText("邀请码"), {
      target: { value: "ABCDEFGH" },
    });
    fireEvent.click(screen.getByRole("button", { name: "进入" }));
    expect(
      await screen.findByRole("dialog", { name: "加入「周末云盘」" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "加入新云盘" }));
    fireEvent.change(await screen.findByLabelText("邀请码"), {
      target: { value: "ABCDEFGH" },
    });
    expect(screen.getByRole("button", { name: "正在验证…" })).toBeDisabled();

    finishDelete(new Response(null, { status: 204 }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "进入" })).toBeEnabled();
    });
  });

  it("enters directly when a signed-in user already belongs to the invited drive", async () => {
    vi.mocked(authClient.useSession).mockReturnValue({
      data: { user: { id: "user-1", email: "member@example.test" } },
      isPending: false,
    } as ReturnType<typeof authClient.useSession>);
    const targetDrive = {
      id: "choir-1",
      name: "小红花云盘",
      guestAdmissionMode: "invite",
    };
    const membership = {
      id: "membership-1",
      displayName: "小花",
      isOwner: false,
      choir: targetDrive,
    };
    const fetchMock = vi.fn().mockImplementation(
      (input: string, init?: RequestInit) => {
        if (input === "/api/guest/session" && init?.method === "POST") {
          return Promise.resolve(
            Response.json({ choir: targetDrive, entryKind: "admission" }),
          );
        }
        if (input === "/api/choirs/current-guest/join-state") {
          return Promise.resolve(
            Response.json({ status: "joined", choir: targetDrive }),
          );
        }
        if (input === "/api/guest/session" && init?.method === "DELETE") {
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        if (input === "/api/guest/session") {
          return Promise.resolve(Response.json({}, { status: 401 }));
        }
        if (input === "/api/choirs") {
          return Promise.resolve(Response.json({ memberships: [membership] }));
        }
        if (input.includes("/bootstrap")) {
          return Promise.resolve(Response.json(driveBootstrapBody({ access: "membership" })));
        }
        return Promise.resolve(Response.json({}, { status: 404 }));
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter initialEntries={["/?join=1#invite=ABCDEFGH"]}>
        <AppRoutes />
      </MemoryRouter>,
    );


    await screen.findByRole("searchbox", { name: /搜索.*中的乐谱/ });
    expect(screen.getByRole("heading", { name: "小红花云盘" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/guest/session", {
      method: "DELETE",
    });
    expect(screen.queryByLabelText("显示名")).not.toBeInTheDocument();
  });

  it("enters an open-admission choir only through its dedicated link", async () => {
    let admitted = false;
    const fetchMock = vi.fn().mockImplementation(
      (input: string, init?: RequestInit) => {
        if (input === "/api/guest/choirs/spring-choir") {
          return Promise.resolve(
            Response.json({
              choir: {
                id: "spring-choir",
                name: "公开体验云盘",
                guestAdmissionMode: "open",
              },
              entryKind: "admission",
            }),
          );
        }
        if (input === "/api/guest/session" && init?.method === "POST") {
          admitted = true;
          return Promise.resolve(
            Response.json({
              choir: {
                id: "spring-choir",
                name: "公开体验云盘",
                guestAdmissionMode: "open",
              },
              entryKind: "admission",
            }),
          );
        }
        if (input === "/api/guest/session") {
          return Promise.resolve(Response.json({}, { status: 401 }));
        }
        if (input.includes("/bootstrap")) {
          return Promise.resolve(
            admitted
              ? Response.json(driveBootstrapBody({
                  choir: {
                    id: "spring-choir",
                    name: "公开体验云盘",
                    guestAdmissionMode: "open",
                  },
                }))
              : Response.json({}, { status: 403 }),
          );
        }
        if (input === "/api/choirs") {
          return Promise.resolve(Response.json({ memberships: [] }));
        }
        return Promise.resolve(Response.json({}, { status: 404 }));
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter initialEntries={["/choirs/spring-choir"]}>
        <AppRoutes />
      </MemoryRouter>,
    );

    expect(await screen.findByText("这个云盘还没有乐谱。")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/guest/session", expect.objectContaining({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ admission: "open", choirId: "spring-choir" }),
    }));
  });

  it("asks a signed-in user for a display name before joining an open choir", async () => {
    vi.mocked(authClient.useSession).mockReturnValue({
      data: { user: { id: "user-1", email: "member@example.test" } },
      isPending: false,
    } as ReturnType<typeof authClient.useSession>);
    let joined = false;
    const fetchMock = vi.fn().mockImplementation(
      (input: string, init?: RequestInit) => {
        if (input === "/api/guest/choirs/spring-choir") {
          return Promise.resolve(
            Response.json({
              choir: {
                id: "spring-choir",
                name: "公开体验云盘",
                guestAdmissionMode: "open",
              },
              entryKind: "admission",
            }),
          );
        }
        if (input === "/api/choirs/join" && init?.method === "POST") {
          joined = true;
          return Promise.resolve(
            Response.json(
              {
                membership: {
                  id: "membership-1",
                  displayName: "小花",
                  isOwner: false,
                  choir: {
                    id: "spring-choir",
                    name: "公开体验云盘",
                    guestAdmissionMode: "open",
                  },
                },
              },
              { status: 201 },
            ),
          );
        }
        if (input === "/api/choirs") {
          return Promise.resolve(
            Response.json({
              memberships: joined
                ? [
                    {
                      id: "membership-1",
                      displayName: "小花",
                      isOwner: false,
                      choir: {
                        id: "spring-choir",
                        name: "公开体验云盘",
                        guestAdmissionMode: "open",
                      },
                    },
                  ]
                : [],
            }),
          );
        }
        if (input === "/api/guest/session") {
          return Promise.resolve(Response.json({}, { status: 401 }));
        }
        if (input.includes("/bootstrap")) {
          return Promise.resolve(
            joined
              ? Response.json(driveBootstrapBody({
                  choir: {
                    id: "spring-choir",
                    name: "公开体验云盘",
                    guestAdmissionMode: "open",
                  },
                  access: "membership",
                }))
              : Response.json({}, { status: 403 }),
          );
        }
        return Promise.resolve(Response.json({}, { status: 404 }));
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter initialEntries={["/choirs/spring-choir"]}>
        <AppRoutes />
      </MemoryRouter>,
    );

    fireEvent.change(
      await screen.findByLabelText("显示名"),
      { target: { value: "小花" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "加入并进入" }));

    expect(await screen.findByText("这个云盘还没有乐谱。")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/choirs/join", expect.objectContaining({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        admission: "open",
        choirId: "spring-choir",
        displayName: "小花",
      }),
    }));
  });

  it("opens signed-in preview access without guest admission or joining", async () => {
    vi.mocked(authClient.useSession).mockReturnValue({
      data: { user: { id: "user-1", email: "member@example.test" } },
      isPending: false,
    } as ReturnType<typeof authClient.useSession>);
    const fetchMock = vi.fn().mockImplementation((input: string) => {
      if (input === "/api/choirs/preview-choir/bootstrap") {
        return Promise.resolve(Response.json(driveBootstrapBody({
          choir: { id: "preview-choir", name: "公开体验云盘", guestAdmissionMode: "open" },
          access: "preview",
        })));
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MemoryRouter initialEntries={["/choirs/preview-choir"]}><AppRoutes /></MemoryRouter>);
    expect(await screen.findByRole("heading", { name: "公开体验云盘" })).toBeInTheDocument();
    expect(screen.getByText("这个云盘还没有乐谱。")).toBeInTheDocument();
    expect(screen.queryByLabelText("显示名")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "打开云盘菜单" }));
    expect(screen.queryByRole("menu", { name: "管理员菜单" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "关闭" })).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("dialog", { name: "云盘菜单" }), { key: "Escape" });
    expect(fetchMock).not.toHaveBeenCalledWith("/api/choirs/join", expect.anything());
    expect(fetchMock).not.toHaveBeenCalledWith("/api/guest/session", expect.objectContaining({ method: "POST" }));
  });

  it("lets an administrator read the current code and reopen it after rotation", async () => {
    vi.mocked(authClient.useSession).mockReturnValue({
      data: { user: { id: "admin-1", email: "admin@example.test" } },
      isPending: false,
    } as ReturnType<typeof authClient.useSession>);
    let currentCode = "HGFEDCBA";
    const fetchMock = vi.fn().mockImplementation(
      (input: string, init?: RequestInit) => {
        if (input.endsWith("/management")) return Promise.resolve(Response.json({ name: "小红花云盘", guestAdmissionMode: "invite", capabilities: effectiveCapabilities(true, emptyPermissions(), emptyPermissions()), layers: [] }));
        if (input.endsWith("/memberships")) return Promise.resolve(Response.json({ actorId: "owner", capabilities: effectiveCapabilities(true, emptyPermissions(), emptyPermissions()), memberships: [] }));
        if (input.endsWith("/join-code")) {
          return Promise.resolve(Response.json({ joinCode: currentCode }));
        }
        if (input.endsWith("/join-code/rotate") && init?.method === "POST") {
          currentCode = "ABCDEFGH";
          return Promise.resolve(
            Response.json({ joinCode: currentCode }),
          );
        }
        if (input.includes("/bootstrap")) {
          return Promise.resolve(
            Response.json(driveBootstrapBody({ capabilities: effectiveCapabilities(true, emptyPermissions(), emptyPermissions()), access: "membership" })),
          );
        }
        return Promise.resolve(
          Response.json({
            choir: {
              id: "choir-1",
              name: "小红花云盘",
              guestAdmissionMode: "invite",
            },
          }),
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter initialEntries={["/choirs/choir-1"]}>
        <AppRoutes />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "打开云盘菜单" }));
    expect(await screen.findByRole("menuitem", { name: "共享层" })).toHaveAttribute(
      "href",
      "/choirs/choir-1/settings/layers",
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "加入方式" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看与轮换邀请码" }));
    expect(await screen.findByRole("dialog", { name: "邀请加入云盘" })).toBeInTheDocument();
    expect(await screen.findByLabelText("当前有效邀请码")).toHaveTextContent("HGFEDCBA");
    fireEvent.click(screen.getByRole("button", { name: "轮换邀请码" }));
    fireEvent.click(screen.getByRole("button", { name: "确认轮换" }));

    expect(
      await screen.findByText("邀请码已轮换，可随时在这里查看。"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("当前有效邀请码")).toHaveTextContent(
      "ABCDEFGH",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/choirs/choir-1/join-code/rotate",
      { method: "POST" },
    );

    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.queryByLabelText("当前有效邀请码")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看与轮换邀请码" }));
    expect(await screen.findByLabelText("当前有效邀请码")).toHaveTextContent("ABCDEFGH");
  });

  it("links signed-in members to drive-scoped My Preferences", async () => {
    vi.mocked(authClient.useSession).mockReturnValue({
      data: { user: { id: "user-1", email: "member@example.test" } },
      isPending: false,
    } as ReturnType<typeof authClient.useSession>);
    vi.stubGlobal("fetch", vi.fn().mockImplementation((input: string) =>
      Promise.resolve(input.includes("/bootstrap")
        ? Response.json(driveBootstrapBody({ access: "membership" }))
        : Response.json({
            choir: { id: "choir-1", name: "小红花云盘", guestAdmissionMode: "invite" },
          }))));

    render(
      <MemoryRouter initialEntries={["/choirs/choir-1"]}>
        <AppRoutes />
      </MemoryRouter>,
    );

    await screen.findByRole("searchbox", { name: /搜索.*中的乐谱/ });
    fireEvent.click(await screen.findByRole("button", { name: "此云盘设置" }));
    expect(await screen.findByRole("menuitem", { name: "阅读偏好" })).toHaveAttribute(
      "href",
      "/choirs/choir-1/preferences",
    );
  });

  it.each(["uploadFiles", "editDriveInfo"] as const)("shows the upload action only with upload permission: %s", async operation => {
    vi.mocked(authClient.useSession).mockReturnValue({ data: { user: { id: "operator", email: "operator@example.test" } }, isPending: false } as ReturnType<typeof authClient.useSession>);
    vi.stubGlobal("fetch", vi.fn(async (input: string) => input.includes("/bootstrap")
      ? Response.json(driveBootstrapBody({ access: "membership", capabilities: effectiveCapabilities(false, { operations: [operation], sharedLayers: [] }, emptyPermissions()) }))
      : new Response(null, { status: 204 })));
    render(<MemoryRouter initialEntries={["/choirs/choir-1"]}><AppRoutes /></MemoryRouter>);
    await screen.findByText("这个云盘还没有乐谱。");
    if (operation === "uploadFiles") expect(screen.getByRole("button", { name: "上传 PDF" })).toBeEnabled();
    else expect(screen.queryByRole("button", { name: "上传 PDF" })).not.toBeInTheDocument();
  });

  it("keeps management tools but hides invite-code controls for open guest admission", async () => {
    vi.mocked(authClient.useSession).mockReturnValue({
      data: { user: { id: "admin-1", email: "admin@example.test" } },
      isPending: false,
    } as ReturnType<typeof authClient.useSession>);
    const fetchMock = vi.fn().mockImplementation((input: string) => {
      if (input.includes("/bootstrap")) {
        return Promise.resolve(
          Response.json(driveBootstrapBody({
            choir: {
              id: "spring-choir",
              name: "公开体验云盘",
              guestAdmissionMode: "open",
            },
            usedBytes: 900_000_000,
            capabilities: effectiveCapabilities(true, emptyPermissions(), emptyPermissions()),
            access: "membership",
          })),
        );
      }
      return Promise.resolve(
        Response.json({
          choir: {
            id: "spring-choir",
            name: "公开体验云盘",
            guestAdmissionMode: "open",
          },
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter initialEntries={["/choirs/spring-choir"]}>
        <AppRoutes />
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole("button", { name: "上传 PDF" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/云盘存储已使用 858\.3 MB/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "打开云盘菜单" }));
    expect(await screen.findByText(/云盘存储：858\.3 MB/)).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "回收站" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "轮换邀请码" }),
    ).not.toBeInTheDocument();
  });

  it("shows members a filename-first list without administrator storage controls", async () => {
    const fetchMock = vi.fn().mockImplementation((input: string) =>
      Promise.resolve(
        input.includes("/bootstrap")
          ? Response.json({
              choir: {
                id: "choir-1",
                name: "小红花云盘",
                guestAdmissionMode: "invite",
              },
              scores: [
                {
                  id: "score-10",
                  choirId: "choir-1",
                  fileName: "排练 10.pdf",
                  updatedAt: 1,
                  currentVersion: {
                    id: "version-1",
                    versionNumber: 1,
                    sizeBytes: 2 * 1024 * 1024,
                    sha256: "a".repeat(64),
                    etag: '"etag"',
                    pageCount: 2,
                    createdAt: 1,
                  },
                },
              ],
              storage: { usedBytes: 950_000_000, limitBytes: 1_073_741_824 },
              permissions: { capabilities: noCapabilities(), access: "guest" },
            })
          : Response.json({
              choir: {
                id: "choir-1",
                name: "小红花云盘",
                guestAdmissionMode: "invite",
              },
            }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter initialEntries={["/choirs/choir-1"]}>
        <AppRoutes />
      </MemoryRouter>,
    );

    const scoreLink = await screen.findByRole("link", { name: /排练 10/ });
    expect(scoreLink).toHaveAttribute(
      "href",
      "/choirs/choir-1/scores/score-10",
    );
    fireEvent.click(scoreLink, { button: 1 });
    expect(peekReaderScore("guest", "choir-1", "score-10")).toMatchObject({
      id: "score-10",
      fileName: "排练 10.pdf",
      currentVersion: { id: "version-1" },
    });
    expect(screen.queryByRole("button", { name: "上传 PDF" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "回收站" })).not.toBeInTheDocument();
    expect(screen.queryByText(/云盘存储已使用/)).not.toBeInTheDocument();
    expect(screen.queryByText("2.0 MB")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /更多操作/ }));
    expect(screen.queryByRole("menuitem", { name: "重命名" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "文件信息" }));
    const info = await screen.findByRole("dialog", { name: "文件信息" });
    expect(within(info).getByText("2.0 MB")).toBeInTheDocument();
    fireEvent.click(within(info).getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "搜索" })).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: /搜索.*中的乐谱/ }), {
      target: { value: "排练" },
    });
    expect(screen.getByText("找到 1 份，共 1 份乐谱")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("?q="))).toBe(false);

    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(Response.json({ error: "temporary" }, { status: 503 })),
    );
    fireEvent.submit(screen.getByRole("search"));
    expect(
      await screen.findByText("暂时无法更新乐谱列表，当前内容已保留。请稍后重试。"),
    ).toBeInTheDocument();
    expect(screen.getByText("排练 10")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /排练 10/ })).not.toBeInTheDocument();

  });

  it("reuses the home summary while one member bootstrap loads the drive", async () => {
    vi.mocked(authClient.useSession).mockReturnValue({
      data: { user: { id: "user-1", email: "member@example.test" } },
      isPending: false,
    } as ReturnType<typeof authClient.useSession>);
    const ownerKey = driveCacheOwnerKey("user-1", "choir-1");
    rememberDriveSummary(ownerKey, {
      id: "choir-1",
      name: "已知云盘名称",
      guestAdmissionMode: "invite",
    });
    let finishBootstrap!: (response: Response) => void;
    const bootstrap = new Promise<Response>((resolve) => {
      finishBootstrap = resolve;
    });
    const fetchMock = vi.fn().mockImplementation((input: string, init?: RequestInit) => {
      if (input === "/api/choirs/choir-1/bootstrap") return bootstrap;
      if (input === "/api/guest/session" && init?.method === "DELETE") {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(Response.json({}, { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter initialEntries={["/choirs/choir-1"]}>
        <AppRoutes />
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole("heading", { name: "已知云盘名称" }),
    ).toBeInTheDocument();
    // Let the real local-directory read finish while bootstrap is still pending.
    await screen.findByText("本机尚未保存这个云盘的目录或乐谱，请联网后下载。");
    expect(screen.getByRole("heading", { name: "已知云盘名称" })).toBeInTheDocument();
    expect(fetchMock.mock.calls.map(([input]) => input).filter(input => input !== "/api/choirs")).toEqual([
      "/api/choirs/choir-1/bootstrap",
    ]);

    finishBootstrap(Response.json(driveBootstrapBody({ access: "membership" })));
    expect(await screen.findByText("这个云盘还没有乐谱。")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/guest/session", expect.objectContaining({ method: "DELETE" }));
  });

  it("requires explicit confirmation before logout discards pending work", async () => {
    await activateAuthenticatedLocalOwner("user-1");
    vi.mocked(authClient.useSession).mockReturnValue({
      data: { user: { id: "user-1", email: "member@example.test" } },
      isPending: false,
    } as ReturnType<typeof authClient.useSession>);
    await localDatabase.annotationOutbox.put({
      opId: "pending-op",
      ...localWorkspace,
      annotationId: "annotation-1",
      layerId: "layer-1",
      baseVersion: 0,
      type: "upsert",
      payload: {
        kind: "text",
        pageNumber: 1,
        x: 0.1,
        y: 0.1, fontScale: 0.024,
        text: "待同步",
      },
      attemptedAt: null,
      createdAt: 1,
    });
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppRoutes />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "我的" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "退出登录" }));
    expect(await screen.findByRole("dialog", { name: "确认退出登录" })).toHaveTextContent(
      "本机还有 1 项待同步操作",
    );
    fireEvent.click(screen.getByRole("button", { name: "返回处理" }));
    expect(authClient.signOut).not.toHaveBeenCalled();
    expect(await localDatabase.annotationOutbox.count()).toBe(1);
  });

  it("keeps local data when the server rejects logout", async () => {
    await activateAuthenticatedLocalOwner("user-1");
    vi.mocked(authClient.useSession).mockReturnValue({
      data: { user: { id: "user-1", email: "member@example.test" } },
      isPending: false,
    } as ReturnType<typeof authClient.useSession>);
    vi.mocked(authClient.signOut).mockResolvedValueOnce({
      data: null,
      error: { status: 503, statusText: "Service Unavailable" },
    } as Awaited<ReturnType<typeof authClient.signOut>>);
    await localDatabase.annotationLayers.put({
      key: localWorkspaceRecordKey(localWorkspace, "personal-layer"),
      ...localWorkspace,
      id: "personal-layer",
      kind: "personal",
      sharedSlot: null,
      name: "我的笔记",
      sortOrder: 10_000,
      subscribed: true,
      subscriptionSource: "product",
      displayColor: "#b4235a",
      colorSource: "product",
      adminDefaultColor: "#b4235a",
      driveSubscribed: null,
      driveColorOverride: null,
      scoreSubscriptionOverride: null,
      canEdit: true,
    });
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppRoutes />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "我的" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "退出登录" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "退出并清除" }),
    );

    expect(
      await screen.findByText("退出未完成，本机数据没有清除。请重试。"),
    ).toBeInTheDocument();
    expect(await localDatabase.annotationLayers.count()).toBe(1);
  });
});

function driveBootstrapBody(options: {
  choir?: { id: string; name: string; guestAdmissionMode: "invite" | "open" };
  usedBytes?: number;
  capabilities?: ReturnType<typeof noCapabilities>;
  access?: "membership" | "preview" | "guest";
} = {}) {
  return {
    choir: options.choir ?? {
      id: "choir-1",
      name: "小红花云盘",
      guestAdmissionMode: "invite" as const,
    },
    scores: [],
    storage: {
      usedBytes: options.usedBytes ?? 0,
      limitBytes: 1_073_741_824,
    },
    permissions: {
      capabilities: options.capabilities ?? noCapabilities(),
      access: options.access ?? "guest",
    },
  };
}
