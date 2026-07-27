import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The zero state. The heading is set in font-hand because an empty page is
 * where Liffy is most obviously speaking to you rather than reporting data.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  /** A CTA. Rendered only when provided. */
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-2 px-6 py-12 text-center",
        className,
      )}
    >
      {icon && <div className="mb-1 text-ink-sub">{icon}</div>}
      <p className="font-hand text-lg leading-tight text-ink">{title}</p>
      {description && (
        <p className="max-w-prose text-sm text-ink-dim">{description}</p>
      )}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}
