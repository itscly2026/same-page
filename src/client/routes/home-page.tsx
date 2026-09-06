import { useApplicationIdentity } from "../auth/application-identity";
import { LocalEntry } from "../auth/local-entry";
import { diagnosticFetch } from "../diagnostics/diagnostics";
import { type FormEvent, useEffect, useEffectEvent, useRef, useState } from "react";
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
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";

import { isInternalAuthEmail } from "../../shared/auth";
import {
  guestJoinStateResponseSchema,
  guestSessionResponseSchema,
  previewChoirResponseSchema,
  type ChoirSummary,
} from "../../shared/choirs";
import { authClient } from "../auth/auth-client";
import readerPreview from "../assets/home/reader-preview.png";
import sharedLayersIllustration from "../assets/home/shared-layers.webp";
import personalLayerIllustration from "../assets/home/personal-layer.webp";
import replacePdfIllustration from "../assets/home/replace-pdf.webp";
import offlineSyncIllustration from "../assets/home/offline-sync.webp";
import everyDeviceIllustration from "../assets/home/every-device.webp";
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
import { readInviteLink } from "../components/invite-link";
import { JOIN_CODE_LENGTH } from "../components/join-code";
import { startLoadingJourney } from "../performance/loading-performance";
import {
  driveCacheOwnerKey,
  rememberDriveSummary,
} from "../score-library/drive-library-cache";

import { clearLibraryDeviceState } from "../score-library/library-view-state";
import { MembershipList } from "../score-library/membership-list";

type JoinStep =
  | { kind: "invite" }
  | { kind: "display-name"; choir: ChoirSummary };

const productFeatures = [
  {
    title: "不同声部，分层共享批注",
    illustration: sharedLayersIllustration,
    description:
      "排练要求按声部分层共享，获授权的人可以留下批注，大家在同一份谱上查看。",
  },
  {
    title: "共享批注按需看，个人笔记自己留",
    illustration: personalLayerIllustration,
    description:
      "选择需要查看的声部批注，也能在个人层记下自己的提醒，默认仅自己可见。",
  },
  {
    title: "替换乐谱，保留批注",
    illustration: replacePdfIllustration,
    description:
      "谱子有局部修订时，管理员可以直接替换 PDF；已有批注仍按原页码和位置显示，不必重新标注。",
  },
  {
    title: "离线可用，联网同步",
    illustration: offlineSyncIllustration,
    description:
      "提前下载离线副本，断网也能继续看谱、做批注；恢复联网后，批注会继续同步。",
  },
  {
    title: "一份乐谱，多设备可用",
    illustration: everyDeviceIllustration,
    description:
      "建议将合谱像应用一样安装到 Android 手机和平板、iPhone、iPad、Windows 电脑或 Mac，随时打开同一份乐谱和批注。",
  },
] as const;

export function HomePage() {
  const identity = useApplicationIdentity();
  const { session } = identity;
  if (identity.showLocalEntry) return <LocalEntry identity={identity} />;
  return <HomeContent key={session.isPending ? "pending" : session.data?.user.id ?? "guest"} session={session} />;
}

function HomeContent({ session }: { session: ReturnType<typeof authClient.useSession> }) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const [linkInvite] = useState(() => readInviteLink(location.hash));
  const linkHandled = useRef(false);
  const [joinOpen, setJoinOpen] = useState(searchParams.get("join") === "1" || linkInvite !== null);
  const [joinStep, setJoinStep] = useState<JoinStep>({ kind: "invite" });
  const [joinCode, setJoinCode] = useState(linkInvite?.code ?? "");
  const [displayName, setDisplayName] = useState("");
  const [previewChoir, setPreviewChoir] = useState<ChoirSummary | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [clearingGuestSession, setClearingGuestSession] = useState(false);
  const [joinMessage, setJoinMessage] = useState<string | null>(null);
  const [pageMessage, setPageMessage] = useState<string | null>(null);
  const [logoutSummary, setLogoutSummary] =
    useState<LogoutLocalSummary | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const userId = session.data?.user.id;
  useEffect(() => {
    if (session.isPending || userId) return;
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

  const enterInviteDrive = async (event?: FormEvent) => {
    event?.preventDefault();
    if (clearingGuestSession) return;
    setSubmitting(true);
    setJoinMessage(null);
    let createdGuestSession = false;

    try {
      const response = await diagnosticFetch("/api/guest/session", {
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

      const joinStateResponse = await diagnosticFetch("/api/choirs/current-guest/join-state");
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

  const enterLinkedDrive = useEffectEvent(() => {
    if (linkInvite?.code) void enterInviteDrive();
    else setJoinMessage("邀请链接无效，请输入当前邀请码。");
  });

  useEffect(() => {
    if (session.isPending || !linkInvite || linkHandled.current) return;
    linkHandled.current = true;
    // Remove the shared credential before making admission requests.
    void navigate({ pathname: location.pathname, search: location.search, hash: "" }, { replace: true });
    enterLinkedDrive();
  }, [session.isPending, linkInvite, navigate, location.pathname, location.search]);

  const joinValidatedDrive = async (event: FormEvent) => {
    event.preventDefault();
    if (joinStep.kind !== "display-name") return;
    setSubmitting(true);
    setJoinMessage(null);

    try {
      const response = await diagnosticFetch("/api/choirs/join-current-guest", {
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
      clearLibraryDeviceState();
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
              <Link className="header-action" to="/user">个人设置</Link>
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

      {!session.isPending && userId ? (
        <main className="page-shell my-drives-page">
          <div className="my-drives-heading"><div><h1>我已加入的云盘</h1><p>选择云盘，继续排练。</p></div><Button className="secondary-button" onPress={() => setJoinOpen(true)}>加入新云盘</Button></div>
          <MembershipList userId={userId} showContinue autoEnter={!joinOpen && searchParams.size === 0} />
          {pageMessage ? <p role="alert">{pageMessage}</p> : null}
        </main>
      ) : session.isPending ? <main className="page-shell"><p role="status">正在加载…</p></main> : <main className="marketing-content">
        <section className="marketing-hero" aria-labelledby="page-title">
          <div className="marketing-hero__content">
            <p className="hero-mark">合谱 · Same Page</p>
            <h1 id="page-title" lang="en">
              Harmony begins on the Same Page
            </h1>
            <p className="hero-zh" lang="zh-CN">
              你的笔记我的谱
            </p>
            <div className="hero-description">
              <p lang="en">
                A cloud-based score library built for choir rehearsals and shared
                annotations.
              </p>
              <p lang="zh-CN">为合唱排练与共享批注打造的乐谱云盘。</p>
            </div>
            <div className="hero-actions">
              <Button
                className="primary-button hero-cta"
                onPress={() => setJoinOpen(true)}
              >
                进入云盘
              </Button>
              <span className="hero-invite-hint">使用邀请码</span>
              {previewChoir ? (
                <Link
                  className="hero-preview-link"
                  to={`/choirs/${previewChoir.id}`}
                  onClick={() => startLoadingJourney("enter-drive", "warm")}
                >
                  先看示例
                </Link>
              ) : null}
            </div>
            {pageMessage ? (
              <p className="form-message page-message" role="alert">
                {pageMessage}
              </p>
            ) : null}
          </div>
          <figure className="hero-reader-preview">
            <img src={readerPreview} alt="乐谱批注示例：全体排练要求与个人换气提醒显示在同一份谱上" width={720} height={920} fetchPriority="high" />
            <figcaption><span>全体排练要求</span><span>我的换气提醒</span></figcaption>
          </figure>
          <a className="marketing-more-features" href="#features">
            了解更多功能 <span aria-hidden="true">↓</span>
          </a>
        </section>

        <section id="features" className="marketing-features" aria-label="产品特点">
          {productFeatures.map((feature, index) => (
            <article
              className={`marketing-feature marketing-feature--${
                index % 2 === 0 ? "left" : "right"
              }`}
              key={feature.title}
            >
              <div className="marketing-feature__copy">
                <h2>{feature.title}</h2>
                <p className="marketing-feature__description">
                  {feature.description}
                </p>
              </div>
              <img
                className="marketing-feature__illustration"
                src={feature.illustration}
                alt=""
                width={1536}
                height={1024}
                loading="lazy"
                decoding="async"
              />
            </article>
          ))}
        </section>
      </main>}


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
                    <p className="dialog-eyebrow">合谱 · Same Page</p>
                    <Heading slot="title">
                      {joinStep.kind === "invite"
                        ? (userId ? "加入新云盘" : "进入云盘")
                        : `加入「${joinStep.choir.name}」`}
                    </Heading>
                  </div>
                  <Button className="icon-button" aria-label="关闭" onPress={close}>
                    ×
                  </Button>
                </div>

                {joinStep.kind === "invite" ? (
                  <>
                    {!userId ? <section className="membership-picker" aria-labelledby="membership-title"><h3 id="membership-title">我已加入的云盘</h3><Link className="membership-login" to="/login" onClick={finishJoinDialog}>登录后查看</Link></section> : null}

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

async function loadPreviewChoir(): Promise<ChoirSummary | null> {
  try {
    const response = await diagnosticFetch("/api/guest/preview-choir");
    if (!response.ok) return null;
    return previewChoirResponseSchema.parse(await response.json()).choir;
  } catch {
    return null;
  }
}
