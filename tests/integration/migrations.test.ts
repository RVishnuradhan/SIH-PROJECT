/**
 * The migrations are the only way the schema reaches a database. These tests
 * check that they build exactly the validated design and that the Prisma schema
 * and the migrated database agree (no drift), so a later `prisma migrate dev`
 * would never try to drop a rule.
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { one } from "./support/fixtures";
import { createTestDatabase, type TestDatabase } from "./support/test-database";

const run = promisify(execFile);
const prismaCli = path.resolve(
  "node_modules/.bin",
  process.platform === "win32" ? "prisma.cmd" : "prisma",
);

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database?.drop();
});

async function names(sql: string): Promise<string[]> {
  const result = await database.pool.query<{ name: string }>(sql);
  return result.rows.map((row) => row.name);
}

async function prisma(args: string[]) {
  try {
    const { stdout } = await run(prismaCli, args, {
      env: { ...process.env, DATABASE_URL: database.url },
    });
    return { code: 0, output: stdout };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}

describe("migrations", () => {
  it("apply one migration, completely", async () => {
    const rows = await database.pool.query(
      `SELECT migration_name, finished_at IS NOT NULL AS finished, rolled_back_at IS NULL AS kept
       FROM _prisma_migrations`,
    );
    expect(rows.rows).toEqual([
      { migration_name: "20260923180000_init", finished: true, kept: true },
    ]);
  });

  it("create the 19 tables of the design", async () => {
    expect(
      await names(
        `SELECT table_name AS name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations'
         ORDER BY 1`,
      ),
    ).toEqual([
      "accounts",
      "audit_logs",
      "bill_charges",
      "bill_items",
      "bills",
      "business_profiles",
      "counters",
      "customer_documents",
      "customers",
      "inventory",
      "inventory_transactions",
      "material_variants",
      "materials",
      "payments",
      "return_items",
      "returns",
      "sessions",
      "users",
      "verifications",
    ]);
  });

  it("create the 10 enums", async () => {
    expect(
      await names(
        `SELECT t.typname AS name FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
         WHERE n.nspname = 'public' AND t.typtype = 'e' ORDER BY 1`,
      ),
    ).toEqual([
      "charge_type",
      "day_count_rule",
      "document_type",
      "inventory_transaction_type",
      "payment_method",
      "payment_status",
      "payment_type",
      "rental_status",
      "return_condition",
      "settlement_status",
    ]);
  });

  it("install every CHECK constraint and foreign key (58 + 38)", async () => {
    const counts = await one<{ checks: string; foreign_keys: string }>(
      database.pool,
      `SELECT count(*) FILTER (WHERE contype = 'c') AS checks, count(*) FILTER (WHERE contype = 'f') AS foreign_keys
       FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'public'`,
    );
    expect(counts).toEqual({ checks: "58", foreign_keys: "38" });
  });

  it("install the 11 guard and ledger triggers", async () => {
    expect(
      await names(
        `SELECT tgname || ' on ' || tgrelid::regclass AS name FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1`,
      ),
    ).toEqual([
      "audit_logs_append_only on audit_logs",
      "bill_items_guard on bill_items",
      "bills_guard on bills",
      "business_profiles_append_only on business_profiles",
      "counters_guard on counters",
      "inventory_guard on inventory",
      "inventory_transactions_append_only on inventory_transactions",
      "inventory_transactions_apply on inventory_transactions",
      "payments_guard on payments",
      "return_items_append_only on return_items",
      "returns_guard on returns",
    ]);
  });

  it("create the money view and the three integrity views", async () => {
    expect(
      await names(
        `SELECT table_name AS name FROM information_schema.views WHERE table_schema = 'public' ORDER BY 1`,
      ),
    ).toEqual([
      "bill_financials",
      "bill_item_return_discrepancies",
      "inventory_discrepancies",
      "rented_stock_discrepancies",
    ]);
  });

  it("enable trigram search on customer and site names", async () => {
    expect(
      await names(`SELECT extname AS name FROM pg_extension WHERE extname = 'pg_trgm'`),
    ).toEqual(["pg_trgm"]);
    expect(
      await names(
        `SELECT indexname AS name FROM pg_indexes
         WHERE schemaname = 'public' AND indexdef LIKE '%gin_trgm_ops%' ORDER BY 1`,
      ),
    ).toEqual([
      "bills_customer_name_trgm_idx",
      "bills_site_location_trgm_idx",
      "customers_location_trgm_idx",
      "customers_name_trgm_idx",
    ]);
  });

  it("leave a fresh database with no data (the seed is separate)", async () => {
    const counts = await one<Record<string, string>>(
      database.pool,
      `SELECT (SELECT count(*) FROM materials) AS materials, (SELECT count(*) FROM counters) AS counters,
              (SELECT count(*) FROM business_profiles) AS profiles, (SELECT count(*) FROM users) AS users`,
    );
    expect(counts).toEqual({ materials: "0", counters: "0", profiles: "0", users: "0" });
  });

  it("match prisma/schema.prisma exactly (no drift)", async () => {
    const diff = await prisma([
      "migrate",
      "diff",
      "--from-config-datasource",
      "--to-schema",
      "prisma/schema.prisma",
      "--exit-code",
    ]);
    expect(diff.output).toContain("No difference detected");
    expect(diff.code).toBe(0);
  });

  it("are reported up to date by prisma migrate status", async () => {
    const status = await prisma(["migrate", "status"]);
    expect(status.output).toContain("Database schema is up to date");
    expect(status.code).toBe(0);
  });
});
