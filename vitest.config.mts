import path from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const root = import.meta.dirname;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^@\//, replacement: `${path.resolve(root, "src")}/` },
      // `server-only` throws outside a React Server Components bundle; unit tests
      // import server modules directly, so it becomes an empty module here.
      { find: "server-only", replacement: path.resolve(root, "tests/support/server-only.ts") },
    ],
  },
  test: {
    // Node by default; component tests opt into jsdom with a `@vitest-environment jsdom` docblock.
    environment: "node",
    include: ["tests/unit/**/*.test.{ts,tsx}"],
    setupFiles: ["tests/support/setup.ts"],
    restoreMocks: true,
  },
});
