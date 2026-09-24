import type { Auth } from "@/lib/auth";
import { isRole, type Role } from "@/lib/permissions";

/** The signed-in user, as the rest of the app sees them. */
export type CurrentUser = {
  id: string;
  name: string;
  username: string;
  role: Role;
  sessionId: string;
};

type SessionResult = Awaited<ReturnType<Auth["api"]["getSession"]>>;

/**
 * Turns a Better Auth session into the app's user. A deactivated account or an
 * unknown role counts as signed out.
 */
export function toCurrentUser(result: SessionResult): CurrentUser | null {
  if (!result) return null;
  const { user, session } = result;
  if (user.banned || !isRole(user.role)) return null;
  return {
    id: user.id,
    name: user.name,
    username: user.username ?? "",
    role: user.role,
    sessionId: session.id,
  };
}
