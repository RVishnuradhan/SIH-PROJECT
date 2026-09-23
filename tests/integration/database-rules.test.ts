/**
 * The database rules, exercised directly in SQL: the 103 scenarios validated in
 * the design (docs/DATABASE.md §11), now run against real PostgreSQL on every
 * CI run. Tests run in order and build on each other, like a day at the yard:
 * stock is set up, SMS-000001 is generated, returned in two batches, settled,
 * and then every guard is tried.
 */
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "./support/test-database";

let database: TestDatabase;
let client: pg.Client;

beforeAll(async () => {
  database = await createTestDatabase();
  client = new pg.Client({ connectionString: database.url });
  await client.connect();
});

afterAll(async () => {
  await client?.end();
  await database?.drop();
});

async function value(sql: string): Promise<string | null> {
  const result = await client.query(sql);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return row ? String(Object.values(row)[0]) : null;
}

/** Must succeed (and is kept). */
function ok(name: string, sql: string) {
  it(name, async () => {
    try {
      await client.query(sql);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
  });
}

/** Must succeed, then is rolled back so later scenarios don't see it. */
function okRolledBack(name: string, sql: string) {
  it(name, async () => {
    await client.query("BEGIN");
    try {
      await client.query(sql);
    } finally {
      await client.query("ROLLBACK");
    }
  });
}

/** Must be refused by the database, for the stated reason. */
function refused(name: string, sql: string, reason: string) {
  it(name, async () => {
    await client.query("BEGIN");
    try {
      await expect(client.query(sql)).rejects.toThrow(reason);
    } finally {
      await client.query("ROLLBACK");
    }
  });
}

/** The query's first value must equal the expected one. */
function eq(name: string, sql: string, expected: string | number) {
  it(name, async () => {
    expect(await value(sql)).toBe(String(expected));
  });
}

const stock = (variantId: string) =>
  `select concat_ws(',', total_quantity, rented_quantity, held_quantity) from inventory where variant_id = '${variantId}'`;

// ids
const MM = "00000000-0000-7000-8000-0000000000a1",
  RN = "00000000-0000-7000-8000-0000000000b1";
const BOLT = "00000000-0000-7000-8000-0000000000c1",
  SEATS = "00000000-0000-7000-8000-0000000000d1";
const CUST = "00000000-0000-7000-8000-00000000c001";
const B1 = "00000000-0000-7000-8000-00000000b001",
  B2 = "00000000-0000-7000-8000-00000000b002",
  B3 = "00000000-0000-7000-8000-00000000b003";
const BI1 = "00000000-0000-7000-8000-0000000b1101",
  BI2 = "00000000-0000-7000-8000-0000000b1102";
const BI3 = "00000000-0000-7000-8000-0000000b2101",
  BI4 = "00000000-0000-7000-8000-0000000b3101";
const R1 = "00000000-0000-7000-8000-00000000e001",
  R2 = "00000000-0000-7000-8000-00000000e002";
const RI1 = "00000000-0000-7000-8000-0000000e1001",
  RI2 = "00000000-0000-7000-8000-0000000e1002";
const RI3 = "00000000-0000-7000-8000-0000000e2001",
  RI4 = "00000000-0000-7000-8000-0000000e2002";

// ── Setup: users, header v1, counter, catalog (PRD spellings), inventory rows ──
ok(
  "seed users, business profile v1, bill counter",
  `
  INSERT INTO users (id, name, email, username, role, updated_at) VALUES
    ('u-admin', 'Owner', 'owner@example.invalid', 'owner', 'admin', now()),
    ('u-staff', 'Ravi', 'ravi@example.invalid', 'ravi', 'staff', now());
  INSERT INTO business_profiles (id, version, name, tagline, address_lines, phones) VALUES
    (gen_random_uuid(), 1, 'SMS ASSOCIATES', 'Centering Materials Suppliers',
     ARRAY['101-A, Karungalmedu', 'Kunnathur - 638 103.'], ARRAY['9865276111', '9487270111']);
  INSERT INTO counters (key, value, updated_at) VALUES ('bill_number', 0, now());`,
);
ok(
  "seed catalog: rate/threshold NULL where not configured (no invented prices)",
  `
  INSERT INTO materials (id, name, sort_order, updated_at) VALUES
    ('00000000-0000-7000-8000-00000000000a', 'Muttu Maram', 7, now()),
    ('00000000-0000-7000-8000-00000000000b', 'Runner', 8, now()),
    ('00000000-0000-7000-8000-00000000000c', 'Bolt', 13, now()),
    ('00000000-0000-7000-8000-00000000000d', 'Centering Seats', 5, now());
  INSERT INTO material_variants (id, material_id, variant_name, rate_per_day, low_stock_threshold, updated_at) VALUES
    ('${MM}', '00000000-0000-7000-8000-00000000000a', '10 Feet', 5.00, 10, now()),
    ('${RN}', '00000000-0000-7000-8000-00000000000b', '10 Feet', 8.00, 5, now()),
    ('${BOLT}', '00000000-0000-7000-8000-00000000000c', '', NULL, NULL, now()),
    ('${SEATS}', '00000000-0000-7000-8000-00000000000d', '3 × 1½', NULL, NULL, now());
  INSERT INTO inventory (variant_id) VALUES ('${MM}'), ('${RN}'), ('${BOLT}'), ('${SEATS}');`,
);
eq(
  "unicode variant name stored exactly",
  `select variant_name from material_variants where id = '${SEATS}'`,
  "3 × 1½",
);

// ── Stock setup ──
ok(
  "INITIAL_STOCK movements set owned stock",
  `
  INSERT INTO inventory_transactions (id, variant_id, type, total_delta, occurred_at, reason, created_by_id) VALUES
    (gen_random_uuid(), '${MM}', 'INITIAL_STOCK', 200, now(), 'Opening stock count', 'u-admin'),
    (gen_random_uuid(), '${RN}', 'INITIAL_STOCK', 100, now(), 'Opening stock count', 'u-admin');`,
);
eq("Muttu Maram 10 ft: total,rented,held", stock(MM), "200,0,0");
refused(
  "available stock cannot be edited directly",
  `UPDATE inventory SET total_quantity = 1000 WHERE variant_id = '${MM}'`,
  "only through inventory_transactions",
);
refused(
  "rented count cannot be edited directly",
  `UPDATE inventory SET rented_quantity = 7 WHERE variant_id = '${MM}'`,
  "only through inventory_transactions",
);
refused(
  "inventory rows start at zero",
  `
  INSERT INTO material_variants (id, material_id, variant_name, updated_at) VALUES ('00000000-0000-7000-8000-0000000000a2', '00000000-0000-7000-8000-00000000000a', '12 Feet', now());
  INSERT INTO inventory (variant_id, total_quantity) VALUES ('00000000-0000-7000-8000-0000000000a2', 50);`,
  "starts at zero",
);
refused(
  "inventory rows are never deleted",
  `DELETE FROM inventory WHERE variant_id = '${BOLT}'`,
  "never deleted",
);
refused(
  "admin movement needs a reason",
  `
  INSERT INTO inventory_transactions (id, variant_id, type, total_delta, occurred_at, created_by_id)
  VALUES (gen_random_uuid(), '${MM}', 'MANUAL_ADJUSTMENT', 5, now(), 'u-admin')`,
  "inventory_transactions_source",
);
refused(
  "movement type fixes its effect (RENTAL_OUT cannot change owned stock)",
  `
  INSERT INTO inventory_transactions (id, variant_id, type, total_delta, rented_delta, occurred_at, reason, created_by_id)
  VALUES (gen_random_uuid(), '${MM}', 'RENTAL_OUT', 5, 5, now(), 'x', 'u-admin')`,
  "inventory_transactions_effect",
);
refused(
  "owned stock cannot go negative",
  `
  INSERT INTO inventory_transactions (id, variant_id, type, total_delta, occurred_at, reason, created_by_id)
  VALUES (gen_random_uuid(), '${MM}', 'MANUAL_ADJUSTMENT', -250, now(), 'Stock count', 'u-admin')`,
  "inventory_",
);

// ── Customer ──
refused(
  "phone must be stored normalised",
  `
  INSERT INTO customers (id, name, phone, location, created_by_id, updated_at)
  VALUES (gen_random_uuid(), 'X', '+91 98652 76111', 'Kunnathur', 'u-staff', now())`,
  "customers_phone_normalised",
);
refused(
  "phone must be a valid Indian mobile",
  `
  INSERT INTO customers (id, name, phone, location, created_by_id, updated_at)
  VALUES (gen_random_uuid(), 'X', '5865276111', 'Kunnathur', 'u-staff', now())`,
  "customers_phone_normalised",
);
ok(
  "customer created",
  `
  INSERT INTO customers (id, name, phone, location, created_by_id, updated_at)
  VALUES ('${CUST}', 'Shanjiv', '9865276111', 'Kunnathur', 'u-staff', now());`,
);
ok(
  "phone numbers are not unique (A10)",
  `
  INSERT INTO customers (id, name, phone, location, created_by_id, updated_at)
  VALUES (gen_random_uuid(), 'Shanjiv Kumar', '9865276111', 'Perundurai', 'u-staff', now());`,
);
eq(
  "trigram search finds a misspelt name",
  `select count(*) from customers where name % 'Sanjiv'`,
  2,
);

// ── Bill SMS-000001: draft (step 1) → lines (step 2) → advance (step 3) ──
eq(
  "step 1 takes the next bill number",
  `UPDATE counters SET value = value + 1, updated_at = now() WHERE key = 'bill_number' RETURNING value`,
  1,
);
ok(
  "draft bill created with its number and snapshots",
  `
  INSERT INTO bills (id, bill_seq, bill_number, customer_id, taken_at, expected_days, expected_return_date, site_location,
                     notes, customer_name, customer_phone, customer_location, business_profile_id, created_by_id, updated_at)
  VALUES ('${B1}', 1, 'SMS-000001', '${CUST}', '2026-09-23 10:00+05:30', 2, '2026-09-25', 'Kunnathur – temple site',
          'வாடிக்கையாளர் கூடுதல் நேரம் கேட்டார்', 'Shanjiv', '9865276111', 'Kunnathur',
          (SELECT id FROM business_profiles WHERE version = 1), 'u-staff', now());
  INSERT INTO bill_items (id, bill_id, line_no, variant_id, material_name, variant_name, quantity, rate_per_day, estimated_amount) VALUES
    ('${BI1}', '${B1}', 1, '${MM}', 'Muttu Maram', '10 Feet', 20, 5.00, 200.00),
    ('${BI2}', '${B1}', 2, '${RN}', 'Runner', '10 Feet', 10, 8.00, 160.00);
  UPDATE bills SET estimated_amount = 360, draft_advance_amount = 500, draft_advance_method = 'CASH',
                   draft_advance_received = true, version = version + 1, updated_at = now() WHERE id = '${B1}';`,
);
eq(
  "Tamil notes stored exactly",
  `select notes from bills where id = '${B1}'`,
  "வாடிக்கையாளர் கூடுதல் நேரம் கேட்டார்",
);
refused(
  "bill number must match its sequence",
  `
  INSERT INTO bills (id, bill_seq, bill_number, customer_id, taken_at, expected_days, expected_return_date, site_location,
                     customer_name, customer_phone, customer_location, business_profile_id, created_by_id, updated_at)
  VALUES (gen_random_uuid(), 5, 'SMS-5', '${CUST}', now(), 1, current_date + 1, 'x', 'Shanjiv', '9865276111', 'Kunnathur',
          (SELECT id FROM business_profiles WHERE version = 1), 'u-staff', now())`,
  "bills_number_matches_seq",
);
okRolledBack(
  "bill numbers widen past SMS-999999 instead of truncating",
  `
  INSERT INTO bills (id, bill_seq, bill_number, customer_id, taken_at, expected_days, expected_return_date, site_location,
                     customer_name, customer_phone, customer_location, business_profile_id, created_by_id, updated_at)
  VALUES (gen_random_uuid(), 1234567, 'SMS-1234567', '${CUST}', now(), 1, current_date + 1, 'x', 'Shanjiv', '9865276111', 'Kunnathur',
          (SELECT id FROM business_profiles WHERE version = 1), 'u-staff', now())`,
);
refused(
  "a draft holds no money status",
  `UPDATE bills SET settlement_status = 'ADDITIONAL_DUE' WHERE id = '${B1}'`,
  "bills_draft_has_no_money",
);

// ── Generate SMS-000001 (one transaction) ──
ok(
  "generate bill: ACTIVE + RENTAL_OUT per line + advance payment + audit",
  `
  BEGIN;
  UPDATE bills SET status = 'ACTIVE', generated_at = now(), generated_by_id = 'u-staff',
         draft_advance_amount = NULL, draft_advance_method = NULL, draft_advance_received = NULL, draft_advance_reference = NULL,
         version = version + 1, updated_at = now()
   WHERE id = '${B1}' AND status = 'DRAFT' AND version = 2;
  INSERT INTO inventory_transactions (id, variant_id, type, rented_delta, occurred_at, bill_id, bill_item_id, customer_id, created_by_id) VALUES
    (gen_random_uuid(), '${MM}', 'RENTAL_OUT', 20, '2026-09-23 10:00+05:30', '${B1}', '${BI1}', '${CUST}', 'u-staff'),
    (gen_random_uuid(), '${RN}', 'RENTAL_OUT', 10, '2026-09-23 10:00+05:30', '${B1}', '${BI2}', '${CUST}', 'u-staff');
  INSERT INTO payments (id, bill_id, type, status, amount, method, received_at, idempotency_key, recorded_by_id)
  VALUES (gen_random_uuid(), '${B1}', 'ADVANCE', 'COMPLETED', 500, 'CASH', '2026-09-23 10:00+05:30', gen_random_uuid(), 'u-staff');
  INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, summary)
  VALUES (gen_random_uuid(), 'u-staff', 'bill.generated', 'Bill', '${B1}', 'Generated SMS-000001 for Shanjiv');
  COMMIT;`,
);
eq("Muttu Maram after rental: 200 owned, 20 out", stock(MM), "200,20,0");
eq("Runner after rental: 100 owned, 10 out", stock(RN), "100,10,0");
refused(
  "draft payment fields cannot survive generation",
  `UPDATE bills SET draft_advance_amount = 100 WHERE id = '${B1}'`,
  "bills_draft_advance_only_in_draft",
);
refused(
  "rented quantity locked after generation",
  `UPDATE bill_items SET quantity = 25 WHERE id = '${BI1}'`,
  "locked once the bill is generated",
);
refused(
  "historical rate locked after generation",
  `UPDATE bill_items SET rate_per_day = 6 WHERE id = '${BI1}'`,
  "locked once the bill is generated",
);
refused(
  "no new lines after generation",
  `
  INSERT INTO bill_items (id, bill_id, line_no, variant_id, material_name, variant_name, quantity, rate_per_day, estimated_amount)
  VALUES (gen_random_uuid(), '${B1}', 3, '${BOLT}', 'Bolt', '', 5, 1, 10)`,
  "only be added while the bill is a draft",
);
refused(
  "lines of a generated bill cannot be removed",
  `DELETE FROM bill_items WHERE id = '${BI2}'`,
  "cannot be removed",
);
refused(
  "customer snapshot locked after generation",
  `UPDATE bills SET customer_name = 'Someone else' WHERE id = '${B1}'`,
  "locked",
);
refused(
  "taking date locked after generation",
  `UPDATE bills SET taken_at = now() WHERE id = '${B1}'`,
  "locked",
);
refused(
  "bill number never changes",
  `UPDATE bills SET bill_seq = 9, bill_number = 'SMS-000009' WHERE id = '${B1}'`,
  "can never change",
);
refused(
  "a generated bill cannot go back to draft",
  `UPDATE bills SET status = 'DRAFT' WHERE id = '${B1}'`,
  "cannot go back to draft",
);
refused("bills are never deleted", `DELETE FROM bills WHERE id = '${B1}'`, "never deleted");
refused(
  "customer with bills cannot be deleted",
  `DELETE FROM customers WHERE id = '${CUST}'`,
  "foreign key",
);
okRolledBack(
  "site location, notes and expected duration stay editable (A6)",
  `
  UPDATE bills SET site_location = 'Kunnathur – new site', notes = 'Customer requested additional time.',
                   expected_days = 3, expected_return_date = '2026-09-26', estimated_amount = 540,
                   version = version + 1, updated_at = now() WHERE id = '${B1}';
  UPDATE bill_items SET estimated_amount = quantity * rate_per_day * 3 WHERE bill_id = '${B1}';`,
);

// ── Overselling is impossible, and the whole generation rolls back ──
ok(
  "draft SMS-000002 asks for 500 Muttu Maram",
  `
  UPDATE counters SET value = value + 1, updated_at = now() WHERE key = 'bill_number';
  INSERT INTO bills (id, bill_seq, bill_number, customer_id, taken_at, expected_days, expected_return_date, site_location,
                     customer_name, customer_phone, customer_location, business_profile_id, created_by_id, updated_at)
  VALUES ('${B2}', 2, 'SMS-000002', '${CUST}', '2026-09-24 09:00+05:30', 2, '2026-09-26', 'Perundurai',
          'Shanjiv', '9865276111', 'Kunnathur', (SELECT id FROM business_profiles WHERE version = 1), 'u-staff', now());
  INSERT INTO bill_items (id, bill_id, line_no, variant_id, material_name, variant_name, quantity, rate_per_day, estimated_amount)
  VALUES ('${BI3}', '${B2}', 1, '${MM}', 'Muttu Maram', '10 Feet', 500, 5.00, 5000.00);`,
);
refused(
  "generating a bill beyond available stock is refused",
  `
  UPDATE bills SET status = 'ACTIVE', generated_at = now(), generated_by_id = 'u-staff' WHERE id = '${B2}';
  INSERT INTO inventory_transactions (id, variant_id, type, rented_delta, occurred_at, bill_id, bill_item_id, customer_id, created_by_id)
  VALUES (gen_random_uuid(), '${MM}', 'RENTAL_OUT', 500, now(), '${B2}', '${BI3}', '${CUST}', 'u-staff');`,
  "inventory_within_stock",
);
eq(
  "…and nothing from that attempt was kept",
  `select status || ' / ' || (${stock(MM)}) from bills where id = '${B2}'`,
  "DRAFT / 200,20,0",
);
refused(
  "stock cannot be reduced below what is out",
  `
  INSERT INTO inventory_transactions (id, variant_id, type, total_delta, occurred_at, reason, created_by_id)
  VALUES (gen_random_uuid(), '${MM}', 'MANUAL_ADJUSTMENT', -185, now(), 'Scrapped', 'u-admin')`,
  "inventory_within_stock",
);

// ── Return 1 on 26 Sep: 15 Muttu Maram + all 10 Runners, 3 days ──
eq(
  "A1: day count uses IST calendar dates (26 Sep 00:30 IST → 3 days)",
  `select (timestamptz '2026-09-26 00:30+05:30' at time zone 'Asia/Kolkata')::date - (timestamptz '2026-09-23 10:00+05:30' at time zone 'Asia/Kolkata')::date`,
  3,
);
eq(
  "…whereas UTC dates would under-count it as 2 days",
  `select (timestamptz '2026-09-26 00:30+05:30' at time zone 'UTC')::date - (timestamptz '2026-09-23 10:00+05:30' at time zone 'UTC')::date`,
  2,
);
ok(
  "return batch 1 recorded; bill updated in place",
  `
  BEGIN;
  SELECT id FROM bills WHERE id = '${B1}' FOR UPDATE;
  INSERT INTO returns (id, bill_id, return_no, returned_at, idempotency_key, processed_by_id)
  VALUES ('${R1}', '${B1}', 1, '2026-09-26 17:30+05:30', '11111111-1111-7111-8111-111111111111', 'u-staff');
  INSERT INTO return_items (id, return_id, bill_item_id, condition, quantity, chargeable_days, rate_per_day, amount) VALUES
    ('${RI1}', '${R1}', '${BI1}', 'GOOD', 15, 3, 5.00, 225.00),
    ('${RI2}', '${R1}', '${BI2}', 'GOOD', 10, 3, 8.00, 240.00);
  UPDATE bill_items SET returned_quantity = returned_quantity + 15 WHERE id = '${BI1}';
  UPDATE bill_items SET returned_quantity = returned_quantity + 10 WHERE id = '${BI2}';
  INSERT INTO inventory_transactions (id, variant_id, type, rented_delta, occurred_at, bill_id, bill_item_id, return_id, return_item_id, customer_id, created_by_id) VALUES
    (gen_random_uuid(), '${MM}', 'RETURN_IN', -15, '2026-09-26 17:30+05:30', '${B1}', '${BI1}', '${R1}', '${RI1}', '${CUST}', 'u-staff'),
    (gen_random_uuid(), '${RN}', 'RETURN_IN', -10, '2026-09-26 17:30+05:30', '${B1}', '${BI2}', '${R1}', '${RI2}', '${CUST}', 'u-staff');
  UPDATE bills SET status = 'PARTIALLY_RETURNED', version = version + 1, updated_at = now() WHERE id = '${B1}';
  COMMIT;`,
);
eq("Muttu Maram after return 1", stock(MM), "200,5,0");
eq(
  "charges so far ₹465; nothing settled mid-rental (A2)",
  `select rental_charges || ' / received ' || received from bill_financials where bill_id = '${B1}'`,
  "465.00 / received 500.00",
);
refused(
  "batch amount must equal qty × rate × days",
  `
  INSERT INTO returns (id, bill_id, return_no, returned_at, idempotency_key, processed_by_id)
  VALUES (gen_random_uuid(), '${B1}', 2, now(), gen_random_uuid(), 'u-staff');
  INSERT INTO return_items (id, return_id, bill_item_id, condition, quantity, chargeable_days, rate_per_day, amount)
  VALUES (gen_random_uuid(), (SELECT id FROM returns WHERE bill_id = '${B1}' AND return_no = 2), '${BI1}', 'GOOD', 5, 5, 5.00, 999.00);`,
  "return_items_amount_is_product",
);
refused(
  "damaged or lost pieces need a note (A3)",
  `
  INSERT INTO returns (id, bill_id, return_no, returned_at, idempotency_key, processed_by_id)
  VALUES (gen_random_uuid(), '${B1}', 2, now(), gen_random_uuid(), 'u-staff');
  INSERT INTO return_items (id, return_id, bill_item_id, condition, quantity, chargeable_days, rate_per_day, amount)
  VALUES (gen_random_uuid(), (SELECT id FROM returns WHERE bill_id = '${B1}' AND return_no = 2), '${BI1}', 'LOST', 1, 5, 5.00, 25.00);`,
  "return_items_note_for_damage_or_loss",
);
refused(
  "cannot return more than was taken",
  `UPDATE bill_items SET returned_quantity = 21 WHERE id = '${BI1}'`,
  "bill_items_returns_within_quantity",
);
refused(
  "cannot bring back more than is out",
  `
  INSERT INTO inventory_transactions (id, variant_id, type, rented_delta, occurred_at, bill_id, bill_item_id, return_id, return_item_id, customer_id, created_by_id)
  VALUES (gen_random_uuid(), '${MM}', 'RETURN_IN', -10, now(), '${B1}', '${BI1}', '${R1}', '${RI1}', '${CUST}', 'u-staff')`,
  "inventory_rented_nonnegative",
);
refused(
  "the same return form cannot be saved twice",
  `
  INSERT INTO returns (id, bill_id, return_no, returned_at, idempotency_key, processed_by_id)
  VALUES (gen_random_uuid(), '${B1}', 2, now(), '11111111-1111-7111-8111-111111111111', 'u-staff')`,
  "idempotency_key",
);
refused(
  "a processed return cannot be edited",
  `UPDATE returns SET notes = 'edited later' WHERE id = '${R1}'`,
  "cannot be edited",
);
refused("returns are never deleted", `DELETE FROM returns WHERE id = '${R1}'`, "never deleted");
refused(
  "return batches are append-only",
  `UPDATE return_items SET quantity = 1 WHERE id = '${RI1}'`,
  "append-only",
);
okRolledBack(
  "a return can be voided once (admin, with reason)",
  `
  UPDATE returns SET voided_at = now(), voided_by_id = 'u-admin', void_reason = 'Entered against the wrong bill' WHERE id = '${R1}';`,
);
refused(
  "voiding needs a reason",
  `UPDATE returns SET voided_at = now(), voided_by_id = 'u-admin' WHERE id = '${R1}'`,
  "returns_void_recorded",
);

// ── Return 2 on 28 Sep: last 5 Muttu Maram (3 good, 2 damaged), 5 days ──
ok(
  "return batch 2 recorded; damaged pieces held out of available stock",
  `
  BEGIN;
  INSERT INTO returns (id, bill_id, return_no, returned_at, idempotency_key, processed_by_id)
  VALUES ('${R2}', '${B1}', 2, '2026-09-28 09:00+05:30', gen_random_uuid(), 'u-staff');
  INSERT INTO return_items (id, return_id, bill_item_id, condition, quantity, chargeable_days, rate_per_day, amount, note) VALUES
    ('${RI3}', '${R2}', '${BI1}', 'GOOD', 3, 5, 5.00, 75.00, NULL),
    ('${RI4}', '${R2}', '${BI1}', 'DAMAGED', 2, 5, 5.00, 50.00, 'Two props bent at the ends');
  UPDATE bill_items SET returned_quantity = returned_quantity + 3, damaged_quantity = damaged_quantity + 2 WHERE id = '${BI1}';
  INSERT INTO inventory_transactions (id, variant_id, type, rented_delta, held_delta, occurred_at, bill_id, bill_item_id, return_id, return_item_id, customer_id, created_by_id) VALUES
    (gen_random_uuid(), '${MM}', 'RETURN_IN', -3, 0, '2026-09-28 09:00+05:30', '${B1}', '${BI1}', '${R2}', '${RI3}', '${CUST}', 'u-staff'),
    (gen_random_uuid(), '${MM}', 'RETURN_TO_HOLD', -2, 2, '2026-09-28 09:00+05:30', '${B1}', '${BI1}', '${R2}', '${RI4}', '${CUST}', 'u-staff');
  UPDATE bills SET status = 'RETURNED', settlement_status = 'ADDITIONAL_DUE', version = version + 1, updated_at = now() WHERE id = '${B1}';
  COMMIT;`,
);
eq("Muttu Maram: 200 owned, 0 out, 2 held → 198 available", stock(MM), "200,0,2");
eq(
  "final: 15×5×3 + 10×8×3 + 3×5×5 + 2×5×5 = ₹590; advance ₹500 → ₹90 due",
  `select rental_charges || ' / balance ' || balance from bill_financials where bill_id = '${B1}'`,
  "590.00 / balance 90.00",
);

// ── Payments ledger ──
refused(
  "reference only with UPI",
  `
  INSERT INTO payments (id, bill_id, type, status, amount, method, transaction_reference, received_at, idempotency_key, recorded_by_id)
  VALUES (gen_random_uuid(), '${B1}', 'ADDITIONAL', 'COMPLETED', 90, 'CASH', 'REF1', now(), gen_random_uuid(), 'u-staff')`,
  "payments_reference_only_for_upi",
);
refused(
  "money received needs a received time",
  `
  INSERT INTO payments (id, bill_id, type, status, amount, method, idempotency_key, recorded_by_id)
  VALUES (gen_random_uuid(), '${B1}', 'ADDITIONAL', 'COMPLETED', 90, 'CASH', gen_random_uuid(), 'u-staff')`,
  "payments_received_time",
);
refused(
  "zero payments are not recorded",
  `
  INSERT INTO payments (id, bill_id, type, status, amount, method, received_at, idempotency_key, recorded_by_id)
  VALUES (gen_random_uuid(), '${B1}', 'ADVANCE', 'COMPLETED', 0, 'CASH', now(), gen_random_uuid(), 'u-staff')`,
  "payments_amount_positive",
);
refused(
  'refunds cannot be "pending" (refund due is a settlement status)',
  `
  INSERT INTO payments (id, bill_id, type, status, amount, method, idempotency_key, recorded_by_id)
  VALUES (gen_random_uuid(), '${B1}', 'REFUND', 'PENDING', 10, 'CASH', gen_random_uuid(), 'u-staff')`,
  "payments_pending_only_incoming",
);
refused(
  "a discount needs a reason (A9)",
  `
  INSERT INTO payments (id, bill_id, type, status, amount, idempotency_key, recorded_by_id)
  VALUES (gen_random_uuid(), '${B1}', 'DISCOUNT', 'COMPLETED', 10, gen_random_uuid(), 'u-admin')`,
  "payments_discount_reason",
);
refused(
  "a discount has no payment method",
  `
  INSERT INTO payments (id, bill_id, type, status, amount, method, note, received_at, idempotency_key, recorded_by_id)
  VALUES (gen_random_uuid(), '${B1}', 'DISCOUNT', 'COMPLETED', 10, 'CASH', 'Regular customer', now(), gen_random_uuid(), 'u-admin')`,
  "payments_method_rules",
);
ok(
  "additional ₹90 by UPI settles the bill",
  `
  INSERT INTO payments (id, bill_id, type, status, amount, method, transaction_reference, received_at, return_id, idempotency_key, recorded_by_id)
  VALUES ('22222222-2222-7222-8222-222222222222', '${B1}', 'ADDITIONAL', 'COMPLETED', 90, 'UPI', 'UPI-424242', '2026-09-28 09:10+05:30', '${R2}', gen_random_uuid(), 'u-staff');
  UPDATE bills SET settlement_status = 'SETTLED', version = version + 1, updated_at = now() WHERE id = '${B1}';`,
);
eq(
  "ledger balance after settlement",
  `select balance from bill_financials where bill_id = '${B1}'`,
  "0.00",
);
refused(
  "payment amounts never change",
  `UPDATE payments SET amount = 100 WHERE id = '22222222-2222-7222-8222-222222222222'`,
  "never change",
);
refused(
  "payments are never deleted",
  `DELETE FROM payments WHERE id = '22222222-2222-7222-8222-222222222222'`,
  "never deleted",
);
refused(
  "completed payment cannot go back to pending",
  `UPDATE payments SET status = 'PENDING' WHERE id = '22222222-2222-7222-8222-222222222222'`,
  "cannot change from COMPLETED to PENDING",
);
refused(
  "cancelling needs a reason",
  `
  UPDATE payments SET status = 'CANCELLED', status_changed_at = now(), status_changed_by_id = 'u-admin'
  WHERE id = '22222222-2222-7222-8222-222222222222'`,
  "payments_status_change_recorded",
);
okRolledBack(
  "admin can cancel a mistaken payment with a reason",
  `
  UPDATE payments SET status = 'CANCELLED', status_changed_at = now(), status_changed_by_id = 'u-admin', status_change_reason = 'Entered twice'
  WHERE id = '22222222-2222-7222-8222-222222222222';`,
);
okRolledBack(
  '"Payment Not Yet" advance: pending, then received by UPI',
  `
  INSERT INTO payments (id, bill_id, type, status, amount, method, idempotency_key, recorded_by_id)
  VALUES ('33333333-3333-7333-8333-333333333333', '${B1}', 'ADDITIONAL', 'PENDING', 50, 'CASH', gen_random_uuid(), 'u-staff');
  UPDATE payments SET status = 'COMPLETED', method = 'UPI', transaction_reference = 'UPI-777', received_at = now(),
                      status_changed_at = now(), status_changed_by_id = 'u-staff'
  WHERE id = '33333333-3333-7333-8333-333333333333';`,
);
refused(
  "method cannot change without a status change",
  `
  UPDATE payments SET method = 'CASH', transaction_reference = NULL WHERE id = '22222222-2222-7222-8222-222222222222'`,
  "only together with a status change",
);
it("pending money is never counted as received", async () => {
  await client.query("BEGIN");
  try {
    await client.query(`INSERT INTO payments (id, bill_id, type, status, amount, method, idempotency_key, recorded_by_id)
                   VALUES (gen_random_uuid(), '${B1}', 'ADDITIONAL', 'PENDING', 50, 'CASH', gen_random_uuid(), 'u-staff');`);
    expect(
      await value(
        `select received || ' / pending ' || pending || ' / balance ' || balance from bill_financials where bill_id = '${B1}'`,
      ),
    ).toBe("590.00 / pending 50.00 / balance 0.00");
  } finally {
    await client.query("ROLLBACK");
  }
});

// ── Admin resolves held (damaged) stock (A3) ──
ok(
  "write off 1 damaged piece, release 1 repaired piece",
  `
  INSERT INTO inventory_transactions (id, variant_id, type, total_delta, held_delta, occurred_at, return_item_id, reason, created_by_id) VALUES
    (gen_random_uuid(), '${MM}', 'HOLD_WRITE_OFF', -1, -1, now(), '${RI4}', 'Beyond repair', 'u-admin'),
    (gen_random_uuid(), '${MM}', 'HOLD_RELEASE', 0, -1, now(), '${RI4}', 'Repaired and back in use', 'u-admin');`,
);
eq("Muttu Maram: 199 owned, nothing out or held", stock(MM), "199,0,0");
refused(
  "cannot release more than is held",
  `
  INSERT INTO inventory_transactions (id, variant_id, type, held_delta, occurred_at, reason, created_by_id)
  VALUES (gen_random_uuid(), '${MM}', 'HOLD_RELEASE', -1, now(), 'x', 'u-admin')`,
  "inventory_held_nonnegative",
);
refused(
  "stock ledger is append-only (update)",
  `UPDATE inventory_transactions SET reason = 'changed' WHERE type = 'INITIAL_STOCK'`,
  "append-only",
);
refused(
  "stock ledger is append-only (delete)",
  `DELETE FROM inventory_transactions WHERE type = 'INITIAL_STOCK'`,
  "append-only",
);

// ── Void a generated bill (A6) and cancel a draft (A4) ──
ok(
  "SMS-000003 generated with 5 Runners",
  `
  BEGIN;
  UPDATE counters SET value = value + 1, updated_at = now() WHERE key = 'bill_number';
  INSERT INTO bills (id, bill_seq, bill_number, customer_id, taken_at, expected_days, expected_return_date, site_location,
                     customer_name, customer_phone, customer_location, business_profile_id, created_by_id, updated_at)
  VALUES ('${B3}', 3, 'SMS-000003', '${CUST}', '2026-09-29 11:00+05:30', 1, '2026-09-30', 'Kunnathur',
          'Shanjiv', '9865276111', 'Kunnathur', (SELECT id FROM business_profiles WHERE version = 1), 'u-staff', now());
  INSERT INTO bill_items (id, bill_id, line_no, variant_id, material_name, variant_name, quantity, rate_per_day, estimated_amount)
  VALUES ('${BI4}', '${B3}', 1, '${RN}', 'Runner', '10 Feet', 5, 8.00, 40.00);
  UPDATE bills SET status = 'ACTIVE', generated_at = now(), generated_by_id = 'u-staff', estimated_amount = 40 WHERE id = '${B3}';
  INSERT INTO inventory_transactions (id, variant_id, type, rented_delta, occurred_at, bill_id, bill_item_id, customer_id, created_by_id)
  VALUES (gen_random_uuid(), '${RN}', 'RENTAL_OUT', 5, '2026-09-29 11:00+05:30', '${B3}', '${BI4}', '${CUST}', 'u-staff');
  COMMIT;`,
);
refused(
  "voiding a generated bill needs a reason",
  `
  UPDATE bills SET status = 'CANCELLED', cancelled_at = now(), cancelled_by_id = 'u-admin' WHERE id = '${B3}'`,
  "bills_cancellation_recorded",
);
ok(
  "void: status CANCELLED + stock reversed, number kept",
  `
  BEGIN;
  UPDATE bills SET status = 'CANCELLED', cancelled_at = now(), cancelled_by_id = 'u-admin',
                   cancel_reason = 'Created for the wrong customer', version = version + 1, updated_at = now() WHERE id = '${B3}';
  INSERT INTO inventory_transactions (id, variant_id, type, rented_delta, occurred_at, bill_id, bill_item_id, customer_id, created_by_id)
  VALUES (gen_random_uuid(), '${RN}', 'BILL_VOID_REVERSAL', -5, now(), '${B3}', '${BI4}', '${CUST}', 'u-admin');
  COMMIT;`,
);
eq("Runner stock restored after void", stock(RN), "100,0,0");
refused(
  "cancellation is final",
  `UPDATE bills SET status = 'ACTIVE' WHERE id = '${B3}'`,
  "cancellation is final",
);
refused(
  "only returned or cancelled bills can be archived",
  `
  UPDATE bills SET archived_at = now(), archived_by_id = 'u-admin' WHERE id = '${B2}'`,
  "bills_archive_rules",
);
ok(
  "a draft can be cancelled without a reason; its number stays used",
  `
  UPDATE bills SET status = 'CANCELLED', cancelled_at = now(), cancelled_by_id = 'u-staff', version = version + 1, updated_at = now() WHERE id = '${B2}';`,
);
ok(
  "returned bill archived (admin)",
  `
  UPDATE bills SET archived_at = now(), archived_by_id = 'u-admin', archive_reason = 'Old record' WHERE id = '${B1}';`,
);
refused(
  "bill counter never goes backwards",
  `UPDATE counters SET value = value - 1 WHERE key = 'bill_number'`,
  "only move forward",
);
refused("bill counter is never deleted", `DELETE FROM counters`, "never deleted");

// ── Other guards ──
refused("audit log is append-only", `UPDATE audit_logs SET summary = 'edited'`, "append-only");
refused(
  "business profile versions are append-only",
  `UPDATE business_profiles SET phones = ARRAY['123']`,
  "append-only",
);
ok(
  "changing company details adds profile version 2 (old bills keep v1)",
  `
  INSERT INTO business_profiles (id, version, name, tagline, address_lines, phones, created_by_id)
  VALUES (gen_random_uuid(), 2, 'SMS ASSOCIATES', 'Centering Materials Suppliers',
          ARRAY['101-A, Karungalmedu', 'Kunnathur - 638 103.'], ARRAY['9865276111'], 'u-admin');`,
);
eq(
  "old bill still points at header v1",
  `select bp.version from bills b join business_profiles bp on bp.id = b.business_profile_id where b.id = '${B1}'`,
  1,
);
refused(
  "ID proofs are always marked sensitive",
  `
  INSERT INTO customer_documents (id, customer_id, type, is_sensitive, storage_key, file_name, mime_type, size_bytes, sha256, uploaded_by_id)
  VALUES (gen_random_uuid(), '${CUST}', 'ID_PROOF', false, 'k1', 'a.jpg', 'image/jpeg', 100, 'x', 'u-staff')`,
  "customer_documents_id_proof_sensitive",
);
ok(
  "documents can be permanently deleted (A13)",
  `
  INSERT INTO customer_documents (id, customer_id, type, is_sensitive, storage_key, file_name, mime_type, size_bytes, sha256, uploaded_by_id)
  VALUES ('44444444-4444-7444-8444-444444444444', '${CUST}', 'ID_PROOF', true, 'k2', 'aadhaar-masked.jpg', 'image/jpeg', 100, 'x', 'u-staff');
  DELETE FROM customer_documents WHERE id = '44444444-4444-7444-8444-444444444444';`,
);
refused(
  "one default variant per material",
  `
  INSERT INTO material_variants (id, material_id, variant_name, updated_at) VALUES (gen_random_uuid(), '00000000-0000-7000-8000-00000000000c', '', now())`,
  "material_variants_material_id_variant_name_key",
);
refused(
  "rates cannot be negative",
  `UPDATE material_variants SET rate_per_day = -1 WHERE id = '${MM}'`,
  "material_variants_rate_nonnegative",
);
refused(
  "roles are admin or staff",
  `UPDATE users SET role = 'manager' WHERE id = 'u-staff'`,
  "users_role_valid",
);

// ── Integrity views must be empty ──
eq("stock counters match the ledger", `select count(*) from inventory_discrepancies`, 0);
eq(
  "rented stock matches pending pieces on open bills",
  `select count(*) from rented_stock_discrepancies`,
  0,
);
eq(
  "bill line return totals match their batches",
  `select count(*) from bill_item_return_discrepancies`,
  0,
);
