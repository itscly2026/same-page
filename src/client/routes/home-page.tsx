import { enterDrive, joinDrive, cancelDriveEntry, type DriveEntryResult } from "../auth/drive-entry";
import { invalidateSettingsLifetime, useSettingsLifetime } from "../settings/use-settings-lifetime";
import { InstallButton } from "../install/install-entry";
import { useApplicationIdentity } from "../auth/application-identity";
import { LocalEntry } from "../auth/local-entry";
import { diagnosticFetch } from "../diagnostics/diagnostics";
import { type FormEvent, useEffect, useEffectEvent, useRef, useState } from "react";
import {
  Button,

  Form,
  Heading,
  Input,
  Label,
  Modal,
  ModalOverlay,
  TextField,
} from "react-aria-components";
import { Dialog } from "../navigation/overlays";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";

import { PersonalMenu } from "../components/personal-menu";
import {
  previewChoirResponseSchema,
  type ChoirSummary,
} from "../../shared/choirs";
import { authClient } from "../auth/auth-client";
import sharedLayersIllustration from "../assets/home/shared-layers.webp";
import personalLayerIllustration from "../assets/home/personal-layer.webp";
import replacePdfIllustration from "../assets/home/replace-pdf.webp";
import offlineSyncIllustration from "../assets/home/offline-sync.webp";
import everyDeviceIllustration from "../assets/home/every-device.webp";
import {
  clearGuestSession,
  clearPreviewGuestSession,
} from "../auth/preview-guest-session";
import { AppHeader } from "../components/app-header";
import { JoinCodeField } from "../components/join-code-field";
import { readInviteLink } from "../components/invite-link";
import { JOIN_CODE_LENGTH } from "../components/join-code";
import { startLoadingJourney } from "../performance/loading-performance";
import {
  driveCacheOwnerKey,
  rememberDriveSummary,
} from "../score-library/drive-library-cache";

import { MembershipList } from "../score-library/membership-list";

type JoinStep =
  | { kind: "invite" }
  | { kind: "display-name"; choir: ChoirSummary };

const productFeatures = [
  {
    title: "不同声部，分层共享笔记",
    illustration: sharedLayersIllustration,
    description:
      "排练要求按声部分层共享，获授权的人可以留下笔记，大家在同一份谱上查看。",
  },
  {
    title: "共享笔记按需看，个人笔记自己留",
    illustration: personalLayerIllustration,
    description:
      "选择需要查看的声部笔记，也能在个人层记下自己的提醒，默认仅自己可见。",
  },
  {
    title: "替换乐谱，保留笔记",
    illustration: replacePdfIllustration,
    description:
      "谱子有局部修订时，管理员可以直接替换 PDF；已有笔记仍按原页码和位置显示，不必重新标注。",
  },
  {
    title: "离线可用，联网同步",
    illustration: offlineSyncIllustration,
    description:
      "提前下载离线副本，断网也能继续看谱、做笔记；恢复联网后，笔记会继续同步。",
  },
  {
    title: "一份乐谱，多设备可用",
    illustration: everyDeviceIllustration,
    description:
      "建议将合谱像应用一样安装到 Android 手机和平板、iPhone、iPad、Windows 电脑或 Mac，随时打开同一份乐谱和笔记。",
  },
] as const;

export function HomePage({ startup = false }: { startup?: boolean }) {
  const identity = useApplicationIdentity();
  const { session } = identity;
  if (identity.showLocalEntry) return <LocalEntry identity={identity} startup={startup} />;
  return <HomeContent key={session.isPending ? "pending" : session.data?.user.id ?? "guest"} session={session} startup={startup} />;
}

function HomeContent({ session, startup }: { session: ReturnType<typeof authClient.useSession>; startup: boolean }) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const [linkInvite] = useState(() => readInviteLink(location.hash));
  const linkHandled = useRef(false);
  const [startupIntent, setStartupIntent] = useState(startup && location.pathname === "/" && !location.search && !location.hash);
  const [joinOpen, setJoinOpen] = useState(searchParams.get("join") === "1" || linkInvite !== null);
  const [joinStep, setJoinStep] = useState<JoinStep>({ kind: "invite" });
  const [joinCode, setJoinCode] = useState(linkInvite?.code ?? "");
  const [displayName, setDisplayName] = useState("");
  const [previewChoir, setPreviewChoir] = useState<ChoirSummary | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [clearingGuestSession, setClearingGuestSession] = useState(false);
  const [joinMessage, setJoinMessage] = useState<string | null>(null);
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
    setStartupIntent(false);
    setJoinOpen(false);
    resetJoinFlow();
  };

  const clearActiveGuestSession = async () => {
    setClearingGuestSession(true);
    await clearGuestSession();
    setClearingGuestSession(false);
  };

  const pendingEntryRef = useRef<Promise<DriveEntryResult> | null>(null);
  const dismissJoinDialog = () => {
    invalidateSettingsLifetime(entryLifetimeRef);
    setSubmitting(false);
    setClearingGuestSession(true);
    void cancelDriveEntry(pendingEntryRef.current).finally(() => setClearingGuestSession(false));
    finishJoinDialog();
  };

  const entryLifetimeRef = useSettingsLifetime();
  const enterInviteDrive = async (event?: FormEvent) => {
    event?.preventDefault();
    if (clearingGuestSession || submitting) return;
    const generation = entryLifetimeRef.current;
    setSubmitting(true); setJoinMessage(null);
    const pending = enterDrive({ admission: "invite", joinCode }, Boolean(userId));
    pendingEntryRef.current = pending;
    const result = await pending;
    if (generation !== entryLifetimeRef.current) return;
    setSubmitting(false);
    if (result.kind === "enter") {
      finishJoinDialog();
      await navigate(`/choirs/${result.choir.id}`);
    } else if (result.kind === "display-name") {
      setJoinCode("");
      setJoinStep({ kind: "display-name", choir: result.choir });
    } else if (result.kind === "failed") setJoinMessage(result.message);
  };

  const enterLinkedDrive = useEffectEvent(() => {
    if (linkInvite?.code) void enterInviteDrive();
    else setJoinMessage("邀请链接无效，请输入当前邀请码。");
  });

  useEffect(() => {
    let active = true;
    // StrictMode disconnects and reconnects effects before this microtask.
    // Start only the committed lifetime, keeping automatic admission single-shot.
    void Promise.resolve().then(() => {
      if (!active || session.isPending || !linkInvite || linkHandled.current) return;
      linkHandled.current = true;
      // Remove the shared credential before making admission requests.
      void navigate({ pathname: location.pathname, search: location.search, hash: "" }, { replace: true });
      enterLinkedDrive();
    });
    return () => { active = false; };
  }, [session.isPending, linkInvite, navigate, location.pathname, location.search]);

  const joinValidatedDrive = async (event: FormEvent) => {
    event.preventDefault();
    if (joinStep.kind !== "display-name" || submitting) return;
    const generation = entryLifetimeRef.current;
    setSubmitting(true); setJoinMessage(null);
    const pending = joinDrive({ kind: "guest", choirId: joinStep.choir.id }, displayName);
    pendingEntryRef.current = pending;
    const result = await pending;
    if (generation !== entryLifetimeRef.current) return;
    setSubmitting(false);
    if (result.kind === "enter") {
      finishJoinDialog(); await navigate(`/choirs/${result.choir.id}`);
    } else if (result.kind === "failed") {
      if (result.restart) setJoinStep({ kind: "invite" });
      setJoinMessage(result.message);
    }
  };

  return (
    <div className="marketing-page">
      <AppHeader
        actions={
          session.data?.user ? (
            <><InstallButton className="header-action" /><PersonalMenu email={session.data.user.email} /></>
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
          <MembershipList userId={userId} autoEnter={startupIntent && location.pathname === "/" && !joinOpen && searchParams.size === 0} />
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
              <p lang="zh-CN">为合唱排练与共享笔记打造的乐谱云盘。</p>
            </div>
            <div className="hero-actions">
              <Button
                className="primary-button hero-cta"
                onPress={() => setJoinOpen(true)}
              >
                进入云盘
              </Button>
              <InstallButton />
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
          </div>
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
                        isDisabled={submitting || clearingGuestSession}
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
