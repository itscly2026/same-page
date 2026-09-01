import { guestSessionResponseSchema } from "../../shared/choirs";

export async function clearGuestSession() {
  await fetch("/api/guest/session", { method: "DELETE" }).catch(() => null);
}

export async function clearPreviewGuestSession({
  keepForChoirId,
}: {
  keepForChoirId?: string;
} = {}) {
  try {
    const response = await fetch("/api/guest/session");
    if (!response.ok) return false;
    const guest = guestSessionResponseSchema.parse(await response.json());
    if (guest.entryKind !== "preview" || guest.choir.id === keepForChoirId) {
      return false;
    }
    await clearGuestSession();
    return true;
  } catch {
    return false;
  }
}
