import { describe, expect, it } from "vitest";

import {
  availableQuantity,
  availableStockPercent,
  isLowStock,
  stockShortage,
} from "@/domain/stock";

describe("stock rules", () => {
  it("available = total − rented − held (PRD §43: 200 − 42 = 158)", () => {
    expect(availableQuantity({ totalQuantity: 200, rentedQuantity: 42, heldQuantity: 0 })).toBe(
      158,
    );
    expect(availableQuantity({ totalQuantity: 200, rentedQuantity: 0, heldQuantity: 2 })).toBe(198);
  });

  it("refuses inconsistent counters", () => {
    expect(() =>
      availableQuantity({ totalQuantity: 10, rentedQuantity: 8, heldQuantity: 3 }),
    ).toThrow(RangeError);
  });

  it("reports the shortage the way PRD §16 shows it", () => {
    expect(stockShortage(30, 20)).toEqual({ requested: 30, available: 20, shortage: 10 });
    expect(stockShortage(15, 20).shortage).toBe(0);
  });

  it("flags low stock only when a threshold is set (A16)", () => {
    expect(isLowStock(8, 10)).toBe(true);
    expect(isLowStock(10, 10)).toBe(true);
    expect(isLowStock(11, 10)).toBe(false);
    expect(isLowStock(0, null)).toBe(false);
  });

  it("computes available stock % across variants (A16)", () => {
    const variants = [
      { totalQuantity: 200, rentedQuantity: 42, heldQuantity: 0 },
      { totalQuantity: 100, rentedQuantity: 10, heldQuantity: 2 },
    ];
    expect(availableStockPercent(variants)).toBeCloseTo((246 / 300) * 100, 10);
    expect(availableStockPercent([])).toBeNull();
  });
});
