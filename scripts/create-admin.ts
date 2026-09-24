/**
 * Creates the first admin account (decision A12: no public sign-up).
 *
 *   pnpm admin:create                 asks for the details; the password is typed hidden
 *   pnpm admin:create --additional    creates another admin even though one exists
 *                                     (e.g. when the only admin can't sign in any more)
 *
 * For automated setups the details can come from the environment instead:
 * ADMIN_NAME, ADMIN_USERNAME, ADMIN_EMAIL (optional) and ADMIN_PASSWORD.
 * The password is never printed or logged.
 */
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { parseEnv } from "node:util";

import { createPrismaClient } from "@/lib/db";
import { createUserSchema } from "@/modules/users/schemas";
import { countActiveAdmins, createUser } from "@/modules/users/service";

for (const file of [".env.local", ".env"]) {
  if (!existsSync(file)) continue;
  for (const [key, value] of Object.entries(parseEnv(readFileSync(file, "utf8")))) {
    process.env[key] ??= value;
  }
}

const additional = process.argv.includes("--additional");
const interactive = process.stdin.isTTY === true && !process.env.ADMIN_PASSWORD;

async function ask(question: string, envKey: string, optional = false): Promise<string> {
  const fromEnv = process.env[envKey];
  if (fromEnv !== undefined) return fromEnv;
  if (!interactive) {
    if (optional) return "";
    throw new Error(`${envKey} is not set`);
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await prompt.question(question);
  } finally {
    prompt.close();
  }
}

/** Reads a line from the terminal without echoing it. */
function askHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    let value = "";
    process.stdout.write(question);
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");

    const done = (error?: Error) => {
      input.setRawMode(false);
      input.pause();
      input.removeListener("data", onData);
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === "\r" || character === "\n") return done();
        if (character === "\u0003") return done(new Error("Cancelled"));
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else if (character >= " ") value += character;
      }
    };
    input.on("data", onData);
  });
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set (copy .env.example to .env.local)");
  const db = createPrismaClient(databaseUrl);

  try {
    const existing = await countActiveAdmins(db);
    if (existing > 0 && !additional) {
      console.error(
        `An active admin account already exists (${existing}). Sign in as that admin and manage ` +
          "users in Settings → Users. To create another admin anyway (for example when no admin " +
          "can sign in), run: pnpm admin:create --additional",
      );
      process.exitCode = 1;
      return;
    }

    console.log("Create an admin account for SMS Associates.\n");
    const name = await ask("Full name: ", "ADMIN_NAME");
    const username = await ask("Username (used to sign in): ", "ADMIN_USERNAME");
    const email = await ask("Email (optional, press Enter to skip): ", "ADMIN_EMAIL", true);
    const password = interactive
      ? await askHidden("Password (at least 10 characters): ")
      : (process.env.ADMIN_PASSWORD ?? "");
    const confirmPassword = interactive ? await askHidden("Repeat the password: ") : password;

    const parsed = createUserSchema.safeParse({
      name,
      username,
      email,
      role: "admin",
      password,
      confirmPassword,
    });
    if (!parsed.success) {
      console.error("\nThe account was not created:");
      for (const issue of parsed.error.issues) {
        console.error(`  - ${String(issue.path[0] ?? "input")}: ${issue.message}`);
      }
      process.exitCode = 1;
      return;
    }

    await createUser(db, { actor: null, input: parsed.data, request: null });
    const signInUrl = new URL("/login", process.env.BETTER_AUTH_URL ?? "http://localhost:3000");
    console.log(`\nAdmin account "${parsed.data.username}" created. Sign in at ${signInUrl.href}`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  // A ServiceError message ("That username is already taken.") is safe to show;
  // nothing here ever contains the password.
  console.error(
    `\nThe account was not created: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
