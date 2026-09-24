/**
 * User management rules against a real database: unique usernames, at least
 * one active admin at all times (also under concurrent changes), no
 * self-lockout, password changes, and the audit trail of every change.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "@/lib/db";
import { ServiceError } from "@/lib/errors";
import { verifyPassword } from "@/modules/auth/password";
import {
  changeOwnPassword,
  changeRole,
  countActiveAdmins,
  createUser,
  deactivateUser,
  listUsers,
  reactivateUser,
  resetPassword,
  type Actor,
} from "@/modules/users/service";

import { createTestDatabase, type TestDatabase } from "./support/test-database";

let database: TestDatabase;
let db: Database;
const PASSWORD = "integration-passphrase";

beforeAll(async () => {
  database = await createTestDatabase();
  db = database.prisma();
});

afterAll(async () => {
  await database?.drop();
});

async function newUser(username: string, role: "admin" | "staff", actor: Actor = null) {
  const { id } = await createUser(db, {
    actor,
    input: {
      name: username.toUpperCase(),
      username,
      role,
      password: PASSWORD,
      confirmPassword: PASSWORD,
    },
    request: { ipAddress: "203.0.113.1", userAgent: "IntegrationTest" },
  });
  return { id, username };
}

async function sessionFor(userId: string) {
  return db.session.create({
    data: {
      id: crypto.randomUUID(),
      token: crypto.randomUUID(),
      userId,
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
}

async function expectServiceError(promise: Promise<unknown>, code: string, message: string) {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(ServiceError);
  expect(error).toMatchObject({ code, message });
}

describe("creating users", () => {
  it("records who created whom, without secrets", async () => {
    const owner = await newUser("owner", "admin");
    await newUser("ravi", "staff", owner);
    const entries = await db.auditLog.findMany({
      where: { action: "user.created" },
      orderBy: { createdAt: "asc" },
    });
    expect(entries.map((entry) => [entry.actorId, entry.summary])).toEqual([
      [null, 'Setup script created admin account "owner" for OWNER'],
      [owner.id, 'Created staff account "ravi" for RAVI'],
    ]);
    expect(entries[1]?.changes).toEqual({
      name: { to: "RAVI" },
      username: { to: "ravi" },
      role: { to: "staff" },
    });
    expect(entries[1]?.ipAddress).toBe("203.0.113.1");
    expect(JSON.stringify(entries)).not.toContain(PASSWORD);
  });

  it("refuses a username or email that is already used", async () => {
    await expectServiceError(
      newUser("ravi", "staff"),
      "CONFLICT",
      "That username is already taken.",
    );
    await createUser(db, {
      actor: null,
      input: {
        name: "Mani",
        username: "mani",
        email: "mani@example.com",
        role: "staff",
        password: PASSWORD,
        confirmPassword: PASSWORD,
      },
      request: null,
    });
    await expectServiceError(
      createUser(db, {
        actor: null,
        input: {
          name: "Mani 2",
          username: "mani2",
          email: "mani@example.com",
          role: "staff",
          password: PASSWORD,
          confirmPassword: PASSWORD,
        },
        request: null,
      }),
      "CONFLICT",
      "That email is already used by another account.",
    );
  });

  it("lists users with placeholder emails hidden", async () => {
    const users = await listUsers(db);
    expect(users.find((user) => user.username === "ravi")).toMatchObject({
      email: null,
      role: "staff",
      active: true,
    });
    expect(users.find((user) => user.username === "mani")?.email).toBe("mani@example.com");
  });
});

describe("keeping at least one active admin", () => {
  it("refuses to demote or deactivate the only active admin", async () => {
    const owner = await db.user.findUniqueOrThrow({ where: { username: "owner" } });
    expect(await countActiveAdmins(db)).toBe(1);
    // Admins can't act on themselves (next test), so the rule is shown with the
    // setup script as the actor.
    await expectServiceError(
      changeRole(db, { actor: null, userId: owner.id, role: "staff", request: null }),
      "CONFLICT",
      "At least one active admin must remain. Make another user an admin first.",
    );
    await expectServiceError(
      deactivateUser(db, { actor: null, userId: owner.id, request: null }),
      "CONFLICT",
      "At least one active admin must remain. Make another user an admin first.",
    );
    expect(await countActiveAdmins(db)).toBe(1);
  });

  it("allows demoting an admin while another active admin remains", async () => {
    const owner = await db.user.findUniqueOrThrow({ where: { username: "owner" } });
    const ravi = await db.user.findUniqueOrThrow({ where: { username: "ravi" } });
    const actor = { id: owner.id, username: "owner" };
    await changeRole(db, { actor, userId: ravi.id, role: "admin", request: null });
    await changeRole(db, { actor, userId: ravi.id, role: "staff", request: null });
    const changes = await db.auditLog.findMany({
      where: { action: "user.role_changed", entityId: ravi.id },
      orderBy: { createdAt: "asc" },
    });
    expect(changes.map((entry) => entry.changes)).toEqual([
      { role: { from: "staff", to: "admin" } },
      { role: { from: "admin", to: "staff" } },
    ]);
    expect(changes[0]?.summary).toBe('Changed "ravi" from Staff to Admin');
  });

  it("never ends with no admin when two admins demote each other at the same moment", async () => {
    const a = await newUser("admin.a", "admin");
    const b = await newUser("admin.b", "admin");
    const owner = await db.user.findUniqueOrThrow({ where: { username: "owner" } });
    // Only a and b are active admins for this test.
    await deactivateUser(db, { actor: a, userId: owner.id, request: null });

    const results = await Promise.allSettled([
      changeRole(db, { actor: a, userId: b.id, role: "staff", request: null }),
      changeRole(db, { actor: b, userId: a.id, role: "staff", request: null }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((result) => result.status === "rejected");
    expect((refused as PromiseRejectedResult).reason).toMatchObject({ code: "CONFLICT" });
    expect(await countActiveAdmins(db)).toBe(1);

    // Put things back for the next tests.
    const remaining = await db.user.findFirstOrThrow({ where: { role: "admin", banned: false } });
    await reactivateUser(db, {
      actor: { id: remaining.id, username: remaining.username ?? "" },
      userId: owner.id,
      request: null,
    });
  });

  it("stops admins changing their own role, deactivating or resetting themselves", async () => {
    const owner = await db.user.findUniqueOrThrow({ where: { username: "owner" } });
    const self = { id: owner.id, username: "owner" };
    await expectServiceError(
      changeRole(db, { actor: self, userId: owner.id, role: "staff", request: null }),
      "CONFLICT",
      "You can't change your own role. Ask another admin to do it.",
    );
    await expectServiceError(
      deactivateUser(db, { actor: self, userId: owner.id, request: null }),
      "CONFLICT",
      "You can't deactivate your own account.",
    );
    await expectServiceError(
      resetPassword(db, {
        actor: self,
        userId: owner.id,
        password: "whatever-new-pass",
        request: null,
      }),
      "CONFLICT",
      "Change your own password from your account page.",
    );
  });

  it("reports a user that doesn't exist", async () => {
    const owner = await db.user.findUniqueOrThrow({ where: { username: "owner" } });
    await expectServiceError(
      deactivateUser(db, {
        actor: { id: owner.id, username: "owner" },
        userId: "no-such-user",
        request: null,
      }),
      "NOT_FOUND",
      "That user no longer exists.",
    );
  });
});

describe("deactivation and passwords", () => {
  it("deactivating ends every session and is recorded with its reason", async () => {
    const owner = await db.user.findUniqueOrThrow({ where: { username: "owner" } });
    const staff = await newUser("leaver", "staff");
    await sessionFor(staff.id);
    await sessionFor(staff.id);

    await deactivateUser(db, {
      actor: { id: owner.id, username: "owner" },
      userId: staff.id,
      reason: "Left the company",
      request: null,
    });
    expect(await db.session.count({ where: { userId: staff.id } })).toBe(0);
    expect(await db.user.findUniqueOrThrow({ where: { id: staff.id } })).toMatchObject({
      banned: true,
      banReason: "Left the company",
    });
    const entry = await db.auditLog.findFirstOrThrow({
      where: { action: "user.deactivated", entityId: staff.id },
    });
    expect(entry.summary).toBe('Deactivated "leaver" (Left the company); ended 2 session(s)');
    expect(entry.changes).toEqual({ status: { from: "active", to: "deactivated" } });

    await reactivateUser(db, {
      actor: { id: owner.id, username: "owner" },
      userId: staff.id,
      request: null,
    });
    expect(await db.user.findUniqueOrThrow({ where: { id: staff.id } })).toMatchObject({
      banned: false,
      banReason: null,
    });
  });

  it("an admin's password reset ends the user's sessions", async () => {
    const owner = await db.user.findUniqueOrThrow({ where: { username: "owner" } });
    const staff = await db.user.findUniqueOrThrow({ where: { username: "leaver" } });
    await sessionFor(staff.id);
    await resetPassword(db, {
      actor: { id: owner.id, username: "owner" },
      userId: staff.id,
      password: "reset-passphrase-1",
      request: null,
    });
    expect(await db.session.count({ where: { userId: staff.id } })).toBe(0);
    const account = await db.account.findFirstOrThrow({
      where: { userId: staff.id, providerId: "credential" },
    });
    expect(await verifyPassword({ hash: account.password!, password: "reset-passphrase-1" })).toBe(
      true,
    );
    expect(await verifyPassword({ hash: account.password!, password: PASSWORD })).toBe(false);
  });

  it("changing your own password needs the current one, and keeps only this session", async () => {
    const user = await newUser("changer", "staff");
    const current = await sessionFor(user.id);
    await sessionFor(user.id);
    const me = { id: user.id, username: "changer", sessionId: current.id };

    await expectServiceError(
      changeOwnPassword(db, {
        user: me,
        currentPassword: "wrong-password",
        newPassword: "next-passphrase-1",
        request: null,
      }),
      "INVALID_INPUT",
      "Your current password is incorrect.",
    );
    expect(
      await db.auditLog.count({
        where: { action: "user.password_change_failed", entityId: user.id },
      }),
    ).toBe(1);

    await changeOwnPassword(db, {
      user: me,
      currentPassword: PASSWORD,
      newPassword: "next-passphrase-1",
      request: null,
    });
    const sessions = await db.session.findMany({ where: { userId: user.id } });
    expect(sessions.map((session) => session.id)).toEqual([current.id]);
    const account = await db.account.findFirstOrThrow({
      where: { userId: user.id, providerId: "credential" },
    });
    expect(await verifyPassword({ hash: account.password!, password: "next-passphrase-1" })).toBe(
      true,
    );
  });

  it("limits wrong guesses of the current password", async () => {
    const user = await newUser("guesser", "staff");
    const me = { id: user.id, username: "guesser", sessionId: (await sessionFor(user.id)).id };
    for (let attempt = 0; attempt < 5; attempt++) {
      await expectServiceError(
        changeOwnPassword(db, {
          user: me,
          currentPassword: `guess-${attempt}`,
          newPassword: "next-passphrase-2",
          request: null,
        }),
        "INVALID_INPUT",
        "Your current password is incorrect.",
      );
    }
    await expectServiceError(
      changeOwnPassword(db, {
        user: me,
        currentPassword: PASSWORD,
        newPassword: "next-passphrase-2",
        request: null,
      }),
      "RATE_LIMITED",
      "Too many wrong attempts. Please wait 15 minutes and try again.",
    );
  });
});
