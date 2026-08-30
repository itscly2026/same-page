import { expect } from "vitest";

type CallWorker = (path: string, init?: RequestInit) => Promise<Response>;

export const TEST_PASSWORD = "correct horse battery staple";

export async function registerWithPassword(options: {
  callWorker: CallWorker;
  email: string;
  latestOtp: () => string;
  password?: string;
  afterOtpSent?: (otp: string) => Promise<void>;
}) {
  const password = options.password ?? TEST_PASSWORD;
  const sendOtp = await options.callWorker(
    "/api/auth/registration/request-otp",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: options.email }),
    },
  );
  expect(sendOtp.status, await sendOtp.text()).toBe(200);
  const otp = options.latestOtp();
  expect(otp).toMatch(/^\d{6}$/);
  await options.afterOtpSent?.(otp);

  const registration = await options.callWorker(
    "/api/auth/registration/complete",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: options.email,
        otp,
        password,
      }),
    },
  );
  expect(registration.status, await registration.text()).toBe(200);
  return { cookie: cookieFrom(registration), otp, password };
}

export async function signInWithPassword(options: {
  callWorker: CallWorker;
  email: string;
  password?: string;
}) {
  const response = await options.callWorker("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: options.email,
      password: options.password ?? TEST_PASSWORD,
    }),
  });
  return response;
}

export function cookieFrom(response: Response) {
  const setCookie = response.headers.get("set-cookie");
  expect(setCookie).toBeTruthy();
  return setCookie!.split(";", 1)[0];
}
