import { type FormEvent, useCallback, useEffect, useState } from "react";
import {
  Button,
  Form,
  Input,
  Label,
  Menu,
  MenuItem,
  MenuTrigger,
  Popover,
  TextField,
} from "react-aria-components";
import { Link, useNavigate, useParams } from "react-router-dom";

import {
  choirMembershipsResponseSchema,
  choirSummarySchema,
  guestSessionResponseSchema,
  rotateJoinCodeResponseSchema,
  type ChoirSummary,
} from "../../shared/choirs";
import {
  scoreListResponseSchema,
  type ScoreListResponse,
  type ScoreSummary,
} from "../../shared/scores";
import { authClient } from "../auth/auth-client";
import { AppHeader } from "../components/app-header";
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
  const navigate = useNavigate();
  const session = authClient.useSession();
  const userId = session.data?.user.id;
  const [access, setAccess] = useState<ChoirAccessState>({ kind: "loading" });
  const [openAdmissionDisplayName, setOpenAdmissionDisplayName] = useState("");
  const [search, setSearch] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rotatedJoinCode, setRotatedJoinCode] = useState<string | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [quotaBlocked, setQuotaBlocked] = useState(false);
  const [scoreAction, setScoreAction] = useState<ScoreActionSelection | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);
  const currentChoir =
    access.kind === "opened" || access.kind === "join-required"
      ? access.choir
      : null;

  const refresh = useCallback(
    async (query = search) => {
      const next = await fetchScoreList(choirId, query);
      if (!next) {
        setAccess({ kind: "denied" });
        return;
      }
      setAccess({ kind: "opened", choir: currentChoir, result: next });
    },
    [choirId, currentChoir, search],
  );

  useEffect(() => {
    if (session.isPending) return;
    let active = true;
    void openChoir(choirId, Boolean(userId)).then((opened) => {
      if (!active) return;
      if (opened.kind === "preview-redirect") {
        void navigate("/", { replace: true });
        return;
      }
      setAccess(opened);
    });
    return () => {
      active = false;
    };
  }, [choirId, navigate, userId, session.isPending]);

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
      const [nextChoir, nextResult] = await Promise.all([
        loadChoirSummary(choirId),
        fetchScoreList(choirId, ""),
      ]);
      setAccess(
        nextResult
          ? { kind: "opened", choir: nextChoir ?? currentChoir, result: nextResult }
          : { kind: "denied" },
      );
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

  const rotateJoinCode = async () => {
    if (!window.confirm("轮换后当前邀请码会立即失效。确认继续吗？")) return;
    setBusy(true);
    setRotatedJoinCode(null);
    try {
      const response = await fetch(`/api/choirs/${choirId}/join-code/rotate`, {
        method: "POST",
      });
      if (!response.ok) throw new Error("rotation_failed");
      setRotatedJoinCode(rotateJoinCodeResponseSchema.parse(await response.json()).joinCode);
      setMessage("邀请码已轮换。请现在复制并通过私密渠道发送。");
    } catch {
      setMessage("邀请码轮换失败，当前邀请码没有改变。");
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
        <span className="account-email">{session.data.user.email}</span>
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

  if (access.kind === "loading") {
    return (
      <div className="app-page">
        <AppHeader actions={headerActions} />
        <p className="route-loading">正在打开云盘…</p>
      </div>
    );
  }

  const { choir, result } = access;
  const storageRatio = result.storage.usedBytes / result.storage.limitBytes;

  return (
    <div className="app-page">
      <AppHeader actions={headerActions} />
      <main className="page-shell file-library">
        <div className="library-heading">
          <div>
            <p className="eyebrow">云盘</p>
            <h1>{choir?.name ?? "乐谱"}</h1>
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
                    }}
                  >
                    <MenuItem id="trash">回收站</MenuItem>
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
        </div>

        <Form
          className="library-search"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            void refresh(search);
          }}
        >
          <TextField value={search} onChange={setSearch} aria-label="搜索文件名">
            <Input placeholder="搜索文件名" />
          </TextField>
          <Button type="submit">搜索</Button>
        </Form>

        {result.permissions.canManage && (storageRatio >= 0.8 || quotaBlocked) ? (
          <p className="storage-warning" role="status">
            云盘存储已使用 {formatBytes(result.storage.usedBytes)} / {formatBytes(result.storage.limitBytes)}。
            {quotaBlocked ? " 请先释放空间后再上传。" : " 接近上限，请留意后续上传。"}
          </p>
        ) : null}
        {message ? <p className="library-message" role="status">{message}</p> : null}

        {result.scores.length > 0 ? (
          <section className="file-list" aria-label="PDF 文件">
            {result.scores.map((score) => (
              <article className="file-row" key={score.id}>
                <Link className="file-row__open" to={`/choirs/${choirId}/scores/${score.id}`}>
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

        {result.permissions.canManage && choir?.guestAdmissionMode === "invite" ? (
          <section className="invite-admin" aria-labelledby="invite-title">
            <div>
              <h2 id="invite-title">邀请码</h2>
              <p>轮换会立即停用旧邀请码；新邀请码只在本次操作后显示。</p>
            </div>
            <Button isDisabled={busy} onPress={() => void rotateJoinCode()}>轮换邀请码</Button>
            {rotatedJoinCode ? (
              <div className="join-code-result" role="status">
                <p>新的八位邀请码</p>
                <output aria-label="新的八位邀请码">{rotatedJoinCode}</output>
                <Button onPress={() => setRotatedJoinCode(null)}>已复制，隐藏邀请码</Button>
              </div>
            ) : null}
          </section>
        ) : null}
      </main>

      <UploadDialog
        choirId={choirId}
        isOpen={uploadOpen}
        onOpenChange={setUploadOpen}
        onComplete={refresh}
        onQuotaBlocked={() => setQuotaBlocked(true)}
      />
      {scoreAction ? (
        <ScoreActionDialog
          key={`${scoreAction.score.id}:${scoreAction.action}`}
          choirId={choirId}
          selection={scoreAction}
          onClose={() => setScoreAction(null)}
          onComplete={async (nextMessage) => {
            await refresh();
            setScoreAction(null);
            setMessage(nextMessage);
          }}
        />
      ) : null}
      {trashOpen ? (
        <TrashDialog
          choirId={choirId}
          onClose={() => setTrashOpen(false)}
          onRestored={refresh}
        />
      ) : null}
    </div>
  );
}

async function openChoir(
  choirId: string,
  signedIn: boolean,
): Promise<
  Exclude<ChoirAccessState, { kind: "loading" }> | { kind: "preview-redirect" }
> {
  const [choir, result] = await Promise.all([
    loadChoirSummary(choirId),
    fetchScoreList(choirId, ""),
  ]);
  if (result) return { kind: "opened", choir, result };
  const openAdmission = await loadOpenAdmissionChoir(choirId);
  if (!openAdmission) return { kind: "denied" };
  if (signedIn) {
    return openAdmission.entryKind === "preview"
      ? { kind: "preview-redirect" }
      : { kind: "join-required", choir: openAdmission.choir };
  }
  try {
    const admission = await fetch("/api/guest/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ admission: "open", choirId }),
    });
    if (!admission.ok) return { kind: "denied" };
    const admittedResult = await fetchScoreList(choirId, "");
    return admittedResult
      ? { kind: "opened", choir: openAdmission.choir, result: admittedResult }
      : { kind: "denied" };
  } catch {
    return { kind: "denied" };
  }
}

type ChoirAccessState =
  | { kind: "loading" }
  | { kind: "opened"; choir: ChoirSummary | null; result: ScoreListResponse }
  | { kind: "join-required"; choir: ChoirSummary }
  | { kind: "denied" };

async function loadOpenAdmissionChoir(choirId: string) {
  try {
    const response = await fetch(`/api/guest/choirs/${choirId}`);
    if (!response.ok) return null;
    return guestSessionResponseSchema.parse(await response.json());
  } catch {
    return null;
  }
}

async function loadChoirSummary(choirId: string) {
  try {
    const guestResponse = await fetch("/api/guest/session");
    if (guestResponse.ok) {
      const payload = (await guestResponse.json()) as { choir: unknown };
      const guestChoir = choirSummarySchema.parse(payload.choir);
      if (guestChoir.id === choirId) return guestChoir;
    }
    const memberResponse = await fetch("/api/choirs");
    if (!memberResponse.ok) return null;
    const payload = choirMembershipsResponseSchema.parse(await memberResponse.json());
    return payload.memberships.find((item) => item.choir.id === choirId)?.choir ?? null;
  } catch {
    return null;
  }
}

async function fetchScoreList(choirId: string, query: string) {
  try {
    const response = await fetch(
      `/api/choirs/${choirId}/scores${query ? `?q=${encodeURIComponent(query)}` : ""}`,
    );
    if (!response.ok) return null;
    return scoreListResponseSchema.parse(await response.json());
  } catch {
    return null;
  }
}
