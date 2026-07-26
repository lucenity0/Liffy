import { normalizeApiError } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { Button } from "./Button";

/**
 * A failed query, shown in place of the section that failed rather than
 * taking the whole page down. Distinct from `ErrorBoundary`, which catches
 * *thrown* errors — a rejected query never throws, it just leaves `error` set.
 *
 * Every message comes from `normalizeApiError`, so a 503 reads "no GitHub
 * token configured" instead of "Request failed with status code 503".
 */
export function ErrorNote({
  error,
  onRetry,
  className,
}: {
  error: unknown;
  onRetry?: () => void;
  className?: string;
}) {
  const { message, status } = normalizeApiError(error);

  return (
    <div
      role="alert"
      className={cn(
        "rounded-sheet flex flex-col items-start gap-2 border border-oxide/30 bg-oxide-tint px-4 py-3",
        className,
      )}
    >
      <p className="text-base text-ink">{message}</p>
      {status !== null && <p className="label">HTTP {status}</p>}
      {onRetry && (
        <Button onClick={onRetry} className="mt-1">
          Try again
        </Button>
      )}
    </div>
  );
}
