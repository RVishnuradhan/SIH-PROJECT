/**
 * Historical accuracy (A6, BR-4..BR-8): a generated bill keeps the customer
 * details, material names, rates and bill header it was generated with, even
 * after the master data changes. Exercised through Prisma, the way the app
 * will use the database.
 *
 * Rates here are test values in a throw-away database, not catalog data (A15).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { toPaise } from "@/domain/money";
import { lineEstimate } from "@/domain/pricing";
import { expectedReturnDate, toDbDate } from "@/domain/rental-days";
import type { Database } from "@/lib/db";
import { allocateBillNumber } from "@/modules/billing/bill-number";

import { createTestDatabase, type TestDatabase } from "./support/test-database";

let database: TestDatabase;
let prisma: Database;
let billId: string;
let customerId: string;
let variantId: string;
const ADMIN = "admin-1";
const TAKEN_AT = new Date("2026-09-23T10:00:00+05:30");

beforeAll(async () => {
  database = await createTestDatabase();
  prisma = database.prisma();

  await prisma.user.create({
    data: {
      id: ADMIN,
      name: "Owner",
      email: "owner@example.invalid",
      username: "owner",
      role: "admin",
    },
  });
  await prisma.counter.create({ data: { key: "bill_number", value: 0 } });
  await prisma.businessProfile.create({
    data: {
      version: 1,
      name: "SMS ASSOCIATES",
      tagline: "Centering Materials Suppliers",
      addressLines: ["101-A, Karungalmedu", "Kunnathur - 638 103."],
      phones: ["9865276111", "9487270111"],
    },
  });
  const customer = await prisma.customer.create({
    data: { name: "Shanjiv", phone: "9865276111", location: "Kunnathur", createdById: ADMIN },
  });
  customerId = customer.id;

  const material = await prisma.material.create({ data: { name: "Earthramer" } });
  const variant = await prisma.materialVariant.create({
    data: {
      materialId: material.id,
      variantName: "",
      ratePerDay: "12.50",
      inventory: { create: {} },
    },
  });
  variantId = variant.id;
  await prisma.inventoryTransaction.create({
    data: {
      variantId,
      type: "INITIAL_STOCK",
      totalDelta: 6,
      occurredAt: new Date(),
      reason: "Opening stock count",
      createdById: ADMIN,
    },
  });
});

afterAll(async () => {
  await database?.drop();
});

describe("bill snapshots", () => {
  it("copies the customer, material, rate and bill header onto the bill when it is saved", async () => {
    const bill = await prisma.$transaction(async (tx) => {
      const { billSeq, billNumber } = await allocateBillNumber(tx);
      const customer = await tx.customer.findUniqueOrThrow({ where: { id: customerId } });
      const profile = await tx.businessProfile.findFirstOrThrow({ orderBy: { version: "desc" } });
      const variant = await tx.materialVariant.findUniqueOrThrow({
        where: { id: variantId },
        include: { material: true },
      });
      const expectedDays = 10;
      const rate = toPaise(variant.ratePerDay!);

      const created = await tx.bill.create({
        data: {
          billSeq,
          billNumber,
          customerId: customer.id,
          takenAt: TAKEN_AT,
          expectedDays,
          expectedReturnDate: toDbDate(expectedReturnDate(TAKEN_AT, expectedDays)),
          siteLocation: "Perundurai site",
          customerName: customer.name,
          customerPhone: customer.phone,
          customerLocation: customer.location,
          businessProfileId: profile.id,
          createdById: ADMIN,
          items: {
            create: {
              lineNo: 1,
              variantId: variant.id,
              materialName: variant.material.name,
              variantName: variant.variantName,
              quantity: 4,
              ratePerDay: variant.ratePerDay!,
              estimatedAmount: (
                lineEstimate({ quantity: 4, ratePerDay: rate, expectedDays }) / 100
              ).toFixed(2),
            },
          },
        },
        include: { items: true },
      });

      // Generate: ACTIVE, then take the pieces out of the yard.
      await tx.bill.update({
        where: { id: created.id },
        data: {
          status: "ACTIVE",
          generatedAt: new Date(),
          generatedById: ADMIN,
          estimatedAmount: created.items[0]!.estimatedAmount,
          version: { increment: 1 },
        },
      });
      await tx.inventoryTransaction.createMany({
        data: created.items.map((item) => ({
          variantId: item.variantId,
          type: "RENTAL_OUT" as const,
          rentedDelta: item.quantity,
          occurredAt: TAKEN_AT,
          billId: created.id,
          billItemId: item.id,
          customerId: customer.id,
          createdById: ADMIN,
        })),
      });
      return created;
    });
    billId = bill.id;

    expect(bill.billNumber).toBe("SMS-000001");
    expect(bill.items[0]).toMatchObject({
      materialName: "Earthramer",
      variantName: "",
      quantity: 4,
    });
    expect(bill.items[0]!.ratePerDay.toString()).toBe("12.5");
    expect(bill.items[0]!.estimatedAmount.toFixed(2)).toBe("500.00");
    expect(bill.expectedReturnDate.toISOString()).toBe("2026-10-03T00:00:00.000Z");
    expect(await prisma.inventory.findUniqueOrThrow({ where: { variantId } })).toMatchObject({
      totalQuantity: 6,
      rentedQuantity: 4,
      heldQuantity: 0,
    });
  });

  it("keeps them unchanged after the customer, catalog and bill header change", async () => {
    await prisma.customer.update({
      where: { id: customerId },
      data: { name: "Shanjiv Kumar", phone: "9487270111", location: "Erode" },
    });
    await prisma.material.update({
      where: { name: "Earthramer" },
      data: { description: "Plate compactor" },
    });
    await prisma.materialVariant.update({
      where: { id: variantId },
      data: { ratePerDay: "15.00" },
    });
    await prisma.businessProfile.create({
      data: {
        version: 2,
        name: "SMS ASSOCIATES",
        tagline: "Centering Materials Suppliers",
        addressLines: ["New address line"],
        phones: ["9000000000"],
        createdById: ADMIN,
      },
    });

    const bill = await prisma.bill.findUniqueOrThrow({
      where: { id: billId },
      include: { items: true, businessProfile: true },
    });
    expect(bill).toMatchObject({
      customerName: "Shanjiv",
      customerPhone: "9865276111",
      customerLocation: "Kunnathur",
      dayCountRule: "CALENDAR_DAYS_MIN_1",
      timeZone: "Asia/Kolkata",
    });
    expect(bill.businessProfile).toMatchObject({
      version: 1,
      addressLines: ["101-A, Karungalmedu", "Kunnathur - 638 103."],
      phones: ["9865276111", "9487270111"],
      billTitle: "Rental Bill",
    });
    expect(bill.items[0]).toMatchObject({ materialName: "Earthramer", variantName: "" });
    expect(bill.items[0]!.ratePerDay.toString()).toBe("12.5");
  });

  it("refuses any change to the snapshots of a generated bill", async () => {
    await expect(
      prisma.bill.update({ where: { id: billId }, data: { customerName: "Someone else" } }),
    ).rejects.toThrow("its customer, taking date and snapshots are locked");
    await expect(
      prisma.bill.update({ where: { id: billId }, data: { takenAt: new Date() } }),
    ).rejects.toThrow("its customer, taking date and snapshots are locked");
    const item = await prisma.billItem.findFirstOrThrow({ where: { billId } });
    await expect(
      prisma.billItem.update({ where: { id: item.id }, data: { ratePerDay: "15.00" } }),
    ).rejects.toThrow("Material lines, quantities and rates are locked once the bill is generated");
    await expect(
      prisma.billItem.update({ where: { id: item.id }, data: { quantity: 2 } }),
    ).rejects.toThrow("Material lines, quantities and rates are locked once the bill is generated");
    await expect(
      prisma.businessProfile.update({ where: { version: 1 }, data: { phones: ["9000000000"] } }),
    ).rejects.toThrow("business_profiles is append-only");
    await expect(prisma.bill.delete({ where: { id: billId } })).rejects.toThrow(
      "Bills are never deleted",
    );
  });

  it("lets an admin edit notes, site location and expected days, recorded in the audit log (A6)", async () => {
    const newDays = 12;
    await prisma.$transaction(async (tx) => {
      const before = await tx.bill.findUniqueOrThrow({
        where: { id: billId },
        include: { items: true },
      });
      const item = before.items[0]!;
      const estimate = (
        lineEstimate({
          quantity: item.quantity,
          ratePerDay: toPaise(item.ratePerDay),
          expectedDays: newDays,
        }) / 100
      ).toFixed(2);
      await tx.billItem.update({ where: { id: item.id }, data: { estimatedAmount: estimate } });
      await tx.bill.update({
        where: { id: billId, version: before.version },
        data: {
          notes: "Deliver to the back gate",
          siteLocation: "Perundurai SIPCOT",
          expectedDays: newDays,
          expectedReturnDate: toDbDate(expectedReturnDate(before.takenAt, newDays)),
          estimatedAmount: estimate,
          version: { increment: 1 },
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: ADMIN,
          action: "bill.edited",
          entityType: "bill",
          entityId: billId,
          summary: `Edited ${before.billNumber}`,
          changes: {
            siteLocation: { from: before.siteLocation, to: "Perundurai SIPCOT" },
            expectedDays: { from: before.expectedDays, to: newDays },
          },
        },
      });
    });

    const bill = await prisma.bill.findUniqueOrThrow({
      where: { id: billId },
      include: { items: true },
    });
    expect(bill).toMatchObject({
      siteLocation: "Perundurai SIPCOT",
      notes: "Deliver to the back gate",
      expectedDays: 12,
    });
    expect(bill.expectedReturnDate.toISOString()).toBe("2026-10-05T00:00:00.000Z");
    expect(bill.estimatedAmount.toFixed(2)).toBe("600.00");
    expect(bill.customerName).toBe("Shanjiv");

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: billId } });
    expect(audit.changes).toEqual({
      siteLocation: { from: "Perundurai site", to: "Perundurai SIPCOT" },
      expectedDays: { from: 10, to: 12 },
    });
    await expect(
      prisma.auditLog.update({ where: { id: audit.id }, data: { summary: "x" } }),
    ).rejects.toThrow("audit_logs is append-only");
  });

  it("rejects a stale edit (optimistic locking on version)", async () => {
    const current = await prisma.bill.findUniqueOrThrow({ where: { id: billId } });
    await expect(
      prisma.bill.update({
        where: { id: billId, version: current.version - 1 },
        data: { notes: "stale" },
      }),
    ).rejects.toMatchObject({ code: "P2025" });
  });

  it("keeps a new variant without a rate until one is entered, and never allows direct stock edits", async () => {
    const material = await prisma.material.create({ data: { name: "Vibrator" } });
    const variant = await prisma.materialVariant.create({
      data: { materialId: material.id, inventory: { create: {} } },
    });
    expect(variant.ratePerDay).toBeNull();
    await expect(
      prisma.inventory.update({ where: { variantId: variant.id }, data: { totalQuantity: 10 } }),
    ).rejects.toThrow("Stock changes only through inventory_transactions");
  });
});
