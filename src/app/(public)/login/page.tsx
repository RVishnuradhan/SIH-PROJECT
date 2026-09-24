import type { Metadata, Route } from "next";
import { redirect } from "next/navigation";

import { Logo } from "@/components/brand/logo";
import { brand } from "@/lib/brand";
import { safeRedirectPath } from "@/lib/routes";
import { getCurrentUser } from "@/modules/auth/session";

import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { next } = await searchParams;
  const nextPath = typeof next === "string" ? safeRedirectPath(next) : undefined;

  // Already signed in: go straight on.
  if (await getCurrentUser()) redirect((nextPath ?? safeRedirectPath(undefined)) as Route);

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center text-center">
          <Logo size="lg" />
          <h1 className="mt-8 text-2xl font-semibold tracking-tight">Sign in</h1>
          <p className="mt-2 text-sm text-muted-foreground">{brand.productName}</p>
        </div>
        <div className="mt-8 rounded-2xl border bg-card p-6 shadow-sm">
          <LoginForm next={nextPath} />
        </div>
        <p className="mt-6 text-center text-xs text-muted-foreground">
          Accounts are created by the administrator. Forgot your password? Ask your administrator to
          reset it.
        </p>
      </div>
    </main>
  );
}
