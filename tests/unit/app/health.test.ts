import { describe, expect, it } from "vitest";

import { GET } from "@/app/api/health/route";

import packageJson from "../../../package.json";

describe("GET /api/health", () => {
  it("reports the service as up, with its version", async () => {
    const response = GET();
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      status: "ok",
      service: "sms-associates",
      version: packageJson.version,
    });
    expect(Date.now() - Date.parse(String(body.time))).toBeLessThan(5_000);
  });

  it("is never cached", () => {
    expect(GET().headers.get("Cache-Control")).toBe("no-store");
  });
});
