import { describe, expect, it } from "vitest";

import { formatBillNumber, parseBillNumber } from "@/domain/bill-number";

describe("bill numbers (A4)", () => {
  it("formats SMS- plus six digits", () => {
    expect(formatBillNumber(1)).toBe("SMS-000001");
    expect(formatBillNumber(124)).toBe("SMS-000124");
    expect(formatBillNumber(999_999)).toBe("SMS-999999");
  });

  it("widens instead of truncating after SMS-999999", () => {
    expect(formatBillNumber(1_000_000)).toBe("SMS-1000000");
  });

  it.each([0, -1, 1.5, Number.NaN])("refuses sequence %s", (sequence) => {
    expect(() => formatBillNumber(sequence)).toThrow(RangeError);
  });

  it.each([
    ["SMS-000124", 124],
    ["sms-000124", 124],
    ["sms124", 124],
    ["SMS 124", 124],
    ["124", 124],
    ["  000124 ", 124],
    ["SMS-1000000", 1_000_000],
  ])("reads %j as sequence %i", (input, sequence) => {
    expect(parseBillNumber(input)).toBe(sequence);
  });

  it.each(["", "SMS-", "0", "SMS-0000", "ABC-124", "12a", "SMS-12-3"])("rejects %j", (input) => {
    expect(parseBillNumber(input)).toBeNull();
  });

  it("round-trips", () => {
    for (const sequence of [1, 42, 999_999, 1_234_567]) {
      expect(parseBillNumber(formatBillNumber(sequence))).toBe(sequence);
    }
  });
});
