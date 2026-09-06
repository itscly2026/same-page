import { expect, it, vi } from "vitest";
import { verifyContainerAccess } from "./verify-container-access.mjs";

const credentials = { accountId: "a".repeat(32), token: "synthetic-secret" };

it("rejects the Containers authentication failure seen after successful Worker uploads", async () => {
  const fetchImpl = vi.fn().mockResolvedValue(Response.json({ error: "Authentication error" }, { status: 403 }));
  await expect(verifyContainerAccess({ ...credentials, fetchImpl })).rejects.toThrow(/HTTP 403.*Containers Edit/);
  expect(fetchImpl).toHaveBeenCalledWith(
    `https://api.cloudflare.com/client/v4/accounts/${credentials.accountId}/containers/me`,
    expect.objectContaining({ method: "GET", headers: { authorization: `Bearer ${credentials.token}` }, redirect: "error" }),
  );
});

it("allows a successful read probe without requiring or logging account response data", async () => {
  await expect(verifyContainerAccess({ ...credentials, fetchImpl: async () => Response.json({}) })).resolves.toBeUndefined();
});

it("fails closed without exposing credentials from an upstream transport error", async () => {
  await expect(verifyContainerAccess({ ...credentials, fetchImpl: async () => { throw new Error(credentials.token); } }))
    .rejects.toThrow(/^Cloudflare Containers preflight could not reach the API; no production writes were attempted\.$/);
});
