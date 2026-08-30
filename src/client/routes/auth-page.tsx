import { type FormEvent, useEffect, useState } from "react";
import {
  Button,
  FieldError,
  Form,
  Input,
  Label,
  TextField,
} from "react-aria-components";
import { Link, useNavigate } from "react-router-dom";

import { authClient } from "../auth/auth-client";
import { PASSWORD_POLICY } from "../../shared/auth";
import { AppHeader } from "../components/app-header";

type AuthView =
  | "sign-in"
  | "sign-up"
  | "verify-registration"
  | "request-reset"
  | "reset-password";

export default function AuthPage() {
  const navigate = useNavigate();
  const [view, setView] = useState<AuthView>("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [otp, setOtp] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [guestChoir, setGuestChoir] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const response = await fetch("/api/guest/session");
        if (!active || !response.ok) return;
        const payload = (await response.json()) as {
          choir: { id: string; name: string };
        };
        if (active) setGuestChoir(payload.choir);
      } catch {
        // Authentication remains available when the optional guest lookup fails.
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const finishAuthentication = async () => {
    if (!guestChoir) {
      await navigate("/");
      return true;
    }

    const joinResponse = await fetch("/api/choirs/join-current-guest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName }),
    });
    if (!joinResponse.ok) {
      setMessage(
        joinResponse.status === 403
          ? "已经登录，但该成员关系需要团管理员恢复。"
          : "已经登录，但暂时无法加入合唱团，请返回入口重试。",
      );
      return false;
    }
    await navigate(`/choirs/${guestChoir.id}`);
    return true;
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
    const registrationEmail = normalizedEmail(email);
    const delivery = await postJson("/api/auth/registration/request-otp", {
      email: registrationEmail,
    });
    if (!delivery?.ok) {
      setSubmitting(false);
      setMessage("暂时无法发送验证码，请稍后再试。");
      return;
    }

    setSubmitting(false);
    setView("verify-registration");
    setMessage(
      "如果该邮箱可以注册，验证码已经发送。请检查收件箱和垃圾邮件；已注册用户请直接登录或重设密码。",
    );
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
        : "如果该邮箱仍需验证，新的验证码已经发送。",
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
    setMessage("如果该邮箱已注册，密码重置验证码已经发送。");
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

  const switchView = (nextView: AuthView) => {
    setView(nextView);
    setOtp("");
    setPassword("");
    setPasswordConfirmation("");
    setMessage(null);
  };

  const guestDisplayNameField = guestChoir ? (
    <TextField
      isRequired
      value={displayName}
      onChange={setDisplayName}
      maxLength={40}
    >
      <Label>团内显示名</Label>
      <Input autoComplete="nickname" placeholder="例如：小花" />
      <FieldError />
    </TextField>
  ) : null;

  const viewPanel = (() => {
    switch (view) {
      case "sign-in":
        return {
          title: "密码登录",
          description: guestChoir
            ? `登录后，你将以成员身份加入“${guestChoir.name}”。`
            : "使用邮箱和密码登录；日常登录不发送验证码。",
          form: (
            <Form className="entry-form" onSubmit={signIn}>
              <EmailField value={email} onChange={setEmail} />
              <PasswordField
                label="密码"
                value={password}
                onChange={setPassword}
                autoComplete="current-password"
              />
              {guestDisplayNameField}
              <Button type="submit" isDisabled={submitting}>
                {submitting ? "正在登录…" : "登录"}
              </Button>
              <Button
                type="button"
                className="text-button"
                onPress={() => switchView("request-reset")}
              >
                首次设置或忘记密码
              </Button>
              <Button
                type="button"
                className="text-button"
                onPress={() => switchView("sign-up")}
              >
                注册
              </Button>
            </Form>
          ),
        };
      case "sign-up":
        return {
          title: "注册",
          description: guestChoir
            ? `完成注册后，你将以成员身份加入“${guestChoir.name}”。`
            : "设置密码后，我们只用一次邮箱验证码确认邮箱归属。",
          form: (
            <Form className="entry-form" onSubmit={signUp}>
              <EmailField value={email} onChange={setEmail} />
              <PasswordField
                label={`密码（至少 ${PASSWORD_POLICY.minLength} 位）`}
                value={password}
                onChange={setPassword}
                autoComplete="new-password"
              />
              <PasswordField
                label="确认密码"
                value={passwordConfirmation}
                onChange={setPasswordConfirmation}
                autoComplete="new-password"
              />
              {guestDisplayNameField}
              <Button type="submit" isDisabled={submitting}>
                {submitting ? "正在注册…" : "注册并发送验证码"}
              </Button>
              <Button
                type="button"
                className="text-button"
                onPress={() => switchView("sign-in")}
              >
                返回密码登录
              </Button>
            </Form>
          ),
        };
      case "verify-registration":
        return {
          title: "验证邮箱",
          description: guestChoir
            ? `完成注册后，你将以成员身份加入“${guestChoir.name}”。`
            : "输入邮件中的验证码完成注册。",
          form: (
            <Form className="entry-form" onSubmit={verifyRegistration}>
              <OtpField value={otp} onChange={setOtp} />
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
              <Button
                type="button"
                className="text-button"
                onPress={() => switchView("sign-up")}
              >
                更换邮箱
              </Button>
            </Form>
          ),
        };
      case "request-reset":
        return {
          title: "设置或重设密码",
          description: guestChoir
            ? `登录后，你将以成员身份加入“${guestChoir.name}”。`
            : "已有用户首次设置密码或忘记密码时，需要验证邮箱。",
          form: (
            <Form className="entry-form" onSubmit={requestPasswordReset}>
              <EmailField value={email} onChange={setEmail} />
              {guestDisplayNameField}
              <Button type="submit" isDisabled={submitting}>
                {submitting ? "正在发送…" : "发送密码重置验证码"}
              </Button>
              <Button
                type="button"
                className="text-button"
                onPress={() => switchView("sign-in")}
              >
                返回密码登录
              </Button>
            </Form>
          ),
        };
      case "reset-password":
        return {
          title: "输入验证码和新密码",
          description: guestChoir
            ? `登录后，你将以成员身份加入“${guestChoir.name}”。`
            : "验证成功后，旧密码和其他登录会话将立即失效。",
          form: (
            <Form className="entry-form" onSubmit={resetPassword}>
              <OtpField value={otp} onChange={setOtp} />
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
                onPress={() => switchView("request-reset")}
              >
                重新获取验证码
              </Button>
            </Form>
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
          <h1 id="auth-title">{viewPanel.title}</h1>
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
}) {
  return (
    <TextField
      isRequired
      type="email"
      value={props.value}
      onChange={props.onChange}
    >
      <Label>邮箱</Label>
      <Input autoComplete="email" placeholder="name@example.com" />
      <FieldError />
    </TextField>
  );
}

function PasswordField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: "current-password" | "new-password";
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
      <Input autoComplete={props.autoComplete} />
      <FieldError />
    </TextField>
  );
}

function OtpField(props: {
  value: string;
  onChange: (value: string) => void;
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
