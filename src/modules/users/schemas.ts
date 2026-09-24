import { z } from "zod";

import { ROLES } from "@/lib/permissions";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/modules/auth/password-rules";

/** Usernames are stored in lower case; people can type them in any case. */
export const USERNAME_PATTERN = /^[a-z0-9_.]+$/;

export const usernameSchema = z
  .string({ error: "Enter a username" })
  .trim()
  .toLowerCase()
  .min(3, "Use at least 3 characters")
  .max(30, "Use at most 30 characters")
  .regex(USERNAME_PATTERN, "Use only letters, numbers, dots and underscores");

export const personNameSchema = z
  .string({ error: "Enter the person's name" })
  .trim()
  .min(1, "Enter the person's name")
  .max(100, "Use at most 100 characters");

/** Optional: an empty field means "no email". */
export const optionalEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, "Use at most 254 characters")
  .optional()
  .transform((value) => (value ? value : undefined))
  .pipe(z.email("Enter a valid email address, or leave it empty").optional());

export const newPasswordSchema = z
  .string({ error: "Enter a password" })
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Use at most ${PASSWORD_MAX_LENGTH} characters`);

export const roleSchema = z.enum(ROLES, { error: "Choose a role" });

export const userIdSchema = z.string().trim().min(1, "Missing user").max(64, "Unknown user");

const passwordsMatch = <T extends { password: string; confirmPassword: string }>(value: T) =>
  value.password === value.confirmPassword;
const MISMATCH = { path: ["confirmPassword"], message: "The passwords don't match" };

export const createUserSchema = z
  .object({
    name: personNameSchema,
    username: usernameSchema,
    email: optionalEmailSchema,
    role: roleSchema,
    password: newPasswordSchema,
    confirmPassword: z.string(),
  })
  .refine(passwordsMatch, MISMATCH);
export type CreateUserInput = z.output<typeof createUserSchema>;

export const changeRoleSchema = z.object({ userId: userIdSchema, role: roleSchema });

export const deactivateUserSchema = z.object({
  userId: userIdSchema,
  reason: z
    .string()
    .trim()
    .max(200, "Use at most 200 characters")
    .optional()
    .transform((value) => (value ? value : undefined)),
});

export const reactivateUserSchema = z.object({ userId: userIdSchema });

export const resetPasswordSchema = z
  .object({ userId: userIdSchema, password: newPasswordSchema, confirmPassword: z.string() })
  .refine(passwordsMatch, MISMATCH);

export const changeOwnPasswordSchema = z
  .object({
    currentPassword: z
      .string({ error: "Enter your current password" })
      .min(1, "Enter your current password")
      .max(PASSWORD_MAX_LENGTH, "That isn't your current password"),
    password: newPasswordSchema,
    confirmPassword: z.string(),
  })
  .refine(passwordsMatch, MISMATCH)
  .refine((value) => value.password !== value.currentPassword, {
    path: ["password"],
    message: "Choose a password different from the current one",
  });

export const signInSchema = z.object({
  username: z
    .string({ error: "Enter your username" })
    .trim()
    .min(1, "Enter your username")
    .max(64, "That username is too long"),
  password: z
    .string({ error: "Enter your password" })
    .min(1, "Enter your password")
    .max(256, "That password is too long"),
  next: z.string().max(512).optional(),
});
