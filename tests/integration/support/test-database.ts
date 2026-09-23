import { randomBytes } from "node:crypto";

import pg from "pg";
import { inject } from "vitest";

import { createPrismaClient, type Database } from "@/lib/db";

import { urlForDatabase } from "./env";

export type TestDatabase = {
  name: string;
  url: string;
  /** Raw connections for SQL-level tests (and parallel transactions). */
  pool: pg.Pool;
  /** A Prisma client on this database, created on first use. */
  prisma: () => Database;
  drop: () => Promise<void>;
};

// Cloning a template needs it to be idle, so clones are taken one at a time.
const CLONE_LOCK = 82_104;

/** A fresh, fully migrated database of its own for one test file. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const serverUrl = inject("testServerUrl");
  const template = inject("templateDatabase");
  const name = `sms_test_${randomBytes(6).toString("hex")}`;

  const admin = new pg.Client({ connectionString: serverUrl });
  await admin.connect();
  try {
    await admin.query("SELECT pg_advisory_lock($1)", [CLONE_LOCK]);
    await admin.query(`CREATE DATABASE ${name} TEMPLATE ${template}`);
  } finally {
    await admin.query("SELECT pg_advisory_unlock($1)", [CLONE_LOCK]);
    await admin.end();
  }

  const url = urlForDatabase(serverUrl, name);
  const pool = new pg.Pool({ connectionString: url, max: 25 });
  let prisma: Database | undefined;

  return {
    name,
    url,
    pool,
    prisma: () => (prisma ??= createPrismaClient(url)),
    async drop() {
      await prisma?.$disconnect();
      await pool.end();
      const cleanup = new pg.Client({ connectionString: serverUrl });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await cleanup.end();
    },
  };
}
