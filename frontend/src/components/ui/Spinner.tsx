import { cn } from "@/lib/utils";

const SIZE = {
  sm: "size-3.5 border",
  md: "size-5 border-2",
} as const;

/**
 * A hairline ring with one quarter inked. Under prefers-reduced-motion it
 * stops spinning but stays visible, so it still reads as "in progress".
 */
export function Spinner({
  size = "sm",
  className,
  label = "Loading",
}: {
  size?: keyof typeof SIZE;
  className?: string;
  label?: string;
}) {
  return (
    <span
      role="status"
      aria-label={label}
      className={cn(
        "inline-block shrink-0 rounded-full border-rule border-t-ink",
        "motion-safe:animate-spin",
        SIZE[size],
        className,
      )}
    />
  );
}
