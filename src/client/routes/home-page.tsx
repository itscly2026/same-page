import { type FormEvent, useEffect, useState } from "react";
import {
  Button,
  Dialog,
  Form,
  Heading,
  Input,
  Label,
  Modal,
  ModalOverlay,
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
import { AppHeader } from "../components/app-header";

export function HomePage() {
  const navigate = useNavigate();
  const session = authClient.useSession();
  const [joinOpen, setJoinOpen] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [memberships, setMemberships] = useState<MembershipSummary[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [joinMessage, setJoinMessage] = useState<string | null>(null);
  const [pageMessage, setPageMessage] = useState<string | null>(null);
  const [logoutSummary, setLogoutSummary] =
    useState<LogoutLocalSummary | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const userId = session.data?.user.id;
  const visibleMemberships = userId ? memberships : [];

  useEffect(() => {
    if (!userId) return;

    let active = true;
    void loadMemberships().then((nextMemberships) => {
      if (active) setMemberships(nextMemberships);
    });
    return () => {
      active = false;
    };
  }, [userId]);

  const enterInviteChoir = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setJoinMessage(null);

    try {
      const response = await fetch(
        session.data?.user ? "/api/choirs/join" : "/api/guest/session",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            session.data?.user
              ? { admission: "invite", joinCode, displayName }
              : { admission: "invite", joinCode },
          ),
        },
      );

      if (!response.ok) {
        setJoinMessage(
          response.status === 429
            ? "尝试次数过多，请稍后再试。"
            : response.status === 403 && session.data?.user
              ? "该成员关系需要团管理员恢复。"
              : "邀请码无效或已失效。",
        );
        return;
      }

      const payload = (await response.json()) as {
        choir?: { id: string };
        membership?: { choir: { id: string } };
      };
      const choirId = payload.membership?.choir.id ?? payload.choir?.id;
      if (!choirId) {
        setJoinMessage("暂时无法进入这个合唱团，请稍后再试。");
        return;
      }
      setJoinOpen(false);
      await navigate(`/choirs/${choirId}`);
    } catch {
      setJoinMessage("暂时无法进入这个合唱团，请稍后再试。");
    } finally {
      setSubmitting(false);
    }
  };

  const finishLogout = async () => {
    if (!navigator.onLine) {
      setPageMessage("请联网后退出，以确保服务端会话同时失效。");
      setLogoutSummary(null);
      return;
    }

    setLoggingOut(true);
    try {
      const result = await authClient.signOut();
      if (result.error) throw new Error("sign_out_failed");
      await clearPrivateLocalDataAfterLogout();
      setMemberships([]);
      setLogoutSummary(null);
    } catch {
      setPageMessage("退出未完成，本机数据没有清除。请重试。");
      setLogoutSummary(null);
    } finally {
      setLoggingOut(false);
    }
  };

  return (
    <div className="marketing-page">
      <AppHeader
        actions={
          session.data?.user ? (
            <>
              <span className="account-email">{session.data.user.email}</span>
              <Button
                className="header-action"
                onPress={() => void getLogoutLocalSummary().then(setLogoutSummary)}
              >
                退出登录
              </Button>
            </>
          ) : (
            <Link className="header-action" to="/login">
              登录 / 注册
            </Link>
          )
        }
      />

      <main className="marketing-hero" aria-labelledby="page-title">
        <p className="hero-mark">Same Page</p>
        <h1 id="page-title">Every voice, on the same page.</h1>
        <p className="hero-zh">同页共谱，众声一心。</p>
        <p className="hero-description">为合唱排练而设计的共享乐谱与批注空间。</p>
        <Button className="primary-button hero-cta" onPress={() => setJoinOpen(true)}>
          进入合唱团
        </Button>
        {pageMessage ? (
          <p className="form-message page-message" role="alert">
            {pageMessage}
          </p>
        ) : null}
      </main>

      <ModalOverlay
        className="modal-overlay"
        isOpen={joinOpen}
        onOpenChange={setJoinOpen}
        isDismissable
      >
        <Modal className="app-modal">
          <Dialog className="app-dialog">
            {({ close }) => (
              <>
                <div className="dialog-heading">
                  <div>
                    <p className="dialog-eyebrow">Same Page</p>
                    <Heading slot="title">进入合唱团</Heading>
                  </div>
                  <Button className="icon-button" aria-label="关闭" onPress={close}>
                    ×
                  </Button>
                </div>

                {visibleMemberships.length > 0 ? (
                  <section className="membership-picker" aria-labelledby="membership-title">
                    <h3 id="membership-title">我的合唱团</h3>
                    <div className="membership-list">
                      {visibleMemberships.map((membership) => (
                        <Link
                          className="membership-row"
                          key={membership.id}
                          to={`/choirs/${membership.choir.id}`}
                          onClick={() => setJoinOpen(false)}
                        >
                          <span>
                            <strong>{membership.choir.name}</strong>
                            <small>{membership.displayName}</small>
                          </span>
                          <span aria-hidden="true">→</span>
                        </Link>
                      ))}
                    </div>
                  </section>
                ) : null}

                <section className={visibleMemberships.length ? "invite-section" : undefined}>
                  <h3>{session.data?.user ? "使用邀请码加入" : "使用邀请码访问"}</h3>
                  <p className="dialog-copy">
                    {session.data?.user
                      ? "输入合唱团提供的八位邀请码。"
                      : "无需注册，也可以访客身份只读访问。"}
                  </p>
                  <Form className="entry-form dialog-form" onSubmit={enterInviteChoir}>
                    <TextField
                      isRequired
                      value={joinCode}
                      onChange={(value) => setJoinCode(value.toUpperCase())}
                      minLength={8}
                      maxLength={8}
                    >
                      <Label>八位邀请码</Label>
                      <Input
                        autoFocus
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
                      {submitting ? "正在验证…" : "继续"}
                    </Button>
                  </Form>
                  {joinMessage ? (
                    <p className="form-message" role="alert">
                      {joinMessage}
                    </p>
                  ) : null}
                </section>
              </>
            )}
          </Dialog>
        </Modal>
      </ModalOverlay>

      <ModalOverlay
        className="modal-overlay"
        isOpen={Boolean(logoutSummary)}
        onOpenChange={(open) => {
          if (!open) setLogoutSummary(null);
        }}
        isDismissable={!loggingOut}
      >
        <Modal className="app-modal app-modal--compact">
          <Dialog className="app-dialog">
            <Heading slot="title">确认退出登录</Heading>
            {logoutSummary?.pendingOperations || logoutSummary?.conflicts ? (
              <p className="dialog-copy">
                本机还有 {logoutSummary?.pendingOperations ?? 0} 项待同步操作和{" "}
                {logoutSummary?.conflicts ?? 0} 项本地冲突。继续会永久丢弃这些内容。
              </p>
            ) : (
              <p className="dialog-copy">
                退出后会清除本机个人层、编辑权限和用户偏好；已下载的共享内容可以保留。
              </p>
            )}
            <div className="dialog-actions">
              <Button className="secondary-button" onPress={() => setLogoutSummary(null)}>
                返回处理
              </Button>
              <Button
                className="primary-button"
                isDisabled={loggingOut}
                onPress={() => void finishLogout()}
              >
                {logoutSummary?.pendingOperations || logoutSummary?.conflicts
                  ? "丢弃并退出"
                  : "退出并清除"}
              </Button>
            </div>
          </Dialog>
        </Modal>
      </ModalOverlay>
    </div>
  );
}

async function loadMemberships(): Promise<MembershipSummary[]> {
  try {
    const response = await fetch("/api/choirs");
    if (!response.ok) return [];
    return choirMembershipsResponseSchema.parse(await response.json()).memberships;
  } catch {
    return [];
  }
}
