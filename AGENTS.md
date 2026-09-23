<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Project: SMS Associates

Centering Materials Rental & Inventory Management System. Read these before changing anything:

- `docs/PRD.md`: the requirements (source of truth, kept verbatim)
- `docs/ARCHITECTURE.md`: approved decisions A1–A21, business rules, roles, phase plan
- `docs/DATABASE.md`: data model and the rules the database enforces

Never weaken: bill snapshots, the stock ledger (stock changes only through
`inventory_transactions`), the payment ledger (no stored totals), return batches,
bill-number rules. Never invent material rates, stock quantities or thresholds.
Build only the current phase.

Database: the schema is `prisma/schema.prisma`; the rules Prisma can't express
(CHECKs, triggers, views) are in `prisma/migrations/*_init/migration.sql`. Never edit an
applied migration: change the schema and add a new one. Money is whole paise in
`src/domain/money.ts`; never use floating-point rupees.

Commands: `pnpm dev` · `pnpm check` (lint, format, types, unit tests) · `pnpm test:integration`
(needs PostgreSQL via `DATABASE_URL`) · `pnpm build` · `pnpm test:e2e` · `pnpm db:deploy` ·
`pnpm db:seed`
