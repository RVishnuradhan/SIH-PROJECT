import "server-only";

import { formatBillNumber } from "@/domain/bill-number";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Takes the next bill number (decision A4). Must run inside the same
 * transaction that creates the draft bill: the counter row stays locked until
 * that transaction ends, so concurrent drafts get consecutive numbers, and a
 * failed save rolls the counter back — numbers are never skipped or reused.
 */
export async function allocateBillNumber(
  tx: Prisma.TransactionClient,
): Promise<{ billSeq: number; billNumber: string }> {
  const rows = await tx.$queryRaw<{ value: number }[]>`
    UPDATE counters SET value = value + 1, updated_at = now()
    WHERE key = 'bill_number'
    RETURNING value`;
  const row = rows[0];
  if (!row) throw new Error('The "bill_number" counter is missing — run the database seed');
  return { billSeq: row.value, billNumber: formatBillNumber(row.value) };
}
