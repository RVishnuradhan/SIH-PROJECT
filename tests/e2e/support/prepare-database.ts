/**
 * Prepares the end-to-end database before the app starts (run by the Playwright
 * web server command with the "react-server" condition, so app modules load as
 * they do in Next.js): a fresh database with the real migrations and seed, the
 * test accounts, and one customer with an ID proof (sensitive) and a photo
 * whose files sit in the private test storage folder.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import pg from "pg";

import { createPrismaClient } from "@/lib/db";
import { createUser } from "@/modules/users/service";

import { seed } from "../../../prisma/seed/seed";

import {
  admin,
  lockoutTarget,
  passwordChanger,
  PROJECTS,
  staff,
  testDocuments,
  type TestAccount,
} from "./accounts";
import { assertE2eDatabase } from "./e2e-env";

// A 1×1 PNG, enough for the browser to render the documents as images.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  const documentsDir = process.env.DOCUMENTS_DIR ?? "";
  const { name, serverUrl } = assertE2eDatabase(url);
  if (!documentsDir.includes(".e2e")) throw new Error(`Unexpected DOCUMENTS_DIR: ${documentsDir}`);

  const server = new pg.Client({ connectionString: serverUrl });
  await server.connect();
  await server.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await server.query(`CREATE DATABASE ${name}`);
  await server.end();

  execFileSync(path.resolve("node_modules/.bin/prisma"), ["migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });

  const db = createPrismaClient(url);
  try {
    await seed(db);
    const create = async (account: TestAccount) =>
      (
        await createUser(db, {
          actor: null,
          input: { ...account, email: undefined, confirmPassword: account.password },
          request: null,
        })
      ).id;
    const adminId = await create(admin);
    await create(staff);
    for (const project of PROJECTS) {
      await create(lockoutTarget(project));
      await create(passwordChanger(project));
    }

    const customer = await db.customer.create({
      data: {
        name: "Test Customer",
        phone: "9876543210",
        location: "Kunnathur",
        createdById: adminId,
      },
    });
    rmSync(documentsDir, { recursive: true, force: true });
    const files = [
      {
        id: testDocuments.idProof,
        type: "ID_PROOF",
        isSensitive: true,
        fileName: "aadhaar-masked.png",
      },
      {
        id: testDocuments.photo,
        type: "PHOTO",
        isSensitive: false,
        fileName: "customer-photo.png",
      },
    ] as const;
    for (const file of files) {
      const storageKey = `customers/${customer.id}/${file.id}.png`;
      const fullPath = path.join(documentsDir, storageKey);
      mkdirSync(path.dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, PNG);
      await db.customerDocument.create({
        data: {
          id: file.id,
          customerId: customer.id,
          type: file.type,
          isSensitive: file.isSensitive,
          storageKey,
          fileName: file.fileName,
          mimeType: "image/png",
          sizeBytes: PNG.byteLength,
          sha256: createHash("sha256").update(PNG).digest("hex"),
          uploadedById: adminId,
        },
      });
    }
  } finally {
    await db.$disconnect();
  }
  console.log(`End-to-end database ${name} is ready`);
}

main().catch((error: unknown) => {
  console.error("Preparing the end-to-end database failed:", error);
  process.exit(1);
});
