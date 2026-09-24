import "server-only";

import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { admin } from "better-auth/plugins/admin";
import { username } from "better-auth/plugins/username";

import {
  hashPassword,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  verifyPassword,
} from "@/modules/auth/password";

import { brand } from "./brand";
import { getDb, type Database } from "./db";
import { getServerEnv } from "./env";

/** Session cookies are named `sms.session_token` (`__Secure-` prefixed on HTTPS). */
export const AUTH_COOKIE_PREFIX = "sms";

/** Sessions end after 7 days without use (ARCHITECTURE.md §10). */
export const SESSION_IDLE_TIMEOUT_SECONDS = 7 * 24 * 60 * 60;
/** How often an active session's expiry is pushed forward. */
export const SESSION_REFRESH_AFTER_SECONDS = 24 * 60 * 60;

export const DEACTIVATED_ACCOUNT_MESSAGE =
  "This account has been deactivated. Please contact the administrator.";

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 30;

/**
 * Better Auth, used as a library: usernames and passwords, database sessions and
 * the admin plugin's roles and deactivation. None of its HTTP endpoints are
 * mounted — signing in, signing out and managing users go through this app's own
 * server actions, which add throttling, permission checks and the audit log.
 */
export function createAuth(config: { db: Database; secret: string; baseURL: string }) {
  return betterAuth({
    appName: brand.name,
    baseURL: config.baseURL,
    secret: config.secret,
    database: prismaAdapter(config.db, { provider: "postgresql" }),
    emailAndPassword: {
      enabled: true,
      // No public sign-up: the first admin comes from `pnpm admin:create`,
      // everyone else is created by an admin (A12).
      disableSignUp: true,
      autoSignIn: false,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: PASSWORD_MAX_LENGTH,
      password: { hash: hashPassword, verify: verifyPassword },
    },
    session: {
      expiresIn: SESSION_IDLE_TIMEOUT_SECONDS,
      updateAge: SESSION_REFRESH_AFTER_SECONDS,
      // Every request checks the database, so a deactivated user or a revoked
      // session loses access immediately.
      cookieCache: { enabled: false },
    },
    user: { deleteUser: { enabled: false }, changeEmail: { enabled: false } },
    account: { accountLinking: { enabled: false } },
    advanced: {
      cookiePrefix: AUTH_COOKIE_PREFIX,
      // httpOnly and SameSite=Lax always; Secure whenever the app is served over HTTPS.
      useSecureCookies: config.baseURL.startsWith("https://"),
      database: { generateId: () => crypto.randomUUID() },
    },
    // Better Auth's limiter only guards its HTTP endpoints, which aren't mounted;
    // sign-in is throttled in src/modules/auth/throttle.ts instead.
    rateLimit: { enabled: false },
    telemetry: { enabled: false },
    // Failed sign-ins are recorded in the audit log; the server log keeps errors only.
    logger: { level: "error" },
    plugins: [
      username({ minUsernameLength: USERNAME_MIN_LENGTH, maxUsernameLength: USERNAME_MAX_LENGTH }),
      admin({
        defaultRole: "staff",
        adminRoles: ["admin"],
        bannedUserMessage: DEACTIVATED_ACCOUNT_MESSAGE,
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

let instance: Auth | undefined;

/** The app's auth instance, created on first use (so `next build` needs no secrets). */
export function getAuth(): Auth {
  if (!instance) {
    const env = getServerEnv();
    instance = createAuth({
      db: getDb(),
      secret: env.BETTER_AUTH_SECRET,
      baseURL: env.BETTER_AUTH_URL,
    });
  }
  return instance;
}
