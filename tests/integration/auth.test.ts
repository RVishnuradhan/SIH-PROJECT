/**
 * Sign-in, sessions and brute-force protection against a real database, with
 * the real Better Auth instance (the one the app uses, pointed at a throw-away
 * database).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAuth, type Auth } from "@/lib/auth";
import type { Database } from "@/lib/db";
import { readSession } from "@/modules/auth/session";
import {
  signInWithPassword,
  signOutSession,
  type SignInDependencies,
} from "@/modules/auth/sign-in";
import {
  KeyedLock,
  MAX_FAILURES_PER_ACCOUNT,
  MAX_FAILURES_PER_IP,
  SIGN_IN_WINDOW_MS,
} from "@/modules/auth/throttle";
import { createUser, deactivateUser, reactivateUser, resetPassword } from "@/modules/users/service";

import { createTestDatabase, type TestDatabase } from "./support/test-database";

const SECRET = "integration-test-secret-0123456789-abcdefghij";
const ADMIN_PASSWORD = "admin-passphrase-2026";
const STAFF_PASSWORD = "staff-passphrase-2026";

let database: TestDatabase;
let db: Database;
let auth: Auth;
let deps: SignInDependencies;
let adminId: string;
let staffId: string;

/** Request headers as a browser would send them from a given address. */
function browser(ip = "203.0.113.10", cookie?: string): Headers {
  const headers = new Headers({ "user-agent": "IntegrationTest/1.0", "x-forwarded-for": ip });
  if (cookie) headers.set("cookie", cookie);
  return headers;
}

/** The `name=value` pair of the session cookie from a sign-in response. */
function sessionCookie(responseHeaders: Headers): string {
  const setCookie = responseHeaders.get("set-cookie") ?? "";
  const match = /(sms\.session_token=[^;]+)/.exec(setCookie);
  if (!match) throw new Error(`No session cookie in: ${setCookie}`);
  return match[1]!;
}

async function signIn(username: string, password: string, ip?: string) {
  return signInWithPassword(deps, { username, password, headers: browser(ip) });
}

async function auditRows(action: string) {
  return db.auditLog.findMany({ where: { action }, orderBy: { createdAt: "asc" } });
}

beforeAll(async () => {
  database = await createTestDatabase();
  db = database.prisma();
  auth = createAuth({ db, secret: SECRET, baseURL: "http://localhost:3000" });
  deps = { auth, db, secret: SECRET, lock: new KeyedLock() };

  adminId = (
    await createUser(db, {
      actor: null,
      input: {
        name: "Owner",
        username: "owner",
        role: "admin",
        password: ADMIN_PASSWORD,
        confirmPassword: ADMIN_PASSWORD,
      },
      request: null,
    })
  ).id;
  staffId = (
    await createUser(db, {
      actor: { id: adminId, username: "owner" },
      input: {
        name: "Ravi",
        username: "ravi",
        email: "ravi@example.com",
        role: "staff",
        password: STAFF_PASSWORD,
        confirmPassword: STAFF_PASSWORD,
      },
      request: null,
    })
  ).id;
});

afterAll(async () => {
  await database?.drop();
});

describe("accounts", () => {
  it("stores a salted hash, never the password", async () => {
    const account = await db.account.findFirstOrThrow({ where: { userId: staffId } });
    expect(account.providerId).toBe("credential");
    expect(account.accountId).toBe(staffId);
    expect(account.password).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
    expect(account.password).not.toContain(STAFF_PASSWORD);
  });

  it("keeps an empty email as a hidden placeholder", async () => {
    const owner = await db.user.findUniqueOrThrow({ where: { id: adminId } });
    expect(owner.email).toBe("owner@no-email.invalid");
    expect(owner).toMatchObject({ username: "owner", role: "admin", banned: false });
  });
});

describe("signing in", () => {
  it("signs in with the right username and password, and records it", async () => {
    const outcome = await signIn("ravi", STAFF_PASSWORD);
    expect(outcome.status).toBe("signed-in");
    if (outcome.status !== "signed-in") return;

    const setCookie = outcome.responseHeaders.get("set-cookie") ?? "";
    expect(setCookie).toContain("sms.session_token=");
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Max-Age=604800/);

    const session = await db.session.findFirstOrThrow({ where: { userId: staffId } });
    expect(session.ipAddress).toBe("203.0.113.10");
    expect(session.userAgent).toBe("IntegrationTest/1.0");
    const days = (session.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThanOrEqual(7);

    const [entry] = await auditRows("auth.signed_in");
    expect(entry).toMatchObject({ actorId: staffId, entityType: "user", entityId: staffId });
    expect(entry?.ipAddress).toBe("203.0.113.10");
  });

  it("reads the session back from the cookie", async () => {
    const outcome = await signIn("ravi", STAFF_PASSWORD);
    if (outcome.status !== "signed-in") throw new Error(outcome.status);
    const user = await readSession(
      auth,
      browser(undefined, sessionCookie(outcome.responseHeaders)),
    );
    expect(user).toMatchObject({ id: staffId, name: "Ravi", username: "ravi", role: "staff" });
  });

  it("accepts the username in any case", async () => {
    expect((await signIn("  RAVI ", STAFF_PASSWORD)).status).toBe("signed-in");
  });

  it("refuses a wrong password and an unknown username with the same outcome", async () => {
    expect(await signIn("ravi", "not-the-password")).toEqual({ status: "invalid-credentials" });
    expect(await signIn("nobody", "whatever-password")).toEqual({ status: "invalid-credentials" });

    const failures = await auditRows("auth.sign_in_failed");
    expect(failures.map((row) => row.entityType)).toEqual(["user", "sign_in"]);
    // The unknown name is kept only as a keyed hash.
    expect(failures[1]?.entityId).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(failures)).not.toContain("nobody");
  });

  it("does not accept a forged or unknown session cookie", async () => {
    expect(
      await readSession(auth, browser(undefined, "sms.session_token=forged.value")),
    ).toBeNull();
    expect(await readSession(auth, browser())).toBeNull();
  });

  it("ends the session on sign-out", async () => {
    const outcome = await signIn("ravi", STAFF_PASSWORD);
    if (outcome.status !== "signed-in") throw new Error(outcome.status);
    const cookie = sessionCookie(outcome.responseHeaders);
    const before = await db.session.count({ where: { userId: staffId } });

    const cleared = await signOutSession(
      { auth, db },
      { userId: staffId, headers: browser(undefined, cookie) },
    );
    expect(cleared.get("set-cookie")).toMatch(/sms\.session_token=;/);
    expect(await db.session.count({ where: { userId: staffId } })).toBe(before - 1);
    expect(await readSession(auth, browser(undefined, cookie))).toBeNull();
    expect(await auditRows("auth.signed_out")).toHaveLength(1);
  });

  it("treats an expired session as signed out", async () => {
    const outcome = await signIn("ravi", STAFF_PASSWORD);
    if (outcome.status !== "signed-in") throw new Error(outcome.status);
    const cookie = sessionCookie(outcome.responseHeaders);
    // The cookie holds "<token>.<signature>".
    const token = decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1)).split(".")[0]!;
    await db.session.update({ where: { token }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await readSession(auth, browser(undefined, cookie))).toBeNull();
  });
});

describe("brute-force protection", () => {
  it("locks an account after 5 failed attempts, even for the right password", async () => {
    await createUser(db, {
      actor: null,
      input: {
        name: "Target",
        username: "target",
        role: "staff",
        password: STAFF_PASSWORD,
        confirmPassword: STAFF_PASSWORD,
      },
      request: null,
    });
    for (let attempt = 0; attempt < MAX_FAILURES_PER_ACCOUNT; attempt++) {
      expect((await signIn("target", `wrong-${attempt}-password`, "198.51.100.1")).status).toBe(
        "invalid-credentials",
      );
    }
    const blocked = await signIn("target", STAFF_PASSWORD, "198.51.100.2");
    expect(blocked.status).toBe("throttled");
    if (blocked.status === "throttled") {
      expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
      expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(SIGN_IN_WINDOW_MS / 1000);
    }
    expect((await auditRows("auth.sign_in_blocked")).at(-1)?.summary).toBe(
      'Sign-in blocked for "target": too many failed attempts',
    );
  });

  it("lets an admin password reset lift the lock", async () => {
    const target = await db.user.findUniqueOrThrow({ where: { username: "target" } });
    await resetPassword(db, {
      actor: { id: adminId, username: "owner" },
      userId: target.id,
      password: "brand-new-passphrase",
      request: null,
    });
    expect((await signIn("target", "brand-new-passphrase", "198.51.100.3")).status).toBe(
      "signed-in",
    );
    expect((await signIn("target", STAFF_PASSWORD, "198.51.100.3")).status).toBe(
      "invalid-credentials",
    );
  });

  it("stops counting failures after 15 minutes", async () => {
    await createUser(db, {
      actor: null,
      input: {
        name: "Old",
        username: "old.failures",
        role: "staff",
        password: STAFF_PASSWORD,
        confirmPassword: STAFF_PASSWORD,
      },
      request: null,
    });
    const user = await db.user.findUniqueOrThrow({ where: { username: "old.failures" } });
    for (let index = 0; index < 10; index++) {
      await database.pool.query(
        `INSERT INTO audit_logs (id, action, entity_type, entity_id, summary, created_at)
         VALUES (gen_random_uuid(), 'auth.sign_in_failed', 'user', $1, 'old failure', now() - interval '16 minutes')`,
        [user.id],
      );
    }
    expect((await signIn("old.failures", STAFF_PASSWORD, "198.51.100.4")).status).toBe("signed-in");
  });

  it("locks unknown usernames the same way, so locking reveals nothing", async () => {
    for (let attempt = 0; attempt < MAX_FAILURES_PER_ACCOUNT; attempt++) {
      await signIn("ghost", "guess-password", `192.0.2.${attempt + 1}`);
    }
    expect((await signIn("ghost", "guess-password", "192.0.2.99")).status).toBe("throttled");
  });

  it("limits failed attempts from one network address across accounts", async () => {
    const ip = "198.51.100.200";
    for (let attempt = 0; attempt < MAX_FAILURES_PER_IP; attempt++) {
      expect((await signIn(`spray${attempt}`, "guess-password", ip)).status).toBe(
        "invalid-credentials",
      );
    }
    expect((await signIn("ravi", STAFF_PASSWORD, ip)).status).toBe("throttled");
    expect((await signIn("ravi", STAFF_PASSWORD, "198.51.100.201")).status).toBe("signed-in");
  });

  it("does not let a burst of parallel guesses get past the limit", async () => {
    await createUser(db, {
      actor: null,
      input: {
        name: "Burst",
        username: "burst",
        role: "staff",
        password: STAFF_PASSWORD,
        confirmPassword: STAFF_PASSWORD,
      },
      request: null,
    });
    const outcomes = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        signIn("burst", `parallel-guess-${index}`, `203.0.113.${100 + index}`),
      ),
    );
    const checked = outcomes.filter((outcome) => outcome.status === "invalid-credentials");
    expect(checked).toHaveLength(MAX_FAILURES_PER_ACCOUNT);
    expect(outcomes.filter((outcome) => outcome.status === "throttled")).toHaveLength(
      12 - MAX_FAILURES_PER_ACCOUNT,
    );
  });
});

describe("deactivated accounts", () => {
  it("ends every session at once and refuses to sign in", async () => {
    const outcome = await signIn("ravi", STAFF_PASSWORD, "203.0.113.50");
    if (outcome.status !== "signed-in") throw new Error(outcome.status);
    const cookie = sessionCookie(outcome.responseHeaders);

    await deactivateUser(db, {
      actor: { id: adminId, username: "owner" },
      userId: staffId,
      reason: "Left the company",
      request: null,
    });
    expect(await db.session.count({ where: { userId: staffId } })).toBe(0);
    expect(await readSession(auth, browser(undefined, cookie))).toBeNull();

    expect(await signIn("ravi", STAFF_PASSWORD, "203.0.113.51")).toEqual({ status: "deactivated" });
    expect(await signIn("ravi", "wrong-password-here", "203.0.113.51")).toEqual({
      status: "invalid-credentials",
    });
    expect((await auditRows("auth.sign_in_refused")).at(-1)?.summary).toBe(
      'Sign-in refused for "ravi": the account is deactivated',
    );
  });

  it("can sign in again once reactivated", async () => {
    await reactivateUser(db, {
      actor: { id: adminId, username: "owner" },
      userId: staffId,
      request: null,
    });
    expect((await signIn("ravi", STAFF_PASSWORD, "203.0.113.52")).status).toBe("signed-in");
  });
});

describe("secrets", () => {
  it("never writes a password to the audit log", async () => {
    const { rows } = await database.pool.query<{ row: string }>(
      "SELECT row_to_json(a)::text AS row FROM audit_logs a",
    );
    const everything = rows.map((row) => row.row).join("\n");
    for (const secret of [
      ADMIN_PASSWORD,
      STAFF_PASSWORD,
      "brand-new-passphrase",
      "not-the-password",
      "guess-password",
    ]) {
      expect(everything).not.toContain(secret);
    }
  });
});
