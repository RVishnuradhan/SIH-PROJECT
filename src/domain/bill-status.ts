import type { RentalStatus } from "@/generated/prisma/enums";

export type LineReturnTotals = {
  quantity: number;
  returnedQuantity: number;
  damagedQuantity: number;
  lostQuantity: number;
};

/** Pieces of a line still with the customer: quantity − returned − damaged − lost. */
export function pendingQuantity(line: LineReturnTotals): number {
  const pending = line.quantity - line.returnedQuantity - line.damagedQuantity - line.lostQuantity;
  if (pending < 0) throw new RangeError("More pieces accounted for than were taken");
  return pending;
}

/**
 * Rental status of a generated bill, derived from its line totals (A8):
 * nothing pending → RETURNED; some pieces accounted for → PARTIALLY_RETURNED;
 * otherwise ACTIVE. DRAFT and CANCELLED are set explicitly, never derived.
 */
export function deriveRentalStatus(
  lines: readonly LineReturnTotals[],
): Extract<RentalStatus, "ACTIVE" | "PARTIALLY_RETURNED" | "RETURNED"> {
  if (lines.length === 0) throw new RangeError("A generated bill has at least one line");
  if (lines.every((line) => pendingQuantity(line) === 0)) return "RETURNED";
  const accountedFor = lines.some(
    (line) => line.returnedQuantity + line.damagedQuantity + line.lostQuantity > 0,
  );
  return accountedFor ? "PARTIALLY_RETURNED" : "ACTIVE";
}
