import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";

/**
 * The PostgreSQL server integration tests may use. Tests never touch the
 * database named in the URL: they create throw-away `sms_test_*` databases on
 * the same server (the role needs CREATEDB).
 *
 * TEST_DATABASE_URL wins, then DATABASE_URL — from the environment, .env.local
 * or .env, like the app.
 */
export function testServerUrl(): string {
  for (const file of [".env.local", ".env"]) {
    if (!existsSync(file)) continue;
    for (const [key, value] of Object.entries(parseEnv(readFileSync(file, "utf8")))) {
      process.env[key] ??= value;
    }
  }
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "Integration tests need a PostgreSQL server: set TEST_DATABASE_URL (or DATABASE_URL), " +
        "e.g. start one with `pnpm db:up` and copy .env.example to .env.local.",
    );
  }
  return url;
}

/** The same server and credentials, pointed at another database. */
export function urlForDatabase(serverUrl: string, database: string): string {
  const url = new URL(serverUrl);
  url.pathname = `/${database}`;
  return url.toString();
}
