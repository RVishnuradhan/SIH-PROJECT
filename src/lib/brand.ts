/**
 * Brand identity for the app chrome (logo, page titles).
 *
 * Printed bills never read this: their header comes from the versioned business
 * profile stored with each bill (docs/DATABASE.md §7), so company details can
 * change later without altering old bills.
 */
export const brand = {
  name: "SMS Associates",
  wordmark: "SMS ASSOCIATES",
  tagline: "Centering Materials Suppliers",
  productName: "Centering Materials Rental & Inventory Management",
  /** Hex of the --primary token, for places CSS variables can't reach (icons, browser UI). */
  primaryHex: "#274387",
} as const;
