import "server-only";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@/generated/prisma/client";
import { getServerEnv } from "@/lib/env";

export function createPrismaClient(connectionString: string) {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

export type Database = ReturnType<typeof createPrismaClient>;

// In development, hot reloads re-run this module; keeping the client on
// globalThis avoids opening a new connection pool on every edit.
const globalForPrisma = globalThis as unknown as { prisma?: Database };
let client: Database | undefined;

/** The server's single database client, created on first use. */
export function getDb(): Database {
  client ??= globalForPrisma.prisma ?? createPrismaClient(getServerEnv().DATABASE_URL);
  if (getServerEnv().NODE_ENV !== "production") globalForPrisma.prisma = client;
  return client;
}
