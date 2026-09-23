import { describe, expect, it } from "vitest";

import { toPaise } from "@/domain/money";
import { batchAmount, billEstimate, lineEstimate } from "@/domain/pricing";

const rupees = toPaise;

describe("pricing", () => {
  it("estimates a line as quantity × rate × expected days (PRD §18: 20 × ₹5 × 2 = ₹200)", () => {
    expect(lineEstimate({ quantity: 20, ratePerDay: rupees("5"), expectedDays: 2 })).toBe(
      rupees("200"),
    );
  });

  it("estimates a bill as the sum of its lines (PRD §23: ₹200 + ₹160)", () => {
    const lines = [
      { quantity: 20, ratePerDay: rupees("5") },
      { quantity: 10, ratePerDay: rupees("8") },
    ];
    expect(billEstimate(lines, 2)).toBe(rupees("360"));
  });

  it("prices each return batch by its own days (A2: 15 × ₹5 × 3 + 5 × ₹5 × 5)", () => {
    const first = batchAmount({ quantity: 15, ratePerDay: rupees("5"), chargeableDays: 3 });
    const second = batchAmount({ quantity: 5, ratePerDay: rupees("5"), chargeableDays: 5 });
    expect(first).toBe(rupees("225"));
    expect(second).toBe(rupees("125"));
  });

  it("stays exact with paise rates", () => {
    expect(batchAmount({ quantity: 3, ratePerDay: rupees("2.35"), chargeableDays: 7 })).toBe(
      rupees("49.35"),
    );
  });

  it("allows a ₹0 rate but never a negative one", () => {
    expect(lineEstimate({ quantity: 4, ratePerDay: 0, expectedDays: 3 })).toBe(0);
    expect(() => lineEstimate({ quantity: 4, ratePerDay: -1, expectedDays: 3 })).toThrow(
      RangeError,
    );
  });

  it.each([
    { quantity: 0, ratePerDay: 500, chargeableDays: 1 },
    { quantity: 1.5, ratePerDay: 500, chargeableDays: 1 },
    { quantity: 1, ratePerDay: 500, chargeableDays: 0 },
    { quantity: 1, ratePerDay: 0.5, chargeableDays: 1 },
  ])("rejects invalid input %o", (input) => {
    expect(() => batchAmount(input)).toThrow(RangeError);
  });
});
