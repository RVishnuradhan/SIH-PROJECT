import { describe, expect, it } from "vitest";

import {
  checkSignInThrottle,
  KeyedLock,
  LockQueueFullError,
  MAX_FAILURES_PER_ACCOUNT,
  MAX_FAILURES_PER_IP,
  SIGN_IN_WINDOW_MS,
  signInSubject,
} from "@/modules/auth/throttle";

describe("signInSubject", () => {
  it("counts a known user's attempts under their id", () => {
    expect(signInSubject({ id: "user-1" }, "ravi", "secret")).toEqual({
      entityType: "user",
      entityId: "user-1",
    });
  });

  it("keys an unknown username by a keyed hash, never the name itself", () => {
    const subject = signInSubject(null, "my-password-typed-here", "secret");
    expect(subject.entityType).toBe("sign_in");
    expect(subject.entityId).toMatch(/^[0-9a-f]{64}$/);
    expect(subject.entityId).not.toContain("password");
    expect(signInSubject(null, "my-password-typed-here", "secret")).toEqual(subject);
    expect(signInSubject(null, "my-password-typed-here", "other-secret")).not.toEqual(subject);
  });
});

/** An in-memory stand-in for the audit log reads the throttle makes. */
function fakeAuditLog(
  rows: {
    action: string;
    entityType?: string;
    entityId?: string;
    ipAddress?: string;
    createdAt: Date;
  }[],
) {
  type Where = {
    action?: string | { in: string[] };
    entityType?: string;
    entityId?: string;
    ipAddress?: string;
    createdAt?: { gt: Date };
  };
  const matches = (where: Where) =>
    rows
      .filter((row) => {
        const action = where.action;
        if (typeof action === "string" && row.action !== action) return false;
        if (action && typeof action === "object" && !action.in.includes(row.action)) return false;
        if (where.entityType && row.entityType !== where.entityType) return false;
        if (where.entityId && row.entityId !== where.entityId) return false;
        if (where.ipAddress && row.ipAddress !== where.ipAddress) return false;
        if (where.createdAt && !(row.createdAt > where.createdAt.gt)) return false;
        return true;
      })
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return {
    auditLog: {
      findFirst: async ({ where }: { where: Where }) => matches(where)[0] ?? null,
      findMany: async ({ where, take }: { where: Where; take: number }) =>
        matches(where).slice(0, take),
    },
  } as never;
}

const NOW = new Date("2026-09-24T10:00:00Z");
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
const subject = { entityType: "user" as const, entityId: "user-1" };
const failure = (minutes: number, ip = "203.0.113.1") => ({
  action: "auth.sign_in_failed",
  ...subject,
  ipAddress: ip,
  createdAt: minutesAgo(minutes),
});

describe("checkSignInThrottle", () => {
  it("allows up to 4 recent failures", async () => {
    const db = fakeAuditLog([1, 2, 3, 4].map((m) => failure(m)));
    expect(await checkSignInThrottle(db, { subject, ipAddress: "203.0.113.1", now: NOW })).toEqual({
      blocked: false,
    });
  });

  it("blocks the account at 5 failures within 15 minutes, until the oldest drops out", async () => {
    const db = fakeAuditLog([1, 2, 3, 4, 10].map((m) => failure(m)));
    expect(await checkSignInThrottle(db, { subject, ipAddress: "198.51.100.1", now: NOW })).toEqual(
      {
        blocked: true,
        scope: "account",
        retryAfterSeconds: 5 * 60,
      },
    );
  });

  it("ignores failures older than 15 minutes", async () => {
    const db = fakeAuditLog([1, 2, 3, 4, 16, 20].map((m) => failure(m)));
    expect((await checkSignInThrottle(db, { subject, ipAddress: null, now: NOW })).blocked).toBe(
      false,
    );
  });

  it("starts counting again after a successful sign-in or a password reset", async () => {
    for (const reset of ["auth.signed_in", "user.password_reset"]) {
      const db = fakeAuditLog([
        ...[6, 7, 8, 9, 10].map((m) => failure(m)),
        { action: reset, ...subject, createdAt: minutesAgo(5) },
        failure(1),
      ]);
      expect((await checkSignInThrottle(db, { subject, ipAddress: null, now: NOW })).blocked).toBe(
        false,
      );
    }
  });

  it("blocks an address with 20 failures within 15 minutes, across accounts", async () => {
    const rows = Array.from({ length: MAX_FAILURES_PER_IP }, (_, index) => ({
      action: "auth.sign_in_failed",
      entityType: "sign_in",
      entityId: `hash-${index}`,
      ipAddress: "203.0.113.9",
      createdAt: minutesAgo(1 + index * 0.5),
    }));
    const db = fakeAuditLog(rows);
    const decision = await checkSignInThrottle(db, { subject, ipAddress: "203.0.113.9", now: NOW });
    expect(decision).toMatchObject({ blocked: true, scope: "ip" });
    expect(await checkSignInThrottle(db, { subject, ipAddress: "203.0.113.10", now: NOW })).toEqual(
      {
        blocked: false,
      },
    );
  });

  it("uses the documented limits", () => {
    expect(MAX_FAILURES_PER_ACCOUNT).toBe(5);
    expect(MAX_FAILURES_PER_IP).toBe(20);
    expect(SIGN_IN_WINDOW_MS).toBe(15 * 60 * 1000);
  });
});

describe("KeyedLock", () => {
  it("runs tasks for the same key one at a time, in order", async () => {
    const lock = new KeyedLock();
    const events: string[] = [];
    const task = (name: string, delay: number) =>
      lock.run(["key"], async () => {
        events.push(`start ${name}`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        events.push(`end ${name}`);
      });
    await Promise.all([task("a", 20), task("b", 1), task("c", 1)]);
    expect(events).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
  });

  it("runs tasks for different keys at the same time", async () => {
    const lock = new KeyedLock();
    let running = 0;
    let peak = 0;
    const task = (key: string) =>
      lock.run([key], async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 10));
        running -= 1;
      });
    await Promise.all([task("a"), task("b"), task("c")]);
    expect(peak).toBe(3);
  });

  it("turns work away once the queue for a key is full", async () => {
    const lock = new KeyedLock(2);
    let release!: () => void;
    const blocker = lock.run(["key"], () => new Promise<void>((resolve) => (release = resolve)));
    const waiting = lock.run(["key"], async () => "second");
    await expect(lock.run(["key"], async () => "third")).rejects.toBeInstanceOf(LockQueueFullError);
    release();
    await blocker;
    expect(await waiting).toBe("second");
    expect(await lock.run(["key"], async () => "later")).toBe("later");
  });

  it("releases the lock when a task fails", async () => {
    const lock = new KeyedLock();
    await expect(lock.run(["key"], async () => Promise.reject(new Error("boom")))).rejects.toThrow(
      "boom",
    );
    expect(await lock.run(["key"], async () => "next")).toBe("next");
  });
});
