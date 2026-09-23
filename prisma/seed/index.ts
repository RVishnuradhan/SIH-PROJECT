import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../../src/generated/prisma/client";

import { seed } from "./seed";

// Run with `pnpm db:seed` (prisma db seed), which loads .env.local / .env.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set. Copy .env.example to .env.local first.");
  process.exit(1);
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

try {
  const summary = await seed(prisma);
  console.log("Seed complete:", summary);
} finally {
  await prisma.$disconnect();
}
