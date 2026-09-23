/**
 * Two people at the yard working at the same moment must never rent out the
 * same pieces twice, return the same pieces twice, or lose a stock change.
 * These tests run real overlapping transactions on separate connections.
 */
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  expectNoDiscrepancies,
  generateBill,
  insertBusinessProfileV1,
  insertCounter,
  insertCustomer,
  insertDraftBill,
  insertReturn,
  insertUser,
  insertVariant,
  one,
  recordInitialStock,
  stockOf,
  type DraftLine,
} from "./support/fixtures";
import { createTestDatabase, type TestDatabase } from "./support/test-database";

let database: TestDatabase;
let customerId: string;
let businessProfileId: string;
const USER = "admin-1";

beforeAll(async () => {
  database = await createTestDatabase();
  await insertUser(database.pool, USER);
  await insertCounter(database.pool);
  businessProfileId = await insertBusinessProfileV1(database.pool);
  customerId = await insertCustomer(database.pool, USER);
});

afterAll(async () => {
  await database?.drop();
});

/** A variant with `quantity` pieces in the yard. */
async function stockedVariant(variantName: string, quantity: number): Promise<DraftLine> {
  const variantId = await insertVariant(database.pool, "Big Jockey", variantName, "10.00");
  await recordInitialStock(database.pool, variantId, quantity, USER);
  return { variantId, materialName: "Big Jockey", variantName, quantity: 0, ratePerDay: "10.00" };
}

function draft(lines: DraftLine[]) {
  return insertDraftBill(database.pool, {
    customerId,
    userId: USER,
    businessProfileId,
    takenAt: "2026-09-23T10:00:00+05:30",
    expectedDays: 10,
    lines,
  });
}

/** Runs `work` in its own transaction on its own connection; commits or rolls back. */
async function inTransaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await database.pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Waits until the given connection is blocked on another transaction's lock. */
async function waitUntilBlocked(pid: number) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const { rows } = await database.pool.query<{ wait_event_type: string | null }>(
      "SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1",
      [pid],
    );
    if (rows[0]?.wait_event_type === "Lock") return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Connection ${pid} never waited for a lock`);
}

function errorsOf(results: PromiseSettledResult<unknown>[]): string[] {
  return results.flatMap((result) =>
    result.status === "rejected" ? [String((result.reason as Error).message)] : [],
  );
}

describe("concurrent billing and stock", () => {
  it("lets only one of two bills take the last pieces; the second waits, then is refused", async () => {
    const line = await stockedVariant("16 Feet", 20);
    const first = await draft([{ ...line, quantity: 12 }]);
    const second = await draft([{ ...line, quantity: 12 }]);

    const t1 = await database.pool.connect();
    const t2 = await database.pool.connect();
    try {
      await t1.query("BEGIN");
      await generateBill(t1, first.billId, USER); // holds the variant's stock row

      await t2.query("BEGIN");
      const { pid } = await one<{ pid: number }>(t2, "SELECT pg_backend_pid() AS pid");
      const secondGeneration = generateBill(t2, second.billId, USER);
      secondGeneration.catch(() => {}); // observed below
      await waitUntilBlocked(pid);

      await t1.query("COMMIT");
      await expect(secondGeneration).rejects.toThrow(
        'violates check constraint "inventory_within_stock"',
      );
      await t2.query("ROLLBACK");
    } finally {
      t1.release();
      t2.release();
    }

    expect(await stockOf(database.pool, line.variantId)).toEqual({
      total: 20,
      rented: 12,
      held: 0,
    });
    const statuses = await database.pool.query<{ bill_number: string; status: string }>(
      "SELECT bill_number, status FROM bills WHERE id = ANY($1) ORDER BY bill_seq",
      [[first.billId, second.billId]],
    );
    expect(statuses.rows.map((row) => row.status)).toEqual(["ACTIVE", "DRAFT"]);
  });

  it("never oversells when ten bills race for the same 20 pieces", async () => {
    const line = await stockedVariant("18 Feet", 20);
    const drafts = [];
    for (let index = 0; index < 10; index++) drafts.push(await draft([{ ...line, quantity: 3 }]));

    const results = await Promise.allSettled(
      drafts.map((bill) => inTransaction((client) => generateBill(client, bill.billId, USER))),
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(6); // 6 × 3 = 18 ≤ 20
    expect(errorsOf(results)).toEqual(
      Array(4).fill(
        'new row for relation "inventory" violates check constraint "inventory_within_stock"',
      ),
    );
    expect(await stockOf(database.pool, line.variantId)).toEqual({
      total: 20,
      rented: 18,
      held: 0,
    });
  });

  it("does not deadlock when bills list the same materials in different orders", async () => {
    const a = await stockedVariant("A", 100);
    const b = await stockedVariant("B", 100);
    const drafts = [];
    for (let index = 0; index < 10; index++) {
      const lines = [
        { ...a, quantity: 2 },
        { ...b, quantity: 3 },
      ];
      drafts.push(await draft(index % 2 === 0 ? lines : lines.reverse()));
    }

    const results = await Promise.allSettled(
      drafts.map((bill) => inTransaction((client) => generateBill(client, bill.billId, USER))),
    );

    expect(errorsOf(results)).toEqual([]);
    expect(await stockOf(database.pool, a.variantId)).toEqual({ total: 100, rented: 20, held: 0 });
    expect(await stockOf(database.pool, b.variantId)).toEqual({ total: 100, rented: 30, held: 0 });
  });

  it("accepts only one of two returns of the same pieces submitted at once", async () => {
    const line = await stockedVariant("Return race", 10);
    const bill = await draft([{ ...line, quantity: 5 }]);
    await inTransaction((client) => generateBill(client, bill.billId, USER));
    const billItemId = bill.itemIds[0]!;

    const returnAll = (returnNo: number) =>
      inTransaction((client) =>
        insertReturn(client, {
          billId: bill.billId,
          returnNo,
          returnedAt: "2026-09-26T17:00:00+05:30",
          userId: USER,
          lines: [{ billItemId, condition: "GOOD", quantity: 5, chargeableDays: 3 }],
        }),
      );

    // Same batch number (a double-submitted form) and different ones (two people).
    const sameBatch = await Promise.allSettled([returnAll(1), returnAll(1)]);
    expect(sameBatch.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(errorsOf(sameBatch)).toEqual([
      'duplicate key value violates unique constraint "returns_bill_id_return_no_key"',
    ]);

    const nothingLeft = await Promise.allSettled([returnAll(2), returnAll(3)]);
    expect(nothingLeft.filter((result) => result.status === "fulfilled")).toHaveLength(0);
    expect(errorsOf(nothingLeft)).toEqual(
      Array(2).fill(
        'new row for relation "bill_items" violates check constraint "bill_items_returns_within_quantity"',
      ),
    );

    expect(await stockOf(database.pool, line.variantId)).toEqual({ total: 10, rented: 0, held: 0 });
    const item = await one<{ returned_quantity: number }>(
      database.pool,
      "SELECT returned_quantity FROM bill_items WHERE id = $1",
      [billItemId],
    );
    expect(item.returned_quantity).toBe(5);
  });

  it("refuses the second of two overlapping returns that together exceed what is out", async () => {
    const line = await stockedVariant("Partial race", 10);
    const bill = await draft([{ ...line, quantity: 6 }]);
    await inTransaction((client) => generateBill(client, bill.billId, USER));
    const billItemId = bill.itemIds[0]!;

    const results = await Promise.allSettled(
      [1, 2].map((returnNo) =>
        inTransaction((client) =>
          insertReturn(client, {
            billId: bill.billId,
            returnNo,
            returnedAt: "2026-09-25T09:00:00+05:30",
            userId: USER,
            lines: [
              { billItemId, condition: "GOOD", quantity: 3, chargeableDays: 2 },
              { billItemId, condition: "DAMAGED", quantity: 1, chargeableDays: 2, note: "Bent" },
            ],
          }),
        ),
      ),
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await stockOf(database.pool, line.variantId)).toEqual({ total: 10, rented: 2, held: 1 });
  });

  it("loses no stock change when many adjustments land at once", async () => {
    const line = await stockedVariant("Adjustments", 10);
    const add = Array.from({ length: 20 }, () =>
      database.pool.query(
        `INSERT INTO inventory_transactions (id, variant_id, type, total_delta, occurred_at, reason, created_by_id)
         VALUES (gen_random_uuid(), $1, 'MANUAL_ADJUSTMENT', 1, now(), 'Recount: found one more', $2)`,
        [line.variantId, USER],
      ),
    );
    expect(errorsOf(await Promise.allSettled(add))).toEqual([]);
    expect(await stockOf(database.pool, line.variantId)).toEqual({ total: 30, rented: 0, held: 0 });
  });

  it("never lets write-downs take stock below what is out on rent", async () => {
    const line = await stockedVariant("Write-downs", 5);
    const bill = await draft([{ ...line, quantity: 3 }]);
    await inTransaction((client) => generateBill(client, bill.billId, USER));

    const remove = Array.from({ length: 5 }, () =>
      database.pool.query(
        `INSERT INTO inventory_transactions (id, variant_id, type, total_delta, occurred_at, reason, created_by_id)
         VALUES (gen_random_uuid(), $1, 'MANUAL_ADJUSTMENT', -1, now(), 'Recount: one missing', $2)`,
        [line.variantId, USER],
      ),
    );
    const results = await Promise.allSettled(remove);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    expect(errorsOf(results)).toEqual(
      Array(3).fill(
        'new row for relation "inventory" violates check constraint "inventory_within_stock"',
      ),
    );
    expect(await stockOf(database.pool, line.variantId)).toEqual({ total: 3, rented: 3, held: 0 });
  });

  it("leaves the counters equal to the ledger afterwards", async () => {
    expect(await expectNoDiscrepancies(database.pool)).toEqual({
      inventory_discrepancies: 0,
      rented_stock_discrepancies: 0,
      bill_item_return_discrepancies: 0,
    });
  });
});
