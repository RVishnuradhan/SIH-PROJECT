import "server-only";

import type { Database } from "@/lib/db";
import { can } from "@/lib/permissions";
import type { RequestInfo } from "@/lib/request-info";
import type { CurrentUser } from "@/modules/auth/current-user";
import { writeAudit } from "@/modules/audit/audit";

import { INLINE_DOCUMENT_TYPES, permissionToOpen } from "./access";

export type OpenDocumentResult =
  | { status: 401 | 403 | 404; message: string }
  | { status: 200; file: Buffer; fileName: string; contentType: string; inline: boolean };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Decides whether someone may open a customer document and fetches it:
 * signed-in users only; sensitive documents (ID proofs) for admins only. A
 * refusal and every view of a sensitive document are written to the audit log.
 */
export async function openDocument(
  deps: { db: Database; readFile: (storageKey: string) => Promise<Buffer | null> },
  {
    user,
    documentId,
    request,
  }: { user: CurrentUser | null; documentId: string; request: RequestInfo },
): Promise<OpenDocumentResult> {
  if (!user) return { status: 401, message: "Please sign in to view this document." };
  if (!UUID.test(documentId)) return { status: 404, message: "Document not found." };

  const document = await deps.db.customerDocument.findUnique({
    where: { id: documentId },
    select: {
      id: true,
      type: true,
      isSensitive: true,
      storageKey: true,
      fileName: true,
      mimeType: true,
    },
  });
  if (!document) return { status: 404, message: "Document not found." };

  const permission = permissionToOpen(document);
  if (!can(user.role, permission)) {
    await writeAudit(deps.db, {
      actorId: user.id,
      action: "access.denied",
      entityType: "customer_document",
      entityId: document.id,
      summary: `Refused to open a sensitive document (${document.type}) for ${user.username} (${user.role})`,
      request,
    });
    return { status: 403, message: "Only an administrator can open this document." };
  }

  const file = await deps.readFile(document.storageKey);
  if (!file) {
    console.error(`Document ${document.id} is missing from private storage`);
    return { status: 404, message: "The file for this document could not be found." };
  }

  if (permission === "document.viewSensitive") {
    await writeAudit(deps.db, {
      actorId: user.id,
      action: "document.viewed",
      entityType: "customer_document",
      entityId: document.id,
      summary: `${user.username} opened a sensitive document (${document.type})`,
      request,
    });
  }

  const inline = INLINE_DOCUMENT_TYPES.has(document.mimeType);
  return {
    status: 200,
    file,
    fileName: document.fileName,
    contentType: inline ? document.mimeType : "application/octet-stream",
    inline,
  };
}
