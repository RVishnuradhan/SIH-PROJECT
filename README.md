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
| 2. Database schema        | Next    |
| 3–18                      | Planned |

## Tech stack

Next.js 16 (App Router) · React 19 · TypeScript (strict) · Tailwind CSS 4 · shadcn/ui · Lucide ·
Zod · Vitest · Playwright · GitHub Actions. Coming in later phases: PostgreSQL + Prisma 7
(Phase 2), Better Auth (Phase 3), server-side PDF bills (Phase 10).

## Getting started

Requirements: **Node.js 24 LTS** and **pnpm 12** (Corepack installs the exact version pinned in
`package.json`). Docker is needed for the local database from Phase 2.

```bash
corepack enable          # once per machine
pnpm install
cp .env.example .env.local
pnpm dev                 # http://localhost:3000
```

## Scripts

| Command                             | What it does                                                                                                                                  |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`                          | Development server                                                                                                                            |
| `pnpm build` · `pnpm start`         | Production build and server                                                                                                                   |
| `pnpm check`                        | Lint, formatting, type check and unit tests — run before every push                                                                           |
| `pnpm lint` · `pnpm lint:fix`       | ESLint (zero warnings allowed)                                                                                                                |
| `pnpm format` · `pnpm format:check` | Prettier                                                                                                                                      |
| `pnpm typecheck`                    | Generates Next.js route types, then runs `tsc`                                                                                                |
| `pnpm test` · `pnpm test:watch`     | Unit tests (Vitest)                                                                                                                           |
| `pnpm test:e2e`                     | End-to-end tests (Playwright) against the production build — run `pnpm build` first; first time only: `pnpm exec playwright install chromium` |
| `pnpm db:up` · `pnpm db:down`       | Start / stop the local PostgreSQL in Docker (used from Phase 2)                                                                               |

CI (`.github/workflows/ci.yml`) runs the same checks, the build and the end-to-end tests on
every push and pull request.

## Project layout

```
docs/                 PRD, architecture and database design (+ schema proposal)
src/app/              routes: pages, layouts, API route handlers, icons, error pages
src/components/       ui/ (shadcn/ui primitives), brand/ (logo)
src/lib/              shared code: env validation, brand, utilities
tests/unit/           Vitest tests
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
