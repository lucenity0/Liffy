import type { ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/utils";

/**
 * Badge knows **zero domain enums**. It has a small closed visual vocabulary
 * — six tones, three variants, two sizes — and `badgeMaps.tsx` maps the four
 * backend enums onto it. That split is what keeps four enums from turning
 * into a combinatorial mess here, and keeps tone-picking logic out of pages.
 *
 * Every class string below is complete and literal. Tailwind cannot see a
 * constructed name like `bg-${tone}-tint`, so it would generate nothing.
 */

export type BadgeTone =
  | "neutral"
  | "oxide"
  | "sage"
  | "ochre"
  | "payne"
  | "ink";
export type BadgeVariant = "tint" | "outline" | "solid";
export type BadgeSize = "sm" | "md";

const TONE: Record<BadgeTone, Record<BadgeVariant, string>> = {
  // bg-neutral-tint, not bg-recessed: Sheet.Header and an active Sheet.Row
  // are both --recessed, so a neutral badge sitting on either had no fill of
  // its own at all. --neutral-tint is the token that exists for exactly this
  // and had never been wired up to anything.
  neutral: {
    tint: "border-rule bg-neutral-tint text-ink-dim",
    outline: "border-rule bg-transparent text-ink-dim",
    solid: "border-ink-dim bg-ink-dim text-paper",
  },
  oxide: {
    tint: "border-oxide/30 bg-oxide-tint text-oxide",
    outline: "border-oxide/40 bg-transparent text-oxide",
    solid: "border-oxide bg-oxide text-paper",
  },
  sage: {
    tint: "border-sage/30 bg-sage-tint text-sage",
    outline: "border-sage/40 bg-transparent text-sage",
    solid: "border-sage bg-sage text-paper",
  },
  ochre: {
    tint: "border-ochre/30 bg-ochre-tint text-ochre",
    outline: "border-ochre/40 bg-transparent text-ochre",
    solid: "border-ochre bg-ochre text-paper",
  },
  payne: {
    tint: "border-payne/30 bg-payne-tint text-payne",
    outline: "border-payne/40 bg-transparent text-payne",
    solid: "border-payne bg-payne text-paper",
  },
  ink: {
    tint: "border-rule-strong bg-neutral-tint text-ink",
    outline: "border-rule-strong bg-transparent text-ink",
    solid: "border-ink bg-ink text-paper",
  },
};

const SIZE: Record<BadgeSize, string> = {
  sm: "px-1.5 py-px text-2xs",
  md: "px-2 py-0.5 text-xs",
};

export interface BadgeProps extends ComponentPropsWithoutRef<"span"> {
  tone?: BadgeTone;
  variant?: BadgeVariant;
  size?: BadgeSize;
  /** A leading dot, for when the label alone reads too quietly. */
  dot?: boolean;
  /** Slow pulse, for in-flight states. Respects prefers-reduced-motion. */
  pulse?: boolean;
}

export function Badge({
  tone = "neutral",
  variant = "tint",
  size = "sm",
  dot = false,
  pulse = false,
  className,
  children,
  ...rest
}: BadgeProps) {
  return (
    <span
      data-liffy="finding-badge"
      className={cn(
        "rounded-chip inline-flex items-center gap-1.5 border whitespace-nowrap uppercase",
        "tracking-label leading-normal",
        TONE[tone][variant],
        SIZE[size],
        pulse && "motion-safe:animate-pulse",
        className,
      )}
      {...rest}
    >
      {dot && (
        <span
          aria-hidden="true"
          className="size-1.5 rounded-full bg-current opacity-70"
        />
      )}
      {children}
    </span>
  );
}
