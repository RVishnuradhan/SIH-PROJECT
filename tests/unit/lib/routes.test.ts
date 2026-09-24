import { readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  HOME_PATH,
  isProtectedPath,
  LOGIN_PATH,
  loginPathFor,
  PROTECTED_PREFIXES,
  safeRedirectPath,
} from "@/lib/routes";

describe("protected paths", () => {
  it("covers the signed-in pages and everything below them", () => {
    for (const path of ["/dashboard", "/settings", "/settings/users", "/account", "/account/x"]) {
      expect(isProtectedPath(path)).toBe(true);
    }
  });

  it("leaves public pages alone", () => {
    for (const path of [
      "/",
      "/login",
      "/robots.txt",
      "/icon",
      "/api/health",
      "/dashboards",
      "/accounts",
    ]) {
      expect(isProtectedPath(path)).toBe(false);
    }
  });

  it("includes every top-level folder of the signed-in route group", () => {
    const group = path.resolve("src/app/(app)");
    const folders = readdirSync(group).filter((entry) =>
      statSync(path.join(group, entry)).isDirectory(),
    );
    expect(folders.length).toBeGreaterThan(0);
    for (const folder of folders) {
      expect(PROTECTED_PREFIXES, `src/app/(app)/${folder} is not protected`).toContain(
        `/${folder}`,
      );
    }
  });
});

describe("safeRedirectPath", () => {
  it("keeps a path on this site, with its query and hash", () => {
    expect(safeRedirectPath("/settings/users")).toBe("/settings/users");
    expect(safeRedirectPath("/account?tab=password#top")).toBe("/account?tab=password#top");
  });

  it.each([
    ["another site", "https://evil.example.com/"],
    ["a protocol-relative URL", "//evil.example.com"],
    ["a backslash trick", "/\\evil.example.com"],
    ["a script URL", "javascript:alert(1)"],
    ["a relative path", "dashboard"],
    ["whitespace", "/ /evil"],
    ["a control character", "/dash\u0000board"],
    ["a tab", "/\t/evil.example.com"],
    ["the sign-in page", "/login"],
    ["the sign-in page with a query", "/login?next=/dashboard"],
    ["an empty value", ""],
    ["a very long value", `/${"a".repeat(600)}`],
    ["a non-string", 42],
    ["nothing", undefined],
  ])("refuses %s", (_label, value) => {
    expect(safeRedirectPath(value)).toBe(HOME_PATH);
  });

  it("keeps an encoded backslash as a harmless path on this site", () => {
    // Browsers don't decode %5C into a separator, so this stays a (missing) page here.
    expect(safeRedirectPath("/%5Cevil.example.com")).toBe("/%5Cevil.example.com");
  });

  it("uses the given fallback", () => {
    expect(safeRedirectPath("https://evil.example.com", "/account")).toBe("/account");
  });
});

describe("loginPathFor", () => {
  it("remembers where to go afterwards", () => {
    expect(loginPathFor("/settings/users")).toBe("/login?next=%2Fsettings%2Fusers");
    expect(loginPathFor("/account?tab=1")).toBe("/login?next=%2Faccount%3Ftab%3D1");
  });

  it("drops an unsafe or missing target", () => {
    expect(loginPathFor("https://evil.example.com")).toBe(LOGIN_PATH);
    expect(loginPathFor(undefined)).toBe(LOGIN_PATH);
    expect(loginPathFor(null)).toBe(LOGIN_PATH);
  });
});
