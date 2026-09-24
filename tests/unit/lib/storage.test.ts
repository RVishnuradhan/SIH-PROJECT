import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { InvalidStorageKeyError, readPrivateFile, resolveStoragePath } from "@/lib/storage";

const root = mkdtempSync(path.join(tmpdir(), "sms-storage-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("private document storage", () => {
  it("resolves a storage key inside the storage folder", () => {
    expect(resolveStoragePath(root, "customers/abc/photo.jpg")).toBe(
      path.join(root, "customers", "abc", "photo.jpg"),
    );
  });

  it.each([
    "../secrets.txt",
    "customers/../../etc/passwd",
    "/etc/passwd",
    "customers//photo.jpg",
    "customers/./photo.jpg",
    "Customers/Photo.JPG",
    "customers/photo.jpg\u0000.png",
    "customers\\..\\photo.jpg",
    "",
  ])("refuses the key %j", (key) => {
    expect(() => resolveStoragePath(root, key)).toThrow(InvalidStorageKeyError);
  });

  it("reads a stored file, and returns null for a missing one", async () => {
    mkdirSync(path.join(root, "customers", "c1"), { recursive: true });
    writeFileSync(path.join(root, "customers", "c1", "doc.png"), "png-bytes");
    expect((await readPrivateFile("customers/c1/doc.png", root))?.toString()).toBe("png-bytes");
    expect(await readPrivateFile("customers/c1/missing.png", root)).toBeNull();
  });
});
