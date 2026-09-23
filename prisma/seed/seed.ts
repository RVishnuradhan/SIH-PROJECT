import type { PrismaClient } from "../../src/generated/prisma/client";

import { businessProfileV1 } from "./business-profile";
import { catalog } from "./catalog";

export type SeedSummary = {
  businessProfileCreated: boolean;
  counterCreated: boolean;
  materialsCreated: number;
  variantsCreated: number;
  inventoryRowsCreated: number;
};

/**
 * Creates the approved starting data. Safe to run again: it only adds what is
 * missing and never changes existing rows, so rates or stock entered later are
 * never overwritten.
 */
export async function seed(prisma: PrismaClient): Promise<SeedSummary> {
  return prisma.$transaction(async (tx) => {
    const summary: SeedSummary = {
      businessProfileCreated: false,
      counterCreated: false,
      materialsCreated: 0,
      variantsCreated: 0,
      inventoryRowsCreated: 0,
    };

    if ((await tx.businessProfile.count()) === 0) {
      await tx.businessProfile.create({
        data: {
          ...businessProfileV1,
          addressLines: [...businessProfileV1.addressLines],
          phones: [...businessProfileV1.phones],
        },
      });
      summary.businessProfileCreated = true;
    }

    if (!(await tx.counter.findUnique({ where: { key: "bill_number" } }))) {
      await tx.counter.create({ data: { key: "bill_number", value: 0 } });
      summary.counterCreated = true;
    }

    for (const [materialIndex, material] of catalog.entries()) {
      let materialRow = await tx.material.findUnique({ where: { name: material.name } });
      if (!materialRow) {
        materialRow = await tx.material.create({
          data: { name: material.name, sortOrder: materialIndex + 1 },
        });
        summary.materialsCreated += 1;
      }

      for (const [variantIndex, variant] of material.variants.entries()) {
        const key = { materialId: materialRow.id, variantName: variant.name };
        let variantRow = await tx.materialVariant.findUnique({
          where: { materialId_variantName: key },
        });
        if (!variantRow) {
          variantRow = await tx.materialVariant.create({
            data: {
              ...key,
              ratePerDay: variant.ratePerDay,
              lowStockThreshold: variant.lowStockThreshold,
              sortOrder: variantIndex + 1,
            },
          });
          summary.variantsCreated += 1;
        }

        // Every variant has exactly one stock row. It starts at zero: stock is
        // only ever recorded through inventory_transactions.
        if (!(await tx.inventory.findUnique({ where: { variantId: variantRow.id } }))) {
          await tx.inventory.create({ data: { variantId: variantRow.id } });
          summary.inventoryRowsCreated += 1;
        }
      }
    }

    return summary;
  });
}
