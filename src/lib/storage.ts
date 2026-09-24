import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";

import { getServerEnv } from "./env";

/**
 * Private file storage for customer documents (ARCHITECTURE.md §10). Files live
 * outside `public/`, so the web server never serves them directly: the only way
 * to a file is the permission-checked route `/api/documents/[documentId]`.
 * Phase 7 adds uploads and S3-compatible object storage for production.
 */

/** Storage keys look like "customers/<id>/<file>.jpg" — no "..", no absolute paths. */
const STORAGE_KEY_PATTERN = /^[a-z0-9][a-z0-9/_.-]{0,254}$/;

export class InvalidStorageKeyError extends Error {
  constructor() {
    super("Invalid storage key");
    this.name = "InvalidStorageKeyError";
  }
}

/** The file's absolute path, guaranteed to stay inside the storage folder. */
export function resolveStoragePath(root: string, key: string): string {
  const segments = key.split("/");
  if (
    !STORAGE_KEY_PATTERN.test(key) ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new InvalidStorageKeyError();
  }
  const base = path.resolve(root);
  const full = path.resolve(base, ...segments);
  if (!full.startsWith(`${base}${path.sep}`)) throw new InvalidStorageKeyError();
  return full;
}

/** Reads a stored file, or null when it doesn't exist. */
export async function readPrivateFile(
  key: string,
  root: string = getServerEnv().DOCUMENTS_DIR,
): Promise<Buffer | null> {
  try {
    return await readFile(resolveStoragePath(root, key));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
