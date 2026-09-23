import { describe, expect, it } from "vitest";

import { normalizeIndianMobile } from "@/domain/phone";

describe("Indian mobile normalisation (A10)", () => {
  it.each([
    "+91 98652 76111",
    "09865276111",
    "9865276111",
    "+91-98652-76111",
    "919865276111",
    "0091 98652 76111",
    "091 9865276111",
    "(+91) 98652.76111",
  ])("normalises %j to 9865276111", (input) => {
    expect(normalizeIndianMobile(input)).toBe("9865276111");
  });

  it("keeps a valid number that happens to start with 91", () => {
    expect(normalizeIndianMobile("9198765432")).toBe("9198765432");
  });

  it.each([
    "",
    "98652",
    "5865276111", // Indian mobiles start with 6–9
    "98652761111", // 11 digits without a leading 0
    "+1 415 555 0100", // another country
    "+44 9865276111",
    "98652 7611a",
    "0421 2345678", // landline
  ])("rejects %j", (input) => {
    expect(normalizeIndianMobile(input)).toBeNull();
  });
});
