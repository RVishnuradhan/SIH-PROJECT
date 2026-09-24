import { describe, expect, it, vi } from "vitest";

import { writeAudit } from "@/modules/audit/audit";

function fakeDb() {
  const create = vi.fn(async (_args: unknown) => ({}));
  return { db: { auditLog: { create } } as never, create };
}

describe("writeAudit", () => {
  it("writes one row with the request details", async () => {
    const { db, create } = fakeDb();
    await writeAudit(db, {
      actorId: "u1",
      action: "user.role_changed",
      entityType: "user",
      entityId: "u2",
      summary: 'Changed "ravi" from Staff to Admin',
      changes: { role: { from: "staff", to: "admin" } },
      request: { ipAddress: "203.0.113.1", userAgent: "Browser" },
    });
    expect(create).toHaveBeenCalledWith({
      data: {
        actorId: "u1",
        action: "user.role_changed",
        entityType: "user",
        entityId: "u2",
        summary: 'Changed "ravi" from Staff to Admin',
        changes: { role: { from: "staff", to: "admin" } },
        ipAddress: "203.0.113.1",
        userAgent: "Browser",
      },
    });
  });

  it.each([
    "password",
    "newPassword",
    "passwordHash",
    "token",
    "sessionToken",
    "secret",
    "hash",
    "cookie",
    "otp",
  ])("refuses to record a %s field", async (field) => {
    const { db, create } = fakeDb();
    await expect(
      writeAudit(db, {
        actorId: "u1",
        action: "user.password_reset",
        entityType: "user",
        entityId: "u2",
        summary: "Reset",
        changes: { [field]: { to: "x" } },
      }),
    ).rejects.toThrow(`Audit entries never record secrets (field "${field}")`);
    expect(create).not.toHaveBeenCalled();
  });

  it("keeps summaries to 500 characters", async () => {
    const { db, create } = fakeDb();
    await writeAudit(db, {
      actorId: null,
      action: "auth.signed_out",
      entityType: "user",
      entityId: "u",
      summary: "x".repeat(900),
    });
    const [{ data }] = create.mock.calls[0] as [{ data: { summary: string; ipAddress: null } }];
    expect(data.summary).toHaveLength(500);
    expect(data.ipAddress).toBeNull();
  });
});
