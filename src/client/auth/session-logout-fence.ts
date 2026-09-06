import { localDatabase } from "../platform/local-database";

export async function acceptSession(response: Response) {
  if (response.ok) {
    const body = await response.clone().json().catch(() => null);
    const fence = await localDatabase.system.get("auth:explicit-logout");
    if (fence && body?.user?.id && body?.session?.id) {
      const blocked = JSON.parse(fence.value);
      if (blocked.userId !== body.user.id || (blocked.sessionId && blocked.sessionId !== body.session.id)) {
        await localDatabase.system.delete("auth:explicit-logout");
      } else return Response.json(null);
    }
  }
  return response.clone();
}
