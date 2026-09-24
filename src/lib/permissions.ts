/**
 * Roles and permissions (decision A12, ARCHITECTURE.md §6).
 *
 * One role → permission map for the whole application. Every server action,
 * route handler and data query checks a permission key here; hiding a button is
 * only a convenience. Adding a role later means adding entries, not changing
 * code paths.
 *
 * This module has no server-only code, so client components may use `can()` to
 * decide what to show — the server always checks again.
 */

export const ROLES = ["admin", "staff"] as const;
export type Role = (typeof ROLES)[number];

export const roleLabels: Record<Role, string> = { admin: "Admin", staff: "Staff" };

const EVERYONE = ["admin", "staff"] as const satisfies readonly Role[];
const ADMIN_ONLY = ["admin"] as const satisfies readonly Role[];

/** Who may do what — row by row the table in ARCHITECTURE.md §6. */
export const PERMISSIONS = {
  // View dashboard, bills, Bill History, Pending List, rental history
  "dashboard.view": EVERYONE,
  "bill.view": EVERYONE,
  // Create, resume and generate bills; cancel a draft
  "bill.create": EVERYONE,
  "bill.cancelDraft": EVERYONE,
  // Edit site location / notes / expected duration of a generated bill (A6)
  "bill.editGenerated": ADMIN_ONLY,
  // Void a generated bill · archive a bill
  "bill.void": ADMIN_ONLY,
  "bill.archive": ADMIN_ONLY,
  // Process returns (Returned / Damaged / Lost); void a return
  "return.process": EVERYONE,
  "return.void": ADMIN_ONLY,
  // Record payments (advance, additional, refund); mark a pending payment received
  "payment.record": EVERYONE,
  "payment.markReceived": EVERYONE,
  // Cancel a recorded payment · record a discount (A9)
  "payment.cancel": ADMIN_ONLY,
  "payment.discount": ADMIN_ONLY,
  // Create and edit customers; archive customers
  "customer.create": EVERYONE,
  "customer.edit": EVERYONE,
  "customer.archive": ADMIN_ONLY,
  // Upload customer documents · view customer photos and other non-sensitive files
  "document.upload": EVERYONE,
  "document.view": EVERYONE,
  // Open sensitive ID documents · delete documents
  "document.viewSensitive": ADMIN_ONLY,
  "document.delete": ADMIN_ONLY,
  // View inventory and stock movements
  "inventory.view": EVERYONE,
  // Set initial stock · adjust stock · resolve damaged/lost
  "inventory.setInitialStock": ADMIN_ONLY,
  "inventory.adjust": ADMIN_ONLY,
  "inventory.resolveHeld": ADMIN_ONLY,
  // Manage materials, variants, rates, thresholds
  "catalog.manage": ADMIN_ONLY,
  // Edit the business profile (bill header)
  "businessProfile.edit": ADMIN_ONLY,
  // Manage users · view the audit log
  "user.manage": ADMIN_ONLY,
  "audit.view": ADMIN_ONLY,
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/** Whether a role has a permission. Unknown or missing roles have none. */
export function can(role: Role | null | undefined, permission: Permission): boolean {
  if (!isRole(role)) return false;
  return (PERMISSIONS[permission] as readonly Role[]).includes(role);
}

export function permissionsOf(role: Role): Permission[] {
  return ALL_PERMISSIONS.filter((permission) => can(role, permission));
}
