import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The three controls this page is built out of.
 *
 * Appearance used to be a wall of colour inputs at equal weight, which is how
 * you end up unable to tell which of nineteen swatches is the one you want.
 * These exist so every setting reads as "a named question with a small number
 * of answers" — a segmented choice where the answers are discrete, a slider
 * where they are continuous, and a labelled row around either.
 */

/** A labelled setting. The label is the question; the control is the answer. */
export function Row({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <p className="label text-ink">{label}</p>
      {hint && <p className="text-sm text-ink-sub">{hint}</p>}
      {children}
    </div>
  );
}

/**
 * A segmented choice.
 *
 * A radiogroup rather than a `<select>`: there are never more than six
 * answers, all of them worth seeing at once, and half of them change how the
 * page looks the moment they are pressed. Hiding those behind a dropdown
 * makes you open it, guess, and close it to find out.
 */
export function Choice<T extends string | number>({
  value,
  options,
  onChange,
  label,
  columns,
}: {
  value: T;
  options: readonly { value: T; label: string; note?: string }[];
  onChange: (value: T) => void;
  label: string;
  columns?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn("gap-1.5", columns ? "grid sm:grid-cols-2" : "flex flex-wrap")}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={String(option.value)}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.value)}
            className={cn(
              "rounded-chip border px-2.5 py-1.5 text-left text-sm transition-colors duration-100",
              selected
                ? "border-ink bg-neutral-tint text-ink"
                : "border-rule text-ink-dim hover:border-rule-strong hover:text-ink",
            )}
          >
            <span className="block">{option.label}</span>
            {option.note && (
              <span className="block text-2xs text-ink-sub">{option.note}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A slider that says where it is.
 *
 * The readout is not decoration: a range input with no value is a control you
 * can only aim by watching the page behind it, and half of these move things
 * that are off screen.
 */
export function Slider({
  label,
  hint,
  value,
  min,
  max,
  step,
  format,
  onChange,
  ends,
  hideLabel,
}: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
  /** The two ends, named. Cheaper to read than working them out from min/max. */
  ends?: [string, string];
  /**
   * For callers that already printed the label — the component editor puts
   * its own heading above each knob, and two of them reads as a bug. The
   * `aria-label` on the input stays either way, so the control keeps its name
   * for anyone not reading the heading.
   */
  hideLabel?: boolean;
}) {
  const control = (
    <div className="flex items-center gap-3">
        {ends && <span className="shrink-0 text-2xs text-ink-sub">{ends[0]}</span>}
        <input
          type="range"
          aria-label={label}
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          className="min-w-0 flex-1 accent-ink"
        />
        {ends && <span className="shrink-0 text-2xs text-ink-sub">{ends[1]}</span>}
        <span
          data-numeric
          className="w-12 shrink-0 text-right font-code text-2xs text-ink-dim"
        >
          {format(value)}
        </span>
    </div>
  );

  if (hideLabel) return control;
  return (
    <Row label={label} hint={hint}>
      {control}
    </Row>
  );
}

/** A colour, as a swatch plus the hex it stands for. */
export function ColorInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <span className="flex items-center gap-2">
      <input
        type="color"
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="size-7 shrink-0 cursor-pointer rounded-chip border border-rule bg-card"
      />
      <input
        type="text"
        aria-label={`${label} hex`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-24 rounded-chip border border-rule bg-card px-2 py-1 font-code text-2xs text-ink"
      />
    </span>
  );
}
