import { describe, expect, it } from "vitest";

import {
  addDays,
  calendarDate,
  chargeableDays,
  daysBetween,
  expectedReturnDate,
  fromDbDate,
  isOverdue,
  toDbDate,
} from "@/domain/rental-days";

const ist = (text: string) => new Date(`${text}+05:30`);

describe("chargeable days (decision A1)", () => {
  it("counts calendar days: taken 23 Sep, returned 26 Sep = 3 days (PRD §36)", () => {
    expect(
      chargeableDays({ takenAt: ist("2026-09-23T10:00"), returnedAt: ist("2026-09-26T17:30") }),
    ).toBe(3);
  });

  it("ignores the time of day", () => {
    const takenAt = ist("2026-09-23T18:00");
    expect(chargeableDays({ takenAt, returnedAt: ist("2026-09-26T09:00") })).toBe(3);
    expect(chargeableDays({ takenAt, returnedAt: ist("2026-09-26T23:59") })).toBe(3);
  });

  it("charges at least 1 day for a same-day return", () => {
    const takenAt = ist("2026-09-23T08:00");
    expect(chargeableDays({ takenAt, returnedAt: ist("2026-09-23T19:00") })).toBe(1);
    expect(chargeableDays({ takenAt, returnedAt: takenAt })).toBe(1);
  });

  it("uses Indian dates, not UTC: a 00:30 IST return counts as the new day", () => {
    // 26 Sep 00:30 IST is still 25 Sep in UTC — UTC dates would under-charge.
    expect(
      chargeableDays({ takenAt: ist("2026-09-23T10:00"), returnedAt: ist("2026-09-26T00:30") }),
    ).toBe(3);
  });

  it("works across months and years", () => {
    expect(
      chargeableDays({ takenAt: ist("2026-12-30T12:00"), returnedAt: ist("2027-01-02T12:00") }),
    ).toBe(3);
    expect(
      chargeableDays({ takenAt: ist("2028-02-28T12:00"), returnedAt: ist("2028-03-01T12:00") }),
    ).toBe(2);
  });

  it("refuses a return earlier than the taking time", () => {
    expect(() =>
      chargeableDays({ takenAt: ist("2026-09-23T10:00"), returnedAt: ist("2026-09-23T09:59") }),
    ).toThrow(RangeError);
  });
});

describe("calendar helpers", () => {
  it("gives the IST calendar date of an instant", () => {
    expect(calendarDate(new Date("2026-09-25T19:00:00Z"))).toBe("2026-09-26");
    expect(calendarDate(new Date("2026-09-25T18:29:59Z"))).toBe("2026-09-25");
  });

  it("adds and subtracts calendar days", () => {
    expect(daysBetween("2026-09-23", "2026-09-28")).toBe(5);
    expect(daysBetween("2026-09-28", "2026-09-23")).toBe(-5);
    expect(addDays("2026-09-30", 2)).toBe("2026-10-02");
  });

  it("rejects dates that don't exist", () => {
    expect(() => daysBetween("2026-02-30", "2026-03-01")).toThrow(RangeError);
    expect(() => daysBetween("23-09-2026", "2026-09-24")).toThrow(RangeError);
  });

  it("computes the expected return date from the taking date", () => {
    expect(expectedReturnDate(ist("2026-09-23T10:00"), 2)).toBe("2026-09-25");
    expect(expectedReturnDate(ist("2026-09-23T23:45"), 1)).toBe("2026-09-24");
    expect(() => expectedReturnDate(ist("2026-09-23T10:00"), 0)).toThrow(RangeError);
  });

  it("is overdue only from the day after the expected return date (A16)", () => {
    expect(isOverdue("2026-09-25", ist("2026-09-25T23:59"))).toBe(false);
    expect(isOverdue("2026-09-25", ist("2026-09-26T00:01"))).toBe(true);
  });

  it("maps calendar dates to and from @db.Date values", () => {
    const value = toDbDate("2026-09-25");
    expect(value.toISOString()).toBe("2026-09-25T00:00:00.000Z");
    expect(fromDbDate(value)).toBe("2026-09-25");
  });
});
