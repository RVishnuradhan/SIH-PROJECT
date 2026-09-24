import "server-only";

import { z } from "zod";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Server-side environment variables, validated once when the server starts so a
 * misconfigured deployment fails fast with a clear message.
 *
 * Add each new variable here — and to `.env.example` — in the phase that first
 * needs it.
 */
const serverEnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DATABASE_URL: z.url({
      protocol: /^postgres(ql)?$/,
      error: "must be a postgresql:// connection string",
    }),
    // Signs session cookies and derives other keys. Never commit a real value.
    BETTER_AUTH_SECRET: z
      .string({ error: "is required (generate one with `openssl rand -base64 32`)" })
      .min(32, "must be at least 32 characters (generate one with `openssl rand -base64 32`)"),
    // The address people open the app at, e.g. https://app.example.com.
    BETTER_AUTH_URL: z.url({
      protocol: /^https?$/,
      error: "must be the app's http:// or https:// address",
    }),
    // Private folder for customer documents (never inside public/). Phase 7
    // adds object storage for production.
    DOCUMENTS_DIR: z.string().min(1).default("storage/documents"),
  })
  .superRefine((env, context) => {
    // Session cookies are only marked Secure on HTTPS; plain HTTP is allowed
    // only on this machine (development and end-to-end tests).
    const url = new URL(env.BETTER_AUTH_URL);
    if (
      env.NODE_ENV === "production" &&
      url.protocol !== "https:" &&
      !LOCAL_HOSTS.has(url.hostname)
    ) {
      context.addIssue({
        code: "custom",
        path: ["BETTER_AUTH_URL"],
        message: "must use https:// in production",
      });
    }
  });

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export function parseServerEnv(source: Record<string, string | undefined>): ServerEnv {
  const result = serverEnvSchema.safeParse(source);
  if (!result.success) {
    // Only variable names and rules are reported, never the values.
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
