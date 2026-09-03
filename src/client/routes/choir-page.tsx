import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  Button,
  Dialog,
  Form,
  Heading,
  Input,
  Label,
  Menu,
  MenuItem,
  MenuTrigger,
  Modal,
  ModalOverlay,
  Popover,
  TextField,
} from "react-aria-components";
import { Link, useParams } from "react-router-dom";

import { isInternalAuthEmail } from "../../shared/auth";
import {
  guestSessionResponseSchema,
  rotateJoinCodeResponseSchema,
  type ChoirSummary,
} from "../../shared/choirs";
import {
  driveBootstrapResponseSchema,
  scoreListResponseSchema,
  type ScoreListResponse,
  type ScoreSummary,
} from "../../shared/scores";
import { authClient } from "../auth/auth-client";
import { clearGuestSession } from "../auth/preview-guest-session";
import { AppHeader } from "../components/app-header";
import {
  completeLoadingJourney,
  ensureLoadingJourney,
  isLoadingJourneyActive,
  startLoadingJourney,
} from "../performance/loading-performance";
import { rememberReaderScore } from "../reader/reader-score-cache";
import { classifyReaderOpen } from "../reader/reader-reopen-tracker";
import { scheduleReaderRuntimePreload } from "../reader/reader-runtime";
import {
  driveCacheOwnerKey,
  invalidateDriveLibrary,
  prepareDriveLibraryReturn,
  readDriveLibrary,
  readDriveSummary,
  readReturningDriveCacheOwner,
  rememberDriveLibrary,
  rememberDriveView,
  type DriveCacheOwnerKey,
} from "../score-library/drive-library-cache";
import {
  ScoreActionDialog,
  type ScoreAction,
  type ScoreActionSelection,
} from "../score-library/score-action-dialog";
import { formatBytes } from "../score-library/library-format";
import { TrashDialog } from "../score-library/trash-dialog";
import { UploadDialog } from "../score-library/upload-dialog";

export default function ChoirPage() {
  const { choirId = "" } = useParams();
  const session = authClient.useSession();
  const userId = session.data?.user.id;
  const [access, setAccess] = useState<ChoirAccessState>({ kind: "loading" });
  const [reloadSequence, setReloadSequence] = useState(0);
  const [openAdmissionDisplayName, setOpenAdmissionDisplayName] = useState("");
  const [search, setSearch] = useState("");
  const [searchMessage, setSearchMessage] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rotatedJoinCode, setRotatedJoinCode] = useState<string | null>(null);
  const [rotationMessage, setRotationMessage] = useState<string | null>(null);
  const [inviteManagementOpen, setInviteManagementOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [quotaBlocked, setQuotaBlocked] = useState(false);
  const [scoreAction, setScoreAction] = useState<ScoreActionSelection | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);
  const searchTimer = useRef<number | null>(null);
  const scoreListRequest = useRef(0);
  const viewState = useRef({ search: "", scrollTop: 0 });
  const pendingScrollRestore = useRef<number | null>(null);
  const cacheOwner: DriveCacheOwnerKey | null = session.isPending
    ? readReturningDriveCacheOwner(choirId) ?? driveCacheOwnerKey(null, choirId)
    : driveCacheOwnerKey(userId ?? null, choirId);
  const currentChoir =
    access.kind === "opened" || access.kind === "join-required"
      ? access.choir
      : null;

  useEffect(() => {
    if (!isLoadingJourneyActive("exit-score")) {
      ensureLoadingJourney("enter-drive", "direct");
    }
  }, []);

  useEffect(() => {
    if (access.kind !== "opened") return;
    const frame = window.requestAnimationFrame(() => {
      if (isLoadingJourneyActive("exit-score")) {
        completeLoadingJourney("exit-score", "drive-list-restored");
      } else {
        completeLoadingJourney("enter-drive", "drive-list-usable");
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [access]);

  useEffect(() => {
    if (access.kind !== "opened" || pendingScrollRestore.current === null) return;
    const frame = window.requestAnimationFrame(() => {
      const scrollTop = pendingScrollRestore.current;
      if (scrollTop === null) return;
      document.documentElement.scrollTop = scrollTop;
      document.body.scrollTop = scrollTop;
      pendingScrollRestore.current = null;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [access]);

  useEffect(() => {
    if (access.kind !== "opened") return;
    return scheduleReaderRuntimePreload();
  }, [access.kind]);

  const refresh = useCallback(
    async (query = search) => {
      const request = ++scoreListRequest.current;
      const next = await requestScoreList(choirId, query);
      if (request !== scoreListRequest.current) return;
      if (next.kind === "denied") {
        setAccess({ kind: "denied" });
        return;
      }
      if (next.kind === "failed") {
        setSearchMessage("暂时无法更新乐谱列表，当前内容已保留。请稍后重试。");
        return;
      }
      setSearchMessage(null);
      if (!currentChoir) {
        setAccess({ kind: "failed" });
        return;
      }
      const opened = { kind: "opened" as const, choir: currentChoir, result: next.result };
      setAccess(opened);
      if (cacheOwner) {
        rememberDriveLibrary(cacheOwner, choirId, opened);
        rememberDriveView(cacheOwner, choirId, {
          search: query,
          scrollTop: viewState.current.scrollTop,
        });
      }
    },
    [cacheOwner, choirId, currentChoir, search],
  );

  useEffect(() => {
    if (!cacheOwner) return;
    let active = true;
    let networkSettled = false;
    const cached = readDriveLibrary(cacheOwner, choirId);
    const cachedSummary = cached?.choir ?? readDriveSummary(cacheOwner, choirId);
    const query = cached?.search ?? "";
    const restoreFrame = window.requestAnimationFrame(() => {
      if (!active || networkSettled) return;
      if (!cached) {
        setAccess({ kind: "loading", choir: cachedSummary ?? undefined });
        return;
      }
      viewState.current = { search: cached.search, scrollTop: cached.scrollTop };
      setSearch(cached.search);
      pendingScrollRestore.current = cached.scrollTop;
      setAccess({ kind: "opened", choir: cached.choir, result: cached.result });
    });
    void openChoir(choirId, Boolean(userId), query).then((opened) => {
      networkSettled = true;
      if (!active) return;
      if (opened.kind === "failed" && cached) {
        setSearchMessage("暂时无法更新乐谱列表，当前内容已保留。请稍后重试。");
        return;
      }
      if (opened.kind === "opened") {
        if (cached) {
          viewState.current = { search: cached.search, scrollTop: cached.scrollTop };
          setSearch(cached.search);
          pendingScrollRestore.current = cached.scrollTop;
        }
        rememberDriveLibrary(cacheOwner, choirId, opened);
        rememberDriveView(cacheOwner, choirId, {
          search: query,
          scrollTop: cached?.scrollTop ?? 0,
        });
      } else if (opened.kind === "denied" || opened.kind === "not-found") {
        invalidateDriveLibrary(cacheOwner, choirId);
      }
      setAccess(opened);
    });
    return () => {
      active = false;
      window.cancelAnimationFrame(restoreFrame);
    };
  }, [cacheOwner, choirId, reloadSequence, userId]);

  useEffect(() => () => {
    if (!cacheOwner) return;
    rememberDriveView(cacheOwner, choirId, {
      search: viewState.current.search,
      scrollTop: window.scrollY,
    });
  }, [cacheOwner, choirId]);

  useEffect(
    () => () => {
      if (searchTimer.current !== null) window.clearTimeout(searchTimer.current);
    },
    [],
  );

  const updateSearch = (value: string) => {
    setSearch(value);
    viewState.current.search = value;
    if (searchTimer.current !== null) window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(() => {
      searchTimer.current = null;
      void refresh(value);
    }, 180);
  };

  const joinOpenChoir = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/choirs/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          admission: "open",
          choirId,
          displayName: openAdmissionDisplayName,
        }),
      });
      if (!response.ok) {
        setMessage(
          response.status === 403
            ? "该成员关系需要云盘管理员恢复。"
            : "暂时无法加入这个云盘，请稍后再试。",
        );
        return;
      }
      const next = await requestDriveBootstrap(choirId, "");
      if (next.kind === "loaded") {
        setAccess(next.opened);
        if (cacheOwner) rememberDriveLibrary(cacheOwner, choirId, next.opened);
      } else {
        setAccess({ kind: next.kind });
      }
    } catch {
      setMessage("暂时无法加入这个云盘，请稍后再试。");
    } finally {
      setBusy(false);
    }
  };

  const openScoreAction = (score: ScoreSummary, action: ScoreAction) => {
    setScoreAction({ score, action });
    setMessage(null);
  };

  const refreshAfterMutation = async () => {
    if (cacheOwner) invalidateDriveLibrary(cacheOwner, choirId);
    await refresh();
  };

  const rotateJoinCode = async () => {
    if (!window.confirm("轮换后当前邀请码会立即失效。确认继续吗？")) return;
    setBusy(true);
    setRotatedJoinCode(null);
    setRotationMessage(null);
    try {
      const response = await fetch(`/api/choirs/${choirId}/join-code/rotate`, {
        method: "POST",
      });
      if (!response.ok) throw new Error("rotation_failed");
      setRotatedJoinCode(rotateJoinCodeResponseSchema.parse(await response.json()).joinCode);
      setRotationMessage("邀请码已轮换。请现在复制并通过私密渠道发送。");
    } catch {
      setRotationMessage("邀请码轮换失败，当前邀请码没有改变。");
    } finally {
      setBusy(false);
    }
  };

  const headerActions = (
    <>
      <Link className="header-action" to="/">
        其他云盘
      </Link>
      {session.data?.user ? (
        <MenuTrigger>
          <Button className="account-menu-button" aria-label="用户菜单">
            <span className="account-menu-label">
              {isInternalAuthEmail(session.data.user.email)
                ? "我的"
                : session.data.user.email}
            </span>
            <span className="account-menu-label account-menu-label--compact">
              我的
            </span>
          </Button>
          <Popover className="file-menu-popover account-menu-popover">
            <Menu aria-label="用户菜单">
              <MenuItem href={`/choirs/${choirId}/preferences`}>我的偏好</MenuItem>
            </Menu>
          </Popover>
        </MenuTrigger>
      ) : (
        <Link className="header-action header-action--primary" to="/login">
          登录或注册
        </Link>
      )}
    </>
  );

  if (access.kind === "join-required") {
    return (
      <div className="app-page">
        <AppHeader actions={headerActions} />
        <main className="page-shell compact-page access-page">
          <p className="eyebrow">开放准入</p>
          <h1>{access.choir.name}</h1>
          <p className="hero__copy">填写你在这个云盘中的显示名后即可加入。</p>
          <Form className="entry-form" onSubmit={joinOpenChoir}>
            <TextField
              isRequired
              value={openAdmissionDisplayName}
              onChange={setOpenAdmissionDisplayName}
              maxLength={40}
            >
              <Label>显示名</Label>
              <Input autoComplete="nickname" placeholder="例如：小花" />
            </TextField>
            <Button type="submit" isDisabled={busy}>
              {busy ? "正在加入…" : "加入并进入"}
            </Button>
          </Form>
        </main>
      </div>
    );
  }

  if (access.kind === "denied") {
    return (
      <div className="app-page">
        <AppHeader actions={headerActions} />
        <main className="page-shell compact-page access-page">
          <p className="eyebrow">云盘</p>
          <h1>无法访问这个云盘</h1>
          <p className="hero__copy">请返回首页输入当前邀请码，或使用有成员关系的邮箱登录。</p>
          <Link className="primary-link" to="/">返回首页</Link>
        </main>
      </div>
    );
  }

  if (access.kind === "not-found") {
    return (
      <div className="app-page">
        <AppHeader actions={headerActions} />
        <main className="page-shell compact-page access-page">
          <p className="eyebrow">云盘</p>
          <h1>这个云盘不存在</h1>
          <p className="hero__copy">链接可能已经失效，请返回首页重新选择云盘。</p>
          <Link className="primary-link" to="/">返回首页</Link>
        </main>
      </div>
    );
  }

  if (access.kind === "failed") {
    return (
      <div className="app-page">
        <AppHeader actions={headerActions} />
        <main className="page-shell compact-page access-page">
          <p className="eyebrow">云盘</p>
          <h1>暂时无法打开云盘</h1>
          <p className="hero__copy">网络或服务暂时不可用，请稍后重试。</p>
          <Button className="primary-button" onPress={() => setReloadSequence((value) => value + 1)}>
            重试
          </Button>
        </main>
      </div>
    );
  }

  if (access.kind === "loading") {
    return (
      <div className="app-page">
        <AppHeader actions={headerActions} />
        {access.choir ? (
          <main className="page-shell file-library">
            <header className="library-heading">
              <div className="library-title">
                <h1>{access.choir.name}</h1>
                <p>正在加载乐谱…</p>
              </div>
            </header>
          </main>
        ) : (
          <p className="route-loading">正在打开云盘…</p>
        )}
      </div>
    );
  }

  const { choir, result } = access;
  const storageRatio = result.storage.usedBytes / result.storage.limitBytes;

  return (
    <div className="app-page">
      <AppHeader actions={headerActions} />
      <main className="page-shell file-library">
        <header className="library-heading">
          <div className="library-title">
                <h1>{choir.name}</h1>
            <p>{result.scores.length} 份乐谱</p>
          </div>
          {result.permissions.canManage ? (
            <div className="library-actions">
              <MenuTrigger>
                <Button className="secondary-button">管理</Button>
                <Popover className="file-menu-popover admin-menu-popover">
                  <Menu
                    aria-label="管理员菜单"
                    onAction={(key) => {
                      if (key === "trash") setTrashOpen(true);
                      if (key === "invite") setInviteManagementOpen(true);
                    }}
                  >
                    <MenuItem href={`/choirs/${choirId}/shared-layers`}>
                      共享层
                    </MenuItem>
                    <MenuItem id="trash">回收站</MenuItem>
                    {choir.guestAdmissionMode === "invite" ? (
                      <MenuItem id="invite">邀请码</MenuItem>
                    ) : null}
                    <MenuItem id="storage" isDisabled>
                      云盘存储：{formatBytes(result.storage.usedBytes)} / {formatBytes(result.storage.limitBytes)}
                    </MenuItem>
                  </Menu>
                </Popover>
              </MenuTrigger>
              <Button className="primary-button" onPress={() => setUploadOpen(true)}>
                上传 PDF
              </Button>
            </div>
          ) : null}
        </header>

        <section className="library-workspace" aria-labelledby="library-content-title">
          <div className="library-toolbar">
            <h2 id="library-content-title">乐谱</h2>
            <Form
              className="library-search"
              role="search"
              onSubmit={(event) => {
                event.preventDefault();
                if (searchTimer.current !== null) window.clearTimeout(searchTimer.current);
                searchTimer.current = null;
                void refresh(search);
              }}
            >
              <TextField value={search} onChange={updateSearch} aria-label="搜索文件名">
                <Input type="search" placeholder="搜索乐谱" />
              </TextField>
            </Form>
          </div>

          {result.permissions.canManage && (storageRatio >= 0.8 || quotaBlocked) ? (
            <p className="storage-warning" role="status">
              云盘存储已使用 {formatBytes(result.storage.usedBytes)} / {formatBytes(result.storage.limitBytes)}。
              {quotaBlocked ? " 请先释放空间后再上传。" : " 接近上限，请留意后续上传。"}
            </p>
          ) : null}
          {searchMessage ? (
            <p className="library-message" role="status">{searchMessage}</p>
          ) : null}
          {message ? <p className="library-message" role="status">{message}</p> : null}

          {result.scores.length > 0 ? (
            <section className="file-list" aria-label="PDF 文件">
              {result.scores.map((score) => (
                <article className="file-row" key={score.id}>
                  <Link
                    className="file-row__open"
                    to={`/choirs/${choirId}/scores/${score.id}`}
                    onClick={() =>
                      {
                        startLoadingJourney(
                          "open-score",
                          classifyReaderOpen(userId ?? "guest", choirId, score.id),
                        );
                        if (cacheOwner) {
                          rememberDriveView(cacheOwner, choirId, {
                            search,
                            scrollTop: window.scrollY,
                          });
                          prepareDriveLibraryReturn(cacheOwner, choirId);
                        }
                        rememberReaderScore(userId ?? "guest", score);
                      }
                    }
                  >
                    <span className="pdf-file-icon" aria-hidden="true">PDF</span>
                    <span className="file-row__name">{score.fileName}</span>
                    <span className="file-row__size">{formatBytes(score.currentVersion.sizeBytes)}</span>
                  </Link>
                  {result.permissions.canManage ? (
                    <MenuTrigger>
                      <Button className="file-menu-button" aria-label={`${score.fileName} 更多操作`}>
                        ···
                      </Button>
                      <Popover className="file-menu-popover">
                        <Menu
                          aria-label={`${score.fileName} 操作`}
                          onAction={(key) => openScoreAction(score, key as ScoreAction)}
                        >
                          <MenuItem id="rename">重命名</MenuItem>
                          <MenuItem id="replace">替换 PDF</MenuItem>
                          <MenuItem id="trash">移到回收站</MenuItem>
                        </Menu>
                      </Popover>
                    </MenuTrigger>
                  ) : null}
                </article>
              ))}
            </section>
          ) : (
            <p className="empty-library">这里还没有 PDF 文件。</p>
          )}
        </section>
      </main>

      <ModalOverlay
        className="modal-overlay"
        isOpen={inviteManagementOpen}
        onOpenChange={(open) => {
          setInviteManagementOpen(open);
          if (!open) {
            setRotatedJoinCode(null);
            setRotationMessage(null);
          }
        }}
        isDismissable
      >
        <Modal className="app-modal app-modal--compact">
          <Dialog className="app-dialog drive-management-dialog">
            {({ close }) => (
              <>
                <div className="dialog-heading">
                  <div>
                    <p className="dialog-eyebrow">管理</p>
                    <Heading slot="title">邀请码</Heading>
                  </div>
                  <Button className="icon-button" aria-label="关闭" onPress={close}>×</Button>
                </div>
                <p className="drive-management-copy">
                  轮换会立即停用旧邀请码；新邀请码只在本次操作后显示。
                </p>
                <Button
                  className="secondary-button"
                  isDisabled={busy}
                  onPress={() => void rotateJoinCode()}
                >
                  {busy ? "正在轮换…" : "轮换邀请码"}
                </Button>
                {rotationMessage ? (
                  <p className="library-message" role="status">{rotationMessage}</p>
                ) : null}
                {rotatedJoinCode ? (
                  <div className="join-code-result" role="status">
                    <p>新的八位邀请码</p>
                    <output aria-label="新的八位邀请码">{rotatedJoinCode}</output>
                    <Button onPress={() => setRotatedJoinCode(null)}>已复制，隐藏邀请码</Button>
                  </div>
                ) : null}
              </>
            )}
          </Dialog>
        </Modal>
      </ModalOverlay>

      <UploadDialog
        choirId={choirId}
        isOpen={uploadOpen}
        onOpenChange={setUploadOpen}
        onComplete={refreshAfterMutation}
        onQuotaBlocked={() => setQuotaBlocked(true)}
      />
      {scoreAction ? (
        <ScoreActionDialog
          key={`${scoreAction.score.id}:${scoreAction.action}`}
          choirId={choirId}
          selection={scoreAction}
          onClose={() => setScoreAction(null)}
          onComplete={async (nextMessage) => {
            await refreshAfterMutation();
            setScoreAction(null);
            setMessage(nextMessage);
          }}
        />
      ) : null}
      {trashOpen ? (
        <TrashDialog
          choirId={choirId}
          onClose={() => setTrashOpen(false)}
          onRestored={refreshAfterMutation}
        />
      ) : null}
    </div>
  );
}

async function openChoir(
  choirId: string,
  signedIn: boolean,
  query: string,
): Promise<
  Exclude<ChoirAccessState, { kind: "loading" }>
> {
  const bootstrap = await requestDriveBootstrap(choirId, query);
  if (bootstrap.kind === "loaded") {
    if (signedIn && bootstrap.access === "membership") void clearGuestSession();
    return bootstrap.opened;
  }
  if (bootstrap.kind === "failed") return { kind: "failed" };
  const openAdmission = await loadOpenAdmissionChoir(choirId);
  if (openAdmission.kind === "failed") return { kind: "failed" };
  if (openAdmission.kind === "not-found") return { kind: bootstrap.kind };
  if (signedIn && openAdmission.value.entryKind !== "preview") {
    return { kind: "join-required", choir: openAdmission.value.choir };
  }
  try {
    const admission = await fetch("/api/guest/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ admission: "open", choirId }),
    });
    if ([401, 403].includes(admission.status)) return { kind: "denied" };
    if (!admission.ok) return { kind: "failed" };
    const admitted = await requestDriveBootstrap(choirId, query);
    return admitted.kind === "loaded" ? admitted.opened : { kind: admitted.kind };
  } catch {
    return { kind: "failed" };
  }
}

type ChoirAccessState =
  | { kind: "loading"; choir?: ChoirSummary }
  | { kind: "opened"; choir: ChoirSummary; result: ScoreListResponse }
  | { kind: "join-required"; choir: ChoirSummary }
  | { kind: "denied" }
  | { kind: "not-found" }
  | { kind: "failed" };

async function loadOpenAdmissionChoir(choirId: string) {
  try {
    const response = await fetch(`/api/guest/choirs/${choirId}`);
    if (response.status === 404) return { kind: "not-found" as const };
    if (!response.ok) return { kind: "failed" as const };
    return {
      kind: "loaded" as const,
      value: guestSessionResponseSchema.parse(await response.json()),
    };
  } catch {
    return { kind: "failed" as const };
  }
}

type DriveBootstrapRequest =
  | {
      kind: "loaded";
      access: "membership" | "guest";
      opened: Extract<ChoirAccessState, { kind: "opened" }>;
    }
  | { kind: "denied" | "not-found" | "failed" };

async function requestDriveBootstrap(
  choirId: string,
  query: string,
): Promise<DriveBootstrapRequest> {
  try {
    const response = await fetch(
      `/api/choirs/${choirId}/bootstrap${query ? `?q=${encodeURIComponent(query)}` : ""}`,
    );
    if ([401, 403].includes(response.status)) return { kind: "denied" };
    if (response.status === 404) return { kind: "not-found" };
    if (!response.ok) return { kind: "failed" };
    const payload = driveBootstrapResponseSchema.parse(await response.json());
    return {
      kind: "loaded",
      access: payload.permissions.access,
      opened: {
        kind: "opened",
        choir: payload.choir,
        result: {
          scores: payload.scores,
          storage: payload.storage,
          permissions: { canManage: payload.permissions.canManage },
        },
      },
    };
  } catch {
    return { kind: "failed" };
  }
}

type ScoreListRequest =
  | { kind: "loaded"; result: ScoreListResponse }
  | { kind: "denied" }
  | { kind: "failed" };

async function requestScoreList(
  choirId: string,
  query: string,
): Promise<ScoreListRequest> {
  try {
    const response = await fetch(
      `/api/choirs/${choirId}/scores${query ? `?q=${encodeURIComponent(query)}` : ""}`,
    );
    if ([401, 403, 404].includes(response.status)) return { kind: "denied" };
    if (!response.ok) return { kind: "failed" };
    return {
      kind: "loaded",
      result: scoreListResponseSchema.parse(await response.json()),
    };
  } catch {
    return { kind: "failed" };
  }
}
