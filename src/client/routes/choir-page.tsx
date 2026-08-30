import { type DragEvent, type FormEvent, useCallback, useEffect, useState } from "react";
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

import {
  choirMembershipsResponseSchema,
  choirSummarySchema,
  rotateJoinCodeResponseSchema,
  type ChoirSummary,
} from "../../shared/choirs";
import {
  scoreListResponseSchema,
  scoreTrashResponseSchema,
  type ScoreListResponse,
  type ScoreSummary,
  type TrashedScoreSummary,
} from "../../shared/scores";
import { authClient } from "../auth/auth-client";
import { AppHeader } from "../components/app-header";

type ScoreAction = "rename" | "replace" | "trash";
type UploadStatus = "uploading" | "success" | "error";

interface UploadItem {
  id: string;
  file: File;
  status: UploadStatus;
  message: string;
}

export default function ChoirPage() {
  const { choirId = "" } = useParams();
  const session = authClient.useSession();
  const userId = session.data?.user.id;
  const [access, setAccess] = useState<ChoirAccessState>({ kind: "loading" });
  const [openAdmissionDisplayName, setOpenAdmissionDisplayName] = useState("");
  const [search, setSearch] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rotatedJoinCode, setRotatedJoinCode] = useState<string | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [quotaBlocked, setQuotaBlocked] = useState(false);
  const [scoreAction, setScoreAction] = useState<{
    action: ScoreAction;
    score: ScoreSummary;
  } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [replacementFile, setReplacementFile] = useState<File | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);
  const [trash, setTrash] = useState<TrashedScoreSummary[]>([]);
  const [trashMessage, setTrashMessage] = useState<string | null>(null);
  const [restoreConflict, setRestoreConflict] = useState<TrashedScoreSummary | null>(null);
  const [restoreName, setRestoreName] = useState("");
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
      if (active) setAccess(opened);
    });
    return () => {
      active = false;
    };
  }, [choirId, userId, session.isPending]);

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
            ? "该成员关系需要团管理员恢复。"
            : "暂时无法加入这个合唱团，请稍后再试。",
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
      setMessage("暂时无法加入这个合唱团，请稍后再试。");
    } finally {
      setBusy(false);
    }
  };

  const startUploads = async (files: File[]) => {
    const nextItems = files.map((file) => ({
      id: crypto.randomUUID(),
      file,
      status: isPdfFile(file) ? ("uploading" as const) : ("error" as const),
      message: isPdfFile(file) ? "正在验证并上传…" : "只接受 PDF 文件。",
    }));
    setUploads((current) => [...nextItems, ...current]);
    setUploadOpen(true);

    await Promise.all(
      nextItems.filter((item) => item.status === "uploading").map(async (item) => {
        const form = new FormData();
        form.set("file", item.file);
        try {
          const response = await fetch(`/api/choirs/${choirId}/scores`, {
            method: "POST",
            body: form,
          });
          const payload = await response.json().catch(() => null);
          const next = response.ok
            ? { status: "success" as const, message: "上传完成" }
            : { status: "error" as const, message: uploadMessage(response.status, payload) };
          if ((payload as { error?: string } | null)?.error === "storage_quota_exceeded") {
            setQuotaBlocked(true);
          }
          setUploads((current) =>
            current.map((entry) => (entry.id === item.id ? { ...entry, ...next } : entry)),
          );
        } catch {
          setUploads((current) =>
            current.map((entry) =>
              entry.id === item.id
                ? { ...entry, status: "error", message: "网络中断，请重新选择该文件。" }
                : entry,
            ),
          );
        }
      }),
    );
    await refresh();
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) void startUploads(files);
  };

  const openScoreAction = (score: ScoreSummary, action: ScoreAction) => {
    setScoreAction({ score, action });
    setRenameValue(score.fileName);
    setReplacementFile(null);
    setMessage(null);
  };

  const submitScoreAction = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!scoreAction) return;
    setBusy(true);
    setMessage(null);
    try {
      let response: Response;
      if (scoreAction.action === "rename") {
        response = await fetch(`/api/choirs/${choirId}/scores/${scoreAction.score.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ fileName: renameValue }),
        });
      } else if (scoreAction.action === "replace" && replacementFile) {
        const form = new FormData();
        form.set("file", replacementFile);
        response = await fetch(
          `/api/choirs/${choirId}/scores/${scoreAction.score.id}/versions`,
          { method: "POST", body: form },
        );
      } else {
        response = await fetch(`/api/choirs/${choirId}/scores/${scoreAction.score.id}`, {
          method: "DELETE",
        });
      }
      const payload = response.status === 204 ? null : await response.json().catch(() => null);
      if (!response.ok) {
        setMessage(uploadMessage(response.status, payload));
        return;
      }
      setScoreAction(null);
      setMessage(
        scoreAction.action === "rename"
          ? "文件已重命名。"
          : scoreAction.action === "replace"
            ? "PDF 已替换；现有批注继续使用原页码和坐标。"
            : "文件已移到回收站，将在三十天后自动删除。",
      );
      await refresh();
    } catch {
      setMessage("操作未完成，请稍后重试。");
    } finally {
      setBusy(false);
    }
  };

  const openTrash = async () => {
    setTrashOpen(true);
    setTrashMessage(null);
    try {
      const response = await fetch(`/api/choirs/${choirId}/scores/trash`);
      if (!response.ok) throw new Error("trash_unavailable");
      setTrash(scoreTrashResponseSchema.parse(await response.json()).scores);
    } catch {
      setTrashMessage("暂时无法打开回收站。");
    }
  };

  const restoreScore = async (score: TrashedScoreSummary, nextName?: string) => {
    setBusy(true);
    setTrashMessage(null);
    try {
      if (nextName) {
        const rename = await fetch(`/api/choirs/${choirId}/scores/${score.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ fileName: nextName }),
        });
        if (!rename.ok) {
          setTrashMessage(uploadMessage(rename.status, await rename.json().catch(() => null)));
          return;
        }
      }
      const response = await fetch(`/api/choirs/${choirId}/scores/${score.id}/restore`, {
        method: "POST",
      });
      if (response.status === 409) {
        setRestoreConflict(score);
        setRestoreName(score.fileName);
        setTrashMessage("当前文件库已有同名文件，请先为恢复的文件换一个名称。");
        return;
      }
      if (!response.ok) {
        setTrashMessage("恢复未完成，请稍后重试。");
        return;
      }
      setRestoreConflict(null);
      setTrash((current) => current.filter((entry) => entry.id !== score.id));
      setTrashMessage("文件已恢复。批注和 PDF 版本保持不变。");
      await refresh();
    } catch {
      setTrashMessage("恢复未完成，请稍后重试。");
    } finally {
      setBusy(false);
    }
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
        其他合唱团
      </Link>
      {session.data?.user ? (
        <span className="account-email">{session.data.user.email}</span>
      ) : (
        <Link className="header-action header-action--primary" to="/login">
          登录 / 注册
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
          <p className="hero__copy">这个合唱团采用开放准入。填写团内显示名后即可加入。</p>
          <Form className="entry-form" onSubmit={joinOpenChoir}>
            <TextField
              isRequired
              value={openAdmissionDisplayName}
              onChange={setOpenAdmissionDisplayName}
              maxLength={40}
            >
              <Label>团内显示名</Label>
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
          <p className="eyebrow">合唱团</p>
          <h1>无法访问这个合唱团</h1>
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
        <p className="route-loading">正在打开合唱团…</p>
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
            <p className="eyebrow">合唱团</p>
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
                      if (key === "trash") void openTrash();
                    }}
                  >
                    <MenuItem id="trash">回收站</MenuItem>
                    <MenuItem id="storage" isDisabled>
                      团存储：{formatBytes(result.storage.usedBytes)} / {formatBytes(result.storage.limitBytes)}
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
            团存储已使用 {formatBytes(result.storage.usedBytes)} / {formatBytes(result.storage.limitBytes)}。
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
              <h2 id="invite-title">团邀请码</h2>
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

      <ModalOverlay className="modal-overlay" isOpen={uploadOpen} onOpenChange={setUploadOpen} isDismissable>
        <Modal className="app-modal">
          <Dialog className="app-dialog">
            {({ close }) => (
              <>
                <DialogHeading title="上传 PDF" close={close} />
                <p className="dialog-copy">可一次选择或拖入多个 PDF。每个文件独立验证，单个失败不影响其他文件。</p>
                <div
                  className="upload-dropzone"
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={handleDrop}
                >
                  <label>
                    <span>选择 PDF 文件</span>
                    <input
                      type="file"
                      accept="application/pdf,.pdf"
                      multiple
                      onChange={(event) => {
                        const files = Array.from(event.currentTarget.files ?? []);
                        event.currentTarget.value = "";
                        if (files.length > 0) void startUploads(files);
                      }}
                    />
                  </label>
                  <small>或拖到这里 · 单份最大 20 MB</small>
                </div>
                {uploads.length > 0 ? (
                  <ul className="upload-list" aria-label="上传状态">
                    {uploads.map((item) => (
                      <li key={item.id} data-status={item.status}>
                        <span>{item.file.name}</span>
                        <strong>{item.message}</strong>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </>
            )}
          </Dialog>
        </Modal>
      </ModalOverlay>

      <ModalOverlay
        className="modal-overlay"
        isOpen={Boolean(scoreAction)}
        onOpenChange={(open) => { if (!open) setScoreAction(null); }}
        isDismissable={!busy}
      >
        <Modal className="app-modal app-modal--compact">
          <Dialog className="app-dialog">
            {({ close }) => scoreAction ? (
              <>
                <DialogHeading title={actionTitle(scoreAction.action)} close={close} />
                <Form className="entry-form dialog-form" onSubmit={submitScoreAction}>
                  {scoreAction.action === "rename" ? (
                    <TextField isRequired value={renameValue} onChange={setRenameValue} maxLength={255}>
                      <Label>文件名</Label>
                      <Input autoFocus />
                    </TextField>
                  ) : scoreAction.action === "replace" ? (
                    <label>
                      新的 PDF
                      <input
                        required
                        type="file"
                        accept="application/pdf,.pdf"
                        onChange={(event) => setReplacementFile(event.currentTarget.files?.[0] ?? null)}
                      />
                    </label>
                  ) : (
                    <p className="dialog-copy">“{scoreAction.score.fileName}”将从文件库消失，三十天内可从回收站恢复。</p>
                  )}
                  <Button type="submit" isDisabled={busy || (scoreAction.action === "replace" && !replacementFile)}>
                    {busy ? "正在处理…" : scoreAction.action === "trash" ? "移到回收站" : "确认"}
                  </Button>
                </Form>
                {message ? <p className="form-message" role="alert">{message}</p> : null}
              </>
            ) : null}
          </Dialog>
        </Modal>
      </ModalOverlay>

      <ModalOverlay className="modal-overlay" isOpen={trashOpen} onOpenChange={setTrashOpen} isDismissable={!busy}>
        <Modal className="app-modal">
          <Dialog className="app-dialog">
            {({ close }) => (
              <>
                <DialogHeading title="回收站" close={close} />
                <p className="dialog-copy">文件保留三十天，到期自动删除。这里不提供手工永久删除。</p>
                {trash.length > 0 ? (
                  <ul className="trash-list">
                    {trash.map((score) => (
                      <li key={score.id}>
                        <span><strong>{score.fileName}</strong><small>{daysRemaining(score.trashExpiresAt)} 天后自动删除</small></span>
                        <Button isDisabled={busy} onPress={() => void restoreScore(score)}>恢复</Button>
                      </li>
                    ))}
                  </ul>
                ) : <p className="empty-library">回收站是空的。</p>}
                {restoreConflict ? (
                  <Form
                    className="entry-form restore-conflict"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void restoreScore(restoreConflict, restoreName);
                    }}
                  >
                    <TextField isRequired value={restoreName} onChange={setRestoreName} maxLength={255}>
                      <Label>恢复时使用的新文件名</Label>
                      <Input autoFocus />
                    </TextField>
                    <Button type="submit" isDisabled={busy}>重命名并恢复</Button>
                  </Form>
                ) : null}
                {trashMessage ? <p className="form-message" role="status">{trashMessage}</p> : null}
              </>
            )}
          </Dialog>
        </Modal>
      </ModalOverlay>
    </div>
  );
}

function DialogHeading({ title, close }: { title: string; close: () => void }) {
  return (
    <div className="dialog-heading">
      <div>
        <p className="dialog-eyebrow">Same Page</p>
        <Heading slot="title">{title}</Heading>
      </div>
      <Button className="icon-button" aria-label="关闭" onPress={close}>×</Button>
    </div>
  );
}

async function openChoir(
  choirId: string,
  signedIn: boolean,
): Promise<Exclude<ChoirAccessState, { kind: "loading" }>> {
  const [choir, result] = await Promise.all([
    loadChoirSummary(choirId),
    fetchScoreList(choirId, ""),
  ]);
  if (result) return { kind: "opened", choir, result };
  const openChoirSummary = await loadOpenAdmissionChoir(choirId);
  if (!openChoirSummary) return { kind: "denied" };
  if (signedIn) return { kind: "join-required", choir: openChoirSummary };
  try {
    const admission = await fetch("/api/guest/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ admission: "open", choirId }),
    });
    if (!admission.ok) return { kind: "denied" };
    const admittedResult = await fetchScoreList(choirId, "");
    return admittedResult
      ? { kind: "opened", choir: openChoirSummary, result: admittedResult }
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
    const payload = (await response.json()) as { choir: unknown };
    return choirSummarySchema.parse(payload.choir);
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

function actionTitle(action: ScoreAction) {
  if (action === "rename") return "重命名";
  if (action === "replace") return "替换 PDF";
  return "移到回收站";
}

function daysRemaining(expiresAt: number) {
  return Math.max(1, Math.ceil((expiresAt - Date.now()) / (24 * 60 * 60 * 1000)));
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(0, bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function uploadMessage(status: number, payload: unknown) {
  const error = (payload as { error?: string } | null)?.error;
  if (status === 413 || error === "pdf_too_large") return "PDF 超过 20 MB。";
  if (error === "encrypted_pdf") return "加密 PDF 不能上传。";
  if (error === "invalid_pdf") return "PDF 已损坏或无法解析。";
  if (error === "filename_conflict") return "文件库已有同名文件。请重命名，或在原文件上执行替换 PDF。";
  if (error === "invalid_file_name") return "文件名无效。";
  if (error === "storage_quota_exceeded") return "合唱团的 1 GB 文件配额已用完。";
  if (error === "replacement_in_progress") return "另一项 PDF 替换正在进行，请稍后再试。";
  return "操作没有完成，现有文件保持不变。";
}

function isPdfFile(file: File) {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}
