import { rmSync } from "node:fs";

import pg from "pg";

import { assertE2eDatabase, e2eDatabaseUrl, E2E_ROOT } from "./e2e-env";

/** Leaves nothing behind: drops the end-to-end database and its document files. */
export default async function globalTeardown() {
  const { name, serverUrl } = assertE2eDatabase(e2eDatabaseUrl());
  const server = new pg.Client({ connectionString: serverUrl });
  await server.connect();
  try {
    await server.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  } finally {
    await server.end();
  }
  rmSync(E2E_ROOT, { recursive: true, force: true });
}
