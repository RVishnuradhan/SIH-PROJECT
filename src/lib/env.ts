import "server-only";

import { z } from "zod";

/**
 * Server-side environment variables, validated once when the server starts so a
 * misconfigured deployment fails fast with a clear message.
 *
 * Add each new variable here — and to `.env.example` — in the phase that first
 * needs it.
 */
const serverEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.url({
    protocol: /^postgres(ql)?$/,
    error: "must be a postgresql:// connection string",
  }),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export function parseServerEnv(source: Record<string, string | undefined>): ServerEnv {
  const result = serverEnvSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment variables:\n${problems}`);
  }
  return result.data;
}

let cached: ServerEnv | undefined;

/**
 * The validated environment, read on first use. The server calls this at start-up
 * (src/instrumentation.ts), so a bad configuration still fails immediately, while
 * `next build` and unit tests don't need production secrets.
 */
export function getServerEnv(): ServerEnv {
  cached ??= parseServerEnv(process.env);
  return cached;
}
