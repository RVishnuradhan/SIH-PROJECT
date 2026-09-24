import { ArrowLeft, ShieldX } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "No access" };

/** Shown (with HTTP 403) when a signed-in user opens a page their role can't use. */
export default function Forbidden() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 py-16 text-center">
      <Logo />
      <div className="mt-12 flex max-w-md flex-col items-center gap-3">
        <span className="flex size-14 items-center justify-center rounded-full bg-status-error-soft">
          <ShieldX aria-hidden="true" className="size-6 text-status-error" />
        </span>
        <p className="text-sm font-medium text-muted-foreground">Error 403</p>
        <h1 className="text-2xl font-semibold tracking-tight">
          You don&apos;t have access to this page
        </h1>
        <p className="text-muted-foreground">
          This part of the app is for administrators. If you need it for your work, ask your
          administrator.
        </p>
        <Button asChild className="mt-4">
          <Link href="/dashboard">
            <ArrowLeft aria-hidden="true" />
            Back to the dashboard
          </Link>
        </Button>
      </div>
    </main>
  );
}
