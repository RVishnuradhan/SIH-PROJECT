import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  FORBIDDEN_MESSAGE,
  runAction,
  SESSION_ENDED_MESSAGE,
  UNEXPECTED_MESSAGE,
  type ActionDefinition,
  type ActionDependencies,
} from "@/lib/action";
import { ServiceError } from "@/lib/errors";
import type { CurrentUser } from "@/modules/auth/current-user";

const admin: CurrentUser = {
  id: "u-admin",
  name: "Owner",
  username: "owner",
  role: "admin",
  sessionId: "s1",
};
const staff: CurrentUser = {
  id: "u-staff",
  name: "Ravi",
  username: "ravi",
  role: "staff",
  sessionId: "s2",
};
const request = { ipAddress: "203.0.113.5", userAgent: "UnitTest" };

function deps(user: CurrentUser | null, overrides: Pick<ActionDependencies, "rethrow"> = {}) {
  return {
    getUser: vi.fn(async () => user),
    request,
    recordDenied: vi.fn(async (_entry: unknown) => {}),
    logError: vi.fn((_message: string, _error: unknown) => {}),
    ...overrides,
  } satisfies ActionDependencies;
}

function action(
  permission: ActionDefinition<z.ZodType, unknown>["permission"],
  handler: ActionDefinition<z.ZodType, unknown>["handler"] = async () => "done",
) {
  return {
    name: "user.create",
    permission,
    schema: z.object({
      name: z.string().trim().min(1, "Enter a name"),
      password: z.string().optional(),
    }),
    handler: vi.fn(handler),
  };
}

describe("runAction", () => {
  it("refuses when nobody is signed in, before looking at anything else", async () => {
    const definition = action("user.manage");
    const d = deps(null);
    expect(await runAction(definition, { name: "" }, d)).toEqual({
      ok: false,
      code: "UNAUTHENTICATED",
      message: SESSION_ENDED_MESSAGE,
    });
    expect(definition.handler).not.toHaveBeenCalled();
    expect(d.recordDenied).not.toHaveBeenCalled();
  });

  it("refuses staff an admin-only action and records the attempt", async () => {
    const definition = action("user.manage");
    const d = deps(staff);
    expect(await runAction(definition, { name: "Someone" }, d)).toEqual({
      ok: false,
      code: "FORBIDDEN",
      message: FORBIDDEN_MESSAGE,
    });
    expect(definition.handler).not.toHaveBeenCalled();
    expect(d.recordDenied).toHaveBeenCalledWith({
      actorId: "u-staff",
      action: "access.denied",
      entityType: "action",
      entityId: "user.create",
      summary: "Refused user.create for ravi (staff): needs user.manage",
      request,
    });
  });

  it("checks the permission before validating the input", async () => {
    const d = deps(staff);
    const result = await runAction(action("user.manage"), { name: "" }, d);
    expect(result).toMatchObject({ ok: false, code: "FORBIDDEN" });
  });

  it("lets an admin through, with the validated input and context", async () => {
    const definition = action("user.manage", async (input, context) => ({
      input,
      who: context.user.id,
    }));
    const result = await runAction(definition, { name: "  Priya  " }, deps(admin));
    expect(result).toEqual({ ok: true, data: { input: { name: "Priya" }, who: "u-admin" } });
  });

  it("lets staff do what staff may do", async () => {
    const result = await runAction(action("bill.create"), { name: "x" }, deps(staff));
    expect(result).toEqual({ ok: true, data: "done" });
  });

  it("lets any signed-in user do a signed-in action", async () => {
    for (const user of [admin, staff]) {
      expect(await runAction(action("signed-in"), { name: "x" }, deps(user))).toMatchObject({
        ok: true,
      });
    }
  });

  it("returns field errors for invalid input without calling the service", async () => {
    const definition = action("user.manage");
    const result = await runAction(definition, { name: "   " }, deps(admin));
    expect(result).toEqual({
      ok: false,
      code: "INVALID_INPUT",
      message: "Please check the highlighted fields.",
      fieldErrors: { name: "Enter a name" },
    });
    expect(definition.handler).not.toHaveBeenCalled();
  });

  it("passes an expected service error on as a friendly message", async () => {
    const definition = action("user.manage", async () => {
      throw new ServiceError("CONFLICT", "That username is already taken.", { username: "Taken" });
    });
    expect(await runAction(definition, { name: "x" }, deps(admin))).toEqual({
      ok: false,
      code: "CONFLICT",
      message: "That username is already taken.",
      fieldErrors: { username: "Taken" },
    });
  });

  it("hides unexpected errors behind a reference, and never logs the input", async () => {
    const d = deps(admin);
    const definition = action("user.manage", async () => {
      throw new Error("connect ECONNREFUSED 10.0.0.5:5432");
    });
    const result = await runAction(definition, { name: "x", password: "super-secret-password" }, d);

    expect(result).toMatchObject({ ok: false, code: "UNEXPECTED", message: UNEXPECTED_MESSAGE });
    const reference = !result.ok ? result.reference : undefined;
    expect(reference).toMatch(/^[0-9a-f]{8}$/);
    expect(JSON.stringify(result)).not.toContain("ECONNREFUSED");

    expect(d.logError).toHaveBeenCalledOnce();
    const [message, error] = d.logError.mock.calls[0]!;
    expect(message).toBe(`Action user.create failed [ref ${reference}]`);
    expect(String(error)).toContain("ECONNREFUSED");
    expect(JSON.stringify(d.logError.mock.calls)).not.toContain("super-secret-password");
  });

  it("lets framework control flow (redirects) through", async () => {
    const redirect = new Error("NEXT_REDIRECT");
    const d = deps(admin, {
      rethrow: (error) => {
        if (error === redirect) throw error;
      },
    });
    const definition = action("user.manage", async () => {
      throw redirect;
    });
    await expect(runAction(definition, { name: "x" }, d)).rejects.toBe(redirect);
  });
});
