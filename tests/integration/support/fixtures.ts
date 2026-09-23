import type pg from "pg";

/**
 * SQL-level building blocks for integration tests. They write rows exactly the
 * way the Phase 8–12 services will (same statements, same order), so the
 * database rules are tested independently of any application code.
 */
type Queryable = pg.Pool | pg.PoolClient | pg.Client;

export async function one<T = Record<string, unknown>>(
  q: Queryable,
  sql: string,
  params: unknown[] = [],
): Promise<T> {
  const result = await q.query(sql, params);
  const row = result.rows[0] as T | undefined;
  if (!row) throw new Error(`No row returned by: ${sql}`);
  return row;
}

export async function insertUser(q: Queryable, id: string, role: "admin" | "staff" = "admin") {
  await q.query(
    `INSERT INTO users (id, name, email, username, role, updated_at)
     VALUES ($1, $1, $1 || '@example.invalid', $1, $2, now())`,
    [id, role],
  );
}

export async function insertBusinessProfileV1(q: Queryable): Promise<string> {
  const row = await one<{ id: string }>(
    q,
    `INSERT INTO business_profiles (id, version, name, tagline, address_lines, phones)
     VALUES (gen_random_uuid(), 1, 'SMS ASSOCIATES', 'Centering Materials Suppliers',
             ARRAY['101-A, Karungalmedu', 'Kunnathur - 638 103.'], ARRAY['9865276111', '9487270111'])
     RETURNING id`,
  );
  return row.id;
}

export async function insertCounter(q: Queryable) {
  await q.query(`INSERT INTO counters (key, value, updated_at) VALUES ('bill_number', 0, now())`);
}

/** A material with one variant, its zero stock row, and optionally a rate. */
export async function insertVariant(
  q: Queryable,
  materialName: string,
  variantName: string,
  ratePerDay: string | null,
): Promise<string> {
  const material = await one<{ id: string }>(
    q,
    `INSERT INTO materials (id, name, updated_at) VALUES (gen_random_uuid(), $1, now())
     ON CONFLICT (name) DO UPDATE SET name = excluded.name RETURNING id`,
    [materialName],
  );
  const variant = await one<{ id: string }>(
    q,
    `INSERT INTO material_variants (id, material_id, variant_name, rate_per_day, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, now()) RETURNING id`,
    [material.id, variantName, ratePerDay],
  );
  await q.query(`INSERT INTO inventory (variant_id) VALUES ($1)`, [variant.id]);
  return variant.id;
}

export async function recordInitialStock(
  q: Queryable,
  variantId: string,
  quantity: number,
  userId: string,
) {
  await q.query(
    `INSERT INTO inventory_transactions (id, variant_id, type, total_delta, occurred_at, reason, created_by_id)
     VALUES (gen_random_uuid(), $1, 'INITIAL_STOCK', $2, now(), 'Opening stock count', $3)`,
    [variantId, quantity, userId],
  );
}

export async function stockOf(q: Queryable, variantId: string) {
  return one<{ total: number; rented: number; held: number }>(
    q,
    `SELECT total_quantity AS total, rented_quantity AS rented, held_quantity AS held
     FROM inventory WHERE variant_id = $1`,
    [variantId],
  );
}

export async function insertCustomer(
  q: Queryable,
  userId: string,
  customer = { name: "Shanjiv", phone: "9865276111", location: "Kunnathur" },
): Promise<string> {
  const row = await one<{ id: string }>(
    q,
    `INSERT INTO customers (id, name, phone, location, created_by_id, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, now()) RETURNING id`,
    [customer.name, customer.phone, customer.location, userId],
  );
  return row.id;
}

export type DraftLine = {
  variantId: string;
  materialName: string;
  variantName: string;
  quantity: number;
  ratePerDay: string;
};

/**
 * A DRAFT bill with its lines. Takes the next number from the counter in the
 * same statement sequence the draft service uses.
 */
export async function insertDraftBill(
  q: Queryable,
  options: {
    customerId: string;
    userId: string;
    businessProfileId: string;
    takenAt: string;
    expectedDays: number;
    lines: DraftLine[];
  },
): Promise<{ billId: string; billNumber: string; itemIds: string[] }> {
  const { value: seq } = await one<{ value: number }>(
    q,
    `UPDATE counters SET value = value + 1, updated_at = now() WHERE key = 'bill_number' RETURNING value`,
  );
  const billNumber = `SMS-${String(seq).padStart(6, "0")}`;
  const bill = await one<{ id: string }>(
    q,
    `INSERT INTO bills (id, bill_seq, bill_number, customer_id, taken_at, expected_days,
                        expected_return_date, site_location, customer_name, customer_phone,
                        customer_location, business_profile_id, created_by_id, updated_at)
     SELECT gen_random_uuid(), $1, $2, c.id, $3::timestamptz, $4,
            (($3::timestamptz AT TIME ZONE 'Asia/Kolkata')::date + $4::int), c.location,
            c.name, c.phone, c.location, $5, $6, now()
     FROM customers c WHERE c.id = $7
     RETURNING id`,
    [
      seq,
      billNumber,
      options.takenAt,
      options.expectedDays,
      options.businessProfileId,
      options.userId,
      options.customerId,
    ],
  );
  const itemIds: string[] = [];
  for (const [index, line] of options.lines.entries()) {
    const item = await one<{ id: string }>(
      q,
      `INSERT INTO bill_items (id, bill_id, line_no, variant_id, material_name, variant_name,
                               quantity, rate_per_day, estimated_amount)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6::int, $7::numeric, $6::int * $7::numeric * $8::int)
       RETURNING id`,
      [
        bill.id,
        index + 1,
        line.variantId,
        line.materialName,
        line.variantName,
        line.quantity,
        line.ratePerDay,
        options.expectedDays,
      ],
    );
    itemIds.push(item.id);
  }
  return { billId: bill.id, billNumber, itemIds };
}

/** Generates a draft: ACTIVE + one RENTAL_OUT per line (the stock check happens here). */
export async function generateBill(q: Queryable, billId: string, userId: string) {
  await q.query(
    `UPDATE bills SET status = 'ACTIVE', generated_at = now(), generated_by_id = $2,
                      estimated_amount = (SELECT coalesce(sum(estimated_amount), 0) FROM bill_items WHERE bill_id = $1),
                      version = version + 1, updated_at = now()
     WHERE id = $1 AND status = 'DRAFT'`,
    [billId, userId],
  );
  await q.query(
    `INSERT INTO inventory_transactions (id, variant_id, type, rented_delta, occurred_at, bill_id,
                                         bill_item_id, customer_id, created_by_id)
     SELECT gen_random_uuid(), bi.variant_id, 'RENTAL_OUT', bi.quantity, b.taken_at, b.id, bi.id,
            b.customer_id, $2
     FROM bill_items bi JOIN bills b ON b.id = bi.bill_id
     WHERE b.id = $1
     ORDER BY bi.variant_id`,
    [billId, userId],
  );
}

export type ReturnLine = {
  billItemId: string;
  condition: "GOOD" | "DAMAGED" | "LOST";
  quantity: number;
  chargeableDays: number;
  note?: string;
};

/** One return batch: return row, its lines, line totals, stock movements. */
export async function insertReturn(
  q: Queryable,
  options: {
    billId: string;
    returnNo: number;
    returnedAt: string;
    userId: string;
    lines: ReturnLine[];
  },
): Promise<string> {
  const rentalReturn = await one<{ id: string }>(
    q,
    `INSERT INTO returns (id, bill_id, return_no, returned_at, idempotency_key, processed_by_id)
     VALUES (gen_random_uuid(), $1, $2, $3, gen_random_uuid(), $4) RETURNING id`,
    [options.billId, options.returnNo, options.returnedAt, options.userId],
  );
  for (const line of options.lines) {
    const item = await one<{ id: string }>(
      q,
      `INSERT INTO return_items (id, return_id, bill_item_id, condition, quantity, chargeable_days,
                                 rate_per_day, amount, note)
       SELECT gen_random_uuid(), $1, bi.id, $3, $4::int, $5::int, bi.rate_per_day,
              $4::int * bi.rate_per_day * $5::int, $6
       FROM bill_items bi WHERE bi.id = $2
       RETURNING id`,
      [
        rentalReturn.id,
        line.billItemId,
        line.condition,
        line.quantity,
        line.chargeableDays,
        line.note ?? null,
      ],
    );
    const column =
      line.condition === "GOOD"
        ? "returned_quantity"
        : line.condition === "DAMAGED"
          ? "damaged_quantity"
          : "lost_quantity";
    await q.query(`UPDATE bill_items SET ${column} = ${column} + $2 WHERE id = $1`, [
      line.billItemId,
      line.quantity,
    ]);
    await q.query(
      `INSERT INTO inventory_transactions (id, variant_id, type, rented_delta, held_delta, occurred_at,
                                           bill_id, bill_item_id, return_id, return_item_id, customer_id, created_by_id)
       SELECT gen_random_uuid(), bi.variant_id, $3, -$4::int, $5, $6, b.id, bi.id, $7, $8, b.customer_id, $9
       FROM bill_items bi JOIN bills b ON b.id = bi.bill_id WHERE bi.id = $1 AND b.id = $2`,
      [
        line.billItemId,
        options.billId,
        line.condition === "GOOD" ? "RETURN_IN" : "RETURN_TO_HOLD",
        line.quantity,
        line.condition === "GOOD" ? 0 : line.quantity,
        options.returnedAt,
        rentalReturn.id,
        item.id,
        options.userId,
      ],
    );
  }
  return rentalReturn.id;
}

/** Admin voids a return (BR-28): mark it, undo its line totals, reverse its stock. */
export async function voidReturn(q: Queryable, returnId: string, userId: string, reason: string) {
  await q.query(
    `UPDATE returns SET voided_at = now(), voided_by_id = $2, void_reason = $3 WHERE id = $1`,
    [returnId, userId, reason],
  );
  const items = await q.query<{
    id: string;
    bill_item_id: string;
    condition: string;
    quantity: number;
  }>(
    `SELECT id, bill_item_id, condition, quantity FROM return_items WHERE return_id = $1 ORDER BY bill_item_id`,
    [returnId],
  );
  for (const item of items.rows) {
    const column =
      item.condition === "GOOD"
        ? "returned_quantity"
        : item.condition === "DAMAGED"
          ? "damaged_quantity"
          : "lost_quantity";
    await q.query(`UPDATE bill_items SET ${column} = ${column} - $2 WHERE id = $1`, [
      item.bill_item_id,
      item.quantity,
    ]);
    await q.query(
      `INSERT INTO inventory_transactions (id, variant_id, type, rented_delta, held_delta, occurred_at,
                                           bill_id, bill_item_id, return_id, return_item_id, customer_id, created_by_id)
       SELECT gen_random_uuid(), bi.variant_id, 'RETURN_VOID_REVERSAL', $2::int, $3::int, now(),
              b.id, bi.id, $4, $5, b.customer_id, $6
       FROM bill_items bi JOIN bills b ON b.id = bi.bill_id WHERE bi.id = $1`,
      [
        item.bill_item_id,
        item.quantity,
        item.condition === "GOOD" ? 0 : -item.quantity,
        returnId,
        item.id,
        userId,
      ],
    );
  }
}

/**
 * Admin voids a generated bill with no remaining returns (A6): CANCELLED with a
 * reason, every piece back in stock, promised payments cancelled.
 */
export async function voidBill(q: Queryable, billId: string, userId: string, reason: string) {
  await q.query(
    `UPDATE bills SET status = 'CANCELLED', cancelled_at = now(), cancelled_by_id = $2, cancel_reason = $3,
                      version = version + 1, updated_at = now()
     WHERE id = $1`,
    [billId, userId, reason],
  );
  await q.query(
    `INSERT INTO inventory_transactions (id, variant_id, type, rented_delta, occurred_at, bill_id,
                                         bill_item_id, customer_id, reason, created_by_id)
     SELECT gen_random_uuid(), bi.variant_id, 'BILL_VOID_REVERSAL', -bi.quantity, now(), b.id, bi.id,
            b.customer_id, $3, $2
     FROM bill_items bi JOIN bills b ON b.id = bi.bill_id
     WHERE b.id = $1
     ORDER BY bi.variant_id`,
    [billId, userId, reason],
  );
  await q.query(
    `UPDATE payments SET status = 'CANCELLED', status_changed_at = now(), status_changed_by_id = $2,
                         status_change_reason = 'Bill voided: ' || $3
     WHERE bill_id = $1 AND status = 'PENDING'`,
    [billId, userId, reason],
  );
}

export async function insertPayment(
  q: Queryable,
  options: {
    billId: string;
    userId: string;
    type: "ADVANCE" | "ADDITIONAL" | "REFUND" | "DISCOUNT";
    status?: "PENDING" | "COMPLETED";
    amount: string;
    method?: "CASH" | "UPI" | null;
    note?: string;
  },
): Promise<string> {
  const status = options.status ?? "COMPLETED";
  const method = options.type === "DISCOUNT" ? null : (options.method ?? "CASH");
  const receivedAt =
    status === "COMPLETED" && options.type !== "DISCOUNT" ? new Date().toISOString() : null;
  const row = await one<{ id: string }>(
    q,
    `INSERT INTO payments (id, bill_id, type, status, amount, method, note, received_at,
                           idempotency_key, recorded_by_id)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, gen_random_uuid(), $8) RETURNING id`,
    [
      options.billId,
      options.type,
      status,
      options.amount,
      method,
      options.note ?? null,
      receivedAt,
      options.userId,
    ],
  );
  return row.id;
}

/** Every integrity view must be empty. */
export async function expectNoDiscrepancies(q: Queryable) {
  const views = [
    "inventory_discrepancies",
    "rented_stock_discrepancies",
    "bill_item_return_discrepancies",
  ];
  const counts: Record<string, number> = {};
  for (const view of views) {
    const row = await one<{ count: string }>(q, `SELECT count(*) FROM ${view}`);
    counts[view] = Number(row.count);
  }
  return counts;
}
