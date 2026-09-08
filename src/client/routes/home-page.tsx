import { activateGuestLocalOwner } from "../platform/local-workspace";
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
import sharedLayersAnimation from "../assets/home/shared-layers.gif";
import personalLayerAnimation from "../assets/home/personal-layer.gif";
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
  const location = useLocation();
  const [invitation, setInvitation] = useState(() => ({ hash: location.hash, version: 0, link: readInviteLink(location.hash) }));
  // A same-page navigation does not remount HomePage. Capture each new fragment,
  // but retain the credential in memory when admission removes it from the URL.
  if (invitation.hash !== location.hash) {
    const link = readInviteLink(location.hash);
    setInvitation({ hash: location.hash, version: invitation.version + (link ? 1 : 0), link: link ?? invitation.link });
  }
  const finishInvitation = () => setInvitation(current => ({ ...current, link: null }));
  const linkedGuest = invitation.link !== null && identity.onlineState === "signed-out";
  if (identity.showLocalEntry && !linkedGuest) return <LocalEntry identity={identity} startup={startup} />;
  return <HomeContent key={`${session.isPending ? "pending" : session.data?.user.id ?? "guest"}:${invitation.version}`} session={session} startup={startup} linkInvite={invitation.link} finishInvitation={finishInvitation} />;
}

function HomeContent({ session, startup, linkInvite, finishInvitation }: { session: ReturnType<typeof authClient.useSession>; startup: boolean; linkInvite: ReturnType<typeof readInviteLink>; finishInvitation: () => void }) {
  const [pausedIllustrations, setPausedIllustrations] = useState<number[]>([]);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const location = useLocation();
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
  const [entryDestination, setEntryDestination] = useState<string | null>(null);
  // Let the dialog unregister its exit guard before completing admission.
  useEffect(() => {
    if (entryDestination) void navigate(entryDestination);
  }, [entryDestination, navigate]);
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
    finishInvitation();
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
  const entryAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => entryAbortRef.current?.abort(), []);
  const dismissJoinDialog = () => {
    invalidateSettingsLifetime(entryLifetimeRef);
    entryAbortRef.current?.abort();
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
    const controller = new AbortController();
    entryAbortRef.current = controller;
    const pending = enterDrive({ admission: "invite", joinCode }, Boolean(userId), controller.signal);
    pendingEntryRef.current = pending;
    const result = await pending;
    if (generation !== entryLifetimeRef.current) return;
    if (result.kind === "enter") {
      if (!userId) {
        try { await activateGuestLocalOwner(result.choir.id, controller.signal); }
        catch {
          if (!controller.signal.aborted) { setSubmitting(false); setJoinMessage("无法准备本机访客空间，请重试。"); }
          return;
        }
        if (generation !== entryLifetimeRef.current) return;
      }
      setSubmitting(false);
      finishJoinDialog();
      setEntryDestination(`/choirs/${result.choir.id}`);
      return;
    }
    setSubmitting(false);
    if (result.kind === "display-name") {
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
      // Router navigation can complete asynchronously. Admit only on the next
      // committed location, once the shared credential has left the address bar.
      if (location.hash) {
        void navigate({ pathname: location.pathname, search: location.search, hash: "" }, { replace: true });
        return;
      }
      linkHandled.current = true;
      enterLinkedDrive();
    });
    return () => { active = false; };
  }, [session.isPending, linkInvite, navigate, location.pathname, location.search, location.hash]);

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
      finishJoinDialog(); setEntryDestination(`/choirs/${result.choir.id}`);
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
              {index < 2 ? (
                <div className="marketing-feature__illustration">
                  <picture>
                    <source media="(prefers-reduced-motion: reduce)" srcSet={feature.illustration} />
                    <img
                      src={pausedIllustrations.includes(index) ? feature.illustration : index === 0 ? sharedLayersAnimation : personalLayerAnimation}
                      alt={index === 0 ? "从右到左 B、T、A、S、E 共享层各画两笔批注，再叠加到同一份乐谱上。" : "选择显示 E 和 T 共享批注，隐藏其他共享层；在默认私密的 Me 个人层画一个小笑脸，再叠加到原谱上。"}
                      width={768}
                      height={512}
                      loading="lazy"
                      decoding="async"
                      style={{ display: "block", width: "100%", height: "auto" }}
                    />
                  </picture>
                  <button className="text-button marketing-animation-control" type="button" onClick={() => setPausedIllustrations(values => values.includes(index) ? values.filter(value => value !== index) : [...values, index])}>
                    {pausedIllustrations.includes(index) ? "播放分层示意" : "显示静态图"}
                  </button>
                </div>
              ) : <img
                className="marketing-feature__illustration"
                src={feature.illustration}
                alt=""
                width={1536}
                height={1024}
                loading="lazy"
                decoding="async"
              />}
            </article>
          ))}
        </section>
      </main>}


      <ModalOverlay
        className="modal-overlay"
        isOpen={joinOpen && !(linkInvite && location.hash)}
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
