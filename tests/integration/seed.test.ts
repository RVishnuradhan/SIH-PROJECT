import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { businessProfileV1 } from "../../prisma/seed/business-profile";
import { catalog } from "../../prisma/seed/catalog";
import { seed } from "../../prisma/seed/seed";

import { createTestDatabase, type TestDatabase } from "./support/test-database";

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database?.drop();
});

// The PRD's catalog (§14), written out independently of the seed file.
const PRD_CATALOG: [material: string, variants: string[]][] = [
  ["Big Jockey", ["16 Feet", "18 Feet"]],
  ["Small Jockey", ["12 Feet"]],
  ["Big Span", ["16 Feet"]],
  ["Small Span", ["13 Feet 6 Inch"]],
  ["Centering Seats", ["4 × 2", "3 × 2", "3 × 1½", "5 × ½"]],
  ["Column Box", ["4 × ¾", "4 × ½", "4 × 1", "3 × ¾", "8 × ¾"]],
  ["Muttu Maram", ["12 Feet", "11 Feet", "10 Feet", "8 Feet", "7 Feet", "5 Feet"]],
  ["Runner", ["10 Feet", "8 Feet"]],
  ["Palagai", ["10 Feet", "8 Feet"]],
  ["Earthramer", [""]],
  ["Vibrator", [""]],
  ["Spanner", [""]],
  ["Bolt", [""]],
];

describe("database seed", () => {
  it("creates the starting data on an empty database", async () => {
    const summary = await seed(database.prisma());
    expect(summary).toEqual({
      businessProfileCreated: true,
      counterCreated: true,
      materialsCreated: 13,
      variantsCreated: 28,
      inventoryRowsCreated: 28,
    });
  });

  it("matches the PRD catalog exactly: 13 materials, 28 variants, PRD order and spelling", async () => {
    const materials = await database.prisma().material.findMany({
      orderBy: { sortOrder: "asc" },
      include: { variants: { orderBy: { sortOrder: "asc" } } },
    });
    expect(materials.map((m) => [m.name, m.variants.map((v) => v.variantName)])).toEqual(
      PRD_CATALOG,
    );
    expect(materials.flatMap((m) => m.variants)).toHaveLength(28);
    expect(catalog).toHaveLength(13);
  });

  it('keeps "Earthramer" spelled exactly as in the PRD', async () => {
    const earthramer = await database
      .prisma()
      .material.findUnique({ where: { name: "Earthramer" } });
    expect(earthramer?.name).toBe("Earthramer");
    expect(await database.prisma().material.count({ where: { name: "Earth Rammer" } })).toBe(0);
  });

  it("invents no rates, thresholds or stock (A15)", async () => {
    const variants = await database.prisma().materialVariant.findMany();
    expect(variants.every((v) => v.ratePerDay === null && v.lowStockThreshold === null)).toBe(true);
    expect(variants.every((v) => v.isActive)).toBe(true);

    const inventory = await database.prisma().inventory.findMany();
    expect(inventory).toHaveLength(28);
    expect(
      inventory.every(
        (i) => i.totalQuantity === 0 && i.rentedQuantity === 0 && i.heldQuantity === 0,
      ),
    ).toBe(true);
    expect(await database.prisma().inventoryTransaction.count()).toBe(0);
  });

  it("creates bill-header version 1 exactly as in the PRD, titled Rental Bill", async () => {
    const profiles = await database.prisma().businessProfile.findMany();
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({
      version: 1,
      name: "SMS ASSOCIATES",
      tagline: "Centering Materials Suppliers",
      addressLines: ["101-A, Karungalmedu", "Kunnathur - 638 103."],
      phones: ["9865276111", "9487270111"],
      billTitle: "Rental Bill",
      createdById: null,
    });
    expect(businessProfileV1.billTitle).toBe("Rental Bill");
  });

  it("starts bill numbers from zero, so the first bill is SMS-000001", async () => {
    const counter = await database.prisma().counter.findUnique({ where: { key: "bill_number" } });
    expect(counter?.value).toBe(0);
  });

  it("is safe to run again: nothing is duplicated", async () => {
    const summary = await seed(database.prisma());
    expect(summary).toEqual({
      businessProfileCreated: false,
      counterCreated: false,
      materialsCreated: 0,
      variantsCreated: 0,
      inventoryRowsCreated: 0,
    });
    expect(await database.prisma().materialVariant.count()).toBe(28);
  });

  it("never overwrites values entered later (a rate set by an admin survives a re-seed)", async () => {
    const variant = await database.prisma().materialVariant.findFirstOrThrow({
      where: { material: { name: "Muttu Maram" }, variantName: "10 Feet" },
    });
    await database
      .prisma()
      .materialVariant.update({ where: { id: variant.id }, data: { ratePerDay: "5.00" } });
    await seed(database.prisma());
    const after = await database
      .prisma()
      .materialVariant.findUniqueOrThrow({ where: { id: variant.id } });
    expect(after.ratePerDay?.toString()).toBe("5");
  });
});
