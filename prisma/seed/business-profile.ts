/**
 * Version 1 of the bill header, exactly as given in the PRD (§2, §23).
 * The title is "Rental Bill" (decision A5: not GST-registered). Later changes
 * are made in Settings as new versions; this seed never edits an existing one.
 */
export const businessProfileV1 = {
  version: 1,
  name: "SMS ASSOCIATES",
  tagline: "Centering Materials Suppliers",
  addressLines: ["101-A, Karungalmedu", "Kunnathur - 638 103."],
  phones: ["9865276111", "9487270111"],
  billTitle: "Rental Bill",
} as const;
