import type { ComponentPropsWithoutRef, Ref } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { Spinner } from "./Spinner";

/**
 * Buttons are bordered boxes, not filled pills — straight from the portfolio's
 * interaction language: hover shifts the border `rule → rule-strong`, and the
 * primary action is a full invert to paper-on-ink.
 *
 * React 19: `ref` is an ordinary prop, so no forwardRef.
 */

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

const VARIANT: Record<ButtonVariant, string> = {
  primary:
    "border-ink bg-ink text-paper shadow-hard hover:bg-ink-dim hover:border-ink-dim",
  secondary:
    "border-rule bg-card text-ink shadow-hard hover:border-rule-strong hover:bg-recessed",
  ghost:
    "border-transparent bg-transparent text-ink-dim hover:border-rule hover:text-ink",
  danger:
    "border-oxide/40 bg-oxide-tint text-oxide shadow-hard hover:border-oxide hover:bg-oxide hover:text-paper",
};

const SIZE: Record<ButtonSize, string> = {
  sm: "gap-1.5 px-2.5 py-1 text-sm",
  md: "gap-2 px-3.5 py-1.5 text-base",
};

const BASE = cn(
  "rounded-chip inline-flex items-center justify-center border no-underline",
  "transition-colors duration-100 select-none",
  "disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none",
  "aria-disabled:cursor-not-allowed aria-disabled:opacity-50",
);

interface CommonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
}

export interface ButtonProps
  extends ComponentPropsWithoutRef<"button">,
    CommonProps {
  /** Swaps the leading slot for a Spinner and disables the button. */
  loading?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

export function Button({
  variant = "secondary",
  size = "sm",
  loading = false,
  disabled,
  className,
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={cn(BASE, VARIANT[variant], SIZE[size], className)}
      {...rest}
    >
      {loading && (
        <Spinner
          size="sm"
          label=""
          className={variant === "primary" ? "border-t-paper" : undefined}
        />
      )}
      {children}
    </button>
  );
}

export interface ButtonLinkProps
  extends Omit<ComponentPropsWithoutRef<typeof Link>, "className">,
    CommonProps {}

/** Same skin, but a real link — for navigation rather than an action. */
export function ButtonLink({
  variant = "secondary",
  size = "sm",
  className,
  children,
  ...rest
}: ButtonLinkProps) {
  return (
    <Link
      className={cn(BASE, VARIANT[variant], SIZE[size], className)}
      {...rest}
    >
      {children}
    </Link>
  );
}
