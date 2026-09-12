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

// A bridge is neither a session cookie nor a shared invitation.
describe("installation handoff", () => {
  it("is limited to ten minutes and keeps the original session expiry", async () => {
    const { createInstallHandoff, verifyInstallHandoff } = await import("./install-handoff");
    const claims = { choirId: "drive", guestSessionVersion: 3, expiresAt: 9_000_000 };
    const token = await createInstallHandoff(claims, "secret", 1_000);
    expect(await verifyInstallHandoff(token, "secret", 600_999)).toEqual(claims);
    expect(await verifyInstallHandoff(token, "secret", 601_000)).toBeNull();
    expect(await verifyInstallHandoff(token, "other", 1_001)).toBeNull();
    expect(await verifyGuestSessionToken(token, "secret", 1_001)).toBeNull();
    const cookie = await createGuestSessionToken(claims, "secret");
    expect(await verifyInstallHandoff(cookie, "secret", 1_001)).toBeNull();
  });
  it("cannot outlive the source session or accept malformed input", async () => {
    const { createInstallHandoff, verifyInstallHandoff } = await import("./install-handoff");
    const token = await createInstallHandoff({ choirId: "drive", guestSessionVersion: 1, expiresAt: 2_000 }, "secret", 1_000);
    expect(await verifyInstallHandoff(token, "secret", 2_000)).toBeNull();
    expect(await verifyInstallHandoff(token + ".extra", "secret", 1_001)).toBeNull();
    expect(await verifyInstallHandoff("malformed", "secret", 1_001)).toBeNull();
  });
});
