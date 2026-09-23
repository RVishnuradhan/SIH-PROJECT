"use client";

import "./globals.css";

/**
 * Last-resort fallback when the root layout itself fails. It replaces the whole
 * document, so it renders its own <html>, <body> and <title>.
 */
export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <html lang="en-IN">
      <body className="min-h-dvh bg-background font-sans text-foreground antialiased">
        <title>Something went wrong · SMS Associates</title>
        <main className="flex min-h-dvh flex-col items-center justify-center px-4 py-16 text-center">
          <div role="alert" className="flex max-w-md flex-col items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">Something went wrong</h1>
            <p className="text-muted-foreground">
              The application could not load. Please try again. If it keeps happening, share the
              reference below with your administrator.
            </p>
            {error.digest && (
              <p className="text-sm text-muted-foreground">
                Reference: <code className="font-mono text-foreground">{error.digest}</code>
              </p>
            )}
            <button
              type="button"
              onClick={() => retry()}
              className="mt-4 inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              Try again
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
