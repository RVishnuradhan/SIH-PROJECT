-- =============================================================================
-- SMS Associates — database rules that Prisma's schema language cannot express
-- PROPOSAL FOR REVIEW · companion to docs/database/schema.prisma
--
-- Phase 2 ships this inside the first migration, in this order:
--   1. Section 0 (extension) at the very top — the trigram indexes need it.
--   2. The DDL Prisma generates from schema.prisma.
--   3. Sections 1–4 below.
--
-- Verified: runs cleanly after Prisma 7.10's generated DDL on PostgreSQL 18
-- (PGlite), and a scenario suite exercised every guard (docs/DATABASE.md §9).
-- =============================================================================


-- ─── 0. Extensions ──────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pg_trgm; -- fuzzy/partial name and location search


-- ─── 1. CHECK constraints ───────────────────────────────────────────────────

ALTER TABLE users
  ADD CONSTRAINT users_role_valid CHECK (role IN ('admin', 'staff'));

ALTER TABLE business_profiles
  ADD CONSTRAINT business_profiles_version_positive CHECK (version >= 1),
  ADD CONSTRAINT business_profiles_name_present     CHECK (btrim(name) <> ''),
  ADD CONSTRAINT business_profiles_has_phone        CHECK (cardinality(phones) >= 1);

ALTER TABLE counters
  ADD CONSTRAINT counters_value_nonnegative CHECK (value >= 0);

ALTER TABLE customers
  ADD CONSTRAINT customers_name_present     CHECK (btrim(name) <> ''),
  ADD CONSTRAINT customers_location_present CHECK (btrim(location) <> ''),
  -- stored normalised: +91 98652 76111 / 09865276111 / 9865276111 → 9865276111
  ADD CONSTRAINT customers_phone_normalised CHECK (phone ~ '^[6-9][0-9]{9}$'),
  ADD CONSTRAINT customers_archive_recorded CHECK ((archived_at IS NULL) = (archived_by_id IS NULL));

ALTER TABLE customer_documents
  ADD CONSTRAINT customer_documents_size_positive      CHECK (size_bytes > 0),
  ADD CONSTRAINT customer_documents_id_proof_sensitive CHECK (type <> 'ID_PROOF' OR is_sensitive);

ALTER TABLE materials
  ADD CONSTRAINT materials_name_present CHECK (btrim(name) <> '');

ALTER TABLE material_variants
  -- NULL = not configured yet (no invented prices); such a variant cannot be billed
  ADD CONSTRAINT material_variants_rate_nonnegative      CHECK (rate_per_day IS NULL OR rate_per_day >= 0),
  ADD CONSTRAINT material_variants_threshold_nonnegative CHECK (low_stock_threshold IS NULL OR low_stock_threshold >= 0),
  ADD CONSTRAINT material_variants_name_trimmed          CHECK (variant_name = btrim(variant_name));

-- available = total − rented − held can never go below zero
ALTER TABLE inventory
  ADD CONSTRAINT inventory_total_nonnegative  CHECK (total_quantity >= 0),
  ADD CONSTRAINT inventory_rented_nonnegative CHECK (rented_quantity >= 0),
  ADD CONSTRAINT inventory_held_nonnegative   CHECK (held_quantity >= 0),
  ADD CONSTRAINT inventory_within_stock       CHECK (rented_quantity + held_quantity <= total_quantity);

-- Every movement type has one fixed effect on the counters, and says where it came from.
ALTER TABLE inventory_transactions
  ADD CONSTRAINT inventory_transactions_effect CHECK (
    CASE type
      WHEN 'INITIAL_STOCK'        THEN total_delta > 0  AND rented_delta = 0 AND held_delta = 0
      WHEN 'MANUAL_ADJUSTMENT'    THEN total_delta <> 0 AND rented_delta = 0 AND held_delta = 0
      WHEN 'RENTAL_OUT'           THEN rented_delta > 0 AND total_delta = 0  AND held_delta = 0
      WHEN 'RETURN_IN'            THEN rented_delta < 0 AND total_delta = 0  AND held_delta = 0
      WHEN 'RETURN_TO_HOLD'       THEN rented_delta < 0 AND total_delta = 0  AND held_delta = -rented_delta
      WHEN 'HOLD_RELEASE'         THEN held_delta < 0   AND total_delta = 0  AND rented_delta = 0
      WHEN 'HOLD_WRITE_OFF'       THEN held_delta < 0   AND total_delta = held_delta AND rented_delta = 0
      WHEN 'BILL_VOID_REVERSAL'   THEN rented_delta < 0 AND total_delta = 0  AND held_delta = 0
      WHEN 'RETURN_VOID_REVERSAL' THEN rented_delta > 0 AND total_delta = 0  AND held_delta IN (0, -rented_delta)
      ELSE false
    END),
  ADD CONSTRAINT inventory_transactions_source CHECK (
    CASE
      WHEN type IN ('RENTAL_OUT', 'BILL_VOID_REVERSAL') THEN
        bill_id IS NOT NULL AND bill_item_id IS NOT NULL AND customer_id IS NOT NULL
      WHEN type IN ('RETURN_IN', 'RETURN_TO_HOLD', 'RETURN_VOID_REVERSAL') THEN
        bill_id IS NOT NULL AND bill_item_id IS NOT NULL AND customer_id IS NOT NULL
        AND return_id IS NOT NULL AND return_item_id IS NOT NULL
      ELSE
        btrim(coalesce(reason, '')) <> ''   -- admin movements must say why
    END);

ALTER TABLE bills
  -- SMS-000001 … SMS-999999, then SMS-1000000 (never truncated)
  ADD CONSTRAINT bills_number_matches_seq CHECK (
    bill_seq >= 1
    AND bill_number = 'SMS-' || lpad(bill_seq::text, greatest(6, length(bill_seq::text)), '0')),
  ADD CONSTRAINT bills_expected_days_positive    CHECK (expected_days >= 1),
  ADD CONSTRAINT bills_site_location_present     CHECK (btrim(site_location) <> ''),
  ADD CONSTRAINT bills_customer_name_present     CHECK (btrim(customer_name) <> ''),
  ADD CONSTRAINT bills_customer_phone_normalised CHECK (customer_phone ~ '^[6-9][0-9]{9}$'),
  ADD CONSTRAINT bills_estimate_nonnegative      CHECK (estimated_amount >= 0),
  ADD CONSTRAINT bills_version_positive          CHECK (version >= 1),
  ADD CONSTRAINT bills_draft_advance_nonnegative CHECK (draft_advance_amount IS NULL OR draft_advance_amount >= 0),
  -- wizard payment input exists only while DRAFT; generation turns it into a Payment row
  ADD CONSTRAINT bills_draft_advance_only_in_draft CHECK (
    status = 'DRAFT'
    OR (draft_advance_amount IS NULL AND draft_advance_method IS NULL
        AND draft_advance_received IS NULL AND draft_advance_reference IS NULL)),
  ADD CONSTRAINT bills_generation_recorded CHECK (
    CASE status
      WHEN 'DRAFT'     THEN generated_at IS NULL AND generated_by_id IS NULL
      WHEN 'CANCELLED' THEN (generated_at IS NULL) = (generated_by_id IS NULL)
      ELSE generated_at IS NOT NULL AND generated_by_id IS NOT NULL
    END),
  -- cancelling a draft needs no reason; voiding a generated bill does
  ADD CONSTRAINT bills_cancellation_recorded CHECK (
    (status = 'CANCELLED') = (cancelled_at IS NOT NULL)
    AND (cancelled_at IS NULL) = (cancelled_by_id IS NULL)
    AND (status <> 'CANCELLED' OR generated_at IS NULL OR btrim(coalesce(cancel_reason, '')) <> '')),
  ADD CONSTRAINT bills_archive_rules CHECK (
    (archived_at IS NULL) = (archived_by_id IS NULL)
    AND (archived_at IS NULL OR status IN ('RETURNED', 'CANCELLED'))),
  ADD CONSTRAINT bills_draft_has_no_money CHECK (status <> 'DRAFT' OR settlement_status = 'NO_DUE');

ALTER TABLE bill_items
  ADD CONSTRAINT bill_items_line_no_positive        CHECK (line_no >= 1),
  ADD CONSTRAINT bill_items_quantity_positive       CHECK (quantity >= 1),
  ADD CONSTRAINT bill_items_rate_nonnegative        CHECK (rate_per_day >= 0),
  ADD CONSTRAINT bill_items_estimate_nonnegative    CHECK (estimated_amount >= 0),
  ADD CONSTRAINT bill_items_returns_nonnegative     CHECK (returned_quantity >= 0 AND damaged_quantity >= 0 AND lost_quantity >= 0),
  -- nothing can come back that was not taken
  ADD CONSTRAINT bill_items_returns_within_quantity CHECK (returned_quantity + damaged_quantity + lost_quantity <= quantity);

ALTER TABLE returns
  ADD CONSTRAINT returns_number_positive CHECK (return_no >= 1),
  ADD CONSTRAINT returns_void_recorded CHECK (
    (voided_at IS NULL) = (voided_by_id IS NULL)
    AND (voided_at IS NULL OR btrim(coalesce(void_reason, '')) <> ''));

ALTER TABLE return_items
  ADD CONSTRAINT return_items_quantity_positive CHECK (quantity >= 1),
  ADD CONSTRAINT return_items_days_positive     CHECK (chargeable_days >= 1),
  ADD CONSTRAINT return_items_rate_nonnegative  CHECK (rate_per_day >= 0),
  ADD CONSTRAINT return_items_amount_is_product CHECK (amount = quantity * rate_per_day * chargeable_days),
  ADD CONSTRAINT return_items_note_for_damage_or_loss CHECK (condition = 'GOOD' OR btrim(coalesce(note, '')) <> '');

ALTER TABLE payments
  ADD CONSTRAINT payments_amount_positive CHECK (amount > 0),
  ADD CONSTRAINT payments_method_rules CHECK (
    CASE WHEN type = 'DISCOUNT' THEN method IS NULL AND transaction_reference IS NULL
         ELSE method IS NOT NULL
    END),
  ADD CONSTRAINT payments_reference_only_for_upi CHECK (transaction_reference IS NULL OR method = 'UPI'),
  ADD CONSTRAINT payments_discount_reason        CHECK (type <> 'DISCOUNT' OR btrim(coalesce(note, '')) <> ''),
  -- only money coming in can be "promised"; refunds and discounts are recorded when they happen
  ADD CONSTRAINT payments_pending_only_incoming  CHECK (status <> 'PENDING' OR type IN ('ADVANCE', 'ADDITIONAL')),
  ADD CONSTRAINT payments_received_time          CHECK (status <> 'COMPLETED' OR type = 'DISCOUNT' OR received_at IS NOT NULL),
  ADD CONSTRAINT payments_status_change_recorded CHECK (
    (status_changed_at IS NULL) = (status_changed_by_id IS NULL)
    AND (status <> 'CANCELLED' OR btrim(coalesce(status_change_reason, '')) <> ''));

ALTER TABLE bill_charges
  ADD CONSTRAINT bill_charges_amount_positive     CHECK (amount > 0),
  ADD CONSTRAINT bill_charges_description_present CHECK (btrim(description) <> ''),
  ADD CONSTRAINT bill_charges_void_recorded CHECK (
    (voided_at IS NULL) = (voided_by_id IS NULL)
    AND (voided_at IS NULL OR btrim(coalesce(void_reason, '')) <> ''));

ALTER TABLE audit_logs
  ADD CONSTRAINT audit_logs_action_present CHECK (btrim(action) <> '');


-- ─── 2. Stock ledger → inventory counters ───────────────────────────────────
-- Inserting a movement is the only way to change stock. The trigger applies the
-- movement to the variant's counters; the CHECKs above then refuse anything that
-- would oversell or go negative, which rolls back the whole bill, return or
-- adjustment together with it.

CREATE FUNCTION apply_inventory_transaction() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE inventory
     SET total_quantity  = total_quantity  + NEW.total_delta,
         rented_quantity = rented_quantity + NEW.rented_delta,
         held_quantity   = held_quantity   + NEW.held_delta,
         updated_at      = now()
   WHERE variant_id = NEW.variant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No inventory row for variant %', NEW.variant_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER inventory_transactions_apply
  AFTER INSERT ON inventory_transactions
  FOR EACH ROW EXECUTE FUNCTION apply_inventory_transaction();

-- Counters cannot be written directly: rows start at zero, are never deleted,
-- and only the ledger trigger above (running nested, at trigger depth 2) may
-- change them. Nobody can "edit available stock".
CREATE FUNCTION guard_inventory_counters() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.total_quantity <> 0 OR NEW.rented_quantity <> 0 OR NEW.held_quantity <> 0 THEN
      RAISE EXCEPTION 'Inventory starts at zero; record stock with an INITIAL_STOCK movement';
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Inventory rows are never deleted; deactivate the variant instead';
  END IF;
  IF NEW.variant_id <> OLD.variant_id THEN
    RAISE EXCEPTION 'Inventory rows cannot move to another variant';
  END IF;
  IF pg_trigger_depth() < 2
     AND (NEW.total_quantity, NEW.rented_quantity, NEW.held_quantity)
         IS DISTINCT FROM (OLD.total_quantity, OLD.rented_quantity, OLD.held_quantity) THEN
    RAISE EXCEPTION 'Stock changes only through inventory_transactions';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER inventory_guard
  BEFORE INSERT OR UPDATE OR DELETE ON inventory
  FOR EACH ROW EXECUTE FUNCTION guard_inventory_counters();


-- ─── 3. History guards ──────────────────────────────────────────────────────

-- Append-only tables: rows are written once and never changed or removed.
CREATE FUNCTION forbid_update_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% refused)', TG_TABLE_NAME, TG_OP;
END;
$$;

CREATE TRIGGER inventory_transactions_append_only BEFORE UPDATE OR DELETE ON inventory_transactions
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
CREATE TRIGGER business_profiles_append_only BEFORE UPDATE OR DELETE ON business_profiles
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
CREATE TRIGGER return_items_append_only BEFORE UPDATE OR DELETE ON return_items
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();

-- Bill numbers only move forward and are never reused.
CREATE FUNCTION guard_counters() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Counters are never deleted';
  END IF;
  IF NEW.key <> OLD.key OR NEW.value < OLD.value THEN
    RAISE EXCEPTION 'Counter % can only move forward', OLD.key;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER counters_guard BEFORE UPDATE OR DELETE ON counters
  FOR EACH ROW EXECUTE FUNCTION guard_counters();

-- Bills are never deleted. The number never changes. Once generated, the
-- customer, taking date/time and every snapshot are frozen; only site
-- location, notes, expected duration, status, settlement and the cancel/archive
-- fields can still change. Cancellation is final.
CREATE FUNCTION guard_bills() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Bills are never deleted; cancel, void or archive instead';
  END IF;
  IF (NEW.id, NEW.bill_seq, NEW.bill_number, NEW.created_by_id, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.bill_seq, OLD.bill_number, OLD.created_by_id, OLD.created_at) THEN
    RAISE EXCEPTION 'Bill number % can never change', OLD.bill_number;
  END IF;
  IF OLD.status = 'CANCELLED' AND NEW.status <> 'CANCELLED' THEN
    RAISE EXCEPTION 'Bill % is cancelled; cancellation is final', OLD.bill_number;
  END IF;
  IF OLD.status <> 'DRAFT' THEN
    IF NEW.status = 'DRAFT' THEN
      RAISE EXCEPTION 'Bill % has been generated and cannot go back to draft', OLD.bill_number;
    END IF;
    IF (NEW.customer_id, NEW.taken_at, NEW.customer_name, NEW.customer_phone, NEW.customer_location,
        NEW.business_profile_id, NEW.day_count_rule, NEW.time_zone, NEW.paper_bill_number,
        NEW.generated_at, NEW.generated_by_id)
       IS DISTINCT FROM
       (OLD.customer_id, OLD.taken_at, OLD.customer_name, OLD.customer_phone, OLD.customer_location,
        OLD.business_profile_id, OLD.day_count_rule, OLD.time_zone, OLD.paper_bill_number,
        OLD.generated_at, OLD.generated_by_id) THEN
      RAISE EXCEPTION 'Bill % has been generated; its customer, taking date and snapshots are locked',
        OLD.bill_number;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER bills_guard BEFORE UPDATE OR DELETE ON bills
  FOR EACH ROW EXECUTE FUNCTION guard_bills();

-- Lines can be added, changed or removed only while the bill is a draft. After
-- generation only the running return totals (and the estimate, when an admin
-- changes the expected duration) may change.
CREATE FUNCTION guard_bill_items() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  bill_state rental_status;
BEGIN
  SELECT status INTO bill_state FROM bills WHERE id = COALESCE(NEW.bill_id, OLD.bill_id);

  IF TG_OP = 'INSERT' THEN
    IF bill_state <> 'DRAFT' THEN
      RAISE EXCEPTION 'Lines can only be added while the bill is a draft';
    END IF;
    IF NEW.returned_quantity <> 0 OR NEW.damaged_quantity <> 0 OR NEW.lost_quantity <> 0 THEN
      RAISE EXCEPTION 'A new line cannot already have returns';
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    IF bill_state <> 'DRAFT' THEN
      RAISE EXCEPTION 'Lines of a generated bill cannot be removed';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.bill_id <> OLD.bill_id THEN
    RAISE EXCEPTION 'A line cannot move to another bill';
  END IF;
  IF bill_state = 'DRAFT' THEN
    IF NEW.returned_quantity <> 0 OR NEW.damaged_quantity <> 0 OR NEW.lost_quantity <> 0 THEN
      RAISE EXCEPTION 'A draft cannot have returns';
    END IF;
  ELSIF (NEW.line_no, NEW.variant_id, NEW.material_name, NEW.variant_name, NEW.quantity, NEW.rate_per_day)
        IS DISTINCT FROM
        (OLD.line_no, OLD.variant_id, OLD.material_name, OLD.variant_name, OLD.quantity, OLD.rate_per_day) THEN
    RAISE EXCEPTION 'Material lines, quantities and rates are locked once the bill is generated';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER bill_items_guard BEFORE INSERT OR UPDATE OR DELETE ON bill_items
  FOR EACH ROW EXECUTE FUNCTION guard_bill_items();

-- A processed return is never edited or deleted. It can be voided once (admin,
-- with reason); the service reverses its stock movements in the same transaction.
CREATE FUNCTION guard_returns() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Returns are never deleted; void the return instead';
  END IF;
  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'Return % is already voided', OLD.return_no;
  END IF;
  IF (NEW.id, NEW.bill_id, NEW.return_no, NEW.returned_at, NEW.notes, NEW.idempotency_key,
      NEW.processed_by_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.bill_id, OLD.return_no, OLD.returned_at, OLD.notes, OLD.idempotency_key,
      OLD.processed_by_id, OLD.created_at) THEN
    RAISE EXCEPTION 'A processed return cannot be edited; void it and record it again';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER returns_guard BEFORE UPDATE OR DELETE ON returns
  FOR EACH ROW EXECUTE FUNCTION guard_returns();

-- Payments are never deleted, and their bill, type, amount and note never change.
-- Only the status moves: PENDING → COMPLETED | CANCELLED, COMPLETED → CANCELLED.
-- Method, reference and received time can be filled in only when a promised
-- payment is actually received.
CREATE FUNCTION guard_payments() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Payments are never deleted; cancel them with a reason';
  END IF;
  IF (NEW.id, NEW.bill_id, NEW.type, NEW.amount, NEW.note, NEW.return_id, NEW.idempotency_key,
      NEW.recorded_by_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.bill_id, OLD.type, OLD.amount, OLD.note, OLD.return_id, OLD.idempotency_key,
      OLD.recorded_by_id, OLD.created_at) THEN
    RAISE EXCEPTION 'A payment''s bill, type and amount never change; cancel it and record a new one';
  END IF;
  IF NEW.status = OLD.status THEN
    IF (NEW.method, NEW.transaction_reference, NEW.received_at,
        NEW.status_changed_at, NEW.status_changed_by_id, NEW.status_change_reason)
       IS DISTINCT FROM
       (OLD.method, OLD.transaction_reference, OLD.received_at,
        OLD.status_changed_at, OLD.status_changed_by_id, OLD.status_change_reason) THEN
      RAISE EXCEPTION 'Payment details change only together with a status change';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT ((OLD.status = 'PENDING' AND NEW.status IN ('COMPLETED', 'CANCELLED'))
       OR (OLD.status = 'COMPLETED' AND NEW.status = 'CANCELLED')) THEN
    RAISE EXCEPTION 'Payment status cannot change from % to %', OLD.status, NEW.status;
  END IF;
  IF NOT (OLD.status = 'PENDING' AND NEW.status = 'COMPLETED')
     AND (NEW.method, NEW.transaction_reference, NEW.received_at)
         IS DISTINCT FROM (OLD.method, OLD.transaction_reference, OLD.received_at) THEN
    RAISE EXCEPTION 'Method and reference can only be set when a pending payment is received';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER payments_guard BEFORE UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION guard_payments();


-- ─── 4. Read-only views ─────────────────────────────────────────────────────

-- Money on each bill, always calculated from the ledgers — never a stored total.
-- balance > 0: the customer owes that much · balance < 0: refund due.
-- While materials are still out, rental_charges covers only the batches
-- returned so far; the balance is final once the bill is RETURNED or voided.
CREATE VIEW bill_financials AS
SELECT b.id          AS bill_id,
       b.bill_number,
       b.status,
       coalesce(rc.rental_charges, 0) AS rental_charges,
       coalesce(ec.extra_charges, 0)  AS extra_charges,
       coalesce(p.received, 0)        AS received,
       coalesce(p.refunded, 0)        AS refunded,
       coalesce(p.discounts, 0)       AS discounts,
       coalesce(p.pending, 0)         AS pending,
       coalesce(rc.rental_charges, 0) + coalesce(ec.extra_charges, 0) - coalesce(p.discounts, 0)
         - (coalesce(p.received, 0) - coalesce(p.refunded, 0)) AS balance
FROM bills b
LEFT JOIN LATERAL (
  SELECT sum(ri.amount) AS rental_charges
  FROM returns r
  JOIN return_items ri ON ri.return_id = r.id
  WHERE r.bill_id = b.id AND r.voided_at IS NULL
) rc ON true
LEFT JOIN LATERAL (
  SELECT sum(c.amount) AS extra_charges
  FROM bill_charges c
  WHERE c.bill_id = b.id AND c.voided_at IS NULL
) ec ON true
LEFT JOIN LATERAL (
  SELECT sum(amount) FILTER (WHERE status = 'COMPLETED' AND type IN ('ADVANCE', 'ADDITIONAL')) AS received,
         sum(amount) FILTER (WHERE status = 'COMPLETED' AND type = 'REFUND')                  AS refunded,
         sum(amount) FILTER (WHERE status = 'COMPLETED' AND type = 'DISCOUNT')                AS discounts,
         sum(amount) FILTER (WHERE status = 'PENDING')                                        AS pending
  FROM payments
  WHERE bill_id = b.id
) p ON true;

-- Integrity checks, run by a scheduled job and by the test suite. Each view
-- must always be empty; any row means data drifted from its ledger.

-- Stock counters vs. the stock ledger.
CREATE VIEW inventory_discrepancies AS
SELECT i.variant_id,
       i.total_quantity,  coalesce(l.total, 0)  AS ledger_total,
       i.rented_quantity, coalesce(l.rented, 0) AS ledger_rented,
       i.held_quantity,   coalesce(l.held, 0)   AS ledger_held
FROM inventory i
LEFT JOIN (
  SELECT variant_id,
         sum(total_delta)  AS total,
         sum(rented_delta) AS rented,
         sum(held_delta)   AS held
  FROM inventory_transactions
  GROUP BY variant_id
) l ON l.variant_id = i.variant_id
WHERE (i.total_quantity, i.rented_quantity, i.held_quantity)
      IS DISTINCT FROM (coalesce(l.total, 0), coalesce(l.rented, 0), coalesce(l.held, 0));

-- Pieces "currently rented" vs. pieces still pending on open bills.
CREATE VIEW rented_stock_discrepancies AS
SELECT i.variant_id,
       i.rented_quantity,
       coalesce(o.pending, 0) AS pending_on_bills
FROM inventory i
LEFT JOIN (
  SELECT bi.variant_id,
         sum(bi.quantity - bi.returned_quantity - bi.damaged_quantity - bi.lost_quantity) AS pending
  FROM bill_items bi
  JOIN bills b ON b.id = bi.bill_id
  WHERE b.status IN ('ACTIVE', 'PARTIALLY_RETURNED', 'RETURNED')
  GROUP BY bi.variant_id
) o ON o.variant_id = i.variant_id
WHERE i.rented_quantity <> coalesce(o.pending, 0);

-- Each bill line's return totals vs. its (non-voided) return batches.
CREATE VIEW bill_item_return_discrepancies AS
SELECT bi.id AS bill_item_id,
       bi.bill_id,
       bi.returned_quantity, coalesce(x.good, 0)    AS batches_good,
       bi.damaged_quantity,  coalesce(x.damaged, 0) AS batches_damaged,
       bi.lost_quantity,     coalesce(x.lost, 0)    AS batches_lost
FROM bill_items bi
LEFT JOIN (
  SELECT ri.bill_item_id,
         sum(ri.quantity) FILTER (WHERE ri.condition = 'GOOD')    AS good,
         sum(ri.quantity) FILTER (WHERE ri.condition = 'DAMAGED') AS damaged,
         sum(ri.quantity) FILTER (WHERE ri.condition = 'LOST')    AS lost
  FROM return_items ri
  JOIN returns r ON r.id = ri.return_id AND r.voided_at IS NULL
  GROUP BY ri.bill_item_id
) x ON x.bill_item_id = bi.id
WHERE (bi.returned_quantity, bi.damaged_quantity, bi.lost_quantity)
      IS DISTINCT FROM (coalesce(x.good, 0), coalesce(x.damaged, 0), coalesce(x.lost, 0));
