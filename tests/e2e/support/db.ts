import pg from "pg";

/** Reads from the end-to-end database, to check what the app recorded (audit log, sessions). */
export async function queryE2eDatabase<Row extends Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<Row[]> {
  const client = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await client.connect();
  try {
    return (await client.query<Row>(sql, params)).rows;
  } finally {
    await client.end();
  }
}
