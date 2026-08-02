import {
  useId,
  type ComponentPropsWithoutRef,
  type ReactNode,
  type Ref,
} from "react";
import { cn } from "@/lib/utils";

/**
 * Label + control + hint + error, with the ids and aria-describedby wired up
 * — the part that is tedious enough by hand that it quietly stops happening.
 *
 * Renders its child through a function so the caller keeps full control of
 * the control itself, while Field owns the accessibility plumbing.
 */
export function Field({
  label,
  hint,
  error,
  required,
  children,
  className,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  required?: boolean;
  children: (props: {
    id: string;
    "aria-describedby": string | undefined;
    "aria-invalid": boolean | undefined;
    required: boolean | undefined;
  }) => ReactNode;
  className?: string;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  const describedBy =
    [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(" ") ||
    undefined;

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="label text-ink">
        {label}
        {required && (
          <span aria-hidden="true" className="text-oxide">
            {" "}
            *
          </span>
        )}
      </label>

      {children({
        id,
        "aria-describedby": describedBy,
        "aria-invalid": error ? true : undefined,
        required,
      })}

      {hint && !error && (
        <p id={hintId} className="text-sm text-ink-dim">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-sm text-oxide">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * The paper text input. Inset rather than raised — a ruled box on the page.
 *
 * `ref` is spelled out because React 19 hands it over as an ordinary prop and
 * `ComponentPropsWithoutRef` leaves it out — the reviews filter focuses this
 * the moment its magnifier expands. Same shape as Button's.
 */
export function Input({
  className,
  ref,
  ...rest
}: ComponentPropsWithoutRef<"input"> & { ref?: Ref<HTMLInputElement> }) {
  return (
    <input
      ref={ref}
      className={cn(
        "rounded-chip border border-rule bg-paper px-2.5 py-1.5",
        "font-code text-base text-ink placeholder:text-ink-sub",
        "hover:border-rule-strong",
        "aria-invalid:border-oxide",
        "disabled:cursor-not-allowed disabled:opacity-60",
        className,
      )}
      {...rest}
    />
  );
}

/**
 * The matching dropdown. A native `<select>` rather than a listbox built out
 * of divs: it is keyboard reachable, screen-reader labelled and correct on
 * touch for free, and nothing here needs an affordance a native control
 * cannot give.
 *
 * `font-sans`, not the `font-code` of Input — these hold prose labels, not
 * identifiers.
 */
export function Select({
  className,
  children,
  ...rest
}: ComponentPropsWithoutRef<"select">) {
  return (
    <select
      className={cn(
        "rounded-chip border border-rule bg-paper px-2.5 py-1.5",
        "text-base text-ink",
        "hover:border-rule-strong",
        "disabled:cursor-not-allowed disabled:opacity-60",
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  );
}
