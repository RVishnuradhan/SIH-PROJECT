"use server";

import { revalidatePath } from "next/cache";

import { defineAction, formInput, type ActionResult } from "@/lib/action";
import { getDb } from "@/lib/db";

import {
  changeRoleSchema,
  createUserSchema,
  deactivateUserSchema,
  reactivateUserSchema,
  resetPasswordSchema,
} from "./schemas";
import { changeRole, createUser, deactivateUser, reactivateUser, resetPassword } from "./service";

/** Admin user management (permission `user.manage`). */
const USERS_PAGE = "/settings/users";

type FormAction = (previous: ActionResult | null, formData: FormData) => Promise<ActionResult>;

const guardedCreate = defineAction({
  name: "user.create",
  permission: "user.manage",
  schema: createUserSchema,
  handler: async (input, { user, request }) => {
    await createUser(getDb(), { actor: user, input, request });
    return null;
  },
});

const guardedChangeRole = defineAction({
  name: "user.changeRole",
  permission: "user.manage",
  schema: changeRoleSchema,
  handler: async ({ userId, role }, { user, request }) => {
    await changeRole(getDb(), { actor: user, userId, role, request });
    return null;
  },
});

const guardedDeactivate = defineAction({
  name: "user.deactivate",
  permission: "user.manage",
  schema: deactivateUserSchema,
  handler: async ({ userId, reason }, { user, request }) => {
    await deactivateUser(getDb(), { actor: user, userId, reason, request });
    return null;
  },
});

const guardedReactivate = defineAction({
  name: "user.reactivate",
  permission: "user.manage",
  schema: reactivateUserSchema,
  handler: async ({ userId }, { user, request }) => {
    await reactivateUser(getDb(), { actor: user, userId, request });
    return null;
  },
});

const guardedResetPassword = defineAction({
  name: "user.resetPassword",
  permission: "user.manage",
  schema: resetPasswordSchema,
  handler: async ({ userId, password }, { user, request }) => {
    await resetPassword(getDb(), { actor: user, userId, password, request });
    return null;
  },
});

async function afterChange(result: ActionResult): Promise<ActionResult> {
  if (result.ok) revalidatePath(USERS_PAGE);
  return result;
}

export const createUserAction: FormAction = async (_previous, formData) =>
  afterChange(await guardedCreate(formInput(formData)));

export const changeRoleAction: FormAction = async (_previous, formData) =>
  afterChange(await guardedChangeRole(formInput(formData)));

export const deactivateUserAction: FormAction = async (_previous, formData) =>
  afterChange(await guardedDeactivate(formInput(formData)));

export const reactivateUserAction: FormAction = async (_previous, formData) =>
  afterChange(await guardedReactivate(formInput(formData)));

export const resetPasswordAction: FormAction = async (_previous, formData) =>
  afterChange(await guardedResetPassword(formInput(formData)));
