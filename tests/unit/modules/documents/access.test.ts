import { describe, expect, it } from "vitest";

import { can } from "@/lib/permissions";
import { INLINE_DOCUMENT_TYPES, permissionToOpen } from "@/modules/documents/access";

describe("who may open a customer document", () => {
  it.each([
    { type: "ID_PROOF", isSensitive: true, admin: true, staff: false },
    // ID proofs are sensitive even if a row were ever stored unflagged.
    { type: "ID_PROOF", isSensitive: false, admin: true, staff: false },
    { type: "OTHER", isSensitive: true, admin: true, staff: false },
    { type: "OTHER", isSensitive: false, admin: true, staff: true },
    { type: "PHOTO", isSensitive: false, admin: true, staff: true },
  ] as const)("$type (sensitive: $isSensitive) — admin $admin, staff $staff", (document) => {
    const permission = permissionToOpen(document);
    expect(can("admin", permission)).toBe(document.admin);
    expect(can("staff", permission)).toBe(document.staff);
  });

  it("shows only images and PDFs inline", () => {
    expect([...INLINE_DOCUMENT_TYPES].sort()).toEqual([
      "application/pdf",
      "image/jpeg",
      "image/png",
      "image/webp",
    ]);
    expect(INLINE_DOCUMENT_TYPES.has("text/html")).toBe(false);
    expect(INLINE_DOCUMENT_TYPES.has("image/svg+xml")).toBe(false);
  });
});
