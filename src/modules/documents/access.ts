import type { Permission } from "@/lib/permissions";

/**
 * Who may open a customer document (ARCHITECTURE.md §6, §10): ID proofs
 * (Aadhaar and similar) and anything marked sensitive need
 * `document.viewSensitive` (admins); photos and other files need
 * `document.view` (staff and admins). Staff see only a placeholder for
 * sensitive documents.
 */
export function permissionToOpen(document: {
  type: "PHOTO" | "ID_PROOF" | "OTHER";
  isSensitive: boolean;
}): Permission {
  return document.isSensitive || document.type === "ID_PROOF"
    ? "document.viewSensitive"
    : "document.view";
}

/** File types the document route will display inline; anything else is downloaded. */
export const INLINE_DOCUMENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]);
