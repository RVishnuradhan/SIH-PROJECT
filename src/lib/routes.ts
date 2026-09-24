/**
 * Where people land, and which paths need a signed-in user.
 *
 * Every page under `src/app/(app)` must start with one of the protected
 * prefixes (a unit test checks this). The prefixes only drive the early
 * redirect to the sign-in page in `src/proxy.ts`; each page, server action and
 * route handler still checks the session and permission itself.
 */

export const HOME_PATH = "/dashboard";
export const LOGIN_PATH = "/login";

export const PROTECTED_PREFIXES = ["/dashboard", "/settings", "/account"] as const;

export function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

const MAX_REDIRECT_LENGTH = 512;

/**
 * The page to open after signing in, taken from an untrusted `next` value.
 * Only a path on this site is accepted — never another site ("//evil.test",
 * "https://…", "/\evil.test") and never the sign-in page itself.
 */
export function safeRedirectPath(value: unknown, fallback: string = HOME_PATH): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_REDIRECT_LENGTH) {
    return fallback;
  }
  // Must be an absolute path on this origin: one leading slash, no backslashes
  // (browsers treat "\" like "/"), no control characters or whitespace.
  if (!value.startsWith("/") || value.startsWith("//") || /[\\\s\p{Cc}]/u.test(value)) {
    return fallback;
  }
  let url: URL;
  try {
    url = new URL(value, "http://sms.invalid");
  } catch {
    return fallback;
  }
  if (url.origin !== "http://sms.invalid") return fallback;
  if (url.pathname === LOGIN_PATH || url.pathname.startsWith(`${LOGIN_PATH}/`)) return fallback;
  return `${url.pathname}${url.search}${url.hash}`;
}

/** The sign-in page, remembering where to go afterwards. */
export function loginPathFor(next?: string | null): string {
  const target = next ? safeRedirectPath(next, "") : "";
  return target ? `${LOGIN_PATH}?${new URLSearchParams({ next: target }).toString()}` : LOGIN_PATH;
}
