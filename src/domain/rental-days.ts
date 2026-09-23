import type { DayCountRule } from "@/generated/prisma/enums";

/** Business dates follow the Indian calendar (decision A1). */
export const BUSINESS_TIME_ZONE = "Asia/Kolkata";
export const DEFAULT_DAY_COUNT_RULE: DayCountRule = "CALENDAR_DAYS_MIN_1";

const MS_PER_DAY = 86_400_000;
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The calendar date ("YYYY-MM-DD") of an instant in the given time zone. */
export function calendarDate(instant: Date, timeZone: string = BUSINESS_TIME_ZONE): string {
  if (Number.isNaN(instant.getTime())) throw new RangeError("Invalid date");
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

function calendarDateToUtcMs(date: string): number {
  const match = CALENDAR_DATE.exec(date);
  if (!match) throw new RangeError(`Not a calendar date (YYYY-MM-DD): "${date}"`);
  const [, year, month, day] = match.map(Number) as [number, number, number, number];
  const ms = Date.UTC(year, month - 1, day);
  if (calendarDate(new Date(ms), "UTC") !== date) throw new RangeError(`No such date: "${date}"`);
  return ms;
}

/** Whole days from one calendar date to another (negative if `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((calendarDateToUtcMs(to) - calendarDateToUtcMs(from)) / MS_PER_DAY);
}

export function addDays(date: string, days: number): string {
  if (!Number.isInteger(days)) throw new RangeError(`Days must be a whole number: ${days}`);
  return calendarDate(new Date(calendarDateToUtcMs(date) + days * MS_PER_DAY), "UTC");
}

/**
 * Chargeable rental days for a batch (decision A1): the difference between the
 * return date and the taking date on the business calendar, minimum 1. Times
 * of day are recorded on the bill but never change the count.
 */
export function chargeableDays({
  takenAt,
  returnedAt,
  rule = DEFAULT_DAY_COUNT_RULE,
  timeZone = BUSINESS_TIME_ZONE,
}: {
  takenAt: Date;
  returnedAt: Date;
  rule?: DayCountRule;
  timeZone?: string;
}): number {
  if (returnedAt.getTime() < takenAt.getTime()) {
    throw new RangeError("A return can't be earlier than the taking date and time");
  }
  switch (rule) {
    case "CALENDAR_DAYS_MIN_1":
      return Math.max(
        1,
        daysBetween(calendarDate(takenAt, timeZone), calendarDate(returnedAt, timeZone)),
      );
  }
}

/** Expected return date: the taking date (business calendar) plus the expected days. */
export function expectedReturnDate(
  takenAt: Date,
  expectedDays: number,
  timeZone: string = BUSINESS_TIME_ZONE,
): string {
  if (!Number.isInteger(expectedDays) || expectedDays < 1) {
    throw new RangeError(`Expected days must be a whole number of at least 1: ${expectedDays}`);
  }
  return addDays(calendarDate(takenAt, timeZone), expectedDays);
}

/** Overdue from the day after the expected return date (decision A16). */
export function isOverdue(
  expectedReturn: string,
  now: Date,
  timeZone: string = BUSINESS_TIME_ZONE,
): boolean {
  return daysBetween(expectedReturn, calendarDate(now, timeZone)) > 0;
}

/**
 * A calendar date as the Date Prisma expects for a `@db.Date` column
 * (midnight UTC of that date), and back.
 */
export function toDbDate(date: string): Date {
  return new Date(calendarDateToUtcMs(date));
}

export function fromDbDate(value: Date): string {
  return calendarDate(value, "UTC");
}
