/**
 * Money on a bill (A2, A7, A8, PRD §37–§39): the `bill_financials` view and the
 * domain calculation must always agree, and the rental and settlement statuses
 * derived from them must follow the approved rules — through advances, batch
 * returns, damaged pieces, promised payments, discounts, refunds and voids.
 *
 * The rates (₹5 and ₹8 per day) are the PRD's worked-example numbers, used only
 * in this throw-away test database; the real catalog has no rates yet (A15).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deriveRentalStatus } from "@/domain/bill-status";
import { toPaise } from "@/domain/money";
import { batchAmount, billEstimate } from "@/domain/pricing";
import { chargeableDays } from "@/domain/rental-days";
import { deriveSettlementStatus, summarizeBillMoney, type BillMoney } from "@/domain/settlement";
import type {
  PaymentStatus,
  PaymentType,
  RentalStatus,
  SettlementStatus,
} from "@/generated/prisma/enums";

import {
  expectNoDiscrepancies,
  generateBill,
  insertBusinessProfileV1,
  insertCounter,
  insertCustomer,
  insertDraftBill,
  insertPayment,
  insertReturn,
  insertUser,
  insertVariant,
  one,
  recordInitialStock,
  stockOf,
  voidBill,
  voidReturn,
  type DraftLine,
  type ReturnLine,
} from "./support/fixtures";
import { createTestDatabase, type TestDatabase } from "./support/test-database";

let database: TestDatabase;
let customerId: string;
let businessProfileId: string;
let muttuMaram: DraftLine;
let runner: DraftLine;
const ADMIN = "admin-1";
const TAKEN_AT = "2026-09-23T10:00:00+05:30";

beforeAll(async () => {
  database = await createTestDatabase();
  await insertUser(database.pool, ADMIN);
  await insertCounter(database.pool);
  businessProfileId = await insertBusinessProfileV1(database.pool);
  customerId = await insertCustomer(database.pool, ADMIN);

  const muttuId = await insertVariant(database.pool, "Muttu Maram", "10 Feet", "5.00");
  const runnerId = await insertVariant(database.pool, "Runner", "10 Feet", "8.00");
  await recordInitialStock(database.pool, muttuId, 200, ADMIN);
  await recordInitialStock(database.pool, runnerId, 100, ADMIN);
  muttuMaram = {
    variantId: muttuId,
    materialName: "Muttu Maram",
    variantName: "10 Feet",
    quantity: 0,
    ratePerDay: "5.00",
  };
  runner = {
    variantId: runnerId,
    materialName: "Runner",
    variantName: "10 Feet",
    quantity: 0,
    ratePerDay: "8.00",
  };
});

afterAll(async () => {
  await database?.drop();
});

type Bill = { billId: string; billNumber: string; itemIds: string[] };

/** Saves and generates a bill, as the wizard does. */
async function rent(lines: DraftLine[], expectedDays: number): Promise<Bill> {
  const client = await database.pool.connect();
  try {
    await client.query("BEGIN");
    const bill = await insertDraftBill(client, {
      customerId,
      userId: ADMIN,
      businessProfileId,
      takenAt: TAKEN_AT,
      expectedDays,
      lines,
    });
    await generateBill(client, bill.billId, ADMIN);
    await client.query("COMMIT");
    return bill;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Processes one return batch; days and amounts come from the domain rules. */
async function returnBatch(
  bill: Bill,
  returnNo: number,
  returnedAt: string,
  lines: (Omit<ReturnLine, "billItemId" | "chargeableDays"> & { line: number })[],
): Promise<string> {
  const days = chargeableDays({ takenAt: new Date(TAKEN_AT), returnedAt: new Date(returnedAt) });
  const client = await database.pool.connect();
  try {
    await client.query("BEGIN");
    const returnId = await insertReturn(client, {
      billId: bill.billId,
      returnNo,
      returnedAt,
      userId: ADMIN,
      lines: lines.map(({ line, ...rest }) => ({
        ...rest,
        billItemId: bill.itemIds[line - 1]!,
        chargeableDays: days,
      })),
    });
    await client.query("COMMIT");

    // The amounts stored on the batch are exactly quantity × rate × days.
    const stored = await database.pool.query<{
      quantity: number;
      rate_per_day: string;
      amount: string;
    }>("SELECT quantity, rate_per_day, amount FROM return_items WHERE return_id = $1", [returnId]);
    for (const row of stored.rows) {
      expect(toPaise(row.amount)).toBe(
        batchAmount({
          quantity: row.quantity,
          ratePerDay: toPaise(row.rate_per_day),
          chargeableDays: days,
        }),
      );
    }
    return returnId;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function moneyFromView(billId: string): Promise<BillMoney> {
  const row = await one<Record<string, string>>(
    database.pool,
    "SELECT rental_charges, extra_charges, received, refunded, discounts, pending, balance FROM bill_financials WHERE bill_id = $1",
    [billId],
  );
  return {
    rentalCharges: toPaise(row.rental_charges!),
    extraCharges: toPaise(row.extra_charges!),
    received: toPaise(row.received!),
    refunded: toPaise(row.refunded!),
    discounts: toPaise(row.discounts!),
    pending: toPaise(row.pending!),
    balance: toPaise(row.balance!),
  };
}

async function moneyFromLedgers(billId: string): Promise<BillMoney> {
  const batches = await database.pool.query<{ amount: string }>(
    `SELECT ri.amount FROM return_items ri JOIN returns r ON r.id = ri.return_id
     WHERE r.bill_id = $1 AND r.voided_at IS NULL`,
    [billId],
  );
  const charges = await database.pool.query<{ amount: string }>(
    "SELECT amount FROM bill_charges WHERE bill_id = $1 AND voided_at IS NULL",
    [billId],
  );
  const payments = await database.pool.query<{
    type: PaymentType;
    status: PaymentStatus;
    amount: string;
  }>("SELECT type, status, amount FROM payments WHERE bill_id = $1", [billId]);
  return summarizeBillMoney({
    batchAmounts: batches.rows.map((row) => toPaise(row.amount)),
    charges: charges.rows.map((row) => toPaise(row.amount)),
    payments: payments.rows.map((row) => ({
      type: row.type,
      status: row.status,
      amount: toPaise(row.amount),
    })),
  });
}

/**
 * What the return and payment services do after every change: re-derive both
 * statuses and store them. Returns them with the money, in rupees.
 */
async function refresh(bill: Bill) {
  const current = await one<{ status: RentalStatus; generated_at: Date | null }>(
    database.pool,
    "SELECT status, generated_at FROM bills WHERE id = $1",
    [bill.billId],
  );
  let status = current.status;
  if (status !== "DRAFT" && status !== "CANCELLED") {
    const lines = await database.pool.query<{
      quantity: number;
      returned_quantity: number;
      damaged_quantity: number;
      lost_quantity: number;
    }>(
      "SELECT quantity, returned_quantity, damaged_quantity, lost_quantity FROM bill_items WHERE bill_id = $1",
      [bill.billId],
    );
    status = deriveRentalStatus(
      lines.rows.map((line) => ({
        quantity: line.quantity,
        returnedQuantity: line.returned_quantity,
        damagedQuantity: line.damaged_quantity,
        lostQuantity: line.lost_quantity,
      })),
    );
  }

  const money = await moneyFromView(bill.billId);
  expect(money).toEqual(await moneyFromLedgers(bill.billId));
  const settlement: SettlementStatus = deriveSettlementStatus({
    rentalStatus: status,
    wasGenerated: current.generated_at !== null,
    money,
  });

  await database.pool.query(
    `UPDATE bills SET status = $2, settlement_status = $3, version = version + 1, updated_at = now() WHERE id = $1`,
    [bill.billId, status, settlement],
  );
  const rupees = (paise: number) => paise / 100;
  return {
    status,
    settlement,
    charges: rupees(money.rentalCharges),
    received: rupees(money.received),
    refunded: rupees(money.refunded),
    discounts: rupees(money.discounts),
    pending: rupees(money.pending),
    balance: rupees(money.balance),
  };
}

describe("settlement", () => {
  it("follows the worked example: ₹590 rent, ₹500 advance, ₹90 due, then settled", async () => {
    const bill = await rent(
      [
        { ...muttuMaram, quantity: 20 },
        { ...runner, quantity: 10 },
      ],
      2,
    );
    expect(bill.billNumber).toBe("SMS-000001");
    const estimate = await one<{ estimated_amount: string }>(
      database.pool,
      "SELECT estimated_amount FROM bills WHERE id = $1",
      [bill.billId],
    );
    expect(toPaise(estimate.estimated_amount)).toBe(
      billEstimate(
        [
          { quantity: 20, ratePerDay: 500 },
          { quantity: 10, ratePerDay: 800 },
        ],
        2,
      ),
    );
    expect(estimate.estimated_amount).toBe("360.00");

    await insertPayment(database.pool, {
      billId: bill.billId,
      userId: ADMIN,
      type: "ADVANCE",
      amount: "500.00",
    });
    // Materials are out: nothing is settled until they all come back (A2).
    expect(await refresh(bill)).toMatchObject({
      status: "ACTIVE",
      settlement: "NO_DUE",
      charges: 0,
      received: 500,
    });

    await returnBatch(bill, 1, "2026-09-26T17:30:00+05:30", [
      { line: 1, condition: "GOOD", quantity: 15 },
      { line: 2, condition: "GOOD", quantity: 10 },
    ]);
    expect(await refresh(bill)).toMatchObject({
      status: "PARTIALLY_RETURNED",
      settlement: "NO_DUE",
      charges: 465,
    });

    await returnBatch(bill, 2, "2026-09-28T09:00:00+05:30", [
      { line: 1, condition: "GOOD", quantity: 3 },
      { line: 1, condition: "DAMAGED", quantity: 2, note: "two props bent" },
    ]);
    expect(await refresh(bill)).toEqual({
      status: "RETURNED",
      settlement: "ADDITIONAL_DUE",
      charges: 590,
      received: 500,
      refunded: 0,
      discounts: 0,
      pending: 0,
      balance: 90,
    });

    // V1: damaged pieces pay normal rent to the return date, and nothing more.
    expect(
      (await one<{ count: string }>(database.pool, "SELECT count(*) FROM bill_charges")).count,
    ).toBe("0");
    expect(await stockOf(database.pool, muttuMaram.variantId)).toEqual({
      total: 200,
      rented: 0,
      held: 2,
    });
    expect(await stockOf(database.pool, runner.variantId)).toEqual({
      total: 100,
      rented: 0,
      held: 0,
    });

    await database.pool.query(
      `INSERT INTO payments (id, bill_id, type, status, amount, method, transaction_reference, received_at,
                             idempotency_key, recorded_by_id)
       VALUES (gen_random_uuid(), $1, 'ADDITIONAL', 'COMPLETED', 90, 'UPI', 'UPI-REF-0001', now(), gen_random_uuid(), $2)`,
      [bill.billId, ADMIN],
    );
    expect(await refresh(bill)).toMatchObject({
      status: "RETURNED",
      settlement: "SETTLED",
      balance: 0,
    });
  });

  it("shows a refund when the advance was more than the rent (PRD §37: ₹500 − ₹350 = ₹150)", async () => {
    const bill = await rent([{ ...muttuMaram, quantity: 10 }], 5);
    await insertPayment(database.pool, {
      billId: bill.billId,
      userId: ADMIN,
      type: "ADVANCE",
      amount: "500.00",
    });
    await returnBatch(bill, 1, "2026-09-30T11:00:00+05:30", [
      { line: 1, condition: "GOOD", quantity: 10 },
    ]); // 7 days

    expect(await refresh(bill)).toMatchObject({
      status: "RETURNED",
      settlement: "REFUND_DUE",
      charges: 350,
      balance: -150,
    });

    await insertPayment(database.pool, {
      billId: bill.billId,
      userId: ADMIN,
      type: "REFUND",
      amount: "150.00",
    });
    expect(await refresh(bill)).toMatchObject({ settlement: "SETTLED", refunded: 150, balance: 0 });
  });

  it("shows the extra amount when the rent was more than the advance (PRD §38: ₹650 − ₹500 = ₹150)", async () => {
    const bill = await rent([{ ...muttuMaram, quantity: 13 }], 7);
    await insertPayment(database.pool, {
      billId: bill.billId,
      userId: ADMIN,
      type: "ADVANCE",
      amount: "500.00",
    });
    await returnBatch(bill, 1, "2026-10-03T08:00:00+05:30", [
      { line: 1, condition: "GOOD", quantity: 13 },
    ]); // 10 days

    expect(await refresh(bill)).toMatchObject({
      settlement: "ADDITIONAL_DUE",
      charges: 650,
      balance: 150,
    });

    await insertPayment(database.pool, {
      billId: bill.billId,
      userId: ADMIN,
      type: "ADDITIONAL",
      amount: "150.00",
    });
    expect(await refresh(bill)).toMatchObject({ settlement: "SETTLED", received: 650, balance: 0 });
  });

  it("never counts a promised (“Payment Not Yet”) advance as received", async () => {
    const bill = await rent([{ ...runner, quantity: 5 }], 3);
    const paymentId = await insertPayment(database.pool, {
      billId: bill.billId,
      userId: ADMIN,
      type: "ADVANCE",
      status: "PENDING",
      amount: "300.00",
    });
    expect(await refresh(bill)).toMatchObject({
      status: "ACTIVE",
      settlement: "PAYMENT_PENDING",
      received: 0,
      pending: 300,
      balance: 0,
    });

    // The customer pays by UPI later: only now does it count.
    await database.pool.query(
      `UPDATE payments SET status = 'COMPLETED', method = 'UPI', transaction_reference = 'UPI-REF-0002',
                           received_at = now(), status_changed_at = now(), status_changed_by_id = $2
       WHERE id = $1`,
      [paymentId, ADMIN],
    );
    expect(await refresh(bill)).toMatchObject({
      settlement: "NO_DUE",
      received: 300,
      pending: 0,
      balance: -300,
    });

    await returnBatch(bill, 1, "2026-09-25T18:00:00+05:30", [
      { line: 1, condition: "GOOD", quantity: 5 },
    ]); // 2 days
    expect(await refresh(bill)).toMatchObject({
      status: "RETURNED",
      settlement: "REFUND_DUE",
      charges: 80,
      balance: -220,
    });
  });

  it("allows a ₹0 advance: nothing is owed until the materials come back", async () => {
    const bill = await rent([{ ...muttuMaram, quantity: 2 }], 1);
    expect(await refresh(bill)).toMatchObject({
      status: "ACTIVE",
      settlement: "NO_DUE",
      balance: 0,
    });
    await returnBatch(bill, 1, "2026-09-23T18:00:00+05:30", [
      { line: 1, condition: "GOOD", quantity: 2 },
    ]); // same day → 1
    expect(await refresh(bill)).toMatchObject({
      status: "RETURNED",
      settlement: "ADDITIONAL_DUE",
      charges: 10,
      balance: 10,
    });
  });

  it("drops a voided return from the rent and puts the pieces back on the bill", async () => {
    const bill = await rent([{ ...muttuMaram, quantity: 10 }], 5);
    const wrong = await returnBatch(bill, 1, "2026-09-26T10:00:00+05:30", [
      { line: 1, condition: "GOOD", quantity: 10 },
    ]);
    expect(await refresh(bill)).toMatchObject({ status: "RETURNED", charges: 150 });
    const rentedBefore = (await stockOf(database.pool, muttuMaram.variantId)).rented;

    await voidReturn(database.pool, wrong, ADMIN, "Entered on the wrong date");
    expect(await refresh(bill)).toMatchObject({
      status: "ACTIVE",
      settlement: "NO_DUE",
      charges: 0,
    });
    expect((await stockOf(database.pool, muttuMaram.variantId)).rented).toBe(rentedBefore + 10);

    await returnBatch(bill, 2, "2026-09-27T10:00:00+05:30", [
      { line: 1, condition: "GOOD", quantity: 10 },
    ]);
    expect(await refresh(bill)).toMatchObject({
      status: "RETURNED",
      settlement: "ADDITIONAL_DUE",
      charges: 200,
    });
  });

  it("lets an admin discount close the balance (A9)", async () => {
    const bill = await rent([{ ...muttuMaram, quantity: 10 }], 3);
    await insertPayment(database.pool, {
      billId: bill.billId,
      userId: ADMIN,
      type: "ADVANCE",
      amount: "100.00",
    });
    await returnBatch(bill, 1, "2026-09-26T10:00:00+05:30", [
      { line: 1, condition: "GOOD", quantity: 10 },
    ]);
    expect(await refresh(bill)).toMatchObject({ settlement: "ADDITIONAL_DUE", balance: 50 });

    await insertPayment(database.pool, {
      billId: bill.billId,
      userId: ADMIN,
      type: "DISCOUNT",
      amount: "50.00",
      note: "Regular customer, rounded off",
    });
    expect(await refresh(bill)).toMatchObject({ settlement: "SETTLED", discounts: 50, balance: 0 });
  });

  it("shows the advance as a refund when an admin voids a generated bill (A6)", async () => {
    const before = await stockOf(database.pool, runner.variantId);
    const bill = await rent([{ ...runner, quantity: 4 }], 2);
    await insertPayment(database.pool, {
      billId: bill.billId,
      userId: ADMIN,
      type: "ADVANCE",
      amount: "200.00",
    });
    await insertPayment(database.pool, {
      billId: bill.billId,
      userId: ADMIN,
      type: "ADDITIONAL",
      status: "PENDING",
      amount: "50.00",
    });

    await voidBill(database.pool, bill.billId, ADMIN, "Customer cancelled the order at the yard");
    expect(await refresh(bill)).toMatchObject({
      status: "CANCELLED",
      settlement: "REFUND_DUE",
      pending: 0,
      balance: -200,
    });
    expect(await stockOf(database.pool, runner.variantId)).toEqual(before);

    await insertPayment(database.pool, {
      billId: bill.billId,
      userId: ADMIN,
      type: "REFUND",
      amount: "200.00",
    });
    expect(await refresh(bill)).toMatchObject({
      status: "CANCELLED",
      settlement: "SETTLED",
      balance: 0,
    });
    const kept = await one<{ bill_number: string }>(
      database.pool,
      "SELECT bill_number FROM bills WHERE id = $1",
      [bill.billId],
    );
    expect(kept.bill_number).toBe(bill.billNumber);
  });

  it("owes nothing on a cancelled draft", async () => {
    const draft = await insertDraftBill(database.pool, {
      customerId,
      userId: ADMIN,
      businessProfileId,
      takenAt: TAKEN_AT,
      expectedDays: 2,
      lines: [{ ...runner, quantity: 1 }],
    });
    await database.pool.query(
      `UPDATE bills SET status = 'CANCELLED', cancelled_at = now(), cancelled_by_id = $2 WHERE id = $1`,
      [draft.billId, ADMIN],
    );
    expect(await refresh(draft)).toMatchObject({
      status: "CANCELLED",
      settlement: "NO_DUE",
      balance: 0,
    });
  });

  it("agrees with the domain calculation on every bill, and the ledgers stay consistent", async () => {
    const bills = await database.pool.query<{ id: string }>("SELECT id FROM bills");
    expect(bills.rows.length).toBe(9);
    for (const { id } of bills.rows) {
      expect(await moneyFromView(id)).toEqual(await moneyFromLedgers(id));
    }
    expect(await expectNoDiscrepancies(database.pool)).toEqual({
      inventory_discrepancies: 0,
      rented_stock_discrepancies: 0,
      bill_item_return_discrepancies: 0,
    });
  });
});
