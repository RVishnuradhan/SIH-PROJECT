"use client";

import { RotateCcw, TriangleAlert } from "lucide-react";
import { useEffect } from "react";

import { Button } from "@/components/ui/button";

/**
 * Fallback for unexpected errors inside a page. Never shows technical details:
 * in production Next.js replaces server error messages with a digest, shown
 * here as a reference that matches the server log (PRD §62).
 */
export default function ErrorPage({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 py-16 text-center">
      <div role="alert" className="flex max-w-md flex-col items-center gap-3">
        <span className="flex size-14 items-center justify-center rounded-full bg-status-error-soft">
          <TriangleAlert aria-hidden="true" className="size-6 text-status-error" />
        </span>
        <h1 className="text-2xl font-semibold tracking-tight">Something went wrong</h1>
        <p className="text-muted-foreground">
          Please try again. If it keeps happening, share the reference below with your
          administrator.
        </p>
        {error.digest && (
          <p className="text-sm text-muted-foreground">
            Reference: <code className="font-mono text-foreground">{error.digest}</code>
          </p>
        )}
        <Button type="button" className="mt-4" onClick={() => retry()}>
          <RotateCcw aria-hidden="true" />
          Try again
        </Button>
      </div>
    </main>
  );
}
