import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";

import pg from "pg";
import type { TestProject } from "vitest/node";

import { testServerUrl, urlForDatabase } from "./env";

declare module "vitest" {
  export interface ProvidedContext {
    testServerUrl: string;
    templateDatabase: string;
  }
}

/**
 * Creates a template database and applies the real migrations to it with the
 * Prisma CLI, exactly as a deployment does. Each test file then clones it.
 */
export default async function setup(project: TestProject) {
  const serverUrl = testServerUrl();
  const template = `sms_test_template_${randomBytes(4).toString("hex")}`;

  const admin = new pg.Client({ connectionString: serverUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${template}`);
  await admin.end();

  const prisma = path.resolve(
    "node_modules/.bin",
    process.platform === "win32" ? "prisma.cmd" : "prisma",
  );
  execFileSync(prisma, ["migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: urlForDatabase(serverUrl, template) },
    stdio: "pipe",
  });

  project.provide("testServerUrl", serverUrl);
  project.provide("templateDatabase", template);

  return async () => {
    const cleanup = new pg.Client({ connectionString: serverUrl });
    await cleanup.connect();
    await cleanup.query(`DROP DATABASE IF EXISTS ${template} WITH (FORCE)`);
    await cleanup.end();
  };
}
