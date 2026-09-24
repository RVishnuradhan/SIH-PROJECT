"use client";

import { Eye, EyeOff, LogIn } from "lucide-react";
import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { Field, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { signInAction, type SignInState } from "@/modules/auth/actions";

export function LoginForm({ next }: { next?: string }) {
  const [state, formAction, pending] = useActionState<SignInState, FormData>(signInAction, {});
  const [showPassword, setShowPassword] = useState(false);

  return (
    <form action={formAction} className="grid gap-5" noValidate>
      {next && <input type="hidden" name="next" value={next} />}

      {state.error && <FormMessage tone="error">{state.error}</FormMessage>}

      <Field id="username" label="Username" error={state.fieldErrors?.username}>
        {(describedBy, invalid) => (
          <Input
            id="username"
            name="username"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
            defaultValue={state.username}
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
          />
        )}
      </Field>

      <Field id="password" label="Password" error={state.fieldErrors?.password}>
        {(describedBy, invalid) => (
          <div className="relative">
            <Input
              id="password"
              name="password"
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              required
              className="pr-11"
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
            />
            <button
              type="button"
              onClick={() => setShowPassword((value) => !value)}
              className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-md text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40"
              aria-label={showPassword ? "Hide password" : "Show password"}
              aria-pressed={showPassword}
            >
              {showPassword ? (
                <EyeOff aria-hidden="true" className="size-4" />
              ) : (
                <Eye aria-hidden="true" className="size-4" />
              )}
            </button>
          </div>
        )}
      </Field>

      <Button type="submit" size="lg" disabled={pending} className="w-full">
        <LogIn aria-hidden="true" />
        {pending ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}
