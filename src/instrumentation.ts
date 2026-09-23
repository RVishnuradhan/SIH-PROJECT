/**
 * Runs once when a Next.js server starts. Validating the environment here makes
 * a misconfigured deployment fail at start-up instead of on the first request.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getServerEnv } = await import("./lib/env");
    getServerEnv();
  }
}
