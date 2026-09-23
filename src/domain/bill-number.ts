/** Bill numbers: "SMS-" + the sequence padded to 6 digits, widening after 999999 (A4). */
export const BILL_NUMBER_PREFIX = "SMS-";
const MIN_DIGITS = 6;

export function formatBillNumber(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new RangeError(`Bill sequence must be a positive whole number: ${sequence}`);
  }
  return `${BILL_NUMBER_PREFIX}${String(sequence).padStart(MIN_DIGITS, "0")}`;
}

/**
 * Reads a bill number the way staff type it — "SMS-000124", "sms124", "sms 124"
 * or just "124" — and returns its sequence, or null if it isn't a bill number.
 */
export function parseBillNumber(input: string): number | null {
  const match = /^(?:sms[\s-]*)?0*(\d{1,15})$/i.exec(input.trim());
  if (!match) return null;
  const sequence = Number(match[1]);
  return Number.isSafeInteger(sequence) && sequence >= 1 ? sequence : null;
}
