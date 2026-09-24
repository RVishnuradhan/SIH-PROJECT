import "server-only";

import { headers } from "next/headers";
import { unstable_rethrow } from "next/navigation";
import type { z } from "zod";

import { getCurrentUser, type CurrentUser } from "@/modules/auth/session";
import { writeAudit, type AuditEntry } from "@/modules/audit/audit";

import { getDb } from "./db";
import { ServiceError, type FieldErrors, type ServiceErrorCode } from "./errors";
import { can, type Permission } from "./permissions";
import { requestInfoFrom, type RequestInfo } from "./request-info";

export type ActionErrorCode = "UNAUTHENTICATED" | "FORBIDDEN" | ServiceErrorCode | "UNEXPECTED";

export type ActionResult<T = null> =
  | { ok: true; data: T }
  | {
      ok: false;
      code: ActionErrorCode;
      message: string;
      fieldErrors?: FieldErrors;
      /** For unexpected errors: matches the server log entry. */
      reference?: string;
    };

export const SESSION_ENDED_MESSAGE = "Your session has ended. Please sign in again.";
export const FORBIDDEN_MESSAGE = "You don't have permission to do this.";
export const UNEXPECTED_MESSAGE = "Something went wrong. Please try again.";

export type ActionContext = { user: CurrentUser; request: RequestInfo };

export type ActionDefinition<Schema extends z.ZodType, T> = {
  /** Shown in the audit log when access is refused, e.g. "user.create". */
  name: string;
  /** The permission needed, or "signed-in" for anything a signed-in user may do. */
  permission: Permission | "signed-in";
  schema: Schema;
  handler: (input: z.output<Schema>, context: ActionContext) => Promise<T>;
};

export type ActionDependencies = {
  getUser: () => Promise<CurrentUser | null>;
  request: RequestInfo;
  recordDenied: (entry: AuditEntry) => Promise<void>;
  /** Lets framework control flow (redirect(), notFound()) pass through. */
  rethrow?: (error: unknown) => void;
  logError?: (message: string, error: unknown) => void;
};

/**
 * The guard every server action goes through (ARCHITECTURE.md §7): session →
 * permission → input validation → the service, with friendly errors. Server
 * actions are public HTTP endpoints, so this never relies on what the page shows.
 */
export async function runAction<Schema extends z.ZodType, T>(
  definition: ActionDefinition<Schema, T>,
  rawInput: unknown,
  deps: ActionDependencies,
): Promise<ActionResult<T>> {
  const user = await deps.getUser();
  if (!user) return { ok: false, code: "UNAUTHENTICATED", message: SESSION_ENDED_MESSAGE };

  if (definition.permission !== "signed-in" && !can(user.role, definition.permission)) {
    await deps.recordDenied({
      actorId: user.id,
      action: "access.denied",
      entityType: "action",
      entityId: definition.name,
      summary: `Refused ${definition.name} for ${user.username} (${user.role}): needs ${definition.permission}`,
      request: deps.request,
    });
    return { ok: false, code: "FORBIDDEN", message: FORBIDDEN_MESSAGE };
  }

  const parsed = definition.schema.safeParse(rawInput);
  if (!parsed.success) {
    const fieldErrors: FieldErrors = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path.join(".") || "form";
      fieldErrors[field] ??= issue.message;
    }
    return {
      ok: false,
      code: "INVALID_INPUT",
      message: "Please check the highlighted fields.",
      fieldErrors,
    };
  }

  try {
    const data = await definition.handler(parsed.data, { user, request: deps.request });
    return { ok: true, data };
  } catch (error) {
    deps.rethrow?.(error);
    if (error instanceof ServiceError) {
      return {
        ok: false,
        code: error.code,
        message: error.message,
        ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
      };
    }
    const reference = crypto.randomUUID().slice(0, 8);
    // Only the action name and the error are logged — never the input, which
    // may contain passwords.
    (deps.logError ?? console.error)(`Action ${definition.name} failed [ref ${reference}]`, error);
    return { ok: false, code: "UNEXPECTED", message: UNEXPECTED_MESSAGE, reference };
  }
}

/** Wires a guarded action to the current Next.js request. */
export function defineAction<Schema extends z.ZodType, T>(definition: ActionDefinition<Schema, T>) {
  return async (rawInput: unknown): Promise<ActionResult<T>> => {
    const request = requestInfoFrom(await headers());
    return runAction(definition, rawInput, {
      getUser: getCurrentUser,
      request,
      recordDenied: (entry) => writeAudit(getDb(), entry),
      rethrow: unstable_rethrow,
    });
  };
}

/** Form fields as a plain object for validation (files are not accepted here). */
export function formInput(formData: FormData): Record<string, string> {
  const input: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value === "string" && !key.startsWith("$ACTION")) input[key] = value;
  }
  return input;
}
