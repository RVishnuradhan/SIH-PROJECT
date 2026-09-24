/**
 * `pnpm admin:create`, run for real against a throw-away database the way an
 * operator runs it (details from the environment, as in an automated setup).
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { verifyPassword } from "@/modules/auth/password";

import { createTestDatabase, type TestDatabase } from "./support/test-database";

const run = promisify(execFile);
const tsx = path.resolve("node_modules/.bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
const PASSWORD = "first-admin-passphrase";

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database?.drop();
});

async function createAdmin(env: Record<string, string>, args: string[] = []) {
  try {
    const { stdout, stderr } = await run(
      tsx,
      ["--conditions=react-server", "scripts/create-admin.ts", ...args],
      {
        env: {
          ...process.env,
          DATABASE_URL: database.url,
          BETTER_AUTH_URL: "https://sms.example.com",
          ...env,
        },
      },
    );
    return { code: 0, output: `${stdout}${stderr}` };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}

describe("pnpm admin:create", () => {
  it("refuses bad details and creates nothing", async () => {
    const result = await createAdmin({
      ADMIN_NAME: "Owner",
      ADMIN_USERNAME: "x",
      ADMIN_PASSWORD: "short",
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain("The account was not created:");
    expect(result.output).toContain("username: Use at least 3 characters");
    expect(result.output).toContain("password: Use at least 10 characters");
    expect(result.output).not.toContain("short");
    expect(await database.prisma().user.count()).toBe(0);
  });

  it("creates the first admin, without ever printing the password", async () => {
    const result = await createAdmin({
      ADMIN_NAME: "Shop Owner",
      ADMIN_USERNAME: "Owner",
      ADMIN_EMAIL: "",
      ADMIN_PASSWORD: PASSWORD,
    });
    expect(result.code).toBe(0);
    expect(result.output).toContain(
      'Admin account "owner" created. Sign in at https://sms.example.com/login',
    );
    expect(result.output).not.toContain(PASSWORD);

    const prisma = database.prisma();
    const owner = await prisma.user.findUniqueOrThrow({
      where: { username: "owner" },
      include: { accounts: true },
    });
    expect(owner).toMatchObject({
      name: "Shop Owner",
      role: "admin",
      banned: false,
      email: "owner@no-email.invalid",
    });
    expect(await verifyPassword({ hash: owner.accounts[0]!.password!, password: PASSWORD })).toBe(
      true,
    );

    const entry = await prisma.auditLog.findFirstOrThrow({ where: { action: "user.created" } });
    expect(entry).toMatchObject({ actorId: null, entityId: owner.id });
    expect(entry.summary).toBe('Setup script created admin account "owner" for Shop Owner');
  });

  it("refuses to run again once an admin exists", async () => {
    const result = await createAdmin({
      ADMIN_NAME: "Other",
      ADMIN_USERNAME: "other",
      ADMIN_PASSWORD: PASSWORD,
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain("An active admin account already exists (1).");
    expect(await database.prisma().user.count()).toBe(1);
  });

  it("creates another admin with --additional (recovery)", async () => {
    const result = await createAdmin(
      { ADMIN_NAME: "Recovery", ADMIN_USERNAME: "recovery", ADMIN_PASSWORD: PASSWORD },
      ["--additional"],
    );
    expect(result.code).toBe(0);
    expect(await database.prisma().user.count({ where: { role: "admin" } })).toBe(2);
  });

  it("refuses a username that is taken, even with --additional", async () => {
    const result = await createAdmin(
      { ADMIN_NAME: "Dup", ADMIN_USERNAME: "owner", ADMIN_PASSWORD: PASSWORD },
      ["--additional"],
    );
    expect(result.code).toBe(1);
    expect(result.output).toContain("The account was not created: That username is already taken.");
  });
});
