import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";

import { defineConfig } from "prisma/config";

// Prisma doesn't read .env files. Use the same files as Next.js for local work;
// real environment variables always win, then .env.local, then .env.
for (const file of [".env.local", ".env"]) {
  if (!existsSync(file)) continue;
  for (const [key, value] of Object.entries(parseEnv(readFileSync(file, "utf8")))) {
    process.env[key] ??= value;
  }
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed/index.ts",
  },
  datasource: {
    // Only migrate/seed/studio need it; `prisma generate` works without a database.
    url: process.env.DATABASE_URL ?? "",
  },
});
