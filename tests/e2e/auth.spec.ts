import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type Page } from "@playwright/test";

import {
  admin,
  lockoutTarget,
  passwordChanger,
  staff,
  testDocuments,
  type TestAccount,
} from "./support/accounts";
import { queryE2eDatabase } from "./support/db";

async function signIn(
  page: Page,
  account: Pick<TestAccount, "username" | "password">,
  path = "/login",
) {
  if (!page.url().includes("/login")) await page.goto(path);
  await page.getByLabel("Username").fill(account.username);
  await page.getByLabel("Password", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

/**
 * Submits the sign-in form when it is expected to fail, and waits for the
 * answer: the form clears the password once the attempt has been processed.
 */
async function attemptSignIn(page: Page, account: Pick<TestAccount, "username" | "password">) {
  if (!page.url().includes("/login")) await page.goto("/login");
  await page.getByLabel("Username").fill(account.username);
  const password = page.getByLabel("Password", { exact: true });
  await password.fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(password).toHaveValue("");
}

/** The form's error message (Next.js also has a hidden route announcer with role "alert"). */
function formAlert(page: Page) {
  return page.getByRole("main").getByRole("alert");
}

/** A separate browser (own cookies) signed in as the account. */
async function signedInPage(browser: Browser, account: Pick<TestAccount, "username" | "password">) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, account);
  await expect(page).toHaveURL("/dashboard");
  return page;
}

test.describe("signed out", () => {
  test("protected pages lead to sign-in, and back afterwards", async ({ page }) => {
    for (const path of ["/dashboard", "/settings/users", "/account"]) {
      await page.goto(path);
      await expect(page).toHaveURL(`/login?next=${encodeURIComponent(path)}`);
      await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    }
    await signIn(page, admin);
    await expect(page).toHaveURL("/account");
    await expect(page.getByRole("heading", { level: 1, name: admin.name })).toBeVisible();
  });

  test("document files are refused without a session", async ({ request }) => {
    for (const id of [testDocuments.photo, testDocuments.idProof]) {
      const response = await request.get(`/api/documents/${id}`);
      expect(response.status()).toBe(401);
      expect(response.headers()["cache-control"]).toContain("no-store");
      expect(await response.json()).toEqual({ error: "Please sign in to view this document." });
    }
  });

  test("the sign-in page has no detectable accessibility issues", async ({ page }) => {
    await page.goto("/login");
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});

test.describe("signing in", () => {
  test("a wrong password or unknown username gets one generic message", async ({ page }) => {
    await page.goto("/login");
    await attemptSignIn(page, { username: staff.username, password: "definitely-wrong" });
    await expect(formAlert(page)).toHaveText("Incorrect username or password.");
    await expect(page.getByLabel("Username")).toHaveValue(staff.username);

    await attemptSignIn(page, { username: "no.such.person", password: "definitely-wrong" });
    await expect(formAlert(page)).toHaveText("Incorrect username or password.");
    await expect(page).toHaveURL(/\/login/);
  });

  test("never sends you to another site after signing in", async ({ page }) => {
    for (const next of ["https://evil.example.com/", "//evil.example.com", "/\\evil.example.com"]) {
      await page.context().clearCookies();
      await page.goto(`/login?next=${encodeURIComponent(next)}`);
      await signIn(page, staff);
      await expect(page).toHaveURL("/dashboard");
    }
  });

  test("an admin lands on the dashboard with the admin navigation", async ({ page }) => {
    await signIn(page, admin);
    await expect(page).toHaveURL("/dashboard");
    await expect(page.getByRole("heading", { name: `Welcome, ${admin.name}` })).toBeVisible();
    await expect(page.getByText(`Signed in as ${admin.username} · Admin`)).toBeVisible();

    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Users" })
      .click();
    await expect(page).toHaveURL("/settings/users");
    await expect(page.getByRole("heading", { level: 1, name: "Users" })).toBeVisible();
  });

  test("staff are refused admin pages with a 403", async ({ page }) => {
    await signIn(page, staff);
    await expect(page.getByText(`Signed in as ${staff.username} · Staff`)).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Users" }),
    ).toHaveCount(0);

    const response = await page.goto("/settings/users");
    expect(response?.status()).toBe(403);
    await expect(
      page.getByRole("heading", { name: "You don't have access to this page" }),
    ).toBeVisible();
    await expect(page.getByText("Add a user")).toHaveCount(0);
  });

  test("signing out ends the session for good", async ({ page, context }) => {
    await signIn(page, staff);
    await expect(page).toHaveURL("/dashboard");
    const cookiesBefore = await context.cookies();
    expect(cookiesBefore.find((cookie) => cookie.name === "sms.session_token")?.httpOnly).toBe(
      true,
    );

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL("/login");
    await page.goto("/dashboard");
    await expect(page).toHaveURL("/login?next=%2Fdashboard");

    // Replaying the old cookie doesn't work: the session is gone from the database.
    await context.addCookies(cookiesBefore);
    await page.goto("/dashboard");
    await expect(page).toHaveURL("/login?next=%2Fdashboard");
  });

  test("an account locks after 5 failed attempts, even for the right password", async ({
    page,
  }, testInfo) => {
    const target = lockoutTarget(testInfo.project.name);
    await page.goto("/login");
    for (let attempt = 1; attempt <= 5; attempt++) {
      await attemptSignIn(page, {
        username: target.username,
        password: `wrong-password-${attempt}`,
      });
      await expect(formAlert(page)).toHaveText("Incorrect username or password.");
    }
    await attemptSignIn(page, target);
    await expect(formAlert(page)).toHaveText(
      /^Too many sign-in attempts\. Please wait 1[45] minutes and try again\.$/,
    );
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe("customer documents", () => {
  test("staff open photos but not ID proofs; admins open both, and it is logged", async ({
    browser,
  }) => {
    const staffPage = await signedInPage(browser, staff);
    const photo = await staffPage.request.get(`/api/documents/${testDocuments.photo}`);
    expect(photo.status()).toBe(200);
    expect(photo.headers()["content-type"]).toBe("image/png");
    expect(photo.headers()["cache-control"]).toBe("private, no-store");
    expect(photo.headers()["x-content-type-options"]).toBe("nosniff");

    const refused = await staffPage.request.get(`/api/documents/${testDocuments.idProof}`);
    expect(refused.status()).toBe(403);
    expect(await refused.json()).toEqual({
      error: "Only an administrator can open this document.",
    });

    const adminPage = await signedInPage(browser, admin);
    const idProof = await adminPage.request.get(`/api/documents/${testDocuments.idProof}`);
    expect(idProof.status()).toBe(200);
    expect(idProof.headers()["content-security-policy"]).toContain("sandbox");

    const rows = await queryE2eDatabase<{ action: string; username: string }>(
      `SELECT a.action, u.username FROM audit_logs a JOIN users u ON u.id = a.actor_id
       WHERE a.entity_id = $1 AND a.action IN ('access.denied', 'document.viewed')`,
      [testDocuments.idProof],
    );
    expect(rows).toContainEqual({ action: "access.denied", username: staff.username });
    expect(rows).toContainEqual({ action: "document.viewed", username: admin.username });

    // Nothing is served for an unknown document.
    expect(
      (await adminPage.request.get("/api/documents/01970000-0000-7000-8000-0000000000ff")).status(),
    ).toBe(404);
  });

  test("document files are never served as public files", async ({ request }) => {
    for (const path of ["/storage/documents", "/.e2e/documents", "/documents/aadhaar-masked.png"]) {
      expect((await request.get(path)).status()).toBe(404);
    }
  });
});

test.describe("user management", () => {
  test("an admin adds, deactivates, reactivates, resets and promotes a user", async ({
    browser,
  }, testInfo) => {
    const newUser = {
      name: `New Staff ${testInfo.project.name}`,
      username: `new.${testInfo.project.name}`,
      password: "first-passphrase-123",
    };
    const adminPage = await signedInPage(browser, admin);
    await adminPage.goto("/settings/users");

    // Add the user.
    const form = adminPage.getByRole("region", { name: "Add a user" });
    await form.getByLabel("Full name").fill(newUser.name);
    await form.getByLabel("Username").fill(newUser.username);
    await form.getByLabel("Password", { exact: true }).fill(newUser.password);
    await form.getByLabel("Repeat the password").fill(newUser.password);
    await form.getByRole("button", { name: "Create account" }).click();
    await expect(form.getByRole("status")).toHaveText(
      `Account created. "${newUser.username}" can sign in now.`,
    );

    // They can sign in.
    const userPage = await signedInPage(browser, newUser);
    await expect(userPage.getByText(`Signed in as ${newUser.username} · Staff`)).toBeVisible();

    // Deactivating signs them out at once and blocks signing in.
    await adminPage.reload();
    const card = adminPage.getByRole("article", { name: `${newUser.name} (${newUser.username})` });
    await card.getByText("Deactivate…").click();
    await card.getByLabel("Reason (optional)").fill("Test: left the company");
    await card.getByRole("button", { name: `Deactivate ${newUser.username}` }).click();
    await expect(card.getByText("Deactivated", { exact: true })).toBeVisible();
    await expect(card.getByText("Reason: Test: left the company")).toBeVisible();

    await userPage.reload();
    await expect(userPage).toHaveURL("/login?next=%2Fdashboard");
    await attemptSignIn(userPage, newUser);
    await expect(formAlert(userPage)).toHaveText(
      "This account has been deactivated. Please contact the administrator.",
    );

    // Reactivated, they can sign in again.
    await adminPage.reload();
    await card.getByRole("button", { name: `Reactivate ${newUser.username}` }).click();
    await expect(card.getByText("Active", { exact: true })).toBeVisible();
    await signIn(userPage, newUser);
    await expect(userPage).toHaveURL("/dashboard");

    // A password reset signs them out; only the new password works.
    await adminPage.reload();
    await card.getByText("Reset password…").click();
    await card.getByLabel("New password", { exact: true }).fill("second-passphrase-456");
    await card.getByLabel("Repeat the new password").fill("second-passphrase-456");
    await card.getByRole("button", { name: "Set new password" }).click();
    await expect(card.getByRole("status")).toContainText("Password changed.");
    await userPage.reload();
    await expect(userPage).toHaveURL("/login?next=%2Fdashboard");
    await attemptSignIn(userPage, newUser);
    await expect(formAlert(userPage)).toHaveText("Incorrect username or password.");
    await signIn(userPage, { username: newUser.username, password: "second-passphrase-456" });
    await expect(userPage).toHaveURL("/dashboard");

    // Promoted to admin, they get the admin pages on their next page load.
    await adminPage.reload();
    await card.getByLabel("Role").selectOption("admin");
    await card.getByRole("button", { name: "Save" }).click();
    await expect(card.getByRole("status")).toHaveText("Role updated.");
    await userPage.goto("/settings/users");
    await expect(userPage.getByRole("heading", { level: 1, name: "Users" })).toBeVisible();

    const actions = await queryE2eDatabase<{ action: string }>(
      `SELECT a.action FROM audit_logs a JOIN users u ON u.id = a.entity_id
       WHERE u.username = $1 AND a.action LIKE 'user.%' ORDER BY a.created_at`,
      [newUser.username],
    );
    expect(actions.map((row) => row.action)).toEqual([
      "user.created",
      "user.deactivated",
      "user.reactivated",
      "user.password_reset",
      "user.role_changed",
    ]);
  });

  test("shows a clear error for a username that's taken", async ({ browser }) => {
    const adminPage = await signedInPage(browser, admin);
    await adminPage.goto("/settings/users");
    const form = adminPage.getByRole("region", { name: "Add a user" });
    await form.getByLabel("Full name").fill("Someone Else");
    await form.getByLabel("Username").fill(staff.username.toUpperCase());
    await form.getByLabel("Password", { exact: true }).fill("another-passphrase");
    await form.getByLabel("Repeat the password").fill("another-passphrase");
    await form.getByRole("button", { name: "Create account" }).click();
    await expect(form.getByRole("alert")).toHaveText("That username is already taken.");
    await expect(form.getByText("That username is already taken", { exact: true })).toBeVisible();
    await expect(form.getByLabel("Full name")).toHaveValue("Someone Else");
  });

  test("admins can't change their own role or deactivate themselves", async ({ browser }) => {
    const adminPage = await signedInPage(browser, admin);
    await adminPage.goto("/settings/users");
    const own = adminPage.getByRole("article", { name: `${admin.name} (${admin.username})` });
    await expect(own.getByText("(you)")).toBeVisible();
    await expect(own.getByRole("button")).toHaveCount(0);
    await expect(own.getByText(/Only another admin can change your role/)).toBeVisible();
  });
});

test.describe("your account", () => {
  test("changing your password needs the current one", async ({ page }, testInfo) => {
    const account = passwordChanger(testInfo.project.name);
    await signIn(page, account);
    await expect(page).toHaveURL("/dashboard");
    await page.goto("/account");

    const section = page.getByRole("region", { name: "Change password" });
    await section.getByLabel("Current password").fill("not-my-password");
    await section.getByLabel("New password", { exact: true }).fill("changed-passphrase-789");
    await section.getByLabel("Repeat the new password").fill("changed-passphrase-789");
    await section.getByRole("button", { name: "Change password" }).click();
    await expect(
      section.getByText("Your current password is incorrect", { exact: true }),
    ).toBeVisible();

    await section.getByLabel("Current password").fill(account.password);
    await section.getByLabel("New password", { exact: true }).fill("changed-passphrase-789");
    await section.getByLabel("Repeat the new password").fill("changed-passphrase-789");
    await section.getByRole("button", { name: "Change password" }).click();
    await expect(section.getByRole("status")).toHaveText("Your password has been changed.");

    // Still signed in here; the new password is the one that works.
    await page.goto("/dashboard");
    await expect(page).toHaveURL("/dashboard");
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL("/login");
    await attemptSignIn(page, account);
    await expect(formAlert(page)).toHaveText("Incorrect username or password.");
    await signIn(page, { username: account.username, password: "changed-passphrase-789" });
    await expect(page).toHaveURL("/dashboard");
  });
});
