import { normalizeApiError } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { Button } from "./Button";

/**
 * A failed query, shown in place of the section that failed rather than
 * taking the whole page down. Distinct from `ErrorBoundary`, which catches
 * *thrown* errors — a rejected query never throws, it just leaves `error` set.
 *
 * The message comes from `normalizeApiError` by default, so a 503 reads "no
 * GitHub token configured" instead of "Request failed with status code 503".
 */
export function ErrorNote({
  error,
  message,
  onRetry,
  className,
}: {
  error: unknown;
  /**
   * Replaces the normalized copy for a caller whose failures the shared
   * mapper cannot phrase. `normalizeApiError` is written around the repo and
   * trigger endpoints — its 422 branch says *"That doesn't look like
   * owner/name."*, which is wrong anywhere else. Widening the mapper for one
   * caller would change the copy on every page that already reads correctly.
   */
  message?: string;
  onRetry?: () => void;
  className?: string;
}) {
  const normalized = normalizeApiError(error);
  const text = message ?? normalized.message;
  const { status } = normalized;

  return (
    <div
      role="alert"
      className={cn(
        "rounded-sheet flex flex-col items-start gap-2 border border-oxide/30 bg-oxide-tint px-4 py-3",
        className,
      )}
    >
      <p className="text-base text-ink">{text}</p>
      {status !== null && <p className="label">HTTP {status}</p>}
      {onRetry && (
        <Button onClick={onRetry} className="mt-1">
          Try again
        </Button>
      )}
    </div>
  );
}
