import packageJson from "../../../../package.json";

/**
 * Liveness check for deployments and uptime monitors. Always answered fresh,
 * never cached. A database check is added in Phase 2.
 */
export function GET() {
  return Response.json(
    {
      status: "ok",
      service: "sms-associates",
      version: packageJson.version,
      time: new Date().toISOString(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
