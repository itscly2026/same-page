import { type FormEvent, useEffect, useState } from "react";
import {
  Button,
  Form,
  Input,
  Label,
  TextField,
} from "react-aria-components";
import { Link, useNavigate } from "react-router-dom";

import {
  choirMembershipsResponseSchema,
  choirsWithOpenGuestAdmissionResponseSchema,
  type ChoirSummary,
  type GuestAdmissionRequest,
  type MembershipSummary,
} from "../../shared/choirs";
import { authClient } from "../auth/auth-client";
import {
  clearPrivateLocalDataAfterLogout,
  getLogoutLocalSummary,
  type LogoutLocalSummary,
} from "../auth/logout-local-data";

export function HomePage() {
  const navigate = useNavigate();
  const session = authClient.useSession();
  const [joinCode, setJoinCode] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [memberships, setMemberships] = useState<MembershipSummary[]>([]);
  const [choirsWithOpenGuestAdmission, setChoirsWithOpenGuestAdmission] =
    useState<ChoirSummary[]>([]);
  const [openAdmissionDisplayName, setOpenAdmissionDisplayName] = useState("");
  const [choirEnteringWithOpenAdmissionId, setChoirEnteringWithOpenAdmissionId] =
    useState<string | null>(null);
  const [openAdmissionMessage, setOpenAdmissionMessage] = useState<string | null>(
    null,
  );
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [logoutSummary, setLogoutSummary] =
    useState<LogoutLocalSummary | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const userId = session.data?.user.id;

  useEffect(() => {
    let active = true;
    void loadChoirsWithOpenGuestAdmission().then((nextChoirs) => {
      if (active) {
        setChoirsWithOpenGuestAdmission(nextChoirs);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!userId) {
      return;
    }

    let active = true;
    void loadMemberships().then((nextMemberships) => {
      if (active) {
        setMemberships(nextMemberships);
      }
    });
    return () => {
      active = false;
    };
  }, [userId]);

  const admitToChoir = async (
    admission: GuestAdmissionRequest,
    nextDisplayName: string,
  ) => {
    const response = await fetch(
      session.data?.user ? "/api/choirs/join" : "/api/guest/session",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          session.data?.user
            ? { ...admission, displayName: nextDisplayName }
            : admission,
        ),
      },
    );
    if (!response.ok) {
      return { ok: false as const, status: response.status };
    }

    const payload = (await response.json()) as {
      choir?: { id: string };
      membership?: { choir: { id: string } };
    };
    const choirId = payload.membership?.choir.id ?? payload.choir?.id;
    if (!choirId) {
      return { ok: false as const, status: 500 };
    }
    await navigate(`/choirs/${choirId}`);
    return { ok: true as const, status: response.status };
  };

  const enterInviteChoir = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setMessage(null);

    try {
      const result = await admitToChoir(
        { admission: "invite", joinCode },
        displayName,
      );
      if (result.ok) {
        return;
      }
      setMessage(
        result.status === 429
          ? "尝试次数过多，请稍后再试。"
          : result.status === 403
            ? "该成员关系需要团管理员恢复。"
          : "邀请码无效或已失效。",
      );
    } catch {
      setMessage("暂时无法进入这个合唱团，请稍后再试。");
    } finally {
      setSubmitting(false);
    }
  };

  const enterChoirWithOpenGuestAdmission = async (choir: ChoirSummary) => {
    setChoirEnteringWithOpenAdmissionId(choir.id);
    setOpenAdmissionMessage(null);

    try {
      const result = await admitToChoir(
        { admission: "open", choirId: choir.id },
        openAdmissionDisplayName,
      );
      if (!result.ok) {
        setOpenAdmissionMessage("暂时无法进入这个合唱团，请稍后再试。");
      }
    } catch {
      setOpenAdmissionMessage("暂时无法进入这个合唱团，请稍后再试。");
    } finally {
      setChoirEnteringWithOpenAdmissionId(null);
    }
  };

  return (
    <main className="page-shell">
      <section className="hero" aria-labelledby="page-title">
        <p className="eyebrow">Same Page · 合唱乐谱</p>
        <h1 id="page-title">让每次排练，都在同一页</h1>
        <p className="hero__copy">
          无需注册即可只读体验采用开放准入的合唱团；采用邀请准入的合唱团使用八位团邀请码进入。
        </p>

        {session.data?.user ? (
          <div className="session-strip">
            <span>已登录：{session.data.user.email}</span>
            <Button
              className="text-button"
              onPress={() =>
                void getLogoutLocalSummary().then(setLogoutSummary)
              }
            >
              退出登录
            </Button>
          </div>
        ) : (
          <Link className="primary-link" to="/login">
            邮箱登录或注册
          </Link>
        )}
      </section>

      {logoutSummary ? (
        <aside
          className="logout-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="logout-title"
        >
          <h2 id="logout-title">确认退出登录</h2>
          {logoutSummary.pendingOperations > 0 || logoutSummary.conflicts > 0 ? (
            <p>
              本机还有 {logoutSummary.pendingOperations} 项待同步操作和 {logoutSummary.conflicts}
              项本地冲突。继续会永久丢弃这些内容。
            </p>
          ) : (
            <p>退出后会清除本机个人层、编辑权限和账号偏好；已下载的共享内容可以保留。</p>
          )}
          <div className="update-prompt__actions">
            <Button isDisabled={loggingOut} onPress={() => setLogoutSummary(null)}>
              返回处理
            </Button>
            <Button
              isDisabled={loggingOut}
              onPress={() => {
                if (!navigator.onLine) {
                  setMessage("请联网后退出，以确保服务端会话同时失效。");
                  setLogoutSummary(null);
                  return;
                }
                setLoggingOut(true);
                void authClient
                  .signOut()
                  .then((result) => {
                    if (result.error) throw new Error("sign_out_failed");
                    return clearPrivateLocalDataAfterLogout();
                  })
                  .then(() => {
                    setMemberships([]);
                    setLogoutSummary(null);
                  })
                  .catch(() => {
                    setMessage("退出未完成，本机数据没有清除。请重试。");
                  })
                  .finally(() => setLoggingOut(false));
              }}
            >
              {logoutSummary.pendingOperations > 0 || logoutSummary.conflicts > 0
                ? "丢弃并退出"
                : "退出并清除"}
            </Button>
          </div>
        </aside>
      ) : null}

      {memberships.length > 0 ? (
        <section className="choir-section" aria-labelledby="my-choirs-title">
          <h2 id="my-choirs-title">我的合唱团</h2>
          <div className="choir-grid">
            {memberships.map((membership) => (
              <Link
                className="choir-card"
                key={membership.id}
                to={`/choirs/${membership.choir.id}`}
              >
                <strong>{membership.choir.name}</strong>
                <span>
                  {membership.displayName} ·
                  {membership.role === "admin" ? " 团管理员" : " 成员"}
                </span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      {choirsWithOpenGuestAdmission.length > 0 ? (
        <section
          className="choir-section"
          aria-labelledby="open-guest-admission-title"
        >
          <h2 id="open-guest-admission-title">直接体验</h2>
          <p className="section-copy">
            无需团邀请码；进入后仍然只能阅读已发布乐谱与共享批注。
          </p>
          {session.data?.user ? (
            <TextField
              className="open-admission-display-name"
              isRequired
              value={openAdmissionDisplayName}
              onChange={setOpenAdmissionDisplayName}
              maxLength={40}
            >
              <Label>加入采用开放准入的合唱团时使用的团内显示名</Label>
              <Input autoComplete="nickname" placeholder="例如：小花" />
            </TextField>
          ) : null}
          <div className="choir-grid">
            {choirsWithOpenGuestAdmission.map((choir) => (
              <Button
                className="choir-card choir-card--button"
                isDisabled={
                  session.isPending ||
                  choirEnteringWithOpenAdmissionId !== null ||
                  (Boolean(session.data?.user) &&
                    !openAdmissionDisplayName.trim())
                }
                key={choir.id}
                onPress={() => void enterChoirWithOpenGuestAdmission(choir)}
              >
                <strong>{choir.name}</strong>
                <span>
                  {choirEnteringWithOpenAdmissionId === choir.id
                    ? "正在进入…"
                    : "直接进入"}
                </span>
              </Button>
            ))}
          </div>
          {openAdmissionMessage ? (
            <p className="form-message" role="alert">
              {openAdmissionMessage}
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="join-panel" aria-labelledby="join-title">
        <h2 id="join-title">
          {session.data?.user ? "加入另一个合唱团" : "使用邀请码访问"}
        </h2>
        <Form
          className="entry-form entry-form--inline"
          onSubmit={enterInviteChoir}
        >
          <TextField
            isRequired
            value={joinCode}
            onChange={(value) => setJoinCode(value.toUpperCase())}
            minLength={8}
            maxLength={8}
          >
            <Label>八位邀请码</Label>
            <Input
              autoCapitalize="characters"
              autoComplete="off"
              placeholder="ABCDEFGH"
              pattern="[A-HJ-NP-Z2-9]{8}"
            />
          </TextField>
          {session.data?.user ? (
            <TextField
              isRequired
              value={displayName}
              onChange={setDisplayName}
              maxLength={40}
            >
              <Label>团内显示名</Label>
              <Input autoComplete="nickname" placeholder="例如：小花" />
            </TextField>
          ) : null}
          <Button type="submit" isDisabled={submitting || session.isPending}>
            {submitting
              ? "正在验证…"
              : session.data?.user
                ? "加入"
                : "访客进入"}
          </Button>
        </Form>
        {message ? (
          <p className="form-message" role="alert">
            {message}
          </p>
        ) : null}
      </section>
    </main>
  );
}

async function loadMemberships(): Promise<MembershipSummary[]> {
  const response = await fetch("/api/choirs");
  if (!response.ok) {
    return [];
  }
  return choirMembershipsResponseSchema.parse(await response.json()).memberships;
}

async function loadChoirsWithOpenGuestAdmission(): Promise<ChoirSummary[]> {
  try {
    const response = await fetch("/api/guest/choirs");
    if (!response.ok) {
      return [];
    }
    return choirsWithOpenGuestAdmissionResponseSchema.parse(
      await response.json(),
    ).choirs;
  } catch {
    return [];
  }
}
