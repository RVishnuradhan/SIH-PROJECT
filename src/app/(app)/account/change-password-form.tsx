"use client";

import { KeyRound } from "lucide-react";
import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Field, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import type { ActionResult } from "@/lib/action";
import { cn } from "@/lib/utils";
import { changePasswordAction } from "@/modules/auth/actions";
import { PASSWORD_MIN_LENGTH } from "@/modules/auth/password-rules";

export function ChangePasswordForm({ className }: { className?: string }) {
  const [result, formAction, pending] = useActionState<ActionResult | null, FormData>(
    changePasswordAction,
    null,
  );
  const error = (field: string) => (result && !result.ok ? result.fieldErrors?.[field] : undefined);

  return (
    <form action={formAction} className={cn("grid gap-5", className)} noValidate>
      {result?.ok && <FormMessage tone="success">Your password has been changed.</FormMessage>}
      {result && !result.ok && !result.fieldErrors && (
        <FormMessage tone="error">
          {result.message}
          {result.reference && ` (Reference ${result.reference})`}
        </FormMessage>
      )}
      <Field id="current-password" label="Current password" error={error("currentPassword")}>
        {(describedBy, invalid) => (
          <Input
            id="current-password"
            name="currentPassword"
            type="password"
            autoComplete="current-password"
            required
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
          />
        )}
      </Field>
      <Field
        id="new-password"
        label="New password"
        hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
        error={error("password")}
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
      <Field id="confirm-password" label="Repeat the new password" error={error("confirmPassword")}>
        {(describedBy, invalid) => (
          <Input
            id="confirm-password"
            name="confirmPassword"
            type="password"
            autoComplete="new-password"
            required
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
          />
        )}
      </Field>
      <div>
        <Button type="submit" disabled={pending}>
          <KeyRound aria-hidden="true" />
          {pending ? "Saving…" : "Change password"}
        </Button>
      </div>
    </form>
  );
}
