import "server-only";

import { z } from "zod";

/**
 * Server-side environment variables, validated once when the server starts so a
 * misconfigured deployment fails fast with a clear message.
 *
 * Add each new variable here — and to `.env.example` — in the phase that first
 * needs it (DATABASE_URL arrives with the database in Phase 2).
 */
const serverEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
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

export const env: ServerEnv = parseServerEnv(process.env);
