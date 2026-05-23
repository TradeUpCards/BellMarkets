import * as React from "react";

import { cn } from "@/lib/utils";

export interface MonoNumberProps
  extends Omit<React.HTMLAttributes<HTMLSpanElement>, "children"> {
  /** Numeric value (number or bigint). Strings are rendered verbatim. */
  value: number | bigint | string;
  /** Decimal places for number/bigint formatting. Default: 2 for number, 0 for bigint. */
  decimals?: number;
  /** When true, prefix non-negative numbers with `+`. Useful for P&L deltas. */
  signed?: boolean;
  /** Optional prefix (e.g., "$"). Rendered in the same mono font. */
  prefix?: string;
  /** Optional suffix (e.g., " USDC"). Rendered in the same mono font. */
  suffix?: string;
  /** Color-tag intent: green for profit / Yes, red for loss / No, amber pending. */
  intent?: "profit" | "loss" | "pending" | "neutral";
}

/**
 * Render a numeric value in JetBrains Mono with tabular-nums so columns line
 * up. The single most-used trading UI primitive — every price / size / P&L /
 * balance routes through here.
 *
 * Design-agnostic: the color intent maps to CSS variables (`--bell-yes`,
 * `--bell-no`, `--bell-amber`) so the mockup decision can shift palettes
 * without rewriting consumers.
 */
export const MonoNumber = React.forwardRef<HTMLSpanElement, MonoNumberProps>(
  function MonoNumber(
    { value, decimals, signed, prefix, suffix, intent, className, ...rest },
    ref,
  ) {
    let body: string;
    if (typeof value === "string") {
      body = value;
    } else if (typeof value === "bigint") {
      const d = decimals ?? 0;
      const negative = value < 0n;
      const abs = negative ? -value : value;
      if (d === 0) {
        body = abs.toString();
      } else {
        const s = abs.toString().padStart(d + 1, "0");
        const whole = s.slice(0, -d);
        const frac = s.slice(-d);
        body = `${whole}.${frac}`;
      }
      if (negative) body = `-${body}`;
      else if (signed) body = `+${body}`;
    } else {
      const d = decimals ?? 2;
      const formatted = value.toFixed(d);
      body = signed && value > 0 ? `+${formatted}` : formatted;
    }

    const intentClass: Record<NonNullable<MonoNumberProps["intent"]>, string> = {
      profit: "text-bell-yes",
      loss: "text-bell-no",
      pending: "text-bell-amber",
      neutral: "",
    };

    return (
      <span
        ref={ref}
        className={cn(
          "font-mono tabular-nums",
          intent ? intentClass[intent] : undefined,
          className,
        )}
        {...rest}
      >
        {prefix}
        {body}
        {suffix}
      </span>
    );
  },
);
