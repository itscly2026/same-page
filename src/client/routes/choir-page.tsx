import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Button, Form, Input, Label, TextField } from "react-aria-components";
import { Link, useParams } from "react-router-dom";

import {
  choirMembershipsResponseSchema,
  choirSummarySchema,
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
  const [replacementFiles, setReplacementFiles] = useState<
    Record<string, File | undefined>
  >({});
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
      setAccess(opened);
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

  const uploadScore = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    setBusy(true);
    setMessage(null);
    const form = new FormData(formElement);
    const response = await fetch(`/api/choirs/${choirId}/scores`, {
      method: "POST",
      body: form,
    });
    setBusy(false);
    if (!response.ok) {
      setMessage(uploadMessage(response.status, await response.json()));
      return;
    }
    formElement.reset();
    setMessage("PDF 已验证并保存为草稿。预览确认后再发布。");
    await refresh();
  };

  const updateScore = async (
    scoreId: string,
    patch: Partial<
      Pick<
        ScoreSummary,
        "status" | "sortOrder" | "title" | "composer" | "arranger"
      >
    >,
  ) => {
    setBusy(true);
    setMessage(null);
    const response = await fetch(`/api/choirs/${choirId}/scores/${scoreId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    setBusy(false);
    setMessage(response.ok ? "乐谱状态已更新。" : "暂时无法更新乐谱状态。");
    if (response.ok) await refresh();
  };

  const editScore = (event: FormEvent<HTMLFormElement>, scoreId: string) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void updateScore(scoreId, {
      title: String(form.get("title") ?? ""),
      composer: String(form.get("composer") ?? ""),
      arranger: String(form.get("arranger") ?? ""),
      sortOrder: Number(form.get("sortOrder") ?? 0),
    });
  };

  const deleteDraft = async (score: ScoreSummary) => {
    if (!window.confirm(`确认删除草稿“${score.title}”及其全部 PDF 版本吗？`)) {
      return;
    }
    setBusy(true);
    const response = await fetch(`/api/choirs/${choirId}/scores/${score.id}`, {
      method: "DELETE",
    });
    setBusy(false);
    setMessage(response.ok ? "草稿已删除。" : "只有未发布草稿可以删除。");
    if (response.ok) await refresh();
  };

  const replacePdf = async (scoreId: string) => {
    const file = replacementFiles[scoreId];
    if (!file) return;
    setBusy(true);
    setMessage(null);
    const form = new FormData();
    form.set("file", file);
    const response = await fetch(
      `/api/choirs/${choirId}/scores/${scoreId}/versions`,
      { method: "POST", body: form },
    );
    setBusy(false);
    if (!response.ok) {
      setMessage(uploadMessage(response.status, await response.json()));
      return;
    }
    setReplacementFiles((current) => ({ ...current, [scoreId]: undefined }));
    setMessage("PDF 已替换；批注继续使用原页码和归一化坐标。");
    await refresh();
  };

  const rotateJoinCode = async () => {
    if (
      !window.confirm(
        "轮换后，当前邀请码会立即失效，正在使用旧码的访客也需要重新输入新码。确认继续吗？",
      )
    ) {
      return;
    }

    setBusy(true);
    setMessage(null);
    setRotatedJoinCode(null);
    try {
      const response = await fetch(
        `/api/choirs/${choirId}/join-code/rotate`,
        { method: "POST" },
      );
      if (!response.ok) {
        setMessage("邀请码轮换失败，当前邀请码没有改变。");
        return;
      }
      const payload = rotateJoinCodeResponseSchema.parse(await response.json());
      setRotatedJoinCode(payload.joinCode);
      setMessage("邀请码已轮换。请现在复制新邀请码并通过私密渠道发送。");
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
          <p className="hero__copy">
            这个合唱团采用开放准入。填写团内显示名后即可加入。
          </p>
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
          {message ? (
            <p className="form-message" role="alert">
              {message}
            </p>
          ) : null}
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
          <p className="hero__copy">
            请返回首页输入当前邀请码，或使用有成员关系的邮箱登录。
          </p>
          <Link className="primary-link" to="/">
            返回首页
          </Link>
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

  return (
    <div className="app-page">
      <AppHeader actions={headerActions} />
      <main className="page-shell choir-page">
      <p className="eyebrow">合唱团</p>
      <h1>{choir?.name ?? "乐谱"}</h1>
      <p className="hero__copy">
        {result.permissions.canManage
          ? "管理、预览并发布团内 PDF；所有文件版本共享团级配额。"
          : "选择一份已发布乐谱开始阅读。打开后默认是阅读模式。"}
      </p>

      <section className="score-toolbar" aria-label="乐谱搜索与用量">
        <Form
          className="score-search"
          onSubmit={(event) => {
            event.preventDefault();
            void refresh(search);
          }}
        >
          <TextField value={search} onChange={setSearch}>
            <Label>搜索标题、作曲者或编曲者</Label>
            <Input placeholder="输入关键词" />
          </TextField>
          <Button type="submit">搜索</Button>
        </Form>
        <p>
          已用 {formatBytes(result.storage.usedBytes)} / {formatBytes(result.storage.limitBytes)}
        </p>
      </section>

      {message ? (
        <p className="form-message" role="status">
          {message}
        </p>
      ) : null}

      {result.scores.length ? (
        <section className="score-list" aria-label="乐谱列表">
          {result.scores.map((score) => (
            <article className="score-card" key={score.id}>
              <div>
                <span className={`score-status score-status--${score.status}`}>
                  {statusLabel(score.status)}
                </span>
                <h2>{score.title}</h2>
                <p>
                  {[score.composer, score.arranger]
                    .filter(Boolean)
                    .join(" · ") || "未填写作者信息"}
                </p>
                <small>
                  {score.currentVersion.pageCount} 页 · 第 {score.currentVersion.versionNumber} 版 · {formatBytes(score.currentVersion.sizeBytes)}
                </small>
              </div>
              <div className="score-card__actions">
                <Link
                  className="primary-link"
                  to={`/choirs/${choirId}/scores/${score.id}`}
                >
                  打开阅读器
                </Link>
                {result.permissions.canManage ? (
                  <>
                    <form
                      className="score-metadata-form"
                      onSubmit={(event) => editScore(event, score.id)}
                    >
                      <label>
                        标题
                        <input
                          name="title"
                          defaultValue={score.title}
                          required
                          maxLength={160}
                        />
                      </label>
                      <label>
                        作曲者
                        <input
                          name="composer"
                          defaultValue={score.composer ?? ""}
                          maxLength={120}
                        />
                      </label>
                      <label>
                        编曲者
                        <input
                          name="arranger"
                          defaultValue={score.arranger ?? ""}
                          maxLength={120}
                        />
                      </label>
                      <label>
                        排序
                        <input
                          name="sortOrder"
                          type="number"
                          defaultValue={score.sortOrder}
                        />
                      </label>
                      <button type="submit" disabled={busy}>
                        保存资料与排序
                      </button>
                    </form>
                    {score.status !== "published" ? (
                      <Button
                        isDisabled={busy}
                        onPress={() =>
                          void updateScore(score.id, { status: "published" })
                        }
                      >
                        发布
                      </Button>
                    ) : (
                      <Button
                        isDisabled={busy}
                        onPress={() =>
                          void updateScore(score.id, { status: "archived" })
                        }
                      >
                        归档
                      </Button>
                    )}
                    {score.status === "draft" ? (
                      <Button
                        isDisabled={busy}
                        onPress={() => void deleteDraft(score)}
                      >
                        删除草稿
                      </Button>
                    ) : null}
                    <label className="replacement-control">
                      选择替换 PDF
                      <input
                        type="file"
                        accept="application/pdf,.pdf"
                        onChange={(event) =>
                          setReplacementFiles((current) => ({
                            ...current,
                            [score.id]: event.target.files?.[0],
                          }))
                        }
                      />
                    </label>
                    <Button
                      isDisabled={busy || !replacementFiles[score.id]}
                      onPress={() => void replacePdf(score.id)}
                    >
                      确认替换（保留原批注坐标）
                    </Button>
                  </>
                ) : null}
              </div>
            </article>
          ))}
        </section>
      ) : (
        <p className="empty-state">没有符合条件的已发布乐谱。</p>
      )}

      {result.permissions.canManage ? (
        <>
          {choir?.guestAdmissionMode === "invite" ? (
            <section className="admin-panel" aria-labelledby="invite-title">
              <h2 id="invite-title">团邀请码</h2>
              <p>
                轮换会立即停用旧邀请码。新邀请码只在本次操作后显示，不会保存在浏览器中。
              </p>
              <Button isDisabled={busy} onPress={() => void rotateJoinCode()}>
                轮换邀请码
              </Button>
              {rotatedJoinCode ? (
                <div className="join-code-result" role="status">
                  <p>新的八位邀请码</p>
                  <output aria-label="新的八位邀请码">{rotatedJoinCode}</output>
                  <Button onPress={() => setRotatedJoinCode(null)}>
                    已复制，隐藏邀请码
                  </Button>
                </div>
              ) : null}
            </section>
          ) : null}

          <section className="admin-panel" aria-labelledby="upload-title">
            <h2 id="upload-title">上传新乐谱</h2>
            <p>只接受可解析且未加密的 PDF，单份最大 20 MB。上传后先保存为草稿。</p>
            <form className="entry-form" onSubmit={uploadScore}>
              <label>
                标题
                <input name="title" required maxLength={160} />
              </label>
              <label>
                作曲者（选填）
                <input name="composer" maxLength={120} />
              </label>
              <label>
                编曲者（选填）
                <input name="arranger" maxLength={120} />
              </label>
              <label>
                排序
                <input name="sortOrder" type="number" defaultValue={0} />
              </label>
              <label>
                PDF 文件
                <input
                  name="file"
                  type="file"
                  accept="application/pdf,.pdf"
                  required
                />
              </label>
              <button type="submit" disabled={busy}>
                {busy ? "正在验证并保存…" : "上传为草稿"}
              </button>
            </form>
          </section>
        </>
      ) : null}

        <Link className="back-link" to="/">
          返回首页
        </Link>
      </main>
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
  if (result) {
    return { kind: "opened", choir, result };
  }

  const openChoirSummary = await loadOpenAdmissionChoir(choirId);
  if (!openChoirSummary) {
    return { kind: "denied" };
  }
  if (signedIn) {
    return {
      kind: "join-required",
      choir: openChoirSummary,
    };
  }

  try {
    const admission = await fetch("/api/guest/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ admission: "open", choirId }),
    });
    if (!admission.ok) {
      return { kind: "denied" };
    }
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

async function loadOpenAdmissionChoir(
  choirId: string,
): Promise<ChoirSummary | null> {
  try {
    const response = await fetch(`/api/guest/choirs/${choirId}`);
    if (!response.ok) return null;
    const payload = (await response.json()) as { choir: unknown };
    return choirSummarySchema.parse(payload.choir);
  } catch {
    return null;
  }
}

async function loadChoirSummary(
  choirId: string,
): Promise<ChoirSummary | null> {
  try {
    const guestResponse = await fetch("/api/guest/session");
    if (guestResponse.ok) {
      const payload = (await guestResponse.json()) as {
        choir: unknown;
      };
      const guestChoir = choirSummarySchema.parse(payload.choir);
      if (guestChoir.id === choirId) return guestChoir;
    }
    const memberResponse = await fetch("/api/choirs");
    if (!memberResponse.ok) return null;
    const payload = choirMembershipsResponseSchema.parse(
      await memberResponse.json(),
    );
    return (
      payload.memberships.find((item) => item.choir.id === choirId)?.choir ??
      null
    );
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

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(0, bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function statusLabel(status: ScoreSummary["status"]) {
  if (status === "published") return "已发布";
  if (status === "archived") return "已归档";
  return "草稿";
}

function uploadMessage(status: number, payload: unknown) {
  const error = (payload as { error?: string } | null)?.error;
  if (status === 413 || error === "pdf_too_large") return "PDF 超过 20 MB。";
  if (error === "encrypted_pdf") return "加密 PDF 不能发布。";
  if (error === "invalid_pdf") return "PDF 已损坏或无法解析。";
  if (error === "storage_quota_exceeded") return "合唱团的 1 GB 文件配额已用完。";
  if (error === "replacement_in_progress") return "另一项 PDF 替换正在进行，请稍后再试。";
  return "上传没有完成，原文件和当前版本均未改变。";
}
