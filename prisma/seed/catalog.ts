/**
 * The material catalog exactly as listed in the PRD (§14): 13 materials,
 * 28 variants, spelled exactly as the PRD spells them ("Earthramer" included).
 *
 * TODO(SMS Associates): the real daily rates and low-stock thresholds are not
 * known yet and must never be invented (decision A15). Until they are provided:
 *   - ratePerDay null         → "rate not set"; the variant can't be billed
 *   - lowStockThreshold null  → no low-stock alert
 *   - stock                   → none; an admin records the real counts as
 *                               INITIAL_STOCK movements in the Inventory module
 */
export type SeedVariant = {
  /** "" for a material without variants (printed as "—"). */
  name: string;
  ratePerDay: string | null;
  lowStockThreshold: number | null;
};

export type SeedMaterial = { name: string; variants: readonly SeedVariant[] };

const TODO = null;

const variant = (name: string): SeedVariant => ({
  name,
  ratePerDay: TODO,
  lowStockThreshold: TODO,
});

/** A material with no variants gets exactly one variant with an empty name. */
const NO_VARIANT = [variant("")];

export const catalog: readonly SeedMaterial[] = [
  { name: "Big Jockey", variants: [variant("16 Feet"), variant("18 Feet")] },
  { name: "Small Jockey", variants: [variant("12 Feet")] },
  { name: "Big Span", variants: [variant("16 Feet")] },
  { name: "Small Span", variants: [variant("13 Feet 6 Inch")] },
  {
    name: "Centering Seats",
    variants: [variant("4 × 2"), variant("3 × 2"), variant("3 × 1½"), variant("5 × ½")],
  },
  {
    name: "Column Box",
    variants: [
      variant("4 × ¾"),
      variant("4 × ½"),
      variant("4 × 1"),
      variant("3 × ¾"),
      variant("8 × ¾"),
    ],
  },
  {
    name: "Muttu Maram",
    variants: [
      variant("12 Feet"),
      variant("11 Feet"),
      variant("10 Feet"),
      variant("8 Feet"),
      variant("7 Feet"),
      variant("5 Feet"),
    ],
  },
  { name: "Runner", variants: [variant("10 Feet"), variant("8 Feet")] },
  { name: "Palagai", variants: [variant("10 Feet"), variant("8 Feet")] },
  { name: "Earthramer", variants: NO_VARIANT },
  { name: "Vibrator", variants: NO_VARIANT },
  { name: "Spanner", variants: NO_VARIANT },
  { name: "Bolt", variants: NO_VARIANT },
];
