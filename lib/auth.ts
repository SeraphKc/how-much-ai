// Resolve the single self-hosted tenant for an API request. A local zero-config install is open;
// when APP_PASSWORD is set, every API route requires the signed password-session cookie.
import { authOpen, SESSION_COOKIE, verifySession } from "./session";

export async function requireUser(req: Request): Promise<string | null> {
  if (authOpen()) return "default";

  const cookie = req.headers.get("cookie") ?? "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  return (await verifySession(match?.[1])) ? "default" : null;
}
