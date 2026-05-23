import * as React from "react";

import { cn } from "@/lib/utils";

export type PillIntent =
  | "neutral"
  | "live"
  | "warn"
  | "down"
  | "yes"
  | "no"
  | "accent";

export interface PillProps
  extends React.HTMLAttributes<HTMLSpanElement> {
  intent?: PillIntent;
  /** Small leading dot — useful for status pills (header network / oracle health). */
  withDot?: boolean;
}

const INTENT_STYLES: Record<PillIntent, { ring: string; dot: string; text: string }> = {
  neutral: {
    ring: "ring-border/60",
    dot: "bg-muted-foreground",
    text: "text-muted-foreground",
  },
  live: {
    ring: "ring-bell-yes/40",
    dot: "bg-bell-yes",
    text: "text-bell-yes",
  },
  warn: {
    ring: "ring-bell-amber/40",
    dot: "bg-bell-amber",
    text: "text-bell-amber",
  },
  down: {
    ring: "ring-bell-no/40",
    dot: "bg-bell-no",
    text: "text-bell-no",
  },
  yes: {
    ring: "ring-bell-yes/40",
    dot: "bg-bell-yes",
    text: "text-bell-yes",
  },
  no: {
    ring: "ring-bell-no/40",
    dot: "bg-bell-no",
    text: "text-bell-no",
  },
  accent: {
    ring: "ring-bell-accent/40",
    dot: "bg-bell-accent",
    text: "text-bell-accent",
  },
};

/**
 * Compact status indicator. Header network / oracle pills, market-card outcome
 * tags, position-side labels. Color comes from `--bell-*` CSS variables so
 * the mockup-decision palette swap doesn't touch consumers.
 */
export const Pill = React.forwardRef<HTMLSpanElement, PillProps>(function Pill(
  { intent = "neutral", withDot = false, className, children, ...rest },
  ref,
) {
  const style = INTENT_STYLES[intent];
  return (
    <span
      ref={ref}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
        style.ring,
        style.text,
        className,
      )}
      {...rest}
    >
      {withDot ? (
        <span
          className={cn("size-1.5 rounded-full", style.dot)}
          aria-hidden
        />
      ) : null}
      {children}
    </span>
  );
});
