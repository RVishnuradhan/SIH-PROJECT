import { beforeEach, describe, expect, it, vi } from "vitest";

import packageJson from "../../../package.json";

const queryRaw = vi.fn();

vi.mock("@/lib/db", () => ({ getDb: () => ({ $queryRaw: queryRaw }) }));

const { GET } = await import("@/app/api/health/route");

describe("GET /api/health", () => {
  beforeEach(() => {
    queryRaw.mockReset();
  });

  it("reports the service and database as up, with its version", async () => {
    queryRaw.mockResolvedValue([{ "?column?": 1 }]);
    const response = await GET();
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      status: "ok",
      service: "sms-associates",
      version: packageJson.version,
      database: "ok",
    });
    expect(Date.now() - Date.parse(String(body.time))).toBeLessThan(5_000);
  });

  it("answers 503 when the database can't be reached, without exposing the error", async () => {
    queryRaw.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.5:5432"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await GET();
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ status: "degraded", database: "unreachable" });
    expect(body).not.toContain("ECONNREFUSED");
  });

  it("is never cached", async () => {
    queryRaw.mockResolvedValue([]);
    expect((await GET()).headers.get("Cache-Control")).toBe("no-store");
  });
});
