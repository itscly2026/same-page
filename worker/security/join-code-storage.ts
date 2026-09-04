import { decodeBase64Url, encodeBase64Url, signHmac } from "./crypto";

async function encryptionKey(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    await signHmac(secret, "join-code-encryption", "v1"),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptJoinCode(code: string, choirId: string, secret: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(choirId) },
    await encryptionKey(secret),
    new TextEncoder().encode(code),
  );
  return `v1.${encodeBase64Url(iv)}.${encodeBase64Url(new Uint8Array(ciphertext))}`;
}

export async function decryptJoinCode(value: string, choirId: string, secret: string) {
  const [version, encodedIv, encodedCiphertext, extra] = value.split(".");
  const iv = decodeBase64Url(encodedIv ?? "");
  const ciphertext = decodeBase64Url(encodedCiphertext ?? "");
  if (version !== "v1" || extra !== undefined || iv?.length !== 12 || !ciphertext) {
    throw new Error("Invalid stored join code");
  }
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(choirId) },
    await encryptionKey(secret),
    ciphertext,
  );
  return new TextDecoder().decode(plaintext);
}
