/**
 * Bill numbers (decision A4): taken when a draft is first saved, consecutive,
 * never skipped by a failed save and never reused — also when several people
 * save drafts at the same moment.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Prisma } from "@/generated/prisma/client";
import { allocateBillNumber } from "@/modules/billing/bill-number";

import {
  insertBusinessProfileV1,
  insertCounter,
  insertCustomer,
  insertUser,
} from "./support/fixtures";
import { createTestDatabase, type TestDatabase } from "./support/test-database";

let database: TestDatabase;
let customerId: string;
let businessProfileId: string;

// Long enough for 30 saves queued on the counter's row lock.
const TX_OPTIONS = { maxWait: 30_000, timeout: 30_000 };

beforeAll(async () => {
  database = await createTestDatabase();
  await insertUser(database.pool, "staff-1", "staff");
  businessProfileId = await insertBusinessProfileV1(database.pool);
  customerId = await insertCustomer(database.pool, "staff-1");
});

afterAll(async () => {
  await database?.drop();
});

/** What the draft service will do in one transaction: take a number, save the draft. */
async function saveDraft(tx: Prisma.TransactionClient) {
  const { billSeq, billNumber } = await allocateBillNumber(tx);
  await tx.bill.create({
    data: {
      billSeq,
      billNumber,
      customerId,
      takenAt: new Date("2026-09-23T04:30:00Z"),
      expectedDays: 10,
      expectedReturnDate: new Date("2026-10-03T00:00:00Z"),
      siteLocation: "Perundurai",
      customerName: "Shanjiv",
      customerPhone: "9865276111",
      customerLocation: "Kunnathur",
      businessProfileId,
      createdById: "staff-1",
    },
  });
  return billNumber;
}

class SaveFailed extends Error {}

async function billNumbers(): Promise<string[]> {
  const bills = await database
    .prisma()
    .bill.findMany({ orderBy: { billSeq: "asc" }, select: { billNumber: true } });
  return bills.map((bill) => bill.billNumber);
}

async function counterValue(): Promise<number> {
  const counter = await database
    .prisma()
    .counter.findUniqueOrThrow({ where: { key: "bill_number" } });
  return counter.value;
}

describe("bill number allocation", () => {
  it("explains what to do when the counter has not been seeded", async () => {
    await expect(database.prisma().$transaction((tx) => allocateBillNumber(tx))).rejects.toThrow(
      'The "bill_number" counter is missing — run the database seed',
    );
    await insertCounter(database.pool);
  });

  it("starts at SMS-000001 and counts up one at a time", async () => {
    const prisma = database.prisma();
    expect(await prisma.$transaction(saveDraft)).toBe("SMS-000001");
    expect(await prisma.$transaction(saveDraft)).toBe("SMS-000002");
    expect(await prisma.$transaction(saveDraft)).toBe("SMS-000003");
    expect(await billNumbers()).toEqual(["SMS-000001", "SMS-000002", "SMS-000003"]);
  });

  it("does not use up a number when the save fails", async () => {
    const prisma = database.prisma();
    await expect(
      prisma.$transaction(async (tx) => {
        expect(await saveDraft(tx)).toBe("SMS-000004");
        throw new SaveFailed("customer check failed after numbering");
      }),
    ).rejects.toThrow(SaveFailed);

    expect(await counterValue()).toBe(3);
    expect(await prisma.$transaction(saveDraft)).toBe("SMS-000004");
  });

  it("gives concurrent saves consecutive numbers, with no gaps from the ones that fail", async () => {
    const prisma = database.prisma();
    const attempts = Array.from({ length: 30 }, (_, index) =>
      prisma.$transaction(async (tx) => {
        const billNumber = await saveDraft(tx);
        if (index % 3 === 0) throw new SaveFailed(`save ${index} failed`);
        return billNumber;
      }, TX_OPTIONS),
    );
    const results = await Promise.allSettled(attempts);

    const saved = results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    const failed = results.filter((result) => result.status === "rejected");
    expect(saved).toHaveLength(20);
    expect(failed.every((result) => result.reason instanceof SaveFailed)).toBe(true);

    // Numbers 5–24, each exactly once, whatever order the saves finished in.
    const expected = Array.from(
      { length: 20 },
      (_, index) => `SMS-${String(index + 5).padStart(6, "0")}`,
    );
    expect([...saved].sort()).toEqual(expected);
    expect(await billNumbers()).toEqual([
      "SMS-000001",
      "SMS-000002",
      "SMS-000003",
      "SMS-000004",
      ...expected,
    ]);
    expect(await counterValue()).toBe(24);
  });

  it("widens past SMS-999999 instead of truncating", async () => {
    await database.pool.query(`UPDATE counters SET value = 999999 WHERE key = 'bill_number'`);
    expect(await database.prisma().$transaction(saveDraft)).toBe("SMS-1000000");
  });

  it("can never move backwards, so a number is never handed out twice", async () => {
    await expect(
      database.pool.query(`UPDATE counters SET value = 5 WHERE key = 'bill_number'`),
    ).rejects.toThrow("Counter bill_number can only move forward");
    await expect(database.pool.query(`DELETE FROM counters`)).rejects.toThrow(
      "Counters are never deleted",
    );
    await expect(
      database.pool.query(`UPDATE bills SET bill_number = 'SMS-000099' WHERE bill_seq = 1`),
    ).rejects.toThrow("Bill number SMS-000001 can never change");
  });
});
