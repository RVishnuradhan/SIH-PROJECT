# SMS Associates — Centering Materials Rental & Inventory Management System

A web application for **SMS Associates**, Centering Materials Suppliers (101-A, Karungalmedu,
Kunnathur - 638 103). It replaces paper bills with one system for customers, rental bills,
inventory, advance payments, partial and full returns, refunds and additional payments, and
permanent rental history.

## Documentation

| Document                                     | What it covers                                                               |
| -------------------------------------------- | ---------------------------------------------------------------------------- |
| [docs/PRD.md](docs/PRD.md)                   | Product requirements — the source of truth                                   |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Approved decisions (A1–A21), business rules, roles, architecture, phase plan |
| [docs/DATABASE.md](docs/DATABASE.md)         | Data model, ledgers, snapshots and the rules the database enforces           |

## Status

Built in 18 phases ([plan](docs/ARCHITECTURE.md#12-implementation-phase-plan)).

| Phase                     | Status  |
| ------------------------- | ------- |
| 1. Project initialization | ✅ Done |
| 2. Database schema        | ✅ Done |
| 3–18                      | Planned |

## Tech stack

Next.js 16 (App Router) · React 19 · TypeScript (strict) · Tailwind CSS 4 · shadcn/ui · Lucide ·
Zod · PostgreSQL + Prisma 7 (pg driver adapter) · Vitest · Playwright · GitHub Actions. Coming in
later phases: Better Auth (Phase 3), server-side PDF bills (Phase 10).

## Getting started

Requirements: **Node.js 24 LTS**, **pnpm 12** (Corepack installs the exact version pinned in
`package.json`) and **PostgreSQL 17** — easiest with Docker via `pnpm db:up`.

```bash
corepack enable          # once per machine
pnpm install             # also generates the Prisma client
cp .env.example .env.local
pnpm db:up               # local PostgreSQL in Docker (or point DATABASE_URL at your own)
pnpm db:deploy           # apply the migrations
pnpm db:seed             # bill header v1, bill-number counter, the 13 materials / 28 variants
pnpm dev                 # http://localhost:3000
```

The seed invents nothing: every rate, stock quantity and low-stock threshold starts empty
(TODO) until SMS Associates provides the real values. It is safe to run again; it only creates
what is missing.

## Scripts

| Command                             | What it does                                                                                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`                          | Development server                                                                                                                                            |
| `pnpm build` · `pnpm start`         | Production build and server                                                                                                                                   |
| `pnpm check`                        | Lint, formatting, type check and unit tests — run before every push                                                                                           |
| `pnpm lint` · `pnpm lint:fix`       | ESLint (zero warnings allowed)                                                                                                                                |
| `pnpm format` · `pnpm format:check` | Prettier                                                                                                                                                      |
| `pnpm typecheck`                    | Generates Next.js route types, then runs `tsc`                                                                                                                |
| `pnpm test` · `pnpm test:watch`     | Unit tests (Vitest)                                                                                                                                           |
| `pnpm test:integration`             | Database tests against real PostgreSQL (`TEST_DATABASE_URL`, else `DATABASE_URL`). Each test file gets its own throw-away database; the role needs `CREATEDB` |
| `pnpm test:e2e`                     | End-to-end tests (Playwright) against the production build — run `pnpm build` first; first time only: `pnpm exec playwright install chromium`                 |
| `pnpm db:up` · `pnpm db:down`       | Start / stop the local PostgreSQL in Docker                                                                                                                   |
| `pnpm db:deploy` · `pnpm db:status` | Apply pending migrations · show migration status                                                                                                              |
| `pnpm db:seed`                      | Seed the starting data (create-only, safe to re-run)                                                                                                          |
| `pnpm db:migrate`                   | Create a new migration after changing `prisma/schema.prisma` (development only; never edit an applied migration)                                              |
| `pnpm db:reset`                     | Drop and re-create the local database from the migrations, then run `pnpm db:seed` (development only — deletes all data)                                      |
| `pnpm db:generate`                  | Regenerate the Prisma client (runs automatically on install)                                                                                                  |

CI (`.github/workflows/ci.yml`) runs on every push and pull request: the checks and the build
(without a database), the migrations + seed + integration tests on PostgreSQL 17, and the
end-to-end tests.

## Project layout

```
docs/                 PRD, architecture and database design
prisma/               schema.prisma, migrations/ (tables + database rules), seed/
src/app/              routes: pages, layouts, API route handlers, icons, error pages
src/components/       ui/ (shadcn/ui primitives), brand/ (logo)
src/domain/           pure business rules: money, rental days, pricing, stock, statuses, settlement
src/modules/          business areas (billing: bill-number allocation so far)
src/lib/              shared code: database client, env validation, brand, utilities
tests/unit/           Vitest unit tests
tests/integration/    database tests on real PostgreSQL (rules, concurrency, settlement, seed)
tests/e2e/            Playwright tests
```

The full target structure is in [ARCHITECTURE.md §11](docs/ARCHITECTURE.md#11-folder-structure).

## Ground rules

- Follow the PRD and the approved decisions in `docs/`. Never weaken the ledger, snapshot,
  return-batch or bill-number rules.
- Never invent business data: material rates, stock quantities and low-stock thresholds stay
  as TODO placeholders until SMS Associates provides the real values.
- Every feature meets the PRD's Definition of Done (§75): UI, backend, persistence, validation,
  error handling, responsive layout, loading and empty states, security and tests.
