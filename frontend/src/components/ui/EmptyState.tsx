import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { PixelSprite } from "./PixelSprite";

/**
 * The zero state. The heading is set in font-hand because an empty page is
 * where Liffy is most obviously speaking to you rather than reporting data —
 * and, for the same reason, where the cat belongs. An empty screen is the one
 * place with room for it and the one place that reads as cold without it.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  /** Overrides the cat. Pass `null` to show nothing at all. */
  icon?: ReactNode | null;
  title: string;
  description?: string;
  /** A CTA. Rendered only when provided. */
  action?: ReactNode;
  className?: string;
}) {
  // Decorative: the heading below already says what the state is, so the
  // sprite carries no label and stays out of the accessibility tree.
  const mark =
    icon === undefined ? <PixelSprite name="cat" cell={3} /> : icon;

  return (
    <div
      className={cn(
        "flex flex-col items-center gap-2 px-6 py-12 text-center",
        className,
      )}
    >
      {mark && <div className="mb-1 text-ink-sub">{mark}</div>}
      <p className="font-hand text-lg leading-tight text-ink">{title}</p>
      {description && (
        <p className="max-w-prose text-sm text-ink-dim">{description}</p>
      )}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}
