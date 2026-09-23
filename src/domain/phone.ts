/**
 * Indian mobile numbers are stored normalised to their 10 digits (decision A10):
 * "+91 98652 76111", "091-9865276111", "09865276111" and "9865276111" all become
 * "9865276111". Phone numbers are not unique; this is only about format.
 */
const MOBILE = /^[6-9]\d{9}$/;

export function normalizeIndianMobile(input: string): string | null {
  const compact = input.trim().replace(/[\s\-().]/g, "");
  if (!/^\+?\d+$/.test(compact)) return null;

  let digits = compact.replace(/^\+/, "");
  if (compact.startsWith("+")) {
    if (!digits.startsWith("91")) return null; // another country's number
    digits = digits.slice(2);
  } else if (digits.length === 14 && digits.startsWith("0091")) {
    digits = digits.slice(4);
  } else if (digits.length === 13 && digits.startsWith("091")) {
    digits = digits.slice(3);
  } else if (digits.length === 12 && digits.startsWith("91")) {
    digits = digits.slice(2);
  } else if (digits.length === 11 && digits.startsWith("0")) {
    digits = digits.slice(1);
  }
  return MOBILE.test(digits) ? digits : null;
}
