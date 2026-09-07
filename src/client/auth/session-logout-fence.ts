import { acceptNewSession } from "./logout-fence";

export async function acceptSession(response: Response, requestedAt: number) {
  if (response.ok) {
    const body = await response.clone().json().catch(() => null);
    if (body?.user?.id && body?.session?.id && !await acceptNewSession(body.user.id, body.session.id, requestedAt)) return Response.json(null);
  }
  return response.clone();
}
