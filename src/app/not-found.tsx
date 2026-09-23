import { ArrowLeft, SearchX } from "lucide-react";
import Link from "next/link";

import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 py-16 text-center">
      <Logo />
      <div className="mt-12 flex max-w-md flex-col items-center gap-3">
        <span className="flex size-14 items-center justify-center rounded-full bg-muted">
          <SearchX aria-hidden="true" className="size-6 text-muted-foreground" />
        </span>
        <p className="text-sm font-medium text-muted-foreground">Error 404</p>
        <h1 className="text-2xl font-semibold tracking-tight">Page not found</h1>
        <p className="text-muted-foreground">
          The page you are looking for doesn&apos;t exist or has moved.
        </p>
        <Button asChild className="mt-4">
          <Link href="/">
            <ArrowLeft aria-hidden="true" />
            Back to start
          </Link>
        </Button>
      </div>
    </main>
  );
}
