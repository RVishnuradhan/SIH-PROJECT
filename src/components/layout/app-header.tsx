import { LogOut, UserRound } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";

import { Logo } from "@/components/brand/logo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { can, roleLabels } from "@/lib/permissions";
import { signOutAction } from "@/modules/auth/actions";
import type { CurrentUser } from "@/modules/auth/session";

/**
 * Minimal signed-in header (Phase 3): who is signed in, navigation, sign-out.
 * Phase 4 replaces it with the full application shell.
 */
export function AppHeader({ user }: { user: CurrentUser }) {
  const links: { href: Route; label: string }[] = [{ href: "/dashboard", label: "Dashboard" }];
  if (can(user.role, "user.manage")) links.push({ href: "/settings/users", label: "Users" });

  return (
    <header className="border-b bg-card">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-3 sm:px-6">
        <div className="flex items-center gap-6">
          <Link href="/dashboard" aria-label="SMS Associates — dashboard">
            <Logo size="sm" />
          </Link>
          <nav aria-label="Main">
            <ul className="flex items-center gap-1">
              {links.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className="rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/account"
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent"
          >
            <UserRound aria-hidden="true" className="size-4 text-muted-foreground" />
            <span className="font-medium">{user.name}</span>
            <Badge variant="outline">{roleLabels[user.role]}</Badge>
          </Link>
          <form action={signOutAction}>
            <Button type="submit" variant="ghost" size="sm">
              <LogOut aria-hidden="true" />
              Sign out
            </Button>
          </form>
        </div>
      </div>
    </header>
  );
}
