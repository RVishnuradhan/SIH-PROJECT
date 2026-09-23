import { describe, expect, it } from "vitest";

import { fromPaise, sumPaise, toPaise } from "@/domain/money";

describe("money in paise", () => {
  it.each([
    ["5", 500],
    ["5.5", 550],
    ["5.50", 550],
    ["0.05", 5],
    ["1234.99", 123_499],
    ["-90.00", -9_000],
    [" 12.3 ", 1_230],
  ])("reads %j as %i paise", (input, paise) => {
    expect(toPaise(input)).toBe(paise);
  });

  it("reads Decimal-like values through toString()", () => {
    expect(toPaise({ toString: () => "225.00" })).toBe(22_500);
  });

  it.each(["", "abc", "1.234", "1,000", "1e3", "₹5"])("rejects %j", (input) => {
    expect(() => toPaise(input)).toThrow(RangeError);
  });

  it("writes paise back as a two-decimal rupee string", () => {
    expect(fromPaise(59_000)).toBe("590.00");
    expect(fromPaise(5)).toBe("0.05");
    expect(fromPaise(-9_000)).toBe("-90.00");
    expect(fromPaise(0)).toBe("0.00");
  });

  it("round-trips without floating-point error", () => {
    // 0.1 + 0.2 !== 0.3 in floating point; in paise it is exact.
    expect(fromPaise(sumPaise([toPaise("0.10"), toPaise("0.20")]))).toBe("0.30");
  });

  it("refuses fractional paise", () => {
    expect(() => fromPaise(1.5)).toThrow(RangeError);
    expect(() => sumPaise([1, 0.5])).toThrow(RangeError);
  });
});
