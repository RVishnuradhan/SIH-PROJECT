import { describe, expect, it } from "vitest";

import { deriveRentalStatus, pendingQuantity } from "@/domain/bill-status";

const line = (quantity: number, returned = 0, damaged = 0, lost = 0) => ({
  quantity,
  returnedQuantity: returned,
  damagedQuantity: damaged,
  lostQuantity: lost,
});

describe("rental status (A8)", () => {
  it("counts pending pieces (PRD §33: taken 20, returned 15 → pending 5)", () => {
    expect(pendingQuantity(line(20, 15))).toBe(5);
    expect(pendingQuantity(line(20, 3, 1, 1))).toBe(15);
  });

  it("is ACTIVE while nothing has come back", () => {
    expect(deriveRentalStatus([line(20), line(10)])).toBe("ACTIVE");
  });

  it("is PARTIALLY_RETURNED once some pieces are accounted for", () => {
    expect(deriveRentalStatus([line(20, 15), line(10)])).toBe("PARTIALLY_RETURNED");
    expect(deriveRentalStatus([line(20, 0, 0, 1), line(10)])).toBe("PARTIALLY_RETURNED");
  });

  it("is RETURNED when every piece is returned, damaged or lost", () => {
    expect(deriveRentalStatus([line(20, 18, 2), line(10, 10)])).toBe("RETURNED");
    expect(deriveRentalStatus([line(5, 0, 0, 5)])).toBe("RETURNED");
  });

  it("refuses impossible totals and empty bills", () => {
    expect(() => pendingQuantity(line(5, 4, 2))).toThrow(RangeError);
    expect(() => deriveRentalStatus([])).toThrow(RangeError);
  });
});
