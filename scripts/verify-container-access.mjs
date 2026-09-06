import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Probe the same read-only endpoint Wrangler calls before pushing an image.
// Do this before migrations or Worker uploads, which can otherwise succeed
// before a missing Containers entitlement/permission aborts the release.
export async function verifyContainerAccess({ accountId, token, fetchImpl = fetch }) {
  assert.match(accountId ?? "", /^[a-f0-9]{32}$/, "CLOUDFLARE_ACCOUNT_ID is required");
  assert.ok(token, "CLOUDFLARE_API_TOKEN is required");
  let response;
  try {
    response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${accountId}/containers/me`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("Cloudflare Containers preflight could not reach the API; no production writes were attempted.");
  }
  // Never log response bodies or request objects: they may contain credentials.
  assert.ok(response.ok,
    `Cloudflare Containers preflight failed: HTTP ${response.status}. Check the CI token's Containers Edit permission and the account's Workers Paid / Containers availability before retrying. No production writes were attempted.`);
  console.log("Cloudflare Containers read access verified; write permissions are checked by deployment.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await verifyContainerAccess({ accountId: process.env.CLOUDFLARE_ACCOUNT_ID, token: process.env.CLOUDFLARE_API_TOKEN });
}
