import { describe, expect, it } from "vitest";

import {
  ALL_PERMISSIONS,
  can,
  isRole,
  permissionsOf,
  roleLabels,
  ROLES,
  type Permission,
} from "@/lib/permissions";

/** ARCHITECTURE.md §6, the rows staff have (✓ in both columns). */
const STAFF_CAN: Permission[] = [
  "dashboard.view",
  "bill.view",
  "bill.create",
  "bill.cancelDraft",
  "return.process",
  "payment.record",
  "payment.markReceived",
  "customer.create",
  "customer.edit",
  "document.upload",
  "document.view",
  "inventory.view",
];

/** ARCHITECTURE.md §6, the admin-only rows. */
const ADMIN_ONLY: Permission[] = [
  "bill.editGenerated",
  "bill.void",
  "bill.archive",
  "return.void",
  "payment.cancel",
  "payment.discount",
  "customer.archive",
  "document.viewSensitive",
  "document.delete",
  "inventory.setInitialStock",
  "inventory.adjust",
  "inventory.resolveHeld",
  "catalog.manage",
  "businessProfile.edit",
  "user.manage",
  "audit.view",
];

describe("roles", () => {
  it("are exactly ADMIN and STAFF (A12)", () => {
    expect(ROLES).toEqual(["admin", "staff"]);
    expect(roleLabels).toEqual({ admin: "Admin", staff: "Staff" });
  });

  it("recognises only known roles", () => {
    expect(isRole("admin")).toBe(true);
    expect(isRole("staff")).toBe(true);
    for (const value of ["Admin", "ADMIN", "user", "owner", "", null, undefined, 1]) {
      expect(isRole(value)).toBe(false);
    }
  });
});

describe("permission map (ARCHITECTURE.md §6)", () => {
  it("covers every capability in the table, each exactly once", () => {
    expect([...ALL_PERMISSIONS].sort()).toEqual([...STAFF_CAN, ...ADMIN_ONLY].sort());
  });

  it.each(ALL_PERMISSIONS)("lets an admin %s", (permission) => {
    expect(can("admin", permission)).toBe(true);
  });

  it.each(STAFF_CAN)("lets staff %s", (permission) => {
    expect(can("staff", permission)).toBe(true);
  });

  it.each(ADMIN_ONLY)("refuses staff %s", (permission) => {
    expect(can("staff", permission)).toBe(false);
  });

  it("gives nothing to a missing or unknown role", () => {
    for (const permission of ALL_PERMISSIONS) {
      expect(can(null, permission)).toBe(false);
      expect(can(undefined, permission)).toBe(false);
      expect(can("owner" as never, permission)).toBe(false);
    }
  });

  it("lists each role's permissions", () => {
    expect(permissionsOf("staff").sort()).toEqual([...STAFF_CAN].sort());
    expect(permissionsOf("admin")).toHaveLength(ALL_PERMISSIONS.length);
  });

  it("keeps rates, stock, voids, discounts, ID documents and users admin-only", () => {
    const adminControls: Permission[] = [
      "catalog.manage", // rates
      "inventory.adjust",
      "inventory.setInitialStock",
      "bill.void",
      "return.void",
      "payment.discount",
      "document.viewSensitive",
      "user.manage",
    ];
    for (const permission of adminControls) {
      expect(can("admin", permission)).toBe(true);
      expect(can("staff", permission)).toBe(false);
    }
  });
});
