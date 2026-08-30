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
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [logoutSummary, setLogoutSummary] =
    useState<LogoutLocalSummary | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const userId = session.data?.user.id;

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

  const enterChoir = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setMessage(null);

    if (session.data?.user) {
      const response = await fetch("/api/choirs/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ joinCode, displayName }),
      });
      setSubmitting(false);
      if (!response.ok) {
        setMessage(
          response.status === 403
            ? "该成员关系需要团管理员恢复。"
            : "邀请码无效或已失效。",
        );
        return;
      }
      const payload = (await response.json()) as {
        membership: MembershipSummary;
      };
      await navigate(`/choirs/${payload.membership.choir.id}`);
      return;
    }

    const response = await fetch("/api/guest/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ joinCode }),
    });
    setSubmitting(false);
    if (!response.ok) {
      setMessage(
        response.status === 429
          ? "尝试次数过多，请稍后再试。"
          : "邀请码无效或已失效。",
      );
      return;
    }
    const payload = (await response.json()) as {
      choir: { id: string };
    };
    await navigate(`/choirs/${payload.choir.id}`);
  };

  return (
    <main className="page-shell">
      <section className="hero" aria-labelledby="page-title">
        <p className="eyebrow">Same Page · 合唱乐谱</p>
        <h1 id="page-title">让每次排练，都在同一页</h1>
        <p className="hero__copy">
          使用合唱团的八位邀请码查看乐谱。访客无需注册，只能阅读已发布内容。
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

      <section className="join-panel" aria-labelledby="join-title">
        <h2 id="join-title">
          {session.data?.user ? "加入另一个合唱团" : "使用邀请码访问"}
        </h2>
        <Form className="entry-form entry-form--inline" onSubmit={enterChoir}>
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
