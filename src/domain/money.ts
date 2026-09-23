/**
 * Money is handled as whole paise (₹1 = 100 paise) so every calculation is
 * exact. The database stores rupees as numeric(12,2); convert only at the
 * boundary with `toPaise` / `fromPaise`. Never use floating-point rupees.
 */
export type Paise = number;

const MONEY_PATTERN = /^(-?)(\d+)(?:\.(\d{1,2}))?$/;

/** Parses a rupee amount ("5", "5.5", "1234.50", or a Prisma Decimal) into paise. */
export function toPaise(value: string | number | { toString(): string }): Paise {
  const text = typeof value === "string" ? value.trim() : value.toString();
  const match = MONEY_PATTERN.exec(text);
  if (!match) {
    throw new RangeError(`Not a rupee amount with at most 2 decimal places: "${text}"`);
  }
  const [, sign, rupees, fraction = ""] = match;
  const paise = Number(rupees) * 100 + Number(fraction.padEnd(2, "0"));
  return assertPaise(sign === "-" ? -paise : paise);
}

/** Formats paise as a rupee string for the database, e.g. 12345 → "123.45". */
export function fromPaise(paise: Paise): string {
  assertPaise(paise);
  const sign = paise < 0 ? "-" : "";
  const absolute = Math.abs(paise);
  return `${sign}${Math.trunc(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}

export function assertPaise(paise: Paise): Paise {
  if (!Number.isSafeInteger(paise)) {
    throw new RangeError(`Money must be a whole number of paise within safe range: ${paise}`);
  }
  return paise;
}

export function sumPaise(values: readonly Paise[]): Paise {
  return assertPaise(values.reduce((total, value) => total + assertPaise(value), 0));
}
