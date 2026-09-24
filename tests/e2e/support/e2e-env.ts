import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

/**
 * End-to-end tests run the app against their own database on the same
 * PostgreSQL server (never the development database): created fresh before the
 * run, dropped afterwards. Its name always starts with "sms_e2e".
 */
export const E2E_DATABASE_NAME = "sms_e2e";

/** Working folder for the test run (removed afterwards). */
export const E2E_ROOT = path.resolve(".e2e");
/** Private document storage for the test run. */
export const E2E_DOCUMENTS_DIR = path.join(E2E_ROOT, "documents");

export function e2eDatabaseUrl(): string {
  if (process.env.E2E_DATABASE_URL) return process.env.E2E_DATABASE_URL;
  let serverUrl = process.env.DATABASE_URL;
  for (const file of [".env.local", ".env"]) {
    if (serverUrl || !existsSync(file)) continue;
    serverUrl = parseEnv(readFileSync(file, "utf8")).DATABASE_URL;
  }
  if (!serverUrl) {
    throw new Error(
      "End-to-end tests need DATABASE_URL (a PostgreSQL server; the role needs CREATEDB)",
    );
  }
  const url = new URL(serverUrl);
  url.pathname = `/${E2E_DATABASE_NAME}`;
  return url.toString();
}

/** Refuses to touch any database that isn't the end-to-end one. */
export function assertE2eDatabase(url: string): { name: string; serverUrl: string } {
  const parsed = new URL(url);
  const name = decodeURIComponent(parsed.pathname.slice(1));
  if (!name.startsWith(E2E_DATABASE_NAME) || !/^[a-z0-9_]+$/.test(name)) {
    throw new Error(`Refusing to reset "${name}": not an end-to-end test database`);
  }
  parsed.pathname = "/postgres";
  return { name, serverUrl: parsed.toString() };
}
