import {
  CheckCircle2,
  CircleDot,
  Clock,
  PackageCheck,
  TriangleAlert,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import type { Metadata } from "next";
import type { ReactNode } from "react";

import { Logo } from "@/components/brand/logo";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { brand } from "@/lib/brand";
import { cn } from "@/lib/utils";

// The root layout's title template only applies to child segments, so this
// page (in the same segment) sets its full title itself.
export const metadata: Metadata = { title: { absolute: `UI foundation · ${brand.name}` } };

type Status = {
  variant: NonNullable<BadgeProps["variant"]>;
  label: string;
  icon: LucideIcon;
  usage: string;
};

// The six states the PRD (§59) requires to be visually distinguishable.
const statuses: Status[] = [
  {
    variant: "active",
    label: "Active",
    icon: CircleDot,
    usage: "Materials are out with a customer",
  },
  { variant: "pending", label: "Pending", icon: Clock, usage: "Waiting for a return or a payment" },
  { variant: "returned", label: "Returned", icon: PackageCheck, usage: "Every piece is back" },
  { variant: "success", label: "Success", icon: CheckCircle2, usage: "An action completed" },
  {
    variant: "warning",
    label: "Warning",
    icon: TriangleAlert,
    usage: "Needs attention, e.g. low stock",
  },
  { variant: "error", label: "Error", icon: XCircle, usage: "Something failed or was refused" },
];

const swatches = [
  { name: "Primary", token: "--primary", className: "bg-primary" },
  { name: "Foreground", token: "--foreground", className: "bg-foreground" },
  { name: "Muted text", token: "--muted-foreground", className: "bg-muted-foreground" },
  { name: "Border", token: "--border", className: "bg-border" },
  { name: "Muted", token: "--muted", className: "bg-muted" },
  { name: "Background", token: "--background", className: "bg-background" },
];

function Section({
  eyebrow,
  title,
  className,
  children,
}: {
  eyebrow: string;
  title: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn("rounded-2xl border bg-card p-6 shadow-sm sm:p-8", className)}>
      <p className="text-xs font-semibold tracking-[0.14em] text-primary uppercase">{eyebrow}</p>
      <h2 className="mt-1 text-lg font-semibold tracking-tight">{title}</h2>
      <div className="mt-6">{children}</div>
    </section>
  );
}

/**
 * Temporary Phase 1 page: previews the design foundation (colours, status
 * states, type, buttons, Tamil and numeral rendering). Replaced by the welcome
 * screen in Phase 5.
 */
export default function FoundationPage() {
  return (
    <div className="relative isolate min-h-dvh overflow-hidden">
      <div
        aria-hidden="true"
        className="absolute inset-x-0 top-0 -z-10 h-[28rem] bg-[radial-gradient(60rem_28rem_at_50%_-8rem,color-mix(in_oklch,var(--primary)_14%,transparent),transparent)]"
      />

      <header className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-6 sm:px-6">
        <Logo />
        <Badge variant="outline" className="hidden bg-card sm:inline-flex">
          Phase 1 · UI foundation
        </Badge>
      </header>

      <main className="mx-auto max-w-6xl px-4 pb-16 sm:px-6">
        <div className="py-10 sm:py-16">
          <p className="text-sm font-medium text-muted-foreground">{brand.productName}</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
            {brand.wordmark}
          </h1>
          <p className="mt-3 text-lg text-muted-foreground">{brand.tagline}</p>
          <p className="mt-8 max-w-2xl text-sm/6 text-muted-foreground">
            This page previews the design foundation the application is built on. It is replaced by
            the welcome screen in Phase 5.
          </p>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <Section eyebrow="Colour" title="Brand and neutrals">
            <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              {swatches.map((swatch) => (
                <li key={swatch.token} className="space-y-2">
                  <div className={`h-14 rounded-lg border ${swatch.className}`} />
                  <div>
                    <p className="text-sm font-medium">{swatch.name}</p>
                    <p className="font-mono text-xs text-muted-foreground">{swatch.token}</p>
                  </div>
                </li>
              ))}
            </ul>
          </Section>

          <Section eyebrow="States" title="Status colours">
            <ul className="divide-y">
              {statuses.map(({ variant, label, icon: Icon, usage }) => (
                <li key={variant} className="flex items-center justify-between gap-4 py-3">
                  <Badge variant={variant}>
                    <Icon aria-hidden="true" />
                    {label}
                  </Badge>
                  <span className="text-right text-sm text-muted-foreground">{usage}</span>
                </li>
              ))}
            </ul>
          </Section>

          <Section eyebrow="Type" title="Typography">
            <div className="space-y-4">
              <p className="text-3xl font-semibold tracking-tight">Rental Bill</p>
              <p className="text-xl font-semibold tracking-tight">Pending returns</p>
              <p className="text-base">
                Body text is set in Inter for clear, even reading on screens of every size.
              </p>
              <p className="text-sm text-muted-foreground">
                Secondary text uses the muted colour and still meets WCAG AA contrast.
              </p>
            </div>
          </Section>

          <Section eyebrow="Actions" title="Buttons">
            <div className="flex flex-wrap gap-3">
              <Button type="button">Primary</Button>
              <Button type="button" variant="secondary">
                Secondary
              </Button>
              <Button type="button" variant="outline">
                Outline
              </Button>
              <Button type="button" variant="ghost">
                Ghost
              </Button>
              <Button type="button" variant="destructive">
                Destructive
              </Button>
              <Button type="button" variant="link">
                Link
              </Button>
            </div>
          </Section>

          <Section eyebrow="Rendering" title="Numbers and languages" className="lg:col-span-2">
            <dl className="grid gap-5 sm:grid-cols-3">
              <div>
                <dt className="text-xs text-muted-foreground">Tabular numerals</dt>
                <dd className="mt-1 text-lg font-medium tabular-nums">0123456789</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Size variants</dt>
                <dd className="mt-1 text-lg font-medium">3 × 1½ · 4 × ¾</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Tamil text</dt>
                <dd className="mt-1 text-lg font-medium" lang="ta">
                  முட்டு மரம் · பலகை
                </dd>
              </div>
            </dl>
          </Section>
        </div>
      </main>

      <footer className="border-t bg-card/60">
        <div className="mx-auto max-w-6xl px-4 py-6 text-xs text-muted-foreground sm:px-6">
          {brand.name} · {brand.tagline}
        </div>
      </footer>
    </div>
  );
}
