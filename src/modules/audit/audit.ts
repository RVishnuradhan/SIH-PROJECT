import type { Prisma } from "@/generated/prisma/client";
import type { RequestInfo } from "@/lib/request-info";

/**
 * The audit log (PRD §64, ARCHITECTURE.md §10): append-only (the database
 * refuses updates and deletes), written in the same transaction as the change
 * it records. Later phases add their own actions (bill.generated, …).
 */
export type AuditAction =
  // Sign-in and sessions
  | "auth.signed_in"
  | "auth.sign_in_failed" // wrong password or unknown username
  | "auth.sign_in_blocked" // too many failed attempts
  | "auth.sign_in_refused" // correct password, but the account is deactivated
  | "auth.signed_out"
  // User management
  | "user.created"
  | "user.role_changed"
  | "user.deactivated"
  | "user.reactivated"
  | "user.password_reset" // by an admin
  | "user.password_changed" // by the user themselves
  | "user.password_change_failed" // wrong current password
  // Access control
  | "access.denied"
  | "document.viewed";

export type AuditChanges = Record<
  string,
  { from?: Prisma.InputJsonValue | null; to?: Prisma.InputJsonValue | null }
>;

export type AuditEntry = {
  /** Who did it; null when nobody is signed in (e.g. a failed sign-in) or for the setup script. */
  actorId: string | null;
  action: AuditAction;
  entityType: string;
  entityId: string;
  summary: string;
  /** Before/after values of edited fields — never passwords, hashes or tokens. */
  changes?: AuditChanges | null;
  request?: RequestInfo | null;
};

type AuditWriter = { auditLog: Pick<Prisma.TransactionClient["auditLog"], "create"> };

const SECRET_FIELD = /pass(word)?|secret|token|hash|cookie|otp/i;
const MAX_SUMMARY_LENGTH = 500;

export async function writeAudit(db: AuditWriter, entry: AuditEntry): Promise<void> {
  for (const field of Object.keys(entry.changes ?? {})) {
    if (SECRET_FIELD.test(field)) {
      throw new Error(`Audit entries never record secrets (field "${field}")`);
    }
  }
  await db.auditLog.create({
    data: {
      actorId: entry.actorId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      summary: entry.summary.slice(0, MAX_SUMMARY_LENGTH),
      changes: entry.changes ?? undefined,
      ipAddress: entry.request?.ipAddress ?? null,
      userAgent: entry.request?.userAgent ?? null,
    },
  });
}
