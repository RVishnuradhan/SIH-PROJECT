import { brand } from "@/lib/brand";
import { cn } from "@/lib/utils";

const markSizes = {
  sm: "h-8 w-11 text-[0.7rem] rounded-md",
  md: "h-10 w-14 text-xs rounded-lg",
  lg: "h-14 w-20 text-base rounded-xl",
} as const;

type LogoSize = keyof typeof markSizes;

/** The "SMS" monogram. Decorative: always used next to the written name. */
export function LogoMark({ size = "md", className }: { size?: LogoSize; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center bg-primary font-bold tracking-wider text-primary-foreground shadow-sm ring-1 ring-primary/20 ring-inset",
        markSizes[size],
        className,
      )}
    >
      SMS
    </span>
  );
}

/**
 * Temporary text logo (decision A18) until the real logo file is provided.
 */
export function Logo({
  size = "md",
  showTagline = false,
  className,
}: {
  size?: LogoSize;
  showTagline?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <LogoMark size={size} />
      <div className="flex flex-col leading-tight">
        <span className="text-sm font-semibold tracking-[0.18em] whitespace-nowrap text-foreground">
          {brand.wordmark}
        </span>
        {showTagline && <span className="text-xs text-muted-foreground">{brand.tagline}</span>}
      </div>
    </div>
  );
}
