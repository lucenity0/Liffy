import { cn } from "@/lib/utils";

/**
 * A recessed block, deliberately without a shimmer sweep. A glossy gradient
 * travelling across matte paper is the one thing that would break the
 * material — so loading reads as a blank space on the page instead.
 */
export function Skeleton({
  className,
  ...rest
}: React.ComponentPropsWithoutRef<"div">) {
  return (
    <div
      aria-hidden="true"
      className={cn("rounded-chip h-4 bg-recessed", className)}
      {...rest}
    />
  );
}

/** N skeleton rows sized like Sheet.Row, for list placeholders. */
export function SkeletonRows({ rows = 3 }: { rows?: number }) {
  return (
    <div className="divide-y divide-rule" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3">
          <Skeleton className="w-40" />
          <Skeleton className="w-16" />
          <Skeleton className="ml-auto w-24" />
        </div>
      ))}
    </div>
  );
}
