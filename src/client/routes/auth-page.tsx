import { diagnosticFetch } from "../diagnostics/diagnostics";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Button,
  FieldError,
  Form,
  Input,
  Label,
  TextField,
} from "react-aria-components";
import { Link, useLocation, useNavigate } from "react-router-dom";

import {
  AUTH_OTP_COOLDOWN_SECONDS,
  authFlowResponseSchema,
  authSessionResponseSchema,
  PASSWORD_POLICY,
  socialAuthProvidersResponseSchema,
  type SocialAuthProvider,
} from "../../shared/auth";
import {
  guestJoinStateResponseSchema,
  guestSessionResponseSchema,
  type ChoirSummary,
} from "../../shared/choirs";
import { authClient } from "../auth/auth-client";
import { clearGuestSession } from "../auth/preview-guest-session";
import { AppHeader } from "../components/app-header";

type AuthView =
  | "identify"
  | "sign-in"
  | "sign-up"
  | "verify-registration"
  | "request-reset"
  | "reset-password"
  | "join-choir"
  | "join-result";

const SOCIAL_EMAIL_DRAFT_KEY = "same-page:social-auth-email-draft";

export default function AuthPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const initialOauthResult = new URLSearchParams(location.search).get("oauth");
  const [view, setView] = useState<AuthView>("identify");
  const [email, setEmail] = useState(readSocialEmailDraft);
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [otp, setOtp] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [joinChoir, setJoinChoir] = useState<ChoirSummary | null>(null);
  const [submitting, setSubmitting] = useState(initialOauthResult === "complete");
  const [message, setMessage] = useState<string | null>(() =>
    initialOauthResult === "error"
      ? "第三方登录没有完成，请重试或继续使用邮箱。"
      : null,
  );
  const [otpRetryAt, setOtpRetryAt] = useState(0);
  const [otpClock, setOtpClock] = useState(() => Date.now());
  const [socialProviders, setSocialProviders] = useState<SocialAuthProvider[]>([]);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const previousViewRef = useRef<AuthView>(view);
  const oauthCompletionHandledRef = useRef(false);

  useEffect(() => {
    if (previousViewRef.current !== view) {
      titleRef.current?.focus();
      previousViewRef.current = view;
    }
  }, [view]);

  useEffect(() => {
    if (otpRetryAt <= Date.now()) return;

    const timer = setInterval(() => {
      const now = Date.now();
      setOtpClock(now);
      if (now >= otpRetryAt) clearInterval(timer);
    }, 1_000);
    return () => clearInterval(timer);
  }, [otpRetryAt]);

  const otpRetrySeconds = Math.max(
    0,
    Math.ceil((otpRetryAt - otpClock) / 1_000),
  );

  const rememberOtpCooldown = (response: Response) => {
    const retryAfter = Number(response.headers.get("Retry-After"));
    const seconds =
      response.status === 429 && Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.ceil(retryAfter)
        : response.ok
          ? AUTH_OTP_COOLDOWN_SECONDS
          : 0;
    if (seconds > 0) {
      const now = Date.now();
      setOtpClock(now);
      setOtpRetryAt(now + seconds * 1_000);
    }
    return seconds;
  };

  useEffect(() => {
    let active = true;
    void diagnosticFetch("/api/auth/social-providers", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return null;
        const parsed = socialAuthProvidersResponseSchema.safeParse(
          await response.json(),
        );
        return parsed.success ? parsed.data.providers : null;
      })
      .then((providers) => {
        if (active && providers) setSocialProviders(providers);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const identifyEmail = async (event: FormEvent) => {
    event.preventDefault();
    clearSocialEmailDraft();
    setSubmitting(true);
    setMessage(null);
    const response = await postJson("/api/auth/flow", {
      email: normalizedEmail(email),
    });
    setSubmitting(false);
    if (!response?.ok) {
      setMessage(
        response?.status === 429
          ? "尝试次数过多，请稍后再试。"
          : "暂时无法继续，请稍后再试。",
      );
      return;
    }

    const parsed = authFlowResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      setMessage("暂时无法继续，请稍后再试。");
      return;
    }
    setView(parsed.data.flow);
  };

  const signIn = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setMessage(null);
    const { error } = await authClient.signIn.email({
      email: normalizedEmail(email),
      password,
    });
    if (error) {
      setSubmitting(false);
      setMessage("邮箱或密码不正确。");
      return;
    }
    await finishAuthentication();
    setSubmitting(false);
  };

  const signUp = async (event: FormEvent) => {
    event.preventDefault();
    if (!validPasswordConfirmation(password, passwordConfirmation)) {
      setMessage(passwordValidationMessage(password, passwordConfirmation));
      return;
    }

    setSubmitting(true);
    setMessage(null);
    const delivery = await postJson("/api/auth/registration/request-otp", {
      email: normalizedEmail(email),
    });
    setSubmitting(false);
    if (!delivery?.ok) {
      const retryAfter = delivery ? rememberOtpCooldown(delivery) : 0;
      setMessage(
        retryAfter > 0
          ? `发送太频繁，请在 ${retryAfter} 秒后再试。`
          : "暂时无法发送验证码，请稍后再试。",
      );
      return;
    }

    rememberOtpCooldown(delivery);
    setView("verify-registration");
    setMessage("验证码已经发送，请检查收件箱和垃圾邮件。");
  };

  const verifyRegistration = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setMessage(null);
    const registration = await postJson("/api/auth/registration/complete", {
      email: normalizedEmail(email),
      otp: otp.trim(),
      password,
    });
    if (!registration?.ok) {
      setSubmitting(false);
      setMessage("验证码无效或已过期，请重新获取。");
      return;
    }
    await finishAuthentication();
    setSubmitting(false);
  };

  const resendRegistrationOtp = async () => {
    setSubmitting(true);
    setMessage(null);
    const delivery = await postJson("/api/auth/registration/request-otp", {
      email: normalizedEmail(email),
    });
    setSubmitting(false);
    const retryAfter = delivery ? rememberOtpCooldown(delivery) : 0;
    setMessage(
      !delivery?.ok
        ? retryAfter > 0
          ? `发送太频繁，请在 ${retryAfter} 秒后再试。`
          : "暂时无法发送验证码，请稍后再试。"
        : "新的验证码已经发送。",
    );
  };

  const requestPasswordReset = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setMessage(null);
    const delivery = await postJson(
      "/api/auth/email-otp/request-password-reset",
      {
        email: normalizedEmail(email),
      },
    );
    setSubmitting(false);
    if (!delivery?.ok) {
      const retryAfter = delivery ? rememberOtpCooldown(delivery) : 0;
      setMessage(
        retryAfter > 0
          ? `发送太频繁，请在 ${retryAfter} 秒后再试。`
          : "暂时无法发送验证码，请稍后再试。",
      );
      return;
    }
    rememberOtpCooldown(delivery);
    setView("reset-password");
    setMessage("密码重置验证码已经发送。");
  };

  const resendPasswordResetOtp = async () => {
    setSubmitting(true);
    setMessage(null);
    const delivery = await postJson(
      "/api/auth/email-otp/request-password-reset",
      { email: normalizedEmail(email) },
    );
    setSubmitting(false);
    const retryAfter = delivery ? rememberOtpCooldown(delivery) : 0;
    setMessage(
      !delivery?.ok
        ? retryAfter > 0
          ? `发送太频繁，请在 ${retryAfter} 秒后再试。`
          : "暂时无法发送验证码，请稍后再试。"
        : "新的密码重置验证码已经发送。",
    );
  };

  const resetPassword = async (event: FormEvent) => {
    event.preventDefault();
    if (!validPasswordConfirmation(password, passwordConfirmation)) {
      setMessage(passwordValidationMessage(password, passwordConfirmation));
      return;
    }

    setSubmitting(true);
    setMessage(null);
    const reset = await authClient.emailOtp.resetPassword({
      email: normalizedEmail(email),
      otp: otp.trim(),
      password,
    });
    if (reset.error) {
      setSubmitting(false);
      setMessage("验证码无效或已过期，密码没有改变。");
      return;
    }

    const login = await authClient.signIn.email({
      email: normalizedEmail(email),
      password,
    });
    if (login.error) {
      setSubmitting(false);
      setView("sign-in");
      setMessage("密码已重设，请使用新密码登录。");
      return;
    }
    await finishAuthentication();
    setSubmitting(false);
  };

  const finishAuthentication = useCallback(async () => {
    const lifecycle = await diagnosticFetch("/api/user/lifecycle").then(async (response) => response.ok ? response.json() : null).catch(() => null);
    if (lifecycle?.deletion || lifecycle?.reauthenticated) {
      await navigate("/user");
      return;
    }
    const guestResponse = await diagnosticFetch("/api/guest/session").catch(() => null);
    if (!guestResponse?.ok) {
      await navigate("/");
      return;
    }
    const guest = guestSessionResponseSchema.safeParse(
      await guestResponse.json(),
    );
    if (!guest.success) {
      await navigate("/");
      return;
    }
    if (guest.data.entryKind === "preview") {
      await clearGuestSession();
      await navigate(`/choirs/${guest.data.choir.id}`);
      return;
    }

    const joinStateResponse = await diagnosticFetch(
      "/api/choirs/current-guest/join-state",
    ).catch(() => null);
    if (!joinStateResponse?.ok) {
      setView("join-result");
      setMessage(
        joinStateResponse?.status === 403
          ? "已经登录，但该成员关系需要云盘管理员恢复。"
          : "已经登录，但暂时无法继续加入云盘。",
      );
      return;
    }
    const joinState = guestJoinStateResponseSchema.safeParse(
      await joinStateResponse.json(),
    );
    if (!joinState.success) {
      setView("join-result");
      setMessage("已经登录，但暂时无法继续加入云盘。");
      return;
    }
    if (joinState.data.status === "joined") {
      await clearGuestSession();
      await navigate(`/choirs/${joinState.data.choir.id}`);
      return;
    }

    setJoinChoir(joinState.data.choir);
    setView("join-choir");
  }, [navigate]);

  useEffect(() => {
    const oauthResult = new URLSearchParams(location.search).get("oauth");
    if (!oauthResult || oauthCompletionHandledRef.current) return;
    oauthCompletionHandledRef.current = true;
    void navigate("/login", { replace: true });

    if (oauthResult === "error") return;
    if (oauthResult !== "complete") return;

    void confirmAuthenticatedSession()
      .then(async (authenticated) => {
        if (!authenticated) {
          setMessage(
            "第三方登录没有建立有效会话，请重试或继续使用邮箱。",
          );
          return;
        }
        clearSocialEmailDraft();
        await finishAuthentication();
      })
      .finally(() => setSubmitting(false));
  }, [finishAuthentication, location.search, navigate]);

  const startSocialAuthentication = async (provider: SocialAuthProvider) => {
    setSubmitting(true);
    setMessage(null);
    storeSocialEmailDraft(email);
    const { error } = await authClient.signIn.social({
      provider,
      callbackURL: "/login?oauth=complete",
      errorCallbackURL: "/login?oauth=error",
    });
    if (error) {
      setSubmitting(false);
      setMessage("暂时无法开始第三方登录，请重试或继续使用邮箱。");
    }
  };

  const joinCurrentGuestChoir = async (event: FormEvent) => {
    event.preventDefault();
    if (!joinChoir) return;
    setSubmitting(true);
    setMessage(null);
    const response = await postJson("/api/choirs/join-current-guest", {
      displayName,
    });
    setSubmitting(false);
    if (!response?.ok) {
      setMessage(
        response?.status === 403
          ? "该成员关系需要云盘管理员恢复。"
          : "暂时无法加入这个云盘，请稍后再试。",
      );
      return;
    }
    await navigate(`/choirs/${joinChoir.id}`);
  };

  const changeEmail = () => {
    setView("identify");
    setPassword("");
    setPasswordConfirmation("");
    setOtp("");
    setOtpRetryAt(0);
    setMessage(null);
  };

  const viewPanel = (() => {
    switch (view) {
      case "identify":
        return {
          title: "登录或注册",
          description: "输入邮箱，我们会自动进入登录或注册流程。",
          form: (
            <Form className="entry-form" onSubmit={identifyEmail}>
              <EmailField value={email} onChange={setEmail} autoFocus />
              <Button type="submit" isDisabled={submitting}>
                {submitting ? "正在继续…" : "登录或注册"}
              </Button>
            </Form>
          ),
        };
      case "sign-in":
        return {
          title: "登录",
          description: "使用密码登录 Same Page。",
          form: (
            <Form className="entry-form" onSubmit={signIn}>
              <EmailSummary email={email} />
              <PasswordField
                label="密码"
                value={password}
                onChange={setPassword}
                autoComplete="current-password"
                autoFocus
              />
              <Button type="submit" isDisabled={submitting}>
                {submitting ? "正在登录…" : "登录"}
              </Button>
              <Button
                type="button"
                className="text-button"
                onPress={() => {
                  setView("request-reset");
                  setPassword("");
                  setMessage(null);
                }}
              >
                忘记密码
              </Button>
              <Button type="button" className="text-button" onPress={changeEmail}>
                更换邮箱
              </Button>
            </Form>
          ),
        };
      case "sign-up":
        return {
          title: "注册",
          description: "设置密码后，我们会发送验证码确认邮箱归属。",
          form: (
            <Form className="entry-form" onSubmit={signUp}>
              <EmailSummary email={email} />
              <PasswordField
                label={`密码（至少 ${PASSWORD_POLICY.minLength} 位）`}
                value={password}
                onChange={setPassword}
                autoComplete="new-password"
                autoFocus
              />
              <PasswordField
                label="确认密码"
                value={passwordConfirmation}
                onChange={setPasswordConfirmation}
                autoComplete="new-password"
              />
              <Button type="submit" isDisabled={submitting}>
                {submitting ? "正在发送…" : "发送验证码"}
              </Button>
              <Button type="button" className="text-button" onPress={changeEmail}>
                更换邮箱
              </Button>
            </Form>
          ),
        };
      case "verify-registration":
        return {
          title: "验证邮箱",
          description: `输入发送至 ${normalizedEmail(email)} 的验证码。`,
          form: (
            <Form className="entry-form" onSubmit={verifyRegistration}>
              <OtpField value={otp} onChange={setOtp} autoFocus />
              <Button type="submit" isDisabled={submitting}>
                {submitting ? "正在验证…" : "完成注册"}
              </Button>
              <Button
                type="button"
                className="text-button"
                isDisabled={submitting || otpRetrySeconds > 0}
                onPress={() => void resendRegistrationOtp()}
              >
                {resendButtonLabel(otpRetrySeconds)}
              </Button>
              <Button type="button" className="text-button" onPress={changeEmail}>
                更换邮箱
              </Button>
            </Form>
          ),
        };
      case "request-reset":
        return {
          title: "忘记密码",
          description: "我们会向这个邮箱发送密码重置验证码。",
          form: (
            <Form className="entry-form" onSubmit={requestPasswordReset}>
              <EmailSummary email={email} />
              <Button type="submit" isDisabled={submitting}>
                {submitting ? "正在发送…" : "发送密码重置验证码"}
              </Button>
              <Button
                type="button"
                className="text-button"
                onPress={() => {
                  setView("sign-in");
                  setMessage(null);
                }}
              >
                返回登录
              </Button>
            </Form>
          ),
        };
      case "reset-password":
        return {
          title: "重设密码",
          description: "验证成功后，旧密码和其他登录会话将立即失效。",
          form: (
            <Form className="entry-form" onSubmit={resetPassword}>
              <EmailSummary email={email} />
              <OtpField value={otp} onChange={setOtp} autoFocus />
              <PasswordField
                label={`新密码（至少 ${PASSWORD_POLICY.minLength} 位）`}
                value={password}
                onChange={setPassword}
                autoComplete="new-password"
              />
              <PasswordField
                label="确认新密码"
                value={passwordConfirmation}
                onChange={setPasswordConfirmation}
                autoComplete="new-password"
              />
              <Button type="submit" isDisabled={submitting}>
                {submitting ? "正在重设…" : "重设密码并登录"}
              </Button>
              <Button
                type="button"
                className="text-button"
                isDisabled={submitting || otpRetrySeconds > 0}
                onPress={() => void resendPasswordResetOtp()}
              >
                {resendButtonLabel(otpRetrySeconds)}
              </Button>
            </Form>
          ),
        };
      case "join-choir":
        return {
          title: "加入云盘",
          description: `认证已完成。请设置你在“${joinChoir?.name ?? "这个云盘"}”中的显示名。`,
          form: (
            <Form className="entry-form" onSubmit={joinCurrentGuestChoir}>
              <TextField
                isRequired
                value={displayName}
                onChange={setDisplayName}
                maxLength={40}
              >
                <Label>显示名</Label>
                <Input
                  autoComplete="nickname"
                  placeholder="例如：小花"
                  autoFocus
                />
                <FieldError />
              </TextField>
              <Button type="submit" isDisabled={submitting}>
                {submitting ? "正在加入…" : "加入并进入"}
              </Button>
            </Form>
          ),
        };
      case "join-result":
        return {
          title: "登录完成",
          description: "你已经登录，但本次加入云盘没有完成。",
          form: (
            <Link className="primary-link auth-primary-link" to="/">
              返回首页
            </Link>
          ),
        };
    }
  })();

  return (
    <div className="app-page auth-page">
      <AppHeader
        actions={
          <Link className="header-action" to="/">
            返回首页
          </Link>
        }
      />
      <main className="auth-layout">
        <section className="auth-card" aria-labelledby="auth-title">
          <p className="dialog-eyebrow">Same Page</p>
          <h1 id="auth-title" ref={titleRef} tabIndex={-1}>
            {viewPanel.title}
          </h1>
          <p className="auth-description">{viewPanel.description}</p>
          {viewPanel.form}

          {view === "identify" && socialProviders.length > 0 ? (
            <SocialAuthOptions
              providers={socialProviders}
              disabled={submitting}
              onContinue={(provider) => void startSocialAuthentication(provider)}
            />
          ) : null}

          {message ? (
            <p className="form-message" role="status">
              {message}
            </p>
          ) : null}
        </section>
      </main>
    </div>
  );
}

function SocialAuthOptions(props: {
  providers: SocialAuthProvider[];
  disabled: boolean;
  onContinue(provider: SocialAuthProvider): void;
}) {
  return (
    <section className="social-auth-options" aria-labelledby="social-auth-label">
      <div className="social-auth-divider">
        <span id="social-auth-label">其他登录方式</span>
      </div>
      <div className="social-auth-buttons">
        {props.providers.includes("google") ? (
          <Button
            type="button"
            className="social-auth-button"
            aria-label="使用 Google 继续"
            isDisabled={props.disabled}
            onPress={() => props.onContinue("google")}
          >
            <GoogleIcon />
          </Button>
        ) : null}
        {props.providers.includes("wechat") ? (
          <Button
            type="button"
            className="social-auth-button"
            aria-label="使用微信继续"
            isDisabled={props.disabled}
            onPress={() => props.onContinue("wechat")}
          >
            <WechatIcon />
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function GoogleIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path
        fill="#4285f4"
        d="M21.6 12.23c0-.71-.06-1.4-.18-2.07H12v3.91h5.38a4.6 4.6 0 0 1-2 3.02v2.54h3.24c1.9-1.75 2.98-4.33 2.98-7.4Z"
      />
      <path
        fill="#34a853"
        d="M12 22c2.7 0 4.97-.9 6.62-2.37l-3.24-2.54c-.9.6-2.05.96-3.38.96-2.6 0-4.8-1.76-5.6-4.12H3.05v2.62A10 10 0 0 0 12 22Z"
      />
      <path
        fill="#fbbc05"
        d="M6.4 13.93A6 6 0 0 1 6.08 12c0-.67.12-1.32.32-1.93V7.45H3.05A10 10 0 0 0 2 12c0 1.61.38 3.14 1.05 4.55l3.35-2.62Z"
      />
      <path
        fill="#ea4335"
        d="M12 5.95c1.47 0 2.79.5 3.82 1.5l2.87-2.87A9.64 9.64 0 0 0 12 2a10 10 0 0 0-8.95 5.45l3.35 2.62A5.98 5.98 0 0 1 12 5.95Z"
      />
    </svg>
  );
}

function WechatIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path
        fill="#07c160"
        d="M9.8 3C5 3 1.2 6.1 1.2 9.9c0 2.2 1.3 4.2 3.4 5.5l-.8 2.4 2.8-1.4c1 .3 2.1.5 3.2.5h.5a6.2 6.2 0 0 1-.2-1.5c0-3.7 3.4-6.7 7.7-6.7h.5C17.5 5.5 14.1 3 9.8 3Z"
      />
      <path
        fill="#07c160"
        d="M22.8 15.4c0-3.1-3-5.6-6.7-5.6s-6.7 2.5-6.7 5.6 3 5.6 6.7 5.6c.9 0 1.8-.2 2.6-.4l2.2 1.1-.6-1.9c1.5-1 2.5-2.6 2.5-4.4Z"
      />
      <circle cx="6.8" cy="8.7" r=".8" fill="#fff" />
      <circle cx="12.2" cy="8.7" r=".8" fill="#fff" />
      <circle cx="13.8" cy="14.5" r=".7" fill="#fff" />
      <circle cx="18.3" cy="14.5" r=".7" fill="#fff" />
    </svg>
  );
}

function readSocialEmailDraft() {
  try {
    return sessionStorage.getItem(SOCIAL_EMAIL_DRAFT_KEY) ?? "";
  } catch {
    return "";
  }
}

function storeSocialEmailDraft(email: string) {
  try {
    if (email) sessionStorage.setItem(SOCIAL_EMAIL_DRAFT_KEY, email);
    else sessionStorage.removeItem(SOCIAL_EMAIL_DRAFT_KEY);
  } catch {
    // Storage can be unavailable in hardened browser contexts.
  }
}

function clearSocialEmailDraft() {
  try {
    sessionStorage.removeItem(SOCIAL_EMAIL_DRAFT_KEY);
  } catch {
    // Storage can be unavailable in hardened browser contexts.
  }
}

async function confirmAuthenticatedSession() {
  const lifecycle = await diagnosticFetch("/api/user/lifecycle", { cache: "no-store" })
    .then(async (response) => response.ok ? response.json() : null).catch(() => null);
  if (lifecycle?.deletion) return true;
  const response = await diagnosticFetch("/api/auth/get-session", {
    cache: "no-store",
  }).catch(() => null);
  if (!response?.ok) return false;
  return authSessionResponseSchema.safeParse(await response.json()).success;
}

function EmailField(props: {
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
}) {
  return (
    <TextField
      isRequired
      type="email"
      value={props.value}
      onChange={props.onChange}
    >
      <Label>邮箱</Label>
      <Input
        autoComplete="email"
        placeholder="name@example.com"
        autoFocus={props.autoFocus}
      />
      <FieldError />
    </TextField>
  );
}

function EmailSummary({ email }: { email: string }) {
  return (
    <p className="auth-email" aria-label={`邮箱：${normalizedEmail(email)}`}>
      {normalizedEmail(email)}
    </p>
  );
}

function PasswordField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: "current-password" | "new-password";
  autoFocus?: boolean;
}) {
  return (
    <TextField
      isRequired
      type="password"
      value={props.value}
      onChange={props.onChange}
      minLength={PASSWORD_POLICY.minLength}
      maxLength={PASSWORD_POLICY.maxLength}
    >
      <Label>{props.label}</Label>
      <Input autoComplete={props.autoComplete} autoFocus={props.autoFocus} />
      <FieldError />
    </TextField>
  );
}

function OtpField(props: {
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
}) {
  return (
    <TextField
      isRequired
      value={props.value}
      onChange={props.onChange}
      minLength={6}
      maxLength={6}
    >
      <Label>六位验证码</Label>
      <Input
        autoComplete="one-time-code"
        inputMode="numeric"
        pattern="[0-9]{6}"
        placeholder="000000"
        autoFocus={props.autoFocus}
      />
      <FieldError />
    </TextField>
  );
}

function normalizedEmail(email: string) {
  return email.trim().toLowerCase();
}

function resendButtonLabel(retrySeconds: number) {
  return retrySeconds > 0
    ? `重新发送验证码（${retrySeconds} 秒）`
    : "重新发送验证码";
}

async function postJson(path: string, body: unknown) {
  try {
    return await diagnosticFetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return null;
  }
}

function validPasswordConfirmation(password: string, confirmation: string) {
  return (
    password.length >= PASSWORD_POLICY.minLength && password === confirmation
  );
}

function passwordValidationMessage(password: string, confirmation: string) {
  return password.length < PASSWORD_POLICY.minLength
    ? `密码至少需要 ${PASSWORD_POLICY.minLength} 位。`
    : password !== confirmation
      ? "两次输入的密码不一致。"
      : "密码不符合要求。";
}
