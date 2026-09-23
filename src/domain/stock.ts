/**
 * Stock rules (decisions P1, A3, A16). The database keeps the counters and
 * refuses anything invalid; these functions describe the same rules for the UI.
 */
export type StockCounters = {
  totalQuantity: number;
  rentedQuantity: number;
  heldQuantity: number;
};

/** available = total − rented − held. Never stored and never edited directly. */
export function availableQuantity({ totalQuantity, rentedQuantity, heldQuantity }: StockCounters) {
  const available = totalQuantity - rentedQuantity - heldQuantity;
  if (available < 0) {
    throw new RangeError("Stock counters are inconsistent: more pieces out or held than owned");
  }
  return available;
}

/** Shortage for a requested quantity (PRD §16), e.g. 30 requested of 20 available → 10 short. */
export function stockShortage(requested: number, available: number) {
  return { requested, available, shortage: Math.max(0, requested - available) };
}

/** Low stock: a threshold is set and available ≤ threshold (A16). No threshold, no alert. */
export function isLowStock(available: number, lowStockThreshold: number | null): boolean {
  return lowStockThreshold !== null && available <= lowStockThreshold;
}

/** Available stock % across variants = Σ available ÷ Σ total × 100 (A16). Null when nothing is owned. */
export function availableStockPercent(variants: readonly StockCounters[]): number | null {
  const total = variants.reduce((sum, v) => sum + v.totalQuantity, 0);
  if (total === 0) return null;
  const available = variants.reduce((sum, v) => sum + availableQuantity(v), 0);
  return (available / total) * 100;
}
