import {
  decodeBase64Url,
  decodeUtf8Base64Url,
  encodeBase64Url,
  encodeUtf8Base64Url,
  signHmac,
  verifyHmac,
} from "./crypto";

export const GUEST_SESSION_COOKIE = "same_page_guest";
export const GUEST_SESSION_SECONDS = 60 * 60 * 24 * 30;

export interface GuestSession {
  choirId: string;
  joinCodeVersion: number;
  expiresAt: number;
}

export async function createGuestSessionToken(
  session: GuestSession,
  inviteSecret: string,
): Promise<string> {
  const payload = encodeUtf8Base64Url(JSON.stringify(session));
  const signature = encodeBase64Url(
    await signHmac(inviteSecret, "guest-session", payload),
  );
  return `${payload}.${signature}`;
}

export async function verifyGuestSessionToken(
  token: string,
  inviteSecret: string,
  now = Date.now(),
): Promise<GuestSession | null> {
  const [payload, encodedSignature, extra] = token.split(".");
  if (!payload || !encodedSignature || extra) {
    return null;
  }

  const signature = decodeBase64Url(encodedSignature);
  if (
    !signature ||
    !(await verifyHmac(
      inviteSecret,
      "guest-session",
      payload,
      signature,
    ))
  ) {
    return null;
  }

  const decoded = decodeUtf8Base64Url(payload);
  if (!decoded) {
    return null;
  }

  try {
    const candidate = JSON.parse(decoded) as Partial<GuestSession>;
    if (
      typeof candidate.choirId !== "string" ||
      !Number.isInteger(candidate.joinCodeVersion) ||
      typeof candidate.expiresAt !== "number" ||
      candidate.expiresAt <= now
    ) {
      return null;
    }
    return candidate as GuestSession;
  } catch {
    return null;
  }
}
