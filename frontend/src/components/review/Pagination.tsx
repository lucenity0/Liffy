import { Button } from "@/components/ui/Button";
import { formatCount } from "@/lib/utils";

/**
 * Previous / Next only — no page numbers, and that is not laziness.
 * `GET /reviews` returns a bare array with no total count, so the last page
 * is unknowable; the most we can honestly say is which rows are on screen
 * and whether a full page came back (which means there *may* be more).
 */
export function Pagination({
  offset,
  count,
  hasPrevious,
  hasNext,
  onPrevious,
  onNext,
}: {
  offset: number;
  /** Rows on this page, which is all we know about the size of anything. */
  count: number;
  hasPrevious: boolean;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  return (
    <nav aria-label="Pagination" className="flex w-full items-center gap-3">
      <p className="label" data-numeric>
        {count > 0
          ? `${formatCount(offset + 1)}–${formatCount(offset + count)}`
          : "No rows"}
      </p>

      <div className="ml-auto flex items-center gap-2">
        <Button onClick={onPrevious} disabled={!hasPrevious}>
          ← Previous
        </Button>
        <Button onClick={onNext} disabled={!hasNext}>
          Next →
        </Button>
      </div>
    </nav>
  );
}
