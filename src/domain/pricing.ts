import { assertPaise, sumPaise, type Paise } from "@/domain/money";

function assertWholeAtLeast(name: string, value: number, minimum: number) {
  if (!Number.isInteger(value) || value < minimum) {
    throw new RangeError(`${name} must be a whole number of at least ${minimum}: ${value}`);
  }
}

function assertRate(ratePerDay: Paise) {
  assertPaise(ratePerDay);
  if (ratePerDay < 0) throw new RangeError(`Rate per day can't be negative: ${ratePerDay}`);
}

/** Estimate for one bill line: quantity × rate per day × expected days (PRD §18). */
export function lineEstimate({
  quantity,
  ratePerDay,
  expectedDays,
}: {
  quantity: number;
  ratePerDay: Paise;
  expectedDays: number;
}): Paise {
  assertWholeAtLeast("Quantity", quantity, 1);
  assertWholeAtLeast("Expected days", expectedDays, 1);
  assertRate(ratePerDay);
  return assertPaise(quantity * ratePerDay * expectedDays);
}

/** Amount for one return batch line: quantity × rate per day × chargeable days (A2). */
export function batchAmount({
  quantity,
  ratePerDay,
  chargeableDays,
}: {
  quantity: number;
  ratePerDay: Paise;
  chargeableDays: number;
}): Paise {
  assertWholeAtLeast("Quantity", quantity, 1);
  assertWholeAtLeast("Chargeable days", chargeableDays, 1);
  assertRate(ratePerDay);
  return assertPaise(quantity * ratePerDay * chargeableDays);
}

/** Estimate for a whole bill: the sum of its line estimates. */
export function billEstimate(
  lines: readonly { quantity: number; ratePerDay: Paise }[],
  expectedDays: number,
): Paise {
  return sumPaise(lines.map((line) => lineEstimate({ ...line, expectedDays })));
}
