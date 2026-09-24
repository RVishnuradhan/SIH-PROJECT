/**
 * Who is calling: the client IP and browser, for the audit log and sign-in
 * throttling. The app runs behind a proxy or platform (Vercel, nginx, …) that
 * sets X-Forwarded-For; when Next.js is reached directly it fills the header
 * in from the connection itself.
 */
export type RequestInfo = { ipAddress: string | null; userAgent: string | null };

const IP_PATTERN = /^[0-9a-fA-F:.]{2,45}$/;
const MAX_USER_AGENT_LENGTH = 512;

export function requestInfoFrom(headers: Headers): RequestInfo {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const candidate = forwarded || headers.get("x-real-ip")?.trim() || "";
  const userAgent = headers.get("user-agent")?.trim() ?? "";
  return {
    ipAddress: IP_PATTERN.test(candidate) ? candidate : null,
    userAgent: userAgent ? userAgent.slice(0, MAX_USER_AGENT_LENGTH) : null,
  };
}
