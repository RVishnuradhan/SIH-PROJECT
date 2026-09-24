import type { Metadata } from "next";

import { roleLabels } from "@/lib/permissions";
import { requireUser } from "@/modules/auth/session";

import { ChangePasswordForm } from "./change-password-form";

export const metadata: Metadata = { title: "Your account" };

export default async function AccountPage() {
  const user = await requireUser();

  return (
    <div className="max-w-2xl space-y-8">
      <div>
        <p className="text-sm font-medium text-muted-foreground">Account</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{user.name}</h1>
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 rounded-2xl border bg-card p-6 text-sm shadow-sm">
        <dt className="text-muted-foreground">Username</dt>
        <dd className="font-medium">{user.username}</dd>
        <dt className="text-muted-foreground">Role</dt>
        <dd className="font-medium">{roleLabels[user.role]}</dd>
      </dl>

      <section
        aria-labelledby="change-password"
        className="rounded-2xl border bg-card p-6 shadow-sm"
      >
        <h2 id="change-password" className="text-lg font-semibold tracking-tight">
          Change password
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          You stay signed in here; every other device you&apos;re signed in on is signed out.
        </p>
        <ChangePasswordForm className="mt-6" />
      </section>
    </div>
  );
}
