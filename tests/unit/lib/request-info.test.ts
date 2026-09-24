import { describe, expect, it } from "vitest";

import { requestInfoFrom } from "@/lib/request-info";

describe("requestInfoFrom", () => {
  it("takes the client address from X-Forwarded-For (first entry)", () => {
    const headers = new Headers({
      "x-forwarded-for": "203.0.113.7, 10.0.0.1",
      "user-agent": "Browser/1.0",
    });
    expect(requestInfoFrom(headers)).toEqual({
      ipAddress: "203.0.113.7",
      userAgent: "Browser/1.0",
    });
  });

  it("falls back to X-Real-IP, and accepts IPv6", () => {
    expect(requestInfoFrom(new Headers({ "x-real-ip": "2001:db8::1" })).ipAddress).toBe(
      "2001:db8::1",
    );
    expect(requestInfoFrom(new Headers({ "x-forwarded-for": "::ffff:127.0.0.1" })).ipAddress).toBe(
      "::ffff:127.0.0.1",
    );
  });

  it("ignores values that aren't addresses", () => {
    for (const value of ["<script>", "evil.example.com", "1.2.3.4; DROP TABLE users", ""]) {
      expect(requestInfoFrom(new Headers({ "x-forwarded-for": value })).ipAddress).toBeNull();
    }
    expect(requestInfoFrom(new Headers()).ipAddress).toBeNull();
  });

  it("keeps the browser name to a sensible length", () => {
    const info = requestInfoFrom(new Headers({ "user-agent": "x".repeat(2000) }));
    expect(info.userAgent).toHaveLength(512);
    expect(requestInfoFrom(new Headers()).userAgent).toBeNull();
  });
});
