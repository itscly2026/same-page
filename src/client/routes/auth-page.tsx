import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  Button,
  FieldError,
  Form,
  Input,
  Label,
  TextField,
} from "react-aria-components";
import { Link, useNavigate } from "react-router-dom";

import { authFlowResponseSchema, PASSWORD_POLICY } from "../../shared/auth";
import {
  guestJoinStateResponseSchema,
  guestSessionResponseSchema,
  type ChoirSummary,
} from "../../shared/choirs";
import { authClient } from "../auth/auth-client";
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

export default function AuthPage() {
  const navigate = useNavigate();
  const [view, setView] = useState<AuthView>("identify");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [otp, setOtp] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [joinChoir, setJoinChoir] = useState<ChoirSummary | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const previousViewRef = useRef<AuthView>(view);

  useEffect(() => {
    if (previousViewRef.current !== view) {
      titleRef.current?.focus();
      previousViewRef.current = view;
    }
  }, [view]);

  const identifyEmail = async (event: FormEvent) => {
    event.preventDefault();
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
      setMessage("暂时无法发送验证码，请稍后再试。");
      return;
    }

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
    setMessage(
      !delivery?.ok
        ? "暂时无法发送验证码，请稍后再试。"
        : "新的验证码已经发送。",
    );
  };

  const requestPasswordReset = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setMessage(null);
    const { error } = await authClient.emailOtp.requestPasswordReset({
      email: normalizedEmail(email),
    });
    setSubmitting(false);
    if (error) {
      setMessage("暂时无法发送验证码，请稍后再试。");
      return;
    }
    setView("reset-password");
    setMessage("密码重置验证码已经发送。");
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

  const finishAuthentication = async () => {
    const guestResponse = await fetch("/api/guest/session").catch(() => null);
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
      await navigate("/");
      return;
    }

    const joinStateResponse = await fetch(
      "/api/choirs/current-guest/join-state",
    ).catch(() => null);
    if (!joinStateResponse?.ok) {
      setView("join-result");
      setMessage(
        joinStateResponse?.status === 403
          ? "已经登录，但该成员关系需要团管理员恢复。"
          : "已经登录，但暂时无法继续加入合唱团。",
      );
      return;
    }
    const joinState = guestJoinStateResponseSchema.safeParse(
      await joinStateResponse.json(),
    );
    if (!joinState.success) {
      setView("join-result");
      setMessage("已经登录，但暂时无法继续加入合唱团。");
      return;
    }
    if (joinState.data.status === "joined") {
      await clearGuestSession();
      await navigate(`/choirs/${joinState.data.choir.id}`);
      return;
    }

    setJoinChoir(joinState.data.choir);
    setView("join-choir");
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
          ? "该成员关系需要团管理员恢复。"
          : "暂时无法加入这个合唱团，请稍后再试。",
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
                isDisabled={submitting}
                onPress={() => void resendRegistrationOtp()}
              >
                重新发送验证码
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
                onPress={() => {
                  setView("request-reset");
                  setOtp("");
                  setMessage(null);
                }}
              >
                重新获取验证码
              </Button>
            </Form>
          ),
        };
      case "join-choir":
        return {
          title: "加入合唱团",
          description: `认证已完成。请设置你在“${joinChoir?.name ?? "这个合唱团"}”中的显示名。`,
          form: (
            <Form className="entry-form" onSubmit={joinCurrentGuestChoir}>
              <TextField
                isRequired
                value={displayName}
                onChange={setDisplayName}
                maxLength={40}
              >
                <Label>团内显示名</Label>
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
          description: "你已经登录，但本次加团没有完成。",
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

async function postJson(path: string, body: unknown) {
  try {
    return await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return null;
  }
}

async function clearGuestSession() {
  await fetch("/api/guest/session", { method: "DELETE" }).catch(() => null);
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
