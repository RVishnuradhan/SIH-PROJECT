import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

import { AUTH_COOKIE_PREFIX, getAuth } from "@/lib/auth";
import { isProtectedPath, loginPathFor } from "@/lib/routes";
import { toCurrentUser } from "@/modules/auth/current-user";

const SESSION_COOKIE = `${AUTH_COOKIE_PREFIX}.session_token`;

/**
 * Runs before signed-in pages (never the security boundary — every page, server
 * action and route handler checks the session and permission itself):
 *   - sends people without a valid session to the sign-in page, remembering
 *     where they were going;
 *   - keeps an active session alive: once a day of use, its expiry and the
 *     cookie are pushed 7 days forward, so a session only ends after 7 days
 *     without use (ARCHITECTURE.md §10).
 * Server-action requests (POST) are never redirected here; their own guard
 * answers "please sign in again".
 */
export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (!isProtectedPath(pathname)) return NextResponse.next();

  const isPageRequest = request.method === "GET" || request.method === "HEAD";
  const toSignIn = () =>
    NextResponse.redirect(new URL(loginPathFor(`${pathname}${search}`), request.url));

  if (!getSessionCookie(request.headers, { cookiePrefix: AUTH_COOKIE_PREFIX })) {
    return isPageRequest ? toSignIn() : NextResponse.next();
  }

  try {
    const { headers: authHeaders, response: session } = await getAuth().api.getSession({
      headers: request.headers,
      returnHeaders: true,
      query: { disableCookieCache: true },
    });
    const signedIn = toCurrentUser(session) !== null;
    const result = signedIn || !isPageRequest ? NextResponse.next() : toSignIn();
    // A refreshed cookie, or the removal of an expired one.
    const authCookies = authHeaders.getSetCookie();
    for (const cookie of authCookies) result.headers.append("set-cookie", cookie);
    // A cookie that no longer opens a session (forged, revoked, deactivated
    // user) is removed, so later visits don't need a database check.
    if (!signedIn && authCookies.length === 0) clearSessionCookies(request, result);
    return result;
  } catch (error) {
    // Let the page itself decide (it shows an error or the sign-in page).
    console.error("Session check in proxy failed", error);
    return NextResponse.next();
  }
}

function clearSessionCookies(request: NextRequest, response: NextResponse) {
  for (const name of [SESSION_COOKIE, `__Secure-${SESSION_COOKIE}`]) {
    if (!request.cookies.has(name)) continue;
    response.cookies.set(name, "", {
      maxAge: 0,
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: name.startsWith("__Secure-"),
    });
  }
}

export const config = {
  // Pages only: not static files, images, icons or API route handlers (which
  // answer 401/403 themselves).
  matcher: ["/((?!_next/|api/|favicon\\.ico|icon|apple-icon|robots\\.txt).*)"],
};
