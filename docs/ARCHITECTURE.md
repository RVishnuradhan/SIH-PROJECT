# SMS Associates — Architecture & Decision Record (V1)

**Product:** Centering Materials Rental & Inventory Management System
**Source of truth:** [PRD.md](PRD.md) (v1.0) · **Database design:** [DATABASE.md](DATABASE.md)
**Status:** decisions A1–A21 and the database design approved 23 Sep 2026 · Phase 1 (project initialization) and Phase 2 (database) done · next: Phase 3, after approval

---

## Contents

1. [Product summary](#1-product-summary)
2. [V1 scope](#2-v1-scope)
3. [Approved decisions (A1–A21)](#3-approved-decisions-a1a21)
4. [Implementation principles](#4-implementation-principles)
5. [Business rules](#5-business-rules)
6. [Roles and permissions](#6-roles-and-permissions)
7. [Technical architecture](#7-technical-architecture)
8. [Core operations](#8-core-operations)
9. [Calculations](#9-calculations)
10. [Security](#10-security)
11. [Folder structure](#11-folder-structure)
12. [Implementation phase plan](#12-implementation-phase-plan)
13. [Defaults applied where the decisions were silent](#13-defaults-applied-where-the-decisions-were-silent)
14. [Open items](#14-open-items)
15. [Change log](#15-change-log)

---

## 1. Product summary

SMS Associates rents centering materials to builders and contractors. A customer takes materials to a site, pays an advance, and brings them back over one or more trips. The system is an internal, staff-only rental ERP built around one living record, the **bill**:

1. It is generated when materials go out. Stock leaves the available pool at that moment.
2. The Pending List tracks it while materials are outside.
3. At each return it is updated in place, keeping the same number. Returned pieces go back to stock, and each batch is charged for its real number of days.
4. When everything is back, it settles: the actual charges are compared with the payments recorded in the ledger, giving a refund or an amount due.
5. It stays permanent history that reads exactly as issued, even after rates, names, customer details or company details change.

Around the bill sit:
- a customer registry with private ID documents
- a material catalog stored as data
- an auditable stock ledger
- a payments ledger
- search, A4 PDF bills and a dashboard

## 2. V1 scope

**In scope:** everything in the PRD:
- Welcome/splash and login, then the Dashboard
- the New Bill wizard (4 steps)
- View Details: customers, Add Member, profile, documents, rental history
- the Pending List and return processing (partial and full)
- the Inventory module (stock, ledger, adjustments, low stock)
- payments, bill view and PDF, Bill History, search and filtering
- settings: catalog and rates, business profile, users, audit log
- responsive design, animation, security, audit, testing

**Not in V1** (only when you ask for them):
- WhatsApp integration, SMS integration, barcode/QR
- multi-branch, advanced analytics, customer portal
- complex accounting, GST
- automatic damage/loss charges
- a prominent discount workflow
- offline mode, customer merge, reminders, reports

**In the data model now, so no redesign is needed later:**
- damage/loss charges (`bill_charges`)
- discounts (a `DISCOUNT` ledger entry)
- GST (additive columns, see DATABASE.md §14)

## 3. Approved decisions (A1–A21)

| # | Decision | Where it lives |
|---|---|---|
| **A1** | Rental days = calendar-date difference between the taking date and the return date, **minimum 1**, on the **Asia/Kolkata** calendar. Times are stored and shown but don't change the count. The rule is stored on each bill. | `domain/rental-days.ts`; `bills.day_count_rule`, `bills.time_zone` |
| **A2** | Batch-based returns: each returned batch has its own quantity, date/time, chargeable days, rate and amount (e.g. 15 × rate × 3 + 5 × rate × 5). The advance belongs to the whole bill. No automatic partial refunds; settlement happens when the rental is fully returned. Staff may record an additional payment or refund manually at any time, and it is audited. | `returns`, `return_items`; `domain/settlement.ts` |
| **A3** | At return, each line can be **Returned, Damaged or Lost**. Damaged and lost pieces need a quantity and a note, stay out of available stock ("held"), and are resolved later by an admin (release or write-off). In V1 they are charged the normal rental amount up to their return date, with **no extra damage/loss penalty**; `bill_charges` keeps V2 damage/loss charges possible without a schema redesign. | `return_items.condition`; `inventory.held_quantity`; `HOLD_*` movements |
| **A4** | Saving step 1 creates the draft and **permanently assigns the bill number**, shown throughout the rest of the wizard. Abandoned drafts stay DRAFT and can be resumed. Staff can cancel them. Numbers are never reused. Format `SMS-000001`. | `counters`; `bills.bill_seq`, `bill_number` |
| **A5** | Not GST-registered: no GST calculations or GSTIN. The bill title is **"Rental Bill"**. The schema can take tax fields later. | `business_profiles.bill_title` |
| **A6** | After generation, lines, quantities and rates are locked. Notes, site location and expected duration are editable **by ADMIN only**, with every edit audit-logged; STAFF can't edit generated bills. An admin can void a generated bill: reason required, stock reversed, refund recorded in the ledger where applicable, number kept, never deleted. Materials taken later go on a **new** bill. | DB triggers `bills_guard`, `bill_items_guard`; void operation |
| **A7** | "Payment Finished" means the advance was actually received (COMPLETED). "Payment Not Yet" means PENDING, never counted as received. A ₹0 advance is allowed. | `payments.status` |
| **A8** | Two separate statuses. Rental: DRAFT, ACTIVE, PARTIALLY_RETURNED, RETURNED, CANCELLED. Settlement: NO_DUE, PAYMENT_PENDING, ADDITIONAL_DUE, REFUND_DUE, SETTLED. A bill can be RETURNED with its settlement still open. | `bills.status`, `bills.settlement_status` |
| **A9** | The catalog rate is always used, with no rate editing during billing; admins set rates in Settings. Discounts and waivers are supported in the data model, not a prominent V1 workflow: admin only, reason required, stored as a separate ledger record. | `payments.type = DISCOUNT` |
| **A10** | Phone numbers are **not unique**. Indian numbers are normalised (`+91 98652 76111`, `09865276111` and `9865276111` all become `9865276111`). A matching phone shows the existing customer as a suggestion; creating another customer needs confirmation. | `domain/phone.ts`; CHECK on `customers.phone` |
| **A11** | The customer has their own location. Each bill has a **site location**, prefilled from the customer's location, editable, and kept on the bill permanently. | `customers.location`, `bills.site_location` |
| **A12** | Two roles, ADMIN and STAFF (see §6). One admin at launch; the admin creates staff accounts. | `users.role`; `lib/permissions.ts` |
| **A13** | No physical deletion of history. Generated bills are voided or archived; customers with bills are archived; materials and variants with history are deactivated; documents may be permanently deleted by an admin, with an audit entry. | FK `RESTRICT` + triggers |
| **A14** | Existing paper rentals can be entered: back-dated taking date/time is allowed, with a warning when it is significantly old; no future taking dates; optional **Paper Bill Number**. | `bills.paper_bill_number`; `occurred_at` vs `created_at` |
| **A15** | No invented rates, stock or thresholds. The seed uses clearly marked TODO values (NULL rate, no stock movement, NULL threshold). Whole pieces. Exact PRD spellings. Bolts are not assumed free. | `prisma/seed/catalog.ts`; DATABASE.md §10 |
| **A16** | Active Rentals = bills with materials outside. Pending Returns = active rentals past their expected return date. Available Stock % = available ÷ total × 100. Low Stock = available ≤ threshold. | `modules/dashboard` |
| **A17** | Search by taking date, return date and date range; also by customer name, phone, bill number, location and status. | `modules/search`; indexes in DATABASE.md §12 |
| **A18** | A4 bills in English, with a proper Unicode font so that Tamil text customers give is stored and printed correctly. Temporary text logo. | `src/pdf/` (Noto Sans + Noto Sans Tamil) |
| **A19** | Splash → Continue → login (if signed out) → dashboard. The splash shows once per browser session. No dashboard data before authentication. | `(public)` routes |
| **A20** | Next.js + managed PostgreSQL + private object storage, with a secure but simple and affordable deployment. | §7, §14 |
| **A21** | Build in this repository. Before major changes, inspect it and keep useful existing work unless it conflicts. (The repo held only an unrelated README, which Phase 1 replaces.) | this repo |

## 4. Implementation principles

These come from your design review, and they take precedence over convenience.

- **P1 — Inventory is its own module, and stock is never edited.**
  - Available = total − currently rented − held (damaged/lost awaiting an admin).
  - Every movement is a row in an append-only ledger.
  - The counters are changed only by a database trigger fed by that ledger, and nobody can edit available quantity directly.
- **P2 — A generated bill is a frozen document.** It preserves:
  - customer name, phone and location
  - site location
  - company header and phone numbers (a versioned profile)
  - material and variant names, rates
  - expected duration and the day-counting rule

  Later changes to the customer, catalog, company details or rates never alter it.
- **P3 — Returns update the original bill.** There is no separate return bill. The bill number stays the same and the status moves. The return history is stored separately, one row per return event.
- **P4 — Partial returns are first-class.** A bill can have any number of returns, and each has its own date, days and amount.
- **P5 — Money is a ledger.** Individual payment records (ADVANCE ₹500 CASH, ADDITIONAL ₹90 UPI, REFUND ₹50 CASH …). No stored "total paid". The financial state is always calculated from the ledger.
- **P6 — Don't overbuild V1.** Keep the architecture extensible, but build only what V1 needs (§2).

## 5. Business rules

The rules are numbered so later phases can refer to them. Each is enforced on the server, and wherever possible also by the database (DATABASE.md §8).

**Bill numbers**
- **BR-1** The number is assigned by the database when wizard step 1 is saved. The format is `SMS-000001`. It is unique and sequential, and is never typed, edited or reused. Returns, voids and cancellation don't change it. (A4)

**Customers**
- **BR-2** Step 1 requires:
  - name and a valid phone number
  - the customer's location (for a new customer)
  - the site location
  - taking date and taking time

  Save and Continue stays disabled until everything is valid, with clear errors. (PRD §10–11, A11)
- **BR-3** Phone numbers are normalised to 10-digit Indian mobile numbers and are not unique. A matching phone or name offers the existing customer; creating another needs confirmation. (A10)
- **BR-4** Every bill belongs to an existing customer. The site location is prefilled from the customer and can be edited. (A11)
- **BR-5** Customers with bills are archived, never deleted. (A13)

**Catalog and pricing**
- **BR-6** Materials, variants, rates and thresholds are data that admins manage without code changes. A material without variants has one default variant, printed as "—".
- **BR-7** A variant whose rate isn't set can't be billed. Rates are never invented. (A15)
- **BR-8** Amounts are calculated only on the server. Estimate = quantity × rate × expected days. Batch amount = quantity × rate × chargeable days.
- **BR-9** A rate change affects only bills generated afterwards. There is no rate editing during billing. (A9)
- **BR-10** Materials and variants with history are deactivated, never deleted. (A13)

**Inventory**
- **BR-11** Available = total − rented − held. It is never edited directly. (P1)
- **BR-12** Every stock movement is recorded with who, when, why, and the bill or customer it relates to. The ledger is append-only.
- **BR-13** A bill can't be generated if any line exceeds what's available. The materials step shows the shortage as soon as the quantity is typed ("Only 20 available · requested 30 · short 10"). Generation checks again, authoritatively, inside its transaction.
- **BR-14** Only admins can set initial stock, adjust stock, or resolve held (damaged/lost) pieces, and each action needs a reason.
- **BR-15** Low stock means the variant has a threshold set and available ≤ that threshold.

**Bills**
- **BR-16** A generated bill has at least one line. Quantities are whole numbers of 1 or more. There is one line per variant.
- **BR-17** Generation is all-or-nothing: status ACTIVE, snapshots, one stock-out movement per line, the advance payment and the audit entry all happen together or not at all.
- **BR-18** After generation, the lines, quantities, rates, customer, taking date/time and snapshots are locked. Only the site location, notes and expected duration can change, by an admin, with an audit entry. (A6)
- **BR-19** Lifecycle: DRAFT → ACTIVE → PARTIALLY_RETURNED → RETURNED. A draft can go to CANCELLED (staff or admin). An active bill can go to CANCELLED only when an admin voids it: a reason is required and stock is reversed. Bills are never deleted. RETURNED and CANCELLED bills can be archived by an admin.
- **BR-20** Abandoned drafts stay DRAFT until someone resumes or cancels them. (A4)
- **BR-21** Materials taken later go on a new bill. (A6)
- **BR-22** The taking date/time may be in the past, with a warning when it is more than 7 days old, but never in the future. The paper bill number is optional. (A14)

**Returns**
- **BR-23** A bill can have any number of return events. Each has its own date/time, lines, condition (Returned, Damaged or Lost), chargeable days, rate and amount. (A2, A3)
- **BR-24** Per line, returned + damaged + lost ≤ taken, and each return is ≤ what is still pending.
- **BR-25** Chargeable days = max(1, return date − taking date) on the IST calendar. Times are recorded but don't count. The rule is stored on the bill. (A1)
- **BR-26** Damaged and lost pieces need a note and are charged rent up to the return date. They are held out of available stock until an admin releases them or writes them off. (A3)
- **BR-27** A return updates the original bill, and its status is derived automatically. The return history is kept separately. (P3, P4)
- **BR-28** A wrong return is corrected by an admin voiding the latest return (reason required). Returns are never edited.

**Money**
- **BR-29** Payments are ledger rows (ADVANCE, ADDITIONAL, REFUND, DISCOUNT). No totals are stored. Rows are never deleted and their amounts never change. (P5)
- **BR-30** "Payment Finished" means COMPLETED. "Payment Not Yet" means PENDING and is never counted as received. A ₹0 advance is allowed. (A7)
- **BR-31** No automatic partial refunds. Settlement happens once everything is returned. Staff may record an additional payment or a refund at any time, and each one is audited. (A2)
- **BR-32** Balance = rental charges + extra charges − discounts − (received − refunded). The settlement status is derived from the balance. (A8)
- **BR-33** Discounts are admin-only and need a reason. Each is a separate ledger row. It is not a prominent V1 screen. (A9)

**History, security and audit**
- **BR-34** A generated bill preserves everything listed under P2.
- **BR-35** Login is required everywhere except the splash and login pages. Every rule is enforced on the server. ID documents are private and only admins can open them. Important actions are audited.

## 6. Roles and permissions

| Capability | Admin | Staff |
|---|:-:|:-:|
| View dashboard, bills, Bill History, Pending List, rental history | ✓ | ✓ |
| Create, resume and generate bills | ✓ | ✓ |
| Cancel a draft | ✓ | ✓ |
| Edit site location / notes / expected duration of a generated bill | ✓ | — |
| Void a generated bill · archive a bill | ✓ | — |
| Process returns (Returned / Damaged / Lost) | ✓ | ✓ |
| Void a return | ✓ | — |
| Record payments (advance, additional, refund); mark a pending payment received | ✓ | ✓ |
| Cancel a recorded payment · record a discount | ✓ | — |
| Create and edit customers | ✓ | ✓ |
| Archive customers | ✓ | — |
| Upload customer documents · view customer photos | ✓ | ✓ |
| Open sensitive ID documents · delete documents | ✓ | — ¹ |
| View inventory and stock movements | ✓ | ✓ |
| Set initial stock · adjust stock · resolve damaged/lost | ✓ | — |
| Manage materials, variants, rates, thresholds | ✓ | — |
| Edit the business profile (bill header) | ✓ | — |
| Manage users · view the audit log | ✓ | — |

¹ Staff see that an ID document is on file (a blurred placeholder), but can't open it.

In code, each capability is a permission key (`bill.create`, `bill.void`, `return.void`, `payment.discount`, `document.viewSensitive`, `inventory.adjust`, `catalog.manage`, `user.manage`, `audit.view`, …) in one role → permission map. Every server action and data query checks it. Adding roles later means adding map entries, not changing code paths.

## 7. Technical architecture

**Shape:** a modular monolith: one Next.js application, one PostgreSQL database, one private file bucket. There are no microservices, caches or queues in V1. Module boundaries inside the code keep future splitting possible.

```
 Browser: server-rendered pages + interactive parts (wizard, forms, tables)
    │                                   │
    │ Server Actions (all writes)       │ Route handlers (PDF, files, search, auth)
    ▼                                   ▼
 Guard: session → permission → Zod validation → idempotency → friendly errors
    │
    ▼
 Domain services, one per module (billing, returns, payments, inventory, …)
    │   └─ pure rules, no I/O: day counting, amounts, settlement, status
    ▼
 Prisma 7 (+ raw SQL for row locks and search)
    │
    ├──► PostgreSQL: CHECKs, ledger trigger and history guards enforce the rules
    ├──► Private object storage (customer documents)
    └──► PDF renderer (reads the bill's stored snapshot data)
```

**Technology** (current stable versions checked 23 Sep 2026; exact versions pinned in Phase 1):

| Concern | Choice |
|---|---|
| App | Next.js 16.3 (App Router, Turbopack), React 19.2, TypeScript 5.9 (strict; TypeScript 7 isn't supported by typescript-eslint yet), pnpm 12, Node.js 24 LTS |
| UI | Tailwind CSS, shadcn/ui (accessible Radix components), Lucide icons, TanStack Table, sonner toasts, Motion (formerly Framer Motion) with reduced-motion respected |
| Forms | React Hook Form + Zod, with the same schemas validated again on the server |
| Database | PostgreSQL 16+ (managed; tested on 18; PostgreSQL 17 in Docker for local development), Prisma 7.10 with the `pg` driver adapter, `pg_trgm` for search. Prisma 8 is still a release candidate, so it isn't used. |
| Auth | Better Auth 1.x: username + password, sessions stored in the database, httpOnly secure cookies, login rate limiting, admin plugin for roles and deactivation |
| PDF | `@react-pdf/renderer` 4.x on the server, fed by the same bill view-model as the on-screen bill. A4. Embedded Noto Sans + Noto Sans Tamil, so ₹ and Tamil print correctly. |
| Files | Private S3-compatible bucket (Supabase Storage, Cloudflare R2 or AWS S3, Mumbai region preferred). Local folder in development. |
| Testing | Vitest (domain rules, services), integration tests against real PostgreSQL (including concurrency), Playwright end-to-end |
| CI | GitHub Actions: type-check, lint, unit + integration tests, build |
| Observability | Structured logs (pino), error tracking (e.g. Sentry), `/api/health` |

**Key design decisions:**
- **The server owns every number.** Amounts, days, stock and statuses are calculated on the server. Any value the browser sends is ignored.
- **One guard for every write.** Each server action checks, in order: session, permission, Zod validation and idempotency key. Then it calls the service in a transaction, writes the audit entry, and turns errors into friendly messages. Middleware only redirects signed-out users; it is never the security boundary.
- **Database-enforced integrity.** CHECK constraints, the stock-ledger trigger and history guards (DATABASE.md §8) make overselling, over-returning, editing stock, rewriting payments and deleting history impossible, even if the application has a bug.
- **Concurrency.**
  - Generation locks the variants' inventory rows in a fixed order.
  - Returns lock the bill row.
  - Bills carry a `version` number, so a stale screen can't overwrite newer data.
  - Double-clicks and resubmits are harmless: generation is a state change of the existing draft, and returns and payments carry idempotency keys.
- **Time.** Timestamps are stored in UTC. All day counting, "today", overdue checks and date search use Asia/Kolkata. Dates are shown as DD-MM-YYYY.
- **Money.** `numeric(12,2)` in the database and decimal arithmetic in code, never floating point. Shown as ₹ with Indian digit grouping.
- **Fresh data.** Business pages are always rendered with fresh data, because stale stock numbers are worse than a few milliseconds. Pages refresh after every change. Next.js 16's opt-in *Cache Components* model is evaluated in Phase 3, when authenticated data loading starts. Until then the default model is used, where route handlers and pages that read request data are dynamic.
- **Performance.**
  - Lists are paginated and searches are indexed.
  - Dashboard stats come from a few summary queries.
  - Heavy parts (PDF preview, image viewer) load only when opened.
  - Images are recompressed on upload.
  - PDFs are generated on request and cached per bill version.

## 8. Core operations

Each operation runs as **one database transaction** and writes its audit entry in the same transaction.

| Operation | Who | Steps |
|---|---|---|
| **Save step 1** | Staff/Admin | Validate the input and normalise the phone. Pick the existing customer or create one after confirmation. First save only: take the next number from `counters` and create the DRAFT with snapshots. Later saves update the draft (version check). |
| **Save steps 2–3** | Staff/Admin | Upsert lines (one per variant) with their current name and rate snapshots, refusing variants whose rate isn't set. Store expected days, notes and the advance input (`draft_advance_*`). Recalculate estimates. Show availability and shortages live; nothing is reserved. |
| **Generate bill** | Staff/Admin | 1. Lock the draft: it must still be DRAFT, at the version that was reviewed. 2. Re-check the catalog: if a rate or name changed since review, stop and ask for re-review. 3. Lock the inventory rows in variant order and check every line; any shortage refuses the whole generation with a per-line message. 4. Refresh the customer and header snapshots and set the day rule. 5. Write one RENTAL_OUT per line; the database trigger moves stock and its CHECK is the final backstop. 6. Create the ADVANCE payment if the amount is above zero (COMPLETED or PENDING per A7) and clear the draft fields. 7. Status → ACTIVE; settlement → NO_DUE or PAYMENT_PENDING. |
| **Process return** | Staff/Admin | 1. Lock the bill: ACTIVE or PARTIALLY_RETURNED; the idempotency key must be unused. 2. Validate: the return time isn't before the taking time or in the future; quantities are ≥ 1 and ≤ pending; damaged/lost pieces have notes. 3. Create the return and its lines; days = rule(taken, returned); amount = qty × snapshot rate × days. 4. Update the line totals. Write RETURN_IN (good) or RETURN_TO_HOLD (damaged/lost) movements. 5. Derive the status. If the bill is now RETURNED, compute the balance and settlement status. 6. Optionally record the money that changed hands (additional or refund) in the same step. |
| **Record payment** | Staff/Admin | Add an ADVANCE, ADDITIONAL or REFUND row (idempotency key), or mark a PENDING row as received (method, reference, time). Recompute the settlement status. |
| **Cancel payment · discount** | Admin | Cancel with a reason, or add a DISCOUNT row with a reason. Recompute the settlement status. |
| **Void bill** | Admin | Allowed only while the bill has no un-voided returns (void those first, newest first). Status → CANCELLED with a reason. BILL_VOID_REVERSAL per line. Cancel pending payments. Any money received shows as REFUND_DUE until the refund is recorded. |
| **Void return** | Admin | Latest return only, reason required. RETURN_VOID_REVERSAL per return line. Subtract the line totals. Re-derive the rental and settlement status. |
| **Cancel draft** | Staff/Admin | Status → CANCELLED and clear the draft fields. The number stays used and visible. |
| **Edit generated bill** | Admin | Site location, notes and/or expected days (the expected return date and estimates are recalculated). The version increments and the audit entry records before/after. |
| **Stock: initial / adjust / resolve held** | Admin | Lock the inventory row. Write INITIAL_STOCK, MANUAL_ADJUSTMENT, HOLD_RELEASE or HOLD_WRITE_OFF with a reason. The database refuses anything that would go negative or below what is out. |
| **Change rate / threshold / catalog** | Admin | Update the variant, with an audit entry recording before/after. Existing bills are unaffected (they hold snapshots). |
| **Change company details** | Admin | Insert a new business-profile version; new bills use it, old bills keep theirs. |

## 9. Calculations

These live in `src/domain/`: pure functions with exhaustive unit tests. The server is the only place they run.

```
chargeableDays(takenAt, returnedAt) = max(1, dateIST(returnedAt) − dateIST(takenAt))     A1
lineEstimate   = quantity × ratePerDay × expectedDays
batchAmount    = quantity × ratePerDay × chargeableDays
rentalCharges  = Σ batchAmount over non-voided returns
balance        = rentalCharges + extraCharges − discounts − (received − refunded)       A8

rental status   = RETURNED            if every line has pending = 0
                  PARTIALLY_RETURNED  if some pieces are accounted for
                  ACTIVE              otherwise                (DRAFT/CANCELLED are set explicitly)

settlement      = NO_DUE          draft / cancelled draft
                  PAYMENT_PENDING materials out and a promised payment not yet received
                  NO_DUE          materials out otherwise
                  ADDITIONAL_DUE  returned or voided, balance > 0
                  REFUND_DUE      returned or voided, balance < 0
                  SETTLED         returned or voided, balance = 0, money involved
                  NO_DUE          voided, nothing ever paid

overdue         = status ∈ {ACTIVE, PARTIALLY_RETURNED} and todayIST > expectedReturnDate
expectedReturnDate = dateIST(takenAt) + expectedDays
```

**Dashboard (A16):**
- Active Rentals = count of ACTIVE + PARTIALLY_RETURNED bills.
- Pending Returns = the overdue subset of those.
- Total Customers = customers who aren't archived.
- Available Stock % = Σ available ÷ Σ total × 100.
- Low Stock = count of variants with a threshold set and available ≤ that threshold.

## 10. Security

- **Authentication:**
  - username + password with Better Auth
  - no public sign-up: the first admin comes from a one-off script, and the admin creates staff
  - login rate limiting
  - sessions stored in the database, in httpOnly Secure SameSite=Lax cookies; they expire after 7 days of inactivity
  - deactivating a user ends their sessions
- **Authorization:** the role → permission map is checked in every server action, route handler and data query. Server Actions are public HTTP endpoints, so nothing relies on hiding UI. Middleware is only a redirect, never the security boundary.
- **Input:** Zod validation on the server for everything. React escaping, and notes rendered as text. Prisma parameterised queries, with raw SQL only through tagged templates.
- **ID documents (Aadhaar):**
  - stored in a private bucket, never on a public or long-lived link
  - streamed only through a permission-checked route, and every view is logged
  - staff are prompted to upload the masked Aadhaar (last 4 digits visible), and the ID number is never stored as text
  - staff see only a blurred placeholder
  - images are recompressed with location metadata stripped
  - type and size are validated
  - admins can delete a document permanently (logged)
  - India's DPDP Act, 2023 applies to this data, so a retention period is needed before go-live (§14)
- **Audit:** the append-only `audit_logs`, written in the same transaction as each change. Before/after values are recorded for edits, with no document contents or ID numbers.
- **Platform:** HTTPS only, and security headers including a Content-Security-Policy. Secrets are held in environment variables and never committed. Production uses a separate least-privilege database role. Automated backups, with a restore drill before go-live.
- **Errors:** users see clear messages, never stack traces. Unexpected errors show a reference ID that matches the server log.

## 11. Folder structure

```
SIH-PROJECT/
├── docs/
│   ├── PRD.md                        # product requirements (source of truth)
│   ├── ARCHITECTURE.md               # this document
│   ├── DATABASE.md                   # data model, rules, verification
│   └── database/erd.png              # rendered ER diagram
├── prisma/
│   ├── schema.prisma
│   ├── migrations/                   # init = Prisma DDL + CHECKs, triggers, views, pg_trgm
│   └── seed/
│       ├── index.ts                  # `pnpm db:seed` entry point
│       ├── seed.ts                   # create-only, safe to re-run
│       ├── business-profile.ts       # version 1, from the PRD
│       └── catalog.ts                # 13 materials / 28 variants, rates & stock TODO
├── prisma.config.ts
├── AGENTS.md · CLAUDE.md            # guidance for coding agents (Next.js block kept by `next dev`)
├── components.json                   # shadcn/ui configuration
├── vitest.config.mts · playwright.config.ts
├── scripts/
│   └── create-admin.ts               # first admin account (Phase 3)
├── public/                           # static assets (logo when provided)
├── src/
│   ├── app/
│   │   ├── (public)/
│   │   │   ├── page.tsx              # splash, once per session
│   │   │   └── login/page.tsx
│   │   ├── (app)/                    # signed-in shell: sidebar, top bar, global search
│   │   │   ├── layout.tsx
│   │   │   ├── dashboard/
│   │   │   ├── bills/
│   │   │   │   ├── new/              # step 1 → creates the draft and its number
│   │   │   │   └── [billNumber]/
│   │   │   │       ├── page.tsx      # bill: lines, returns, payments, timeline, PDF
│   │   │   │       ├── edit/[step]/  # draft steps: customer · materials · payment · review
│   │   │   │       └── return/       # return processing
│   │   │   ├── pending/              # Pending List
│   │   │   ├── history/              # Bill History (drafts, dues, archived filters)
│   │   │   ├── customers/            # "View Details" + Add Member
│   │   │   │   └── [customerId]/     # profile, documents, rental history
│   │   │   ├── inventory/
│   │   │   │   ├── [variantId]/      # one variant's movement ledger
│   │   │   │   └── held/             # damaged/lost awaiting an admin
│   │   │   └── settings/
│   │   │       ├── business/         # bill header (versioned)
│   │   │       ├── catalog/          # materials, variants, rates, thresholds
│   │   │       ├── users/
│   │   │       └── audit-log/
│   │   └── api/
│   │       ├── auth/[...all]/route.ts            # Better Auth
│   │       ├── bills/[billNumber]/pdf/route.ts
│   │       ├── documents/[documentId]/route.ts   # permission-checked, every view logged
│   │       ├── search/route.ts
│   │       └── health/route.ts
│   ├── modules/                      # one folder per business area:
│   │   ├── billing/                  #   service · schemas · queries · actions · components
│   │   │   └── bill-number.ts        #   atomic bill-number allocation (A4)
│   │   ├── returns/
│   │   ├── payments/
│   │   ├── inventory/
│   │   ├── catalog/
│   │   ├── customers/
│   │   ├── documents/
│   │   ├── business-profile/
│   │   ├── users/
│   │   ├── dashboard/
│   │   ├── search/
│   │   └── audit/
│   ├── domain/                       # pure rules, no I/O, exhaustively unit-tested
│   │   ├── money.ts                  # whole paise, never floating-point rupees
│   │   ├── rental-days.ts            # A1: IST calendar days, minimum 1
│   │   ├── stock.ts                  # available = total − rented − held
│   │   ├── pricing.ts                # estimates, batch amounts
│   │   ├── settlement.ts             # balance, settlement status (A8)
│   │   ├── bill-status.ts            # rental status from line totals
│   │   ├── bill-number.ts            # SMS-000001 format / parse
│   │   └── phone.ts                  # Indian mobile normalisation (A10)
│   ├── pdf/
│   │   ├── bill-document.tsx         # A4 "Rental Bill" template
│   │   └── fonts/                    # Noto Sans, Noto Sans Tamil
│   ├── components/
│   │   ├── ui/                       # shadcn/ui
│   │   ├── layout/                   # shell, navigation, page headers
│   │   └── shared/                   # status badges, money, data table, quantity stepper, states
│   ├── lib/
│   │   ├── db.ts                     # Prisma client (pg adapter)
│   │   ├── auth.ts                   # Better Auth configuration
│   │   ├── permissions.ts            # role → permission map (A12)
│   │   ├── action.ts                 # guard used by every server action
│   │   ├── storage.ts                # private S3-compatible storage
│   │   ├── format.ts                 # ₹ and DD-MM-YYYY display formatting
│   │   ├── errors.ts
│   │   ├── env.ts
│   │   └── logger.ts
│   └── generated/prisma/             # Prisma client output (git-ignored)
├── tests/
│   ├── unit/
│   ├── integration/                  # real PostgreSQL: DB guards, services, concurrency
│   │   └── support/                  #   per-file throw-away databases, SQL fixtures
│   └── e2e/                          # Playwright
├── docker-compose.yml                # PostgreSQL for local development
├── .env.example
└── .github/workflows/ci.yml
```

## 12. Implementation phase plan

The PRD's 18 phases are kept, with these adjustments from the analysis:
- The Definition of Done (§75) applies **inside every phase**. That means UI, backend, persistence, validation, error handling, responsive layout, loading and empty states, security and tests for everything the phase touches. Phases 15–18 are therefore final review passes, not the first time those things are done.
- Cross-cutting foundations (database guards, the action guard, audit logging) come early.
- Catalog management joins Inventory in Phase 6.

Each phase ends with passing tests, a push to the working branch and a short summary for your review.

| # | Phase | Scope | Done when |
|---|---|---|---|
| 1 | Project initialization | Next.js 16 + TypeScript (strict) + Tailwind + shadcn/ui; ESLint/Prettier; pnpm; typed env validation; Vitest and Playwright set up; Docker Compose PostgreSQL; GitHub Actions CI; replace the README; keep `docs/` | App runs locally; CI green |
| 2 | Database schema | Move the approved schema to `prisma/`; first migration with the database rules (CHECKs, triggers, views); Prisma client (pg adapter); seed (profile v1, counter, 13 materials / 28 variants with TODO values); `src/domain/` rules with unit tests; the 103 DB scenarios as integration tests, plus parallel-connection concurrency tests | `migrate reset` + seed works; all tests pass |
| 3 | Authentication & authorization | Better Auth (username + password), roles, permission map, action guard, audit writer, login page, first-admin script, user management (create staff, reset password, deactivate) | Signed-out users and staff are refused where they should be (tests) |
| 4 | Application shell | Responsive layout (sidebar, top bar, mobile navigation), design tokens (one brand colour + neutrals + status colours), shared components (data table, badges, money/date formatting, quantity stepper, empty/error/loading states, toasts, confirmation dialogs) | Shell works on phone, tablet and desktop; accessibility checks pass |
| 5 | Welcome & dashboard | Splash once per session → login → dashboard; quick actions; stat cards and Recent Activity on real queries, filled in as modules land | No data visible before login; stats correct for seeded data |
| 6 | Catalog & inventory | Settings: materials, variants, rates, thresholds; inventory overview; per-variant ledger; initial stock; adjustments; held stock (release/write-off); low stock; inventory search | Stock changes only through movements; admin-only actions enforced |
| 7 | Customer management | List and search, Add Member, profile, edit, archive; phone normalisation and duplicate suggestions; documents: validated upload, private storage, blurred ID placeholder, admin reveal (logged), permanent delete | Staff can't open ID documents; duplicates are suggested |
| 8 | New Bill workflow | Step 1 (existing/new customer, site location, taking date/time with back-dating warning, paper bill no.) → draft + number; step 2 (materials by category, live availability, shortage messages, "rate not set" handling); drafts list (resume/cancel) | Number assigned once and shown on every later step; drafts resumable |
| 9 | Payment | Step 3 (expected duration, notes, advance, method, status, UPI reference); step 4 review; the generation transaction; payments ledger on the bill (record additional/refund, receive pending, admin cancel); settlement status | Generation is all-or-nothing; overselling impossible; ledger totals correct |
| 10 | Bill preview & PDF | Bill page in every status; A4 PDF (Unicode fonts, text logo, return history, CANCELLED watermark); print; admin edit of site/notes/expected days; admin void | PDF matches the screen; ₹ and Tamil render |
| 11 | Pending List | Bills with materials out; taken/returned/damaged/lost/pending per line; overdue; search by name, date, bill number; status filters | Numbers match the dashboard |
| 12 | Return processing | Return form (partial/full, Returned/Damaged/Lost with notes, date/time); batch pricing; status update; settlement at final return with an optional payment/refund in the same step; admin "void latest return"; returned-bill PDF sections | PRD §34–§40 acceptance criteria pass |
| 13 | Rental history | Customer rental history; Bill History with status, settlement ("Dues"), date and archived filters; admin archive; audit log viewer | Old, returned and cancelled bills open exactly as issued |
| 14 | Search & filtering | Global search (customers, bills); taking/return date and range; location and status; index checks at realistic volume | Searches stay fast with 10,000+ bills |
| 15 | Security hardening | Review every action and route; headers/CSP; rate limits; upload hardening; least-privilege DB role; dependency audit; backup/restore drill | Security checklist signed off |
| 16 | Responsive optimization | Device testing; quick mobile flows (Pending List, returns) | Key flows usable at 360 px wide |
| 17 | Animation & visual polish | Page/card/modal transitions, feedback on generating a bill, micro-interactions; reduced motion respected | Animation never blocks the workflow |
| 18 | Testing, deployment & go-live | Full E2E regression; §74 acceptance checklist; UAT with the real catalog data; production deployment; go-live runbook (enter stock, enter open paper rentals) | Acceptance criteria met in production |

A staging deployment after Phase 5 is optional but recommended, so you can try each phase online. It needs the hosting decision in §14.

## 13. Defaults applied where the decisions were silent

Any of these can be changed without affecting the database design.

1. **Cancelling drafts:** both roles can cancel drafts (A4's "authorized staff").
2. **Editing generated bills:** editing site location, notes and expected duration after generation is **admin-only**, with an audit entry for every edit. *(Confirmed in the second review; now part of A6.)*
3. **Voiding a bill that has returns:** void its returns first, newest first; then void the bill.
4. **Correcting mistakes:**
   - A wrong return: an admin voids the latest return, with a reason.
   - A wrong payment: an admin cancels it, with a reason, and records a new one.
5. **Rent on damaged/lost pieces:** charged the normal rental amount like any batch, up to the return date. There are no extra damage or loss charges in V1. *(Confirmed in the second review; now part of A3.)*
6. **Resolving held stock:** an admin resolves damaged/lost pieces per variant (release or write-off), with a reason, linked to the return line where possible.
7. **Phone numbers:** Indian mobile numbers only (10 digits, starting 6–9). Landlines are not accepted.
8. **Back-dating:** the warning shows for taking dates more than **7 days** old.
9. **Login:** staff log in with **username + password**. Better Auth needs an email on each account, so the admin enters the staff member's email, or a hidden placeholder is stored.
10. **Sessions:** they expire after 7 days of inactivity.
11. **Staff and documents:** staff can view customer photos, and see a blurred placeholder for ID documents.
12. **Staff and inventory:** staff can view inventory and stock movements (read-only), to bill correctly.
13. **Missing catalog values:**
    - A variant without a rate can't be billed.
    - A variant without a threshold never shows as low stock.
    - A variant without stock shows 0 available.
14. **Bill dates:** the bill shows the **taking date/time** as its date. For a back-dated entry, a "Generated on" line is added in the footer.
15. **Display formats:** dates as DD-MM-YYYY; amounts as ₹ with Indian grouping, and paise shown only when present.
16. **Archive reasons:** optional. Void and cancellation reasons are required.
17. **Tooling:** Prisma 7.10 (stable), not the Prisma 8 release candidate; pnpm; current Node LTS.

## 14. Open items

**Genuinely undecided (not blocking Phases 1–2):**
- **Hosting accounts and budget:** needed before the first online deployment (a staging deployment after Phase 5, or Phase 18 at the latest).
  - Recommended default: **Supabase** (managed PostgreSQL + private Storage in the Mumbai region, on a paid plan for automated backups), with the app on **Vercel Pro** or **Render**. Vercel's free Hobby plan is for non-commercial use only.
  - Cheapest alternative: one small VPS running the app and PostgreSQL in Docker, where you own the backups.
  - Also needed: who owns the accounts, and whether you want a custom domain.
- **ID-document retention period:** how long to keep ID images after a customer's last rental. Needed before go-live, for privacy and India's DPDP Act. Until then, documents stay until an admin deletes them.

**Inputs to be provided later:**
- The real **daily rates, total stock and low-stock thresholds** for the 28 variants (A15). They're needed for realistic testing by Phase 9 at the latest, and are required before go-live. Placeholders are used until then.
- The **logo** file (A18), whenever it's ready.
- The first **admin's name, username and email** (Phase 3). The password is set by you when the account is created, never committed.

## 15. Change log

| Date | Change |
|---|---|
| 23 Sep 2026 | Analysis of PRD v1.0; decisions A1–A21 approved; implementation principles P1–P6 added; database design proposed and verified (DATABASE.md). |
| 23 Sep 2026 | Second review: database design approved; generated-bill edits confirmed ADMIN-only with audit (A6); damaged/lost pieces confirmed at normal rent with no V1 penalty (A3). |
| 23 Sep 2026 | Phase 1 done: Next.js 16.3 + TypeScript strict + Tailwind 4 + shadcn/ui foundation, design tokens, typed env, health check, security headers, Docker PostgreSQL, Vitest + Playwright tests, GitHub Actions CI. |
| 23 Sep 2026 | Phase 2 done: Prisma 7 schema and init migration (19 tables, 10 enums, 58 CHECKs, 11 triggers, 4 views); pg-adapter client; atomic bill numbers; seed with the exact PRD catalog and no invented values; `src/domain/` rules; the 103 scenarios plus migration, seed, bill-number, concurrency, settlement and snapshot integration tests on real PostgreSQL in CI. `docs/database/constraints.sql` merged into the migration. |
