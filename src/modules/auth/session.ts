import "server-only";

import { parseSetCookieHeader, toCookieOptions } from "better-auth/cookies";
import type { Route } from "next";
import { cookies, headers } from "next/headers";
import { forbidden, redirect } from "next/navigation";
import { cache } from "react";

import { getAuth, type Auth } from "@/lib/auth";
import { can, type Permission } from "@/lib/permissions";
import { LOGIN_PATH } from "@/lib/routes";

import { toCurrentUser, type CurrentUser } from "./current-user";

export type { CurrentUser } from "./current-user";

/**
 * Reads the session for a request, straight from the database. Read-only:
 * extending an active session's expiry happens in `src/proxy.ts`, the one place
 * that can also update the cookie on page requests.
 */
export async function readSession(
  auth: Auth,
  requestHeaders: Headers,
): Promise<CurrentUser | null> {
  const result = await auth.api.getSession({
    headers: requestHeaders,
    query: { disableRefresh: true, disableCookieCache: true },
  });
  return toCurrentUser(result);
}

/** The signed-in user for this request, or null. Looked up once per request. */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  // Reading the request first marks the page as rendered per request, so a
  // build never tries to pre-render a signed-in page (or needs the secrets).
  const requestHeaders = await headers();
  return readSession(getAuth(), requestHeaders);
});

/** For pages: the signed-in user, or a redirect to the sign-in page. */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect(LOGIN_PATH as Route);
  return user;
}

/** For pages: the signed-in user if they have the permission, otherwise the 403 page. */
export async function requirePermission(permission: Permission): Promise<CurrentUser> {
  const user = await requireUser();
  if (!can(user.role, permission)) forbidden();
  return user;
}

/** Copies the cookies Better Auth set (sign-in, sign-out) onto the Next.js response. */
export async function applyAuthCookies(responseHeaders: Headers): Promise<void> {
  const setCookie = responseHeaders.get("set-cookie");
  if (!setCookie) return;
  const jar = await cookies();
  for (const [name, attributes] of parseSetCookieHeader(setCookie)) {
    jar.set(name, attributes.value, toCookieOptions(attributes));
  }
}
