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

import { isInternalAuthEmail } from "../../shared/auth";
import {
  choirMembershipsResponseSchema,
  guestJoinStateResponseSchema,
  guestSessionResponseSchema,
  previewChoirResponseSchema,
  type ChoirSummary,
  type MembershipSummary,
} from "../../shared/choirs";
import { authClient } from "../auth/auth-client";
import {
  clearGuestSession,
  clearPreviewGuestSession,
} from "../auth/preview-guest-session";
import {
  clearPrivateLocalDataAfterLogout,
  getLogoutLocalSummary,
  type LogoutLocalSummary,
} from "../auth/logout-local-data";
import { AppHeader } from "../components/app-header";
import { JoinCodeField } from "../components/join-code-field";
import { JOIN_CODE_LENGTH } from "../components/join-code";
import { startLoadingJourney } from "../performance/loading-performance";
import {
  driveCacheOwnerKey,
  rememberDriveSummary,
} from "../score-library/drive-library-cache";

type JoinStep =
  | { kind: "invite" }
  | { kind: "display-name"; choir: ChoirSummary };

const productFeatures = [
  {
    title: "不同声部，分层共享",
    description:
      "每份乐谱都包含 E、S、A、T、B 五个默认共享层，其中 E · Ensemble 用于所有人都关注的内容。获授权的人，可以在对应共享层留下批注。",
  },
  {
    title: "只看需要的，也保留自己的",
    description:
      "你可以只显示与自己有关的共享层。你也拥有一个只有自己可见、可编辑的个人层。",
  },
  {
    title: "有网就同步，没网不耽误",
    description:
      "打开乐谱即可获取最新的共享批注。提前下载离线副本后，断网时阅读和批注仍可继续；恢复联网后，本机内容会继续同步。",
  },
  {
    title: "一份乐谱，适配每台设备",
    description:
      "无论使用 iPad、iPhone、Android 设备还是 Windows、macOS 电脑，都能打开同一份乐谱和批注。",
  },
] as const;

export function HomePage() {
  const navigate = useNavigate();
  const session = authClient.useSession();
  const [joinOpen, setJoinOpen] = useState(false);
  const [joinStep, setJoinStep] = useState<JoinStep>({ kind: "invite" });
  const [joinCode, setJoinCode] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [memberships, setMemberships] = useState<MembershipSummary[]>([]);
  const [previewChoir, setPreviewChoir] = useState<ChoirSummary | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [clearingGuestSession, setClearingGuestSession] = useState(false);
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
      if (!active) return;
      setMemberships(nextMemberships);
      for (const membership of nextMemberships) {
        rememberDriveSummary(
          driveCacheOwnerKey(userId, membership.choir.id),
          membership.choir,
        );
      }
    });
    return () => {
      active = false;
    };
  }, [userId]);

  useEffect(() => {
    if (session.isPending) return;
    let active = true;
    void loadPreviewChoir().then((choir) => {
      if (!active) return;
      setPreviewChoir(choir);
      if (choir) {
        rememberDriveSummary(
          driveCacheOwnerKey(userId ?? null, choir.id),
          choir,
        );
      }
    });
    return () => {
      active = false;
    };
  }, [session.isPending, userId]);

  useEffect(() => {
    if (session.isPending || !userId) return;
    void clearPreviewGuestSession();
  }, [session.isPending, userId]);

  const resetJoinFlow = () => {
    setJoinStep({ kind: "invite" });
    setJoinCode("");
    setDisplayName("");
    setJoinMessage(null);
  };

  const finishJoinDialog = () => {
    setJoinOpen(false);
    resetJoinFlow();
  };

  const clearActiveGuestSession = async () => {
    setClearingGuestSession(true);
    await clearGuestSession();
    setClearingGuestSession(false);
  };

  const dismissJoinDialog = () => {
    if (userId && joinStep.kind === "display-name") {
      void clearActiveGuestSession();
    }
    finishJoinDialog();
  };

  const enterInviteDrive = async (event: FormEvent) => {
    event.preventDefault();
    if (clearingGuestSession) return;
    setSubmitting(true);
    setJoinMessage(null);
    let createdGuestSession = false;

    try {
      const response = await fetch("/api/guest/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ admission: "invite", joinCode }),
      });

      if (!response.ok) {
        setJoinMessage(
          response.status === 429
            ? "尝试次数过多，请稍后再试。"
            : "邀请码无效或已失效。",
        );
        return;
      }
      createdGuestSession = true;

      const admitted = guestSessionResponseSchema.parse(await response.json());
      if (!userId) {
        finishJoinDialog();
        await navigate(`/choirs/${admitted.choir.id}`);
        return;
      }

      const joinStateResponse = await fetch("/api/choirs/current-guest/join-state");
      if (!joinStateResponse.ok) {
        await clearActiveGuestSession();
        createdGuestSession = false;
        setJoinMessage(
          joinStateResponse.status === 403
            ? "该成员关系需要云盘管理员恢复。"
            : "暂时无法进入这个云盘，请稍后再试。",
        );
        return;
      }
      const joinState = guestJoinStateResponseSchema.parse(
        await joinStateResponse.json(),
      );
      if (joinState.status === "joined") {
        await clearActiveGuestSession();
        createdGuestSession = false;
        finishJoinDialog();
        await navigate(`/choirs/${joinState.choir.id}`);
        return;
      }
      setJoinStep({ kind: "display-name", choir: joinState.choir });
    } catch {
      if (createdGuestSession) await clearActiveGuestSession();
      setJoinMessage("暂时无法进入这个云盘，请稍后再试。");
    } finally {
      setSubmitting(false);
    }
  };

  const joinValidatedDrive = async (event: FormEvent) => {
    event.preventDefault();
    if (joinStep.kind !== "display-name") return;
    setSubmitting(true);
    setJoinMessage(null);

    try {
      const response = await fetch("/api/choirs/join-current-guest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName }),
      });
      if (!response.ok) {
        if (response.status === 403) {
          await clearActiveGuestSession();
          setJoinStep({ kind: "invite" });
        }
        setJoinMessage(
          response.status === 403
            ? "该成员关系需要云盘管理员恢复。"
            : "暂时无法加入这个云盘，请稍后再试。",
        );
        return;
      }
      const choirId = joinStep.choir.id;
      finishJoinDialog();
      await navigate(`/choirs/${choirId}`);
    } catch {
      setJoinMessage("暂时无法加入这个云盘，请稍后再试。");
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
      await clearPreviewGuestSession();
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
              {!isInternalAuthEmail(session.data.user.email) ? (
                <span className="account-email">{session.data.user.email}</span>
              ) : null}
              <Button
                className="header-action"
                onPress={() => void getLogoutLocalSummary().then(setLogoutSummary)}
              >
                退出登录
              </Button>
            </>
          ) : session.isPending ? null : (
            <Link className="header-action header-action--primary" to="/login">
              登录
            </Link>
          )
        }
      />

      <main className="marketing-content">
        <section className="marketing-hero" aria-labelledby="page-title">
          <p className="hero-mark">Same Page</p>
          <h1 id="page-title">Every voice, on the same page.</h1>
          <p className="hero-zh">同页共谱，众声一心。</p>
          <p className="hero-description">为合唱排练而设计的乐谱云盘。</p>
          <div className="hero-actions">
            <Button
              className="primary-button hero-cta"
              onPress={() => setJoinOpen(true)}
            >
              进入云盘
            </Button>
            {previewChoir ? (
              <Link
                className="hero-preview-link"
                to={`/choirs/${previewChoir.id}`}
                onClick={() => startLoadingJourney("enter-drive", "warm")}
              >
                访问公开体验云盘
              </Link>
            ) : null}
          </div>
          {pageMessage ? (
            <p className="form-message page-message" role="alert">
              {pageMessage}
            </p>
          ) : null}
        </section>

        <section className="marketing-features" aria-label="产品特点">
          {productFeatures.map((feature, index) => (
            <article
              className={`marketing-feature marketing-feature--${
                index % 2 === 0 ? "left" : "right"
              }`}
              key={feature.title}
            >
              <div className="marketing-feature__copy">
                <p className="marketing-feature__number" aria-hidden="true">
                  {String(index + 1).padStart(2, "0")}
                </p>
                <h2>{feature.title}</h2>
                <p className="marketing-feature__description">
                  {feature.description}
                </p>
              </div>
            </article>
          ))}
        </section>
      </main>

      <footer className="marketing-footer">
        <Link to="/privacy">隐私政策</Link>
      </footer>

      <ModalOverlay
        className="modal-overlay"
        isOpen={joinOpen}
        onOpenChange={(open) => {
          if (open) setJoinOpen(true);
          else dismissJoinDialog();
        }}
        isDismissable
      >
        <Modal className="app-modal">
          <Dialog className="app-dialog">
            {({ close }) => (
              <>
                <div className="dialog-heading">
                  <div>
                    <p className="dialog-eyebrow">Same Page</p>
                    <Heading slot="title">
                      {joinStep.kind === "invite"
                        ? "进入云盘"
                        : `加入「${joinStep.choir.name}」`}
                    </Heading>
                  </div>
                  <Button className="icon-button" aria-label="关闭" onPress={close}>
                    ×
                  </Button>
                </div>

                {joinStep.kind === "invite" ? (
                  <>
                    <section
                      className="membership-picker"
                      aria-labelledby="membership-title"
                    >
                      <h3 id="membership-title">我已加入的云盘</h3>
                      {userId ? (
                        visibleMemberships.length > 0 ? (
                          <div className="membership-list">
                            {visibleMemberships.map((membership) => (
                              <Link
                                className="membership-row"
                                key={membership.id}
                                to={`/choirs/${membership.choir.id}`}
                                onClick={() => {
                                  startLoadingJourney("enter-drive", "warm");
                                  finishJoinDialog();
                                }}
                              >
                                <span>
                                  <strong>{membership.choir.name}</strong>
                                  <small>{membership.displayName}</small>
                                </span>
                                <span aria-hidden="true">→</span>
                              </Link>
                            ))}
                          </div>
                        ) : (
                          <p className="membership-empty">还没有已加入的云盘。</p>
                        )
                      ) : (
                        <Link
                          className="membership-login"
                          to="/login"
                          onClick={finishJoinDialog}
                        >
                          登录后查看
                        </Link>
                      )}
                    </section>

                    <section
                      className="invite-section"
                      aria-labelledby="invite-entry-title"
                    >
                      <h3 id="invite-entry-title">使用邀请码进入新的云盘</h3>
                      <Form
                        className="entry-form dialog-form"
                        onSubmit={enterInviteDrive}
                      >
                        <JoinCodeField
                          autoFocus
                          value={joinCode}
                          onChange={setJoinCode}
                        />
                        <Button
                          type="submit"
                          isDisabled={
                            joinCode.length !== JOIN_CODE_LENGTH ||
                            submitting ||
                            clearingGuestSession ||
                            session.isPending
                          }
                        >
                          {submitting || clearingGuestSession ? "正在验证…" : "进入"}
                        </Button>
                      </Form>
                    </section>
                  </>
                ) : (
                  <section className="join-display-name">
                    <p className="dialog-copy">
                      设置你在这个云盘中显示的名字。
                    </p>
                    <Form className="entry-form dialog-form" onSubmit={joinValidatedDrive}>
                      <TextField
                        isRequired
                        value={displayName}
                        onChange={setDisplayName}
                        maxLength={40}
                      >
                        <Label>显示名</Label>
                        <Input autoComplete="nickname" placeholder="例如：小花" autoFocus />
                      </TextField>
                      <Button type="submit" isDisabled={submitting}>
                        {submitting ? "正在加入…" : "加入并进入"}
                      </Button>
                      <Button
                        type="button"
                        className="text-button"
                        isDisabled={clearingGuestSession}
                        onPress={async () => {
                          await clearActiveGuestSession();
                          setJoinStep({ kind: "invite" });
                          setDisplayName("");
                          setJoinMessage(null);
                        }}
                      >
                        返回输入邀请码
                      </Button>
                    </Form>
                  </section>
                )}
                {joinMessage ? (
                  <p className="form-message" role="alert">
                    {joinMessage}
                  </p>
                ) : null}
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
            {logoutSummary?.pendingOperations ||
            logoutSummary?.conflicts ||
            logoutSummary?.syncErrors ? (
              <p className="dialog-copy">
                本机还有 {logoutSummary?.pendingOperations ?? 0} 项待同步操作和{" "}
                {logoutSummary?.conflicts ?? 0} 项本地冲突、
                {logoutSummary?.syncErrors ?? 0} 项同步异常。继续会永久丢弃这些内容。
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
                {logoutSummary?.pendingOperations ||
                logoutSummary?.conflicts ||
                logoutSummary?.syncErrors
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

async function loadPreviewChoir(): Promise<ChoirSummary | null> {
  try {
    const response = await fetch("/api/guest/preview-choir");
    if (!response.ok) return null;
    return previewChoirResponseSchema.parse(await response.json()).choir;
  } catch {
    return null;
  }
}
