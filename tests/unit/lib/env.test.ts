import { describe, expect, it } from "vitest";

import { parseServerEnv } from "@/lib/env";

const DATABASE_URL = "postgresql://sms:secret@localhost:5432/sms_associates";
const BETTER_AUTH_SECRET = "0123456789abcdef0123456789abcdef";
const BETTER_AUTH_URL = "http://localhost:3000";
const valid = { DATABASE_URL, BETTER_AUTH_SECRET, BETTER_AUTH_URL };

describe("parseServerEnv", () => {
  it("defaults NODE_ENV to development and the document folder to storage/documents", () => {
    expect(parseServerEnv(valid)).toEqual({
      NODE_ENV: "development",
      DATABASE_URL,
      BETTER_AUTH_SECRET,
      BETTER_AUTH_URL,
      DOCUMENTS_DIR: "storage/documents",
    });
  });

  it("accepts a valid environment", () => {
    const env = parseServerEnv({
      ...valid,
      NODE_ENV: "production",
      BETTER_AUTH_URL: "https://sms.example.com",
    });
    expect(env.NODE_ENV).toBe("production");
    expect(env.DATABASE_URL).toBe(DATABASE_URL);
  });

  it("accepts the postgres:// form too", () => {
    expect(() =>
      parseServerEnv({ ...valid, DATABASE_URL: "postgres://u:p@db:5432/x" }),
    ).not.toThrow();
  });

  it("requires DATABASE_URL", () => {
    expect(() => parseServerEnv({ BETTER_AUTH_SECRET, BETTER_AUTH_URL })).toThrowError(
      /DATABASE_URL/,
    );
  });

  it("rejects a connection string for another database", () => {
    expect(() => parseServerEnv({ ...valid, DATABASE_URL: "mysql://u:p@db/x" })).toThrowError(
      /DATABASE_URL: must be a postgresql:\/\/ connection string/,
    );
  });

  it("fails fast with a message naming the bad variable", () => {
    expect(() => parseServerEnv({ ...valid, NODE_ENV: "staging" })).toThrowError(
      /Invalid environment variables:\n\s+- NODE_ENV:/,
    );
  });

  it("requires an auth secret of at least 32 characters", () => {
    expect(() => parseServerEnv({ DATABASE_URL, BETTER_AUTH_URL })).toThrowError(
      /BETTER_AUTH_SECRET: is required/,
    );
    expect(() => parseServerEnv({ ...valid, BETTER_AUTH_SECRET: "too-short" })).toThrowError(
      /BETTER_AUTH_SECRET: must be at least 32 characters/,
    );
  });

  it("never repeats a secret value in the error message", () => {
    try {
      parseServerEnv({ ...valid, BETTER_AUTH_SECRET: "short-secret-value" });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain("short-secret-value");
    }
  });

  it("requires the app's address", () => {
    expect(() => parseServerEnv({ DATABASE_URL, BETTER_AUTH_SECRET })).toThrowError(
      /BETTER_AUTH_URL/,
    );
    expect(() => parseServerEnv({ ...valid, BETTER_AUTH_URL: "ftp://example.com" })).toThrowError(
      /BETTER_AUTH_URL: must be the app's http:\/\/ or https:\/\/ address/,
    );
  });

  it("requires https in production, except on this machine", () => {
    expect(() =>
      parseServerEnv({
        ...valid,
        NODE_ENV: "production",
        BETTER_AUTH_URL: "http://sms.example.com",
      }),
    ).toThrowError(/BETTER_AUTH_URL: must use https:\/\/ in production/);
    for (const local of ["http://localhost:3000", "http://127.0.0.1:3100"]) {
      expect(() =>
        parseServerEnv({ ...valid, NODE_ENV: "production", BETTER_AUTH_URL: local }),
      ).not.toThrow();
    }
  });
});
