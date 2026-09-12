import { z } from "zod";
import { decodeBase64Url, decodeUtf8Base64Url, encodeBase64Url, encodeUtf8Base64Url, signHmac, verifyHmac } from "./crypto";
import type { GuestSession } from "./guest-session";

const claimsSchema = z.object({ choirId: z.string().min(1), guestSessionVersion: z.number().int(), expiresAt: z.number(), sessionExpiresAt: z.number() });
export async function createInstallHandoff(session: GuestSession, secret: string, now = Date.now()) {
  const payload = encodeUtf8Base64Url(JSON.stringify({ ...session, sessionExpiresAt: session.expiresAt, expiresAt: Math.min(session.expiresAt, now + 10 * 60_000) }));
  return `${payload}.${encodeBase64Url(await signHmac(secret, "install-handoff", payload))}`;
}
export async function verifyInstallHandoff(token: string, secret: string, now = Date.now()): Promise<GuestSession | null> {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra || token.length > 2048) return null;
  const bytes = decodeBase64Url(signature);
  if (!bytes || !await verifyHmac(secret, "install-handoff", payload, bytes)) return null;
  try {
    const claims = claimsSchema.parse(JSON.parse(decodeUtf8Base64Url(payload) ?? ""));
    if (claims.expiresAt <= now || claims.sessionExpiresAt <= now) return null;
    return { choirId: claims.choirId, guestSessionVersion: claims.guestSessionVersion, expiresAt: claims.sessionExpiresAt };
  } catch { return null; }
}
