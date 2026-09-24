import type { ReactNode } from "react";

import { AppHeader } from "@/components/layout/app-header";
import { requireUser } from "@/modules/auth/session";

/**
 * Everything under this group needs a signed-in user. Layouts don't re-run on
 * every navigation, so each page also checks the session and its permission
 * itself; this check only decides what the header shows.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  return (
    <div className="min-h-dvh">
      <AppHeader user={user} />
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10">{children}</main>
    </div>
  );
}
