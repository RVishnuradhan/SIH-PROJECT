import { createHmac } from "node:crypto";

import type { Prisma } from "@/generated/prisma/client";

/**
 * Brute-force protection for sign-in (ARCHITECTURE.md §10, §13).
 *
 * Failed attempts are counted from the audit log, so the limits hold across
 * server restarts and across several app instances:
 *   - per account: 5 failed attempts within 15 minutes lock the account for the
 *     rest of that window; a successful sign-in or an admin password reset starts
 *     the count again;
 *   - per IP address: 20 failed attempts within 15 minutes, whichever accounts
 *     they tried.
 * Attempts on an unknown username are counted the same way (under a keyed hash of
 * the username), so locking behaviour doesn't reveal which usernames exist.
 */
export const SIGN_IN_WINDOW_MS = 15 * 60 * 1000;
export const MAX_FAILURES_PER_ACCOUNT = 5;
export const MAX_FAILURES_PER_IP = 20;

/** What a sign-in attempt is counted against in the audit log. */
export type SignInSubject = { entityType: "user" | "sign_in"; entityId: string };

/**
 * The account key: the user's id when the username exists, otherwise an HMAC of
 * the username — the attempted name itself is never stored (people sometimes
 * type their password into the username box).
 */
export function signInSubject(
  user: { id: string } | null,
  normalizedUsername: string,
  secret: string,
): SignInSubject {
  if (user) return { entityType: "user", entityId: user.id };
  const digest = createHmac("sha256", secret).update(`sign-in:${normalizedUsername}`).digest("hex");
  return { entityType: "sign_in", entityId: digest };
}

export type ThrottleDecision =
  { blocked: false } | { blocked: true; scope: "account" | "ip"; retryAfterSeconds: number };

type AuditReader = {
  auditLog: Pick<Prisma.TransactionClient["auditLog"], "findFirst" | "findMany">;
};

/** Actions after which an account's failed attempts no longer count. */
const COUNT_RESET_ACTIONS = ["auth.signed_in", "user.password_reset"];

export async function checkSignInThrottle(
  db: AuditReader,
  { subject, ipAddress, now }: { subject: SignInSubject; ipAddress: string | null; now: Date },
): Promise<ThrottleDecision> {
  const windowStart = new Date(now.getTime() - SIGN_IN_WINDOW_MS);

  const lastReset = await db.auditLog.findFirst({
    where: { ...subject, action: { in: COUNT_RESET_ACTIONS } },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  const since = lastReset && lastReset.createdAt > windowStart ? lastReset.createdAt : windowStart;

  const accountFailures = await db.auditLog.findMany({
    where: { ...subject, action: "auth.sign_in_failed", createdAt: { gt: since } },
    orderBy: { createdAt: "desc" },
    take: MAX_FAILURES_PER_ACCOUNT,
    select: { createdAt: true },
  });
  if (accountFailures.length >= MAX_FAILURES_PER_ACCOUNT) {
    return blockedUntil("account", accountFailures[MAX_FAILURES_PER_ACCOUNT - 1]!.createdAt, now);
  }

  if (ipAddress) {
    const ipFailures = await db.auditLog.findMany({
      where: { action: "auth.sign_in_failed", ipAddress, createdAt: { gt: windowStart } },
      orderBy: { createdAt: "desc" },
      take: MAX_FAILURES_PER_IP,
      select: { createdAt: true },
    });
    if (ipFailures.length >= MAX_FAILURES_PER_IP) {
      return blockedUntil("ip", ipFailures[MAX_FAILURES_PER_IP - 1]!.createdAt, now);
    }
  }

  return { blocked: false };
}

/** Blocked until the oldest counted failure leaves the window. */
function blockedUntil(scope: "account" | "ip", oldestCounted: Date, now: Date): ThrottleDecision {
  const until = oldestCounted.getTime() + SIGN_IN_WINDOW_MS;
  return {
    blocked: true,
    scope,
    retryAfterSeconds: Math.max(1, Math.ceil((until - now.getTime()) / 1000)),
  };
}

export class LockQueueFullError extends Error {
  constructor() {
    super("Too many sign-in attempts are waiting");
    this.name = "LockQueueFullError";
  }
}

/**
 * Runs sign-in attempts for the same account or IP address one at a time within
 * this server process, so a burst of parallel guesses can't all be checked
 * before the first failure is recorded. Queues are short; extra attempts are
 * turned away instead of waiting.
 */
export class KeyedLock {
  private readonly queues = new Map<string, { tail: Promise<void>; holders: number }>();

  constructor(private readonly maxQueue = 5) {}

  async run<T>(keys: readonly string[], task: () => Promise<T>): Promise<T> {
    // A fixed order means two attempts can never wait on each other.
    const ordered = [...new Set(keys)].sort();
    const releases: (() => void)[] = [];
    try {
      for (const key of ordered) releases.push(await this.acquire(key));
      return await task();
    } finally {
      for (const release of releases.reverse()) release();
    }
  }

  private async acquire(key: string): Promise<() => void> {
    const entry = this.queues.get(key) ?? { tail: Promise.resolve(), holders: 0 };
    if (entry.holders >= this.maxQueue) throw new LockQueueFullError();
    entry.holders += 1;
    this.queues.set(key, entry);

    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const previous = entry.tail;
    entry.tail = previous.then(() => released);
    await previous;

    return () => {
      entry.holders -= 1;
      if (entry.holders === 0) this.queues.delete(key);
      release();
    };
  }
}
