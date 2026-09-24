/**
 * The real `src/proxy.ts` against a throw-away database: early redirects to
 * sign-in (keeping where you were going), and keeping active sessions alive —
 * once a day of use, the session and cookie are pushed 7 days forward.
 */
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "@/lib/db";
import { createUser } from "@/modules/users/service";

import { createTestDatabase, type TestDatabase } from "./support/test-database";

const SECRET = "proxy-test-secret-0123456789abcdefghijklmn";
const PASSWORD = "proxy-test-passphrase";

let database: TestDatabase;
let db: Database;
let proxy: (request: NextRequest) => Promise<Response>;
let cookie: string;
let userId: string;

function request(path: string, init: { cookie?: string; method?: string } = {}) {
  const headers = new Headers({ "x-forwarded-for": "203.0.113.40" });
  if (init.cookie) headers.set("cookie", init.cookie);
  return new NextRequest(`http://localhost:3000${path}`, { headers, method: init.method ?? "GET" });
}

const passedThrough = (response: Response) => response.headers.get("x-middleware-next") === "1";

beforeAll(async () => {
  database = await createTestDatabase();
  db = database.prisma();
  // The proxy uses the app's own configuration, read from the environment.
  process.env.DATABASE_URL = database.url;
  process.env.BETTER_AUTH_SECRET = SECRET;
  process.env.BETTER_AUTH_URL = "http://localhost:3000";
  ({ proxy } = await import("@/proxy"));

  const { getAuth } = await import("@/lib/auth");
  const { signInWithPassword } = await import("@/modules/auth/sign-in");
  const { KeyedLock } = await import("@/modules/auth/throttle");
  userId = (
    await createUser(db, {
      actor: null,
      input: {
        name: "Ravi",
        username: "ravi",
        role: "staff",
        password: PASSWORD,
        confirmPassword: PASSWORD,
      },
      request: null,
    })
  ).id;
  const outcome = await signInWithPassword(
    { auth: getAuth(), db, secret: SECRET, lock: new KeyedLock() },
    {
      username: "ravi",
      password: PASSWORD,
      headers: new Headers({ "x-forwarded-for": "203.0.113.40" }),
    },
  );
  if (outcome.status !== "signed-in") throw new Error(outcome.status);
  cookie = /(sms\.session_token=[^;]+)/.exec(outcome.responseHeaders.get("set-cookie") ?? "")![1]!;
});

afterAll(async () => {
  await database?.drop();
});

describe("proxy", () => {
  it("sends signed-out visitors of a protected page to sign-in, remembering the page", async () => {
    for (const [path, target] of [
      ["/dashboard", "/login?next=%2Fdashboard"],
      ["/settings/users?view=all", "/login?next=%2Fsettings%2Fusers%3Fview%3Dall"],
      ["/account", "/login?next=%2Faccount"],
    ]) {
      const response = await proxy(request(path!));
      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe(`http://localhost:3000${target}`);
    }
  });

  it("leaves public pages alone", async () => {
    for (const path of ["/", "/login", "/login?next=%2Fdashboard"]) {
      expect(passedThrough(await proxy(request(path)))).toBe(true);
    }
  });

  it("lets a signed-in user through, without touching a fresh session", async () => {
    const response = await proxy(request("/dashboard", { cookie }));
    expect(passedThrough(response)).toBe(true);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("keeps an active session alive: a day after its last refresh, it gets 7 more days", async () => {
    const session = await db.session.findFirstOrThrow({ where: { userId } });
    // Last refreshed 2 days ago: 5 days left.
    await db.session.update({
      where: { id: session.id },
      data: { expiresAt: new Date(Date.now() + 5 * 86_400_000) },
    });

    const response = await proxy(request("/dashboard", { cookie }));
    expect(passedThrough(response)).toBe(true);
    expect(response.headers.get("set-cookie")).toMatch(/sms\.session_token=.+Max-Age=604800/);
    const refreshed = await db.session.findUniqueOrThrow({ where: { id: session.id } });
    const daysLeft = (refreshed.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(daysLeft).toBeGreaterThan(6.9);
  });

  it("sends a forged or ended session to sign-in and clears the cookie", async () => {
    const forged = await proxy(request("/dashboard", { cookie: "sms.session_token=forged.value" }));
    expect(forged.status).toBe(307);
    expect(forged.headers.get("set-cookie")).toMatch(
      /^sms\.session_token=; Path=\/; Max-Age=0; .*HttpOnly/i,
    );

    // A real session that has since been deleted (e.g. signed out elsewhere).
    const other = await db.session.create({
      data: {
        id: crypto.randomUUID(),
        token: crypto.randomUUID(),
        userId,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    await db.session.delete({ where: { id: other.id } });
    const ended = await proxy(request("/account", { cookie: "sms.session_token=" + other.token }));
    expect(ended.status).toBe(307);
  });

  it("treats a deactivated user as signed out", async () => {
    await db.user.update({ where: { id: userId }, data: { banned: true } });
    const response = await proxy(request("/dashboard", { cookie }));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost:3000/login?next=%2Fdashboard");
    await db.user.update({ where: { id: userId }, data: { banned: false } });
  });

  it("never redirects a server action (POST); the action's own guard answers", async () => {
    expect(passedThrough(await proxy(request("/settings/users", { method: "POST" })))).toBe(true);
    expect(
      passedThrough(
        await proxy(
          request("/settings/users", { method: "POST", cookie: "sms.session_token=forged.value" }),
        ),
      ),
    ).toBe(true);
  });
});
