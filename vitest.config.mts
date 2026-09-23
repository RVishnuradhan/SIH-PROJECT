import path from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const root = import.meta.dirname;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^@\//, replacement: `${path.resolve(root, "src")}/` },
      // `server-only` throws outside a React Server Components bundle; tests
      // import server modules directly, so it becomes an empty module here.
      { find: "server-only", replacement: path.resolve(root, "tests/support/server-only.ts") },
    ],
  },
  test: {
    restoreMocks: true,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          // Node by default; component tests opt into jsdom with a `@vitest-environment jsdom` docblock.
          environment: "node",
          include: ["tests/unit/**/*.test.{ts,tsx}"],
          setupFiles: ["tests/support/setup.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          environment: "node",
          include: ["tests/integration/**/*.test.ts"],
          // Migrates a template database once; each test file then works on its own copy.
          globalSetup: ["tests/integration/support/global-setup.ts"],
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
