import { randomBytes } from "node:crypto";

import { defineConfig, devices } from "@playwright/test";

import { E2E_DOCUMENTS_DIR, e2eDatabaseUrl } from "./tests/e2e/support/e2e-env";

const port = Number(process.env.E2E_PORT ?? 3100);
const baseURL = `http://127.0.0.1:${port}`;

// The app under test gets its own database (created before, dropped after the
// run) and a secret of its own. Tests read the database URL from here too.
const databaseUrl = e2eDatabaseUrl();
process.env.E2E_DATABASE_URL = databaseUrl;

// Normally Playwright uses the browser it installs (`pnpm exec playwright install chromium`).
// PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH lets a machine with its own Chromium use that instead.
const launchOptions = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
  : {};

/**
 * End-to-end tests run against the production build (`pnpm build` first), the
 * way the app is actually served.
 */
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  // Each project gets its own client address (as a proxy in front of the app
  // would report it), so the per-address sign-in limit isn't shared between them.
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions,
        extraHTTPHeaders: { "x-forwarded-for": "198.51.100.11" },
      },
    },
    {
      name: "mobile",
      use: {
        ...devices["Pixel 7"],
        launchOptions,
        extraHTTPHeaders: { "x-forwarded-for": "198.51.100.12" },
      },
    },
  ],
  globalTeardown: "./tests/e2e/support/global-teardown.ts",
  webServer: {
    // Prepare the test database, then `next` directly (on PATH via `pnpm test:e2e`):
    // a package-manager wrapper doesn't pass the stop signal on, which leaves the
    // server running after tests.
    command: `tsx --conditions=react-server tests/e2e/support/prepare-database.ts && next start --hostname 127.0.0.1 --port ${port}`,
    url: `${baseURL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    env: {
      DATABASE_URL: databaseUrl,
      BETTER_AUTH_URL: baseURL,
      BETTER_AUTH_SECRET: randomBytes(32).toString("base64"),
      DOCUMENTS_DIR: E2E_DOCUMENTS_DIR,
    },
  },
});
