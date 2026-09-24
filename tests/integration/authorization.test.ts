/**
 * Server-side authorization with real sessions: the action guard reads the
 * session from the request cookie (as in production), checks the permission,
 * and records refused attempts in the audit log. Every admin-only permission
 * is tried by staff (refused) and by an admin (allowed).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { runAction, type ActionDefinition, type ActionDependencies } from "@/lib/action";
import { createAuth, type Auth } from "@/lib/auth";
import type { Database } from "@/lib/db";
import { ALL_PERMISSIONS, can, type Permission } from "@/lib/permissions";
import { writeAudit } from "@/modules/audit/audit";
import { readSession } from "@/modules/auth/session";
import { signInWithPassword } from "@/modules/auth/sign-in";
import { KeyedLock } from "@/modules/auth/throttle";
import { createUserSchema } from "@/modules/users/schemas";
import { createUser, deactivateUser } from "@/modules/users/service";

import { createTestDatabase, type TestDatabase } from "./support/test-database";

const SECRET = "authorization-test-secret-0123456789abcdef";
const PASSWORD = "authorization-passphrase";

let database: TestDatabase;
let db: Database;
let auth: Auth;
const cookies: Record<"admin" | "staff" | "leaver", string> = { admin: "", staff: "", leaver: "" };

async function signInCookie(username: string): Promise<string> {
  const outcome = await signInWithPassword(
    { auth, db, secret: SECRET, lock: new KeyedLock() },
    { username, password: PASSWORD, headers: new Headers({ "x-forwarded-for": "203.0.113.20" }) },
  );
  if (outcome.status !== "signed-in")
    throw new Error(`Could not sign in ${username}: ${outcome.status}`);
  return /(sms\.session_token=[^;]+)/.exec(outcome.responseHeaders.get("set-cookie") ?? "")![1]!;
}

/** The same wiring as `defineAction`, with the request's cookie. */
function dependencies(cookie: string | null): ActionDependencies {
  const headers = new Headers({
    "x-forwarded-for": "203.0.113.21",
    "user-agent": "AuthorizationTest",
  });
  if (cookie) headers.set("cookie", cookie);
  return {
    getUser: () => readSession(auth, headers),
    request: { ipAddress: "203.0.113.21", userAgent: "AuthorizationTest" },
    recordDenied: (entry) => writeAudit(db, entry),
    logError: () => {},
  };
}

function probe(permission: Permission): ActionDefinition<z.ZodType, string> {
  return {
    name: `probe.${permission}`,
    permission,
    schema: z.object({}),
    handler: async () => "allowed",
  };
}

beforeAll(async () => {
  database = await createTestDatabase();
  db = database.prisma();
  auth = createAuth({ db, secret: SECRET, baseURL: "http://localhost:3000" });
  for (const [username, role] of [
    ["owner", "admin"],
    ["ravi", "staff"],
    ["leaver", "staff"],
  ] as const) {
    await createUser(db, {
      actor: null,
      input: { name: username, username, role, password: PASSWORD, confirmPassword: PASSWORD },
      request: null,
    });
  }
  cookies.admin = await signInCookie("owner");
  cookies.staff = await signInCookie("ravi");
  cookies.leaver = await signInCookie("leaver");
});

afterAll(async () => {
  await database?.drop();
});

describe("user management action", () => {
  const createUserAction = {
    name: "user.create",
    permission: "user.manage",
    schema: createUserSchema,
    handler: async (input, { user, request }) => {
      await createUser(db, { actor: user, input, request });
      return null;
    },
  } satisfies ActionDefinition<typeof createUserSchema, null>;
  const input = (username: string) => ({
    name: "New Person",
    username,
    role: "admin",
    password: "new-person-pass",
    confirmPassword: "new-person-pass",
  });

  it("refuses someone who isn't signed in", async () => {
    expect(await runAction(createUserAction, input("anon.try"), dependencies(null))).toMatchObject({
      ok: false,
      code: "UNAUTHENTICATED",
    });
    expect(
      await runAction(
        createUserAction,
        input("forged.try"),
        dependencies("sms.session_token=forged.x"),
      ),
    ).toMatchObject({
      ok: false,
      code: "UNAUTHENTICATED",
    });
  });

  it("refuses staff — nothing is created, and the attempt is recorded", async () => {
    expect(
      await runAction(createUserAction, input("staff.try"), dependencies(cookies.staff)),
    ).toMatchObject({
      ok: false,
      code: "FORBIDDEN",
    });
    expect(await db.user.count({ where: { username: "staff.try" } })).toBe(0);
    const ravi = await db.user.findUniqueOrThrow({ where: { username: "ravi" } });
    const denied = await db.auditLog.findFirstOrThrow({
      where: { action: "access.denied", actorId: ravi.id },
    });
    expect(denied).toMatchObject({
      entityType: "action",
      entityId: "user.create",
      summary: "Refused user.create for ravi (staff): needs user.manage",
      ipAddress: "203.0.113.21",
      userAgent: "AuthorizationTest",
    });
  });

  it("lets an admin create the user", async () => {
    expect(
      await runAction(createUserAction, input("admin.made"), dependencies(cookies.admin)),
    ).toEqual({
      ok: true,
      data: null,
    });
    const created = await db.user.findUniqueOrThrow({ where: { username: "admin.made" } });
    const owner = await db.user.findUniqueOrThrow({ where: { username: "owner" } });
    const entry = await db.auditLog.findFirstOrThrow({
      where: { action: "user.created", entityId: created.id },
    });
    expect(entry.actorId).toBe(owner.id);
  });

  it("refuses a deactivated user whose browser still has the cookie", async () => {
    const owner = await db.user.findUniqueOrThrow({ where: { username: "owner" } });
    const leaver = await db.user.findUniqueOrThrow({ where: { username: "leaver" } });
    await deactivateUser(db, {
      actor: { id: owner.id, username: "owner" },
      userId: leaver.id,
      request: null,
    });
    expect(await runAction(probe("bill.create"), {}, dependencies(cookies.leaver))).toMatchObject({
      ok: false,
      code: "UNAUTHENTICATED",
    });
  });
});

describe("every permission, both roles", () => {
  it.each(ALL_PERMISSIONS)("%s", async (permission) => {
    const asAdmin = await runAction(probe(permission), {}, dependencies(cookies.admin));
    const asStaff = await runAction(probe(permission), {}, dependencies(cookies.staff));
    expect(asAdmin).toEqual({ ok: true, data: "allowed" });
    if (can("staff", permission)) {
      expect(asStaff).toEqual({ ok: true, data: "allowed" });
    } else {
      expect(asStaff).toMatchObject({ ok: false, code: "FORBIDDEN" });
      expect(
        await db.auditLog.count({
          where: { action: "access.denied", entityId: `probe.${permission}` },
        }),
      ).toBe(1);
    }
  });
});
