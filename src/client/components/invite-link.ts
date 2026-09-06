export function createInviteLink(origin: string, code: string) {
  const url = new URL("/", origin);
  url.searchParams.set("join", "1");
  url.hash = new URLSearchParams({ invite: code }).toString();
  return url.href;
}

export function readInviteLink(hash: string): { code: string | null } | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  if (!params.has("invite")) return null;
  const code = (params.get("invite") ?? "").toUpperCase().replace(/-/g, "");
  return { code: params.getAll("invite").length === 1 && /^[A-HJ-NP-Z2-9]{8}$/.test(code) ? code : null };
}
