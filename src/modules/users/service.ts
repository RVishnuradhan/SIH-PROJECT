import "server-only";

import { Prisma } from "@/generated/prisma/client";
import type { Database } from "@/lib/db";
import { ServiceError } from "@/lib/errors";
import { roleLabels, type Role } from "@/lib/permissions";
import type { RequestInfo } from "@/lib/request-info";
import { writeAudit } from "@/modules/audit/audit";
import { hashPassword, verifyPassword } from "@/modules/auth/password";
import { MAX_FAILURES_PER_ACCOUNT, SIGN_IN_WINDOW_MS } from "@/modules/auth/throttle";

import type { CreateUserInput } from "./schemas";

/**
 * User management (Phase 3). Every change runs in one transaction together with
 * its audit entry. Users are never deleted: they are deactivated, which also
 * ends all their sessions.
 */

/** Who is making the change; null for the first-admin setup script. */
export type Actor = { id: string; username: string } | null;

type Tx = Prisma.TransactionClient;

/**
 * Better Auth needs an email on every account; when the admin leaves it empty a
 * placeholder on the reserved `.invalid` domain is stored and never shown.
 */
export const PLACEHOLDER_EMAIL_DOMAIN = "no-email.invalid";

export function placeholderEmail(username: string): string {
  return `${username}@${PLACEHOLDER_EMAIL_DOMAIN}`;
}

export function visibleEmail(email: string): string | null {
  return email.endsWith(`@${PLACEHOLDER_EMAIL_DOMAIN}`) ? null : email;
}

const LAST_ADMIN_MESSAGE =
  "At least one active admin must remain. Make another user an admin first.";

export type UserSummary = {
  id: string;
  name: string;
  username: string;
  email: string | null;
  role: Role;
  active: boolean;
  deactivationReason: string | null;
  createdAt: Date;
};

export async function listUsers(db: Database): Promise<UserSummary[]> {
  const users = await db.user.findMany({
    orderBy: [{ banned: "asc" }, { role: "asc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      username: true,
      email: true,
      role: true,
      banned: true,
      banReason: true,
      createdAt: true,
    },
  });
  return users.map((user) => ({
    id: user.id,
    name: user.name,
    username: user.username ?? "",
    email: visibleEmail(user.email),
    role: user.role === "admin" ? "admin" : "staff",
    active: !user.banned,
    deactivationReason: user.banReason,
    createdAt: user.createdAt,
  }));
}

export async function countActiveAdmins(db: Database): Promise<number> {
  return db.user.count({ where: { role: "admin", banned: false } });
}

export async function createUser(
  db: Database,
  { actor, input, request }: { actor: Actor; input: CreateUserInput; request: RequestInfo | null },
): Promise<{ id: string }> {
  const id = crypto.randomUUID();
  const email = input.email ?? placeholderEmail(input.username);
  const passwordHash = await hashPassword(input.password);

  try {
    await db.$transaction(async (tx) => {
      if (await tx.user.findUnique({ where: { username: input.username }, select: { id: true } })) {
        throw new ServiceError("CONFLICT", "That username is already taken.", {
          username: "That username is already taken",
        });
      }
      if (await tx.user.findUnique({ where: { email }, select: { id: true } })) {
        throw new ServiceError("CONFLICT", "That email is already used by another account.", {
          email: "That email is already used by another account",
        });
      }
      await tx.user.create({
        data: {
          id,
          name: input.name,
          email,
          username: input.username,
          displayUsername: input.username,
          role: input.role,
          // The credential account Better Auth checks at sign-in.
          accounts: {
            create: {
              id: crypto.randomUUID(),
              accountId: id,
              providerId: "credential",
              password: passwordHash,
            },
          },
        },
      });
      await writeAudit(tx, {
        actorId: actor?.id ?? null,
        action: "user.created",
        entityType: "user",
        entityId: id,
        summary: `${actor ? "Created" : "Setup script created"} ${roleLabels[input.role].toLowerCase()} account "${input.username}" for ${input.name}`,
        changes: {
          name: { to: input.name },
          username: { to: input.username },
          role: { to: input.role },
        },
        request,
      });
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new ServiceError("CONFLICT", "That username or email is already in use.");
    }
    throw error;
  }
  return { id };
}

type LockedUser = { id: string; username: string | null; role: string; banned: boolean };

/**
 * Locks the target user and every active admin, in id order, for the rest of
 * the transaction. The fixed order keeps two admins changing each other at the
 * same moment from deadlocking — and from leaving no active admin.
 */
async function lockTargetAndAdmins(tx: Tx, userId: string) {
  const rows = await tx.$queryRaw<LockedUser[]>`
    SELECT id, username, role, banned FROM users
    WHERE id = ${userId} OR (role = 'admin' AND NOT banned)
    ORDER BY id
    FOR UPDATE`;
  const target = rows.find((row) => row.id === userId);
  if (!target) throw new ServiceError("NOT_FOUND", "That user no longer exists.");
  const otherActiveAdmins = rows.filter(
    (row) => row.id !== userId && row.role === "admin" && !row.banned,
  ).length;
  return { target, otherActiveAdmins };
}

function assertNotSelf(actor: Actor, userId: string, message: string) {
  if (actor && actor.id === userId) throw new ServiceError("CONFLICT", message);
}

export async function changeRole(
  db: Database,
  {
    actor,
    userId,
    role,
    request,
  }: { actor: Actor; userId: string; role: Role; request: RequestInfo | null },
): Promise<void> {
  assertNotSelf(actor, userId, "You can't change your own role. Ask another admin to do it.");
  await db.$transaction(async (tx) => {
    const { target, otherActiveAdmins } = await lockTargetAndAdmins(tx, userId);
    if (target.role === role) return;
    if (target.role === "admin" && !target.banned && otherActiveAdmins === 0) {
      throw new ServiceError("CONFLICT", LAST_ADMIN_MESSAGE);
    }
    await tx.user.update({ where: { id: userId }, data: { role } });
    await writeAudit(tx, {
      actorId: actor?.id ?? null,
      action: "user.role_changed",
      entityType: "user",
      entityId: userId,
      summary: `Changed "${target.username}" from ${roleLabels[target.role === "admin" ? "admin" : "staff"]} to ${roleLabels[role]}`,
      changes: { role: { from: target.role, to: role } },
      request,
    });
  });
}

export async function deactivateUser(
  db: Database,
  {
    actor,
    userId,
    reason,
    request,
  }: { actor: Actor; userId: string; reason?: string; request: RequestInfo | null },
): Promise<void> {
  assertNotSelf(actor, userId, "You can't deactivate your own account.");
  await db.$transaction(async (tx) => {
    const { target, otherActiveAdmins } = await lockTargetAndAdmins(tx, userId);
    if (target.banned) return;
    if (target.role === "admin" && otherActiveAdmins === 0) {
      throw new ServiceError("CONFLICT", LAST_ADMIN_MESSAGE);
    }
    await tx.user.update({
      where: { id: userId },
      data: { banned: true, banReason: reason ?? null, banExpires: null },
    });
    // Signed out everywhere, immediately.
    const ended = await tx.session.deleteMany({ where: { userId } });
    await writeAudit(tx, {
      actorId: actor?.id ?? null,
      action: "user.deactivated",
      entityType: "user",
      entityId: userId,
      summary: `Deactivated "${target.username}"${reason ? ` (${reason})` : ""}; ended ${ended.count} session(s)`,
      changes: { status: { from: "active", to: "deactivated" } },
      request,
    });
  });
}

export async function reactivateUser(
  db: Database,
  { actor, userId, request }: { actor: Actor; userId: string; request: RequestInfo | null },
): Promise<void> {
  await db.$transaction(async (tx) => {
    const { target } = await lockTargetAndAdmins(tx, userId);
    if (!target.banned) return;
    await tx.user.update({
      where: { id: userId },
      data: { banned: false, banReason: null, banExpires: null },
    });
    await writeAudit(tx, {
      actorId: actor?.id ?? null,
      action: "user.reactivated",
      entityType: "user",
      entityId: userId,
      summary: `Reactivated "${target.username}"`,
      changes: { status: { from: "deactivated", to: "active" } },
      request,
    });
  });
}

async function setCredentialPassword(tx: Tx, userId: string, passwordHash: string) {
  const updated = await tx.account.updateMany({
    where: { userId, providerId: "credential" },
    data: { password: passwordHash },
  });
  if (updated.count === 0) {
    await tx.account.create({
      data: {
        id: crypto.randomUUID(),
        userId,
        accountId: userId,
        providerId: "credential",
        password: passwordHash,
      },
    });
  }
}

/** An admin sets a new password for someone else; all their sessions end. */
export async function resetPassword(
  db: Database,
  {
    actor,
    userId,
    password,
    request,
  }: { actor: Actor; userId: string; password: string; request: RequestInfo | null },
): Promise<void> {
  assertNotSelf(actor, userId, "Change your own password from your account page.");
  const passwordHash = await hashPassword(password);
  await db.$transaction(async (tx) => {
    const { target } = await lockTargetAndAdmins(tx, userId);
    await setCredentialPassword(tx, userId, passwordHash);
    const ended = await tx.session.deleteMany({ where: { userId } });
    await writeAudit(tx, {
      actorId: actor?.id ?? null,
      action: "user.password_reset",
      entityType: "user",
      entityId: userId,
      summary: `Reset the password of "${target.username}"; ended ${ended.count} session(s)`,
      request,
    });
  });
}

/**
 * A signed-in user changes their own password. The current password is
 * required, repeated wrong guesses are limited like sign-in, and every other
 * session of the user ends.
 */
export async function changeOwnPassword(
  db: Database,
  {
    user,
    currentPassword,
    newPassword,
    request,
    now = new Date(),
  }: {
    user: { id: string; username: string; sessionId: string };
    currentPassword: string;
    newPassword: string;
    request: RequestInfo | null;
    now?: Date;
  },
): Promise<void> {
  const recentFailures = await db.auditLog.count({
    where: {
      entityType: "user",
      entityId: user.id,
      action: "user.password_change_failed",
      createdAt: { gt: new Date(now.getTime() - SIGN_IN_WINDOW_MS) },
    },
  });
  if (recentFailures >= MAX_FAILURES_PER_ACCOUNT) {
    throw new ServiceError(
      "RATE_LIMITED",
      "Too many wrong attempts. Please wait 15 minutes and try again.",
    );
  }

  const account = await db.account.findFirst({
    where: { userId: user.id, providerId: "credential" },
    select: { password: true },
  });
  const matches = account?.password
    ? await verifyPassword({ hash: account.password, password: currentPassword })
    : false;
  if (!matches) {
    await writeAudit(db, {
      actorId: user.id,
      action: "user.password_change_failed",
      entityType: "user",
      entityId: user.id,
      summary: `Wrong current password when "${user.username}" tried to change it`,
      request,
    });
    throw new ServiceError("INVALID_INPUT", "Your current password is incorrect.", {
      currentPassword: "Your current password is incorrect",
    });
  }

  const passwordHash = await hashPassword(newPassword);
  await db.$transaction(async (tx) => {
    await setCredentialPassword(tx, user.id, passwordHash);
    const ended = await tx.session.deleteMany({
      where: { userId: user.id, NOT: { id: user.sessionId } },
    });
    await writeAudit(tx, {
      actorId: user.id,
      action: "user.password_changed",
      entityType: "user",
      entityId: user.id,
      summary: `"${user.username}" changed their password; ended ${ended.count} other session(s)`,
      request,
    });
  });
}
