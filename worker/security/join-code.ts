import { encodeBase64Url, signHmac } from "./crypto";

export const JOIN_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const JOIN_CODE_LENGTH = 8;

export function generateJoinCode(
  getRandomValues: (array: Uint8Array) => Uint8Array = (array) =>
    crypto.getRandomValues(array),
): string {
  const random = getRandomValues(new Uint8Array(JOIN_CODE_LENGTH));
  return Array.from(
    random,
    (value) => JOIN_CODE_ALPHABET[value & (JOIN_CODE_ALPHABET.length - 1)],
  ).join("");
}

export function normalizeJoinCode(value: string): string | null {
  const normalized = value.trim().toUpperCase();
  if (
    normalized.length !== JOIN_CODE_LENGTH ||
    [...normalized].some((character) => !JOIN_CODE_ALPHABET.includes(character))
  ) {
    return null;
  }
  return normalized;
}

export async function hashJoinCode(
  code: string,
  inviteSecret: string,
): Promise<string> {
  return encodeBase64Url(await signHmac(inviteSecret, "join-code", code));
}
