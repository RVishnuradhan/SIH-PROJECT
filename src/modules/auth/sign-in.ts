import "server-only";

import { isAPIError } from "better-auth/api";

import type { Auth } from "@/lib/auth";
import type { Database } from "@/lib/db";
import { requestInfoFrom } from "@/lib/request-info";
import { writeAudit } from "@/modules/audit/audit";

import { checkSignInThrottle, type KeyedLock, LockQueueFullError, signInSubject } from "./throttle";

export type SignInDependencies = {
  auth: Auth;
  db: Database;
  /** Keys the hash of unknown usernames (the auth secret). */
  secret: string;
  lock: KeyedLock;
  now?: () => Date;
};

export type SignInOutcome =
  | { status: "signed-in"; userId: string; responseHeaders: Headers }
  | { status: "invalid-credentials" }
  | { status: "deactivated" }
  | { status: "throttled"; retryAfterSeconds: number };

/** Seconds to suggest when too many attempts are already queued. */
const BUSY_RETRY_SECONDS = 30;

/**
 * Signs a person in with username and password. Attempts for the same account
 * and network address run one at a time, the failure limits are checked before
 * the password is, and every outcome is written to the audit log. The caller
 * shows one generic message for a wrong username or password.
 */
export async function signInWithPassword(
  deps: SignInDependencies,
  input: { username: string; password: string; headers: Headers },
): Promise<SignInOutcome> {
  const normalized = input.username.trim().toLowerCase();
  const request = requestInfoFrom(input.headers);
  const user = await deps.db.user.findUnique({
    where: { username: normalized },
    select: { id: true, username: true },
  });
  const subject = signInSubject(user, normalized, deps.secret);
  const who = user ? `"${user.username}"` : "an unknown username";

  try {
    return await deps.lock.run(
      [`ip:${request.ipAddress ?? "unknown"}`, `${subject.entityType}:${subject.entityId}`],
      async (): Promise<SignInOutcome> => {
        const now = deps.now?.() ?? new Date();
        const throttle = await checkSignInThrottle(deps.db, {
          subject,
          ipAddress: request.ipAddress,
          now,
        });
        if (throttle.blocked) {
          await writeAudit(deps.db, {
            actorId: null,
            action: "auth.sign_in_blocked",
            ...subject,
            summary:
              throttle.scope === "account"
                ? `Sign-in blocked for ${who}: too many failed attempts`
                : `Sign-in blocked for ${who}: too many failed attempts from this network address`,
            request,
          });
          return { status: "throttled", retryAfterSeconds: throttle.retryAfterSeconds };
        }

        try {
          const { headers: responseHeaders, response } = await deps.auth.api.signInUsername({
            body: { username: normalized, password: input.password, rememberMe: true },
            headers: input.headers,
            returnHeaders: true,
          });
          const userId = response.user.id;
          await writeAudit(deps.db, {
            actorId: userId,
            action: "auth.signed_in",
            entityType: "user",
            entityId: userId,
            summary: `Signed in as "${normalized}"`,
            request,
          });
          return { status: "signed-in", userId, responseHeaders };
        } catch (error) {
          if (!isAPIError(error)) throw error;
          if (error.body?.code === "BANNED_USER") {
            await writeAudit(deps.db, {
              actorId: null,
              action: "auth.sign_in_refused",
              ...subject,
              summary: `Sign-in refused for ${who}: the account is deactivated`,
              request,
            });
            return { status: "deactivated" };
          }
          if (error.statusCode === 400 || error.statusCode === 401 || error.statusCode === 422) {
            await writeAudit(deps.db, {
              actorId: null,
              action: "auth.sign_in_failed",
              ...subject,
              summary: user
                ? `Failed sign-in for ${who}`
                : "Failed sign-in with an unknown username",
              request,
            });
            return { status: "invalid-credentials" };
          }
          throw error;
        }
      },
    );
  } catch (error) {
    if (error instanceof LockQueueFullError) {
      return { status: "throttled", retryAfterSeconds: BUSY_RETRY_SECONDS };
    }
    throw error;
  }
}

/** Ends the current session and records it. Returns the cookie-clearing headers. */
export async function signOutSession(
  deps: { auth: Auth; db: Database },
  input: { userId: string | null; headers: Headers },
): Promise<Headers> {
  const { headers: responseHeaders } = await deps.auth.api.signOut({
    headers: input.headers,
    returnHeaders: true,
  });
  if (input.userId) {
    await writeAudit(deps.db, {
      actorId: input.userId,
      action: "auth.signed_out",
      entityType: "user",
      entityId: input.userId,
      summary: "Signed out",
      request: requestInfoFrom(input.headers),
    });
  }
  return responseHeaders;
}
