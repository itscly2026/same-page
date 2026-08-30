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

export default function AuthPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [guestChoir, setGuestChoir] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [step, setStep] = useState<"email" | "otp">("email");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const response = await fetch("/api/guest/session");
        if (!active || !response.ok) {
          return;
        }
        const payload = (await response.json()) as {
          choir: { id: string; name: string };
        };
        if (active) {
          setGuestChoir(payload.choir);
        }
      } catch {
        // Login remains available when the optional guest upgrade lookup fails.
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const requestOtp = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setMessage(null);
    const { error } = await authClient.emailOtp.sendVerificationOtp({
      email: email.trim().toLowerCase(),
      type: "sign-in",
    });
    setSubmitting(false);

    if (error) {
      setMessage("暂时无法发送验证码，请稍后再试。");
      return;
    }

    setStep("otp");
    setMessage("如果邮件地址可用，验证码已经发送。请检查收件箱和垃圾邮件。");
  };

  const verifyOtp = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setMessage(null);
    const { error } = await authClient.signIn.emailOtp({
      email: email.trim().toLowerCase(),
      otp: otp.trim(),
      name: "Same Page 用户",
    });

    if (error) {
      setSubmitting(false);
      setMessage("验证码无效或已过期，请重新获取。");
      return;
    }

    if (guestChoir) {
      const joinResponse = await fetch("/api/choirs/join-current-guest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName }),
      });
      if (!joinResponse.ok) {
        setSubmitting(false);
        setMessage(
          joinResponse.status === 403
            ? "已经登录，但该成员关系需要团管理员恢复。"
            : "已经登录，但暂时无法加入合唱团，请返回入口重试。",
        );
        return;
      }
      await navigate(`/choirs/${guestChoir.id}`);
      return;
    }

    await navigate("/");
  };

  return (
    <main className="page-shell compact-page">
      <p className="eyebrow">Same Page · 邮箱登录</p>
      <h1>{step === "email" ? "登录或注册" : "输入验证码"}</h1>
      <p className="hero__copy">
        {guestChoir
          ? `验证邮箱后，你将以成员身份加入“${guestChoir.name}”。`
          : "Same Page 不使用密码。新邮箱验证成功后会自动完成注册。"}
      </p>

      {step === "email" ? (
        <Form className="entry-form" onSubmit={requestOtp}>
          <TextField
            isRequired
            type="email"
            value={email}
            onChange={setEmail}
          >
            <Label>邮箱</Label>
            <Input autoComplete="email" placeholder="name@example.com" />
            <FieldError />
          </TextField>
          {guestChoir ? (
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
          ) : null}
          <Button type="submit" isDisabled={submitting}>
            {submitting ? "正在发送…" : "发送验证码"}
          </Button>
        </Form>
      ) : (
        <Form className="entry-form" onSubmit={verifyOtp}>
          <TextField
            isRequired
            value={otp}
            onChange={setOtp}
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
          <Button type="submit" isDisabled={submitting}>
            {submitting ? "正在验证…" : "登录"}
          </Button>
          <Button
            type="button"
            className="text-button"
            onPress={() => {
              setStep("email");
              setOtp("");
              setMessage(null);
            }}
          >
            更换邮箱
          </Button>
        </Form>
      )}

      {message ? (
        <p className="form-message" role="status">
          {message}
        </p>
      ) : null}
      <Link className="back-link" to="/">
        返回入口
      </Link>
    </main>
  );
}
