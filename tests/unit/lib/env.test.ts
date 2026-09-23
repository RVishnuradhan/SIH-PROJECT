import { describe, expect, it } from "vitest";

import { parseServerEnv } from "@/lib/env";

const DATABASE_URL = "postgresql://sms:secret@localhost:5432/sms_associates";

describe("parseServerEnv", () => {
  it("defaults NODE_ENV to development", () => {
    expect(parseServerEnv({ DATABASE_URL })).toEqual({ NODE_ENV: "development", DATABASE_URL });
  });

  it("accepts a valid environment", () => {
    const env = parseServerEnv({ NODE_ENV: "production", DATABASE_URL });
    expect(env.NODE_ENV).toBe("production");
    expect(env.DATABASE_URL).toBe(DATABASE_URL);
  });

  it("accepts the postgres:// form too", () => {
    expect(() => parseServerEnv({ DATABASE_URL: "postgres://u:p@db:5432/x" })).not.toThrow();
  });

  it("requires DATABASE_URL", () => {
    expect(() => parseServerEnv({})).toThrowError(/DATABASE_URL/);
  });

  it("rejects a connection string for another database", () => {
    expect(() => parseServerEnv({ DATABASE_URL: "mysql://u:p@db/x" })).toThrowError(
      /DATABASE_URL: must be a postgresql:\/\/ connection string/,
    );
  });

  it("fails fast with a message naming the bad variable", () => {
    expect(() => parseServerEnv({ NODE_ENV: "staging", DATABASE_URL })).toThrowError(
      /Invalid environment variables:\n\s+- NODE_ENV:/,
    );
  });
});
