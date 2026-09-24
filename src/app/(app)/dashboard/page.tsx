import { ShieldCheck, Users } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { can, roleLabels } from "@/lib/permissions";
import { requirePermission } from "@/modules/auth/session";

export const metadata: Metadata = { title: "Dashboard" };

/**
 * Where people land after signing in. A placeholder until Phase 5 builds the
 * dashboard (statistics, quick actions, recent activity).
 */
export default async function DashboardPage() {
  const user = await requirePermission("dashboard.view");

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium text-muted-foreground">Dashboard</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Welcome, {user.name}</h1>
      </div>

      <section className="rounded-2xl border bg-card p-6 shadow-sm">
        <div className="flex items-start gap-4">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-status-success-soft">
            <ShieldCheck aria-hidden="true" className="size-5 text-status-success" />
          </span>
          <div className="space-y-1">
            <h2 className="font-semibold">
              Signed in as {user.username} · {roleLabels[user.role]}
            </h2>
            <p className="text-sm text-muted-foreground">
              Rental statistics, quick actions and recent activity will appear here once the
              dashboard is built (Phase 5).
            </p>
          </div>
        </div>
      </section>

      {can(user.role, "user.manage") && (
        <Button asChild variant="outline">
          <Link href="/settings/users">
            <Users aria-hidden="true" />
            Manage users
          </Link>
        </Button>
      )}
    </div>
  );
}
