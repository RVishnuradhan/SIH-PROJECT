import { describe, expect, it } from "vitest";

import { toPaise } from "@/domain/money";
import {
  deriveSettlementStatus,
  summarizeBillMoney,
  type LedgerPayment,
} from "@/domain/settlement";

const rupees = toPaise;
const pay = (
  type: LedgerPayment["type"],
  amount: string,
  status: LedgerPayment["status"] = "COMPLETED",
) => ({
  type,
  status,
  amount: rupees(amount),
});

describe("bill money from the ledgers (P5)", () => {
  it("worked example: ₹590 charged, ₹500 advance → ₹90 due", () => {
    const money = summarizeBillMoney({
      batchAmounts: [rupees("225"), rupees("240"), rupees("75"), rupees("50")],
      payments: [pay("ADVANCE", "500")],
    });
    expect(money).toMatchObject({
      rentalCharges: rupees("590"),
      received: rupees("500"),
      balance: rupees("90"),
    });
  });

  it("PRD §37: advance ₹500, actual ₹350 → refund ₹150 (negative balance)", () => {
    const money = summarizeBillMoney({
      batchAmounts: [rupees("350")],
      payments: [pay("ADVANCE", "500")],
    });
    expect(money.balance).toBe(-rupees("150"));
  });

  it("PRD §38: advance ₹500, actual ₹650 → ₹150 additional due", () => {
    const money = summarizeBillMoney({
      batchAmounts: [rupees("650")],
      payments: [pay("ADVANCE", "500")],
    });
    expect(money.balance).toBe(rupees("150"));
  });

  it("never counts pending or cancelled payments as received (A7)", () => {
    const money = summarizeBillMoney({
      batchAmounts: [rupees("100")],
      payments: [pay("ADVANCE", "500", "PENDING"), pay("ADDITIONAL", "40", "CANCELLED")],
    });
    expect(money).toMatchObject({ received: 0, pending: rupees("500"), balance: rupees("100") });
  });

  it("subtracts refunds from what was received and applies discounts", () => {
    const money = summarizeBillMoney({
      batchAmounts: [rupees("350")],
      charges: [rupees("20")],
      payments: [pay("ADVANCE", "500"), pay("REFUND", "150"), pay("DISCOUNT", "20")],
    });
    expect(money).toMatchObject({
      received: rupees("500"),
      refunded: rupees("150"),
      discounts: rupees("20"),
    });
    expect(money.balance).toBe(0);
  });
});

describe("settlement status (A8)", () => {
  const money = (balanceParts: { charges?: string; paid?: string; pending?: string }) =>
    summarizeBillMoney({
      batchAmounts: balanceParts.charges ? [rupees(balanceParts.charges)] : [],
      payments: [
        ...(balanceParts.paid ? [pay("ADVANCE", balanceParts.paid)] : []),
        ...(balanceParts.pending ? [pay("ADVANCE", balanceParts.pending, "PENDING")] : []),
      ],
    });

  it("drafts and cancelled drafts owe nothing", () => {
    expect(
      deriveSettlementStatus({ rentalStatus: "DRAFT", wasGenerated: false, money: money({}) }),
    ).toBe("NO_DUE");
    expect(
      deriveSettlementStatus({ rentalStatus: "CANCELLED", wasGenerated: false, money: money({}) }),
    ).toBe("NO_DUE");
  });

  it("while materials are out: PAYMENT_PENDING only for a promised payment, else NO_DUE (A2)", () => {
    expect(
      deriveSettlementStatus({
        rentalStatus: "ACTIVE",
        wasGenerated: true,
        money: money({ pending: "500" }),
      }),
    ).toBe("PAYMENT_PENDING");
    // Partial charges above the advance are not "due" until everything is back.
    expect(
      deriveSettlementStatus({
        rentalStatus: "PARTIALLY_RETURNED",
        wasGenerated: true,
        money: money({ charges: "600", paid: "500" }),
      }),
    ).toBe("NO_DUE");
  });

  it("after the final return: ADDITIONAL_DUE, REFUND_DUE or SETTLED by the balance", () => {
    const returned = (m: ReturnType<typeof money>) =>
      deriveSettlementStatus({ rentalStatus: "RETURNED", wasGenerated: true, money: m });
    expect(returned(money({ charges: "590", paid: "500" }))).toBe("ADDITIONAL_DUE");
    expect(returned(money({ charges: "350", paid: "500" }))).toBe("REFUND_DUE");
    expect(returned(money({ charges: "500", paid: "500" }))).toBe("SETTLED");
    // A returned bill whose advance was never received owes the full amount.
    expect(returned(money({ charges: "590", pending: "500" }))).toBe("ADDITIONAL_DUE");
  });

  it("a voided bill refunds what was paid, and owes nothing if nothing was paid", () => {
    const voided = (m: ReturnType<typeof money>) =>
      deriveSettlementStatus({ rentalStatus: "CANCELLED", wasGenerated: true, money: m });
    expect(voided(money({ paid: "500" }))).toBe("REFUND_DUE");
    expect(voided(money({}))).toBe("NO_DUE");
    expect(
      voided(
        summarizeBillMoney({
          batchAmounts: [],
          payments: [pay("ADVANCE", "500"), pay("REFUND", "500")],
        }),
      ),
    ).toBe("SETTLED");
  });
});
