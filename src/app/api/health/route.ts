import { getDb } from "@/lib/db";

import packageJson from "../../../../package.json";

/**
 * Health check for deployments and uptime monitors. Always answered fresh,
 * never cached. Reports 503 when the database can't be reached.
 */
export async function GET() {
  let database: "ok" | "unreachable" = "ok";
  try {
    await getDb().$queryRaw`SELECT 1`;
  } catch (error) {
    console.error("Health check: database unreachable", error);
    database = "unreachable";
  }

  const healthy = database === "ok";
  return Response.json(
    {
      status: healthy ? "ok" : "degraded",
      service: "sms-associates",
      version: packageJson.version,
      database,
      time: new Date().toISOString(),
    },
    { status: healthy ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
