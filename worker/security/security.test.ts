import { describe, expect, it } from "vitest";

import {
  createGuestSessionToken,
  verifyGuestSessionToken,
} from "./guest-session";
import {
  generateJoinCode,
  JOIN_CODE_ALPHABET,
  normalizeJoinCode,
} from "./join-code";

describe("invite credentials", () => {
  it("generates eight unambiguous uppercase characters without modulo bias", () => {
    expect(JOIN_CODE_ALPHABET).toHaveLength(32);
    const code = generateJoinCode((array) => {
      array.set([0, 1, 2, 3, 28, 29, 30, 31]);
      return array;
    });

    expect(code).toBe("ABCD6789");
    expect(normalizeJoinCode(` ${code.toLowerCase()} `)).toBe(code);
    expect(normalizeJoinCode("O0I1ABCD")).toBeNull();
  });

  it("rejects tampered and expired guest sessions", async () => {
    const secret = "guest-session-test-secret-with-32-characters";
    const token = await createGuestSessionToken(
      { choirId: "choir-1", guestSessionVersion: 2, expiresAt: 2_000 },
      secret,
    );

    await expect(verifyGuestSessionToken(token, secret, 1_000)).resolves.toEqual(
      { choirId: "choir-1", guestSessionVersion: 2, expiresAt: 2_000 },
    );
    await expect(
      verifyGuestSessionToken(`${token}x`, secret, 1_000),
    ).resolves.toBeNull();
    await expect(verifyGuestSessionToken(token, secret, 2_001)).resolves.toBeNull();
  });
});
