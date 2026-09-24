"use client";

import { KeyRound, ShieldCheck, UserMinus, UserPlus, UserRoundCheck } from "lucide-react";
import { useActionState, useId } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FormMessage } from "@/components/ui/form";
import { Input, Select } from "@/components/ui/input";
import type { ActionResult } from "@/lib/action";
import { roleLabels, ROLES, type Role } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { PASSWORD_MIN_LENGTH } from "@/modules/auth/password-rules";
import {
  changeRoleAction,
  createUserAction,
  deactivateUserAction,
  reactivateUserAction,
  resetPasswordAction,
} from "@/modules/users/actions";

type FormAction = (previous: ActionResult | null, formData: FormData) => Promise<ActionResult>;

function errorOf(result: ActionResult | null, field: string): string | undefined {
  return result && !result.ok ? result.fieldErrors?.[field] : undefined;
}

function ResultMessage({ result, success }: { result: ActionResult | null; success: string }) {
  if (!result) return null;
  if (result.ok) return <FormMessage tone="success">{success}</FormMessage>;
  return (
    <FormMessage tone="error">
      {result.message}
      {result.reference && ` (Reference ${result.reference})`}
    </FormMessage>
  );
}

const PASSWORD_HINT = `At least ${PASSWORD_MIN_LENGTH} characters. A few unrelated words make a strong, memorable password.`;

type CreateState = {
  result: ActionResult | null;
  /** What was typed, so a correction doesn't mean retyping everything (never passwords). */
  values: Record<string, string>;
  created?: string;
};

export function CreateUserForm({ className }: { className?: string }) {
  const [state, formAction, pending] = useActionState<CreateState, FormData>(
    async (_previous, formData): Promise<CreateState> => {
      const result = await createUserAction(null, formData);
      const text = (key: string) => String(formData.get(key) ?? "");
      return result.ok
        ? { result, values: {}, created: text("username").trim().toLowerCase() }
        : {
            result,
            values: {
              name: text("name"),
              username: text("username"),
              email: text("email"),
              role: text("role"),
            },
          };
    },
    { result: null, values: {} },
  );
  const { result, values } = state;

  return (
    <form action={formAction} className={cn("grid gap-5", className)} noValidate>
      <ResultMessage
        result={result}
        success={`Account created. "${state.created}" can sign in now.`}
      />
      <div className="grid gap-5 sm:grid-cols-2">
        <Field id="new-name" label="Full name" error={errorOf(result, "name")}>
          {(describedBy, invalid) => (
            <Input
              id="new-name"
              name="name"
              autoComplete="off"
              required
              defaultValue={values.name}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
            />
          )}
        </Field>
        <Field
          id="new-username"
          label="Username"
          hint="Used to sign in. Letters, numbers, dots and underscores; can't be changed later."
          error={errorOf(result, "username")}
        >
          {(describedBy, invalid) => (
            <Input
              id="new-username"
              name="username"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              required
              defaultValue={values.username}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
            />
          )}
        </Field>
        <Field id="new-email" label="Email (optional)" error={errorOf(result, "email")}>
          {(describedBy, invalid) => (
            <Input
              id="new-email"
              name="email"
              type="email"
              autoComplete="off"
              defaultValue={values.email}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
            />
          )}
        </Field>
        <Field id="new-role" label="Role" error={errorOf(result, "role")}>
          {(describedBy, invalid) => (
            <Select
              id="new-role"
              name="role"
              defaultValue={values.role || "staff"}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
            >
              {ROLES.map((role) => (
                <option key={role} value={role}>
                  {roleLabels[role]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field
          id="new-password"
          label="Password"
          hint={PASSWORD_HINT}
          error={errorOf(result, "password")}
        >
          {(describedBy, invalid) => (
            <Input
              id="new-password"
              name="password"
              type="password"
              autoComplete="new-password"
              required
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
            />
          )}
        </Field>
        <Field
          id="new-confirm"
          label="Repeat the password"
          error={errorOf(result, "confirmPassword")}
        >
          {(describedBy, invalid) => (
            <Input
              id="new-confirm"
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              required
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
            />
          )}
        </Field>
      </div>
      <div>
        <Button type="submit" disabled={pending}>
          <UserPlus aria-hidden="true" />
          {pending ? "Creating…" : "Create account"}
        </Button>
      </div>
    </form>
  );
}

export type UserView = {
  id: string;
  name: string;
  username: string;
  email: string | null;
  role: Role;
  active: boolean;
  deactivationReason: string | null;
  createdAt: string;
};

export function UserCard({
  user,
  isSelf,
  isLastActiveAdmin,
}: {
  user: UserView;
  isSelf: boolean;
  isLastActiveAdmin: boolean;
}) {
  return (
    <article
      aria-label={`${user.name} (${user.username})`}
      className="rounded-xl border bg-card p-4 shadow-xs sm:p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">
            {user.name}
            {isSelf && (
              <span className="ml-2 text-sm font-normal text-muted-foreground">(you)</span>
            )}
          </p>
          <p className="truncate text-sm text-muted-foreground">
            {user.username}
            {user.email && ` · ${user.email}`}
          </p>
        </div>
        <div className="flex gap-2">
          <Badge variant={user.role === "admin" ? "active" : "outline"}>
            {user.role === "admin" && <ShieldCheck aria-hidden="true" />}
            {roleLabels[user.role]}
          </Badge>
          <Badge variant={user.active ? "success" : "error"}>
            {user.active ? "Active" : "Deactivated"}
          </Badge>
        </div>
      </div>
      {!user.active && user.deactivationReason && (
        <p className="mt-2 text-sm text-muted-foreground">Reason: {user.deactivationReason}</p>
      )}

      {isSelf ? (
        <p className="mt-4 text-xs text-muted-foreground">
          Change your own password from your account page. Only another admin can change your role
          or deactivate you.
        </p>
      ) : (
        <div className="mt-4 grid gap-4 border-t pt-4 lg:grid-cols-3">
          <RoleForm user={user} locked={isLastActiveAdmin} />
          {user.active ? (
            <DeactivateForm user={user} locked={isLastActiveAdmin} />
          ) : (
            <ReactivateForm user={user} />
          )}
          <ResetPasswordForm user={user} />
        </div>
      )}
    </article>
  );
}

function useRowAction(action: FormAction) {
  return useActionState<ActionResult | null, FormData>(action, null);
}

function RoleForm({ user, locked }: { user: UserView; locked: boolean }) {
  const [result, formAction, pending] = useRowAction(changeRoleAction);
  const id = useId();
  return (
    <form action={formAction} className="grid content-start gap-2">
      <input type="hidden" name="userId" value={user.id} />
      <Field
        id={`${id}-role`}
        label="Role"
        hint={locked ? "The only active admin must stay an admin." : undefined}
      >
        {(describedBy) => (
          <div className="flex gap-2">
            <Select
              id={`${id}-role`}
              name="role"
              defaultValue={user.role}
              aria-describedby={describedBy}
            >
              {ROLES.map((role) => (
                <option key={role} value={role}>
                  {roleLabels[role]}
                </option>
              ))}
            </Select>
            <Button type="submit" variant="outline" disabled={pending}>
              {pending ? "Saving…" : "Save"}
            </Button>
          </div>
        )}
      </Field>
      <ResultMessage result={result} success="Role updated." />
    </form>
  );
}

function DeactivateForm({ user, locked }: { user: UserView; locked: boolean }) {
  const [result, formAction, pending] = useRowAction(deactivateUserAction);
  const id = useId();
  return (
    <details className="group rounded-lg border px-3 py-2 open:pb-3">
      <summary className="cursor-pointer text-sm font-medium">Deactivate…</summary>
      <form action={formAction} className="mt-3 grid gap-3">
        <input type="hidden" name="userId" value={user.id} />
        <p className="text-xs text-muted-foreground">
          {user.name} is signed out everywhere at once and can&apos;t sign in until reactivated.
          Their history stays.
        </p>
        <Field id={`${id}-reason`} label="Reason (optional)" error={errorOf(result, "reason")}>
          {(describedBy, invalid) => (
            <Input
              id={`${id}-reason`}
              name="reason"
              maxLength={200}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
            />
          )}
        </Field>
        <Button type="submit" variant="destructive" disabled={pending || locked}>
          <UserMinus aria-hidden="true" />
          {pending ? "Deactivating…" : `Deactivate ${user.username}`}
        </Button>
        {locked && (
          <p className="text-xs text-muted-foreground">
            The only active admin can&apos;t be deactivated.
          </p>
        )}
        <ResultMessage result={result} success="Deactivated." />
      </form>
    </details>
  );
}

function ReactivateForm({ user }: { user: UserView }) {
  const [result, formAction, pending] = useRowAction(reactivateUserAction);
  return (
    <form action={formAction} className="grid content-start gap-2">
      <input type="hidden" name="userId" value={user.id} />
      <p className="text-sm font-medium">Access</p>
      <Button type="submit" variant="outline" disabled={pending}>
        <UserRoundCheck aria-hidden="true" />
        {pending ? "Reactivating…" : `Reactivate ${user.username}`}
      </Button>
      <ResultMessage result={result} success="Reactivated. They can sign in again." />
    </form>
  );
}

function ResetPasswordForm({ user }: { user: UserView }) {
  const [result, formAction, pending] = useRowAction(resetPasswordAction);
  const id = useId();
  return (
    <details className="rounded-lg border px-3 py-2 open:pb-3">
      <summary className="cursor-pointer text-sm font-medium">Reset password…</summary>
      <form action={formAction} className="mt-3 grid gap-3" noValidate>
        <input type="hidden" name="userId" value={user.id} />
        <Field
          id={`${id}-password`}
          label="New password"
          hint={PASSWORD_HINT}
          error={errorOf(result, "password")}
        >
          {(describedBy, invalid) => (
            <Input
              id={`${id}-password`}
              name="password"
              type="password"
              autoComplete="new-password"
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
            />
          )}
        </Field>
        <Field
          id={`${id}-confirm`}
          label="Repeat the new password"
          error={errorOf(result, "confirmPassword")}
        >
          {(describedBy, invalid) => (
            <Input
              id={`${id}-confirm`}
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
            />
          )}
        </Field>
        <Button type="submit" variant="outline" disabled={pending}>
          <KeyRound aria-hidden="true" />
          {pending ? "Saving…" : "Set new password"}
        </Button>
        <ResultMessage
          result={result}
          success={`Password changed. ${user.name} has been signed out and must use the new password.`}
        />
      </form>
    </details>
  );
}
