// Bearer material is deliberately kept out of diagnostic request recording.
export async function prepareInstallLink(choirId: string, signal: AbortSignal): Promise<string | null> {
  const response = await fetch("/api/guest/install-handoff", { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ choirId }) });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error("install_handoff_unavailable");
  const data: { token: string } = await response.json();
  const url = new URL("/install", window.location.origin);
  url.searchParams.set("drive", choirId);
  url.hash = new URLSearchParams({ handoff: data.token }).toString();
  return url.href;
}
