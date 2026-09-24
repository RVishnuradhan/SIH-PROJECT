/**
 * Customer document access against a real database: signed-in users only,
 * ID proofs and sensitive files for admins only, every refusal and every view
 * of a sensitive document in the audit log.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "@/lib/db";
import { readPrivateFile } from "@/lib/storage";
import type { CurrentUser } from "@/modules/auth/current-user";
import { openDocument } from "@/modules/documents/open-document";
import { createUser } from "@/modules/users/service";

import { createTestDatabase, type TestDatabase } from "./support/test-database";

let database: TestDatabase;
let db: Database;
let admin: CurrentUser;
let staff: CurrentUser;
const root = mkdtempSync(path.join(tmpdir(), "sms-documents-"));
const request = { ipAddress: "203.0.113.30", userAgent: "DocumentsTest" };
const ids = {
  idProof: "01970000-0000-7000-8000-00000000a001",
  photo: "01970000-0000-7000-8000-00000000a002",
  sensitiveOther: "01970000-0000-7000-8000-00000000a003",
  missingFile: "01970000-0000-7000-8000-00000000a004",
};

function open(user: CurrentUser | null, documentId: string) {
  return openDocument(
    { db, readFile: (key) => readPrivateFile(key, root) },
    { user, documentId, request },
  );
}

beforeAll(async () => {
  database = await createTestDatabase();
  db = database.prisma();
  const make = async (username: string, role: "admin" | "staff"): Promise<CurrentUser> => {
    const { id } = await createUser(db, {
      actor: null,
      input: {
        name: username,
        username,
        role,
        password: "documents-passphrase",
        confirmPassword: "documents-passphrase",
      },
      request: null,
    });
    return { id, name: username, username, role, sessionId: "test" };
  };
  admin = await make("owner", "admin");
  staff = await make("ravi", "staff");

  const customer = await db.customer.create({
    data: { name: "Shanjiv", phone: "9865276111", location: "Kunnathur", createdById: admin.id },
  });
  const documents = [
    { id: ids.idProof, type: "ID_PROOF", isSensitive: true, write: true },
    { id: ids.photo, type: "PHOTO", isSensitive: false, write: true },
    { id: ids.sensitiveOther, type: "OTHER", isSensitive: true, write: true },
    { id: ids.missingFile, type: "PHOTO", isSensitive: false, write: false },
  ] as const;
  for (const document of documents) {
    const storageKey = `customers/${customer.id}/${document.id}.png`;
    if (document.write) {
      mkdirSync(path.join(root, "customers", customer.id), { recursive: true });
      writeFileSync(path.join(root, storageKey), `file ${document.id}`);
    }
    await db.customerDocument.create({
      data: {
        id: document.id,
        customerId: customer.id,
        type: document.type,
        isSensitive: document.isSensitive,
        storageKey,
        fileName: `${document.type.toLowerCase()}.png`,
        mimeType: "image/png",
        sizeBytes: 10,
        sha256: "0".repeat(64),
        uploadedById: admin.id,
      },
    });
  }
});

afterAll(async () => {
  rmSync(root, { recursive: true, force: true });
  await database?.drop();
});

async function audit(action: string, documentId: string) {
  return db.auditLog.findMany({
    where: { action, entityId: documentId },
    orderBy: { createdAt: "asc" },
  });
}

describe("opening customer documents", () => {
  it("refuses anyone who isn't signed in, without looking the document up", async () => {
    expect(await open(null, ids.idProof)).toEqual({
      status: 401,
      message: "Please sign in to view this document.",
    });
    expect(await open(null, "not-a-uuid")).toMatchObject({ status: 401 });
  });

  it("answers 404 for an unknown or malformed id", async () => {
    expect(await open(admin, "01970000-0000-7000-8000-0000000000ff")).toEqual({
      status: 404,
      message: "Document not found.",
    });
    expect(await open(admin, "../../etc/passwd")).toEqual({
      status: 404,
      message: "Document not found.",
    });
  });

  it("lets staff open a photo (not logged as sensitive)", async () => {
    const result = await open(staff, ids.photo);
    expect(result).toMatchObject({
      status: 200,
      contentType: "image/png",
      inline: true,
      fileName: "photo.png",
    });
    expect(result.status === 200 && result.file.toString()).toBe(`file ${ids.photo}`);
    expect(await audit("document.viewed", ids.photo)).toHaveLength(0);
  });

  it("refuses staff an ID proof or other sensitive file, and records it", async () => {
    for (const id of [ids.idProof, ids.sensitiveOther]) {
      expect(await open(staff, id)).toEqual({
        status: 403,
        message: "Only an administrator can open this document.",
      });
      const [denied] = await audit("access.denied", id);
      expect(denied).toMatchObject({
        actorId: staff.id,
        entityType: "customer_document",
        ipAddress: "203.0.113.30",
      });
    }
    expect(await audit("document.viewed", ids.idProof)).toHaveLength(0);
  });

  it("lets an admin open an ID proof, and logs every view", async () => {
    for (let view = 1; view <= 2; view++) {
      expect(await open(admin, ids.idProof)).toMatchObject({ status: 200 });
    }
    const views = await audit("document.viewed", ids.idProof);
    expect(views).toHaveLength(2);
    expect(views[0]).toMatchObject({
      actorId: admin.id,
      summary: "owner opened a sensitive document (ID_PROOF)",
    });
  });

  it("reports a file missing from storage as not found", async () => {
    expect(await open(admin, ids.missingFile)).toEqual({
      status: 404,
      message: "The file for this document could not be found.",
    });
  });

  it("can't store an ID proof as non-sensitive (database rule)", async () => {
    const customer = await db.customer.findFirstOrThrow();
    await expect(
      db.customerDocument.create({
        data: {
          customerId: customer.id,
          type: "ID_PROOF",
          isSensitive: false,
          storageKey: "customers/x/unflagged.png",
          fileName: "unflagged.png",
          mimeType: "image/png",
          sizeBytes: 1,
          sha256: "0".repeat(64),
          uploadedById: admin.id,
        },
      }),
    ).rejects.toThrow(/customer_documents_id_proof_sensitive/);
  });
});
