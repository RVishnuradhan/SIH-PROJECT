import { describe, expect, it } from "vitest";

import { parseServerEnv } from "@/lib/env";

describe("parseServerEnv", () => {
  it("defaults NODE_ENV to development", () => {
    expect(parseServerEnv({})).toEqual({ NODE_ENV: "development" });
  });

  it("accepts a valid environment", () => {
    expect(parseServerEnv({ NODE_ENV: "production" }).NODE_ENV).toBe("production");
  });

  it("fails fast with a message naming the bad variable", () => {
    expect(() => parseServerEnv({ NODE_ENV: "staging" })).toThrowError(
      /Invalid environment variables:\n\s+- NODE_ENV:/,
    );
  });
});
