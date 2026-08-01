import { REVIEWS_PAGE_SIZE } from "@/hooks/useReviews";
import { isValidPrNumber } from "@/lib/validators";
import { REVIEW_STATUSES, type ReviewStatus } from "@/types/api";
import type { ReviewSort } from "@/api/reviews";

/**
 * The reviews list keeps its whole view — page *and* filters — in the URL, so
 * a filtered view survives a refresh, a back button and being pasted into
 * Slack. That also means every one of these values has to survive whatever
 * someone types in the address bar.
 *
 * The backend answers 422 to a `status` it does not recognise and to a
 * non-integer `offset`, and a 422 on a list page is a blank screen rather
 * than a field anyone can correct. So each parser below degrades an unusable
 * value to "no filter" and lets the page render, rather than forwarding
 * garbage and letting the API reject it.
 */

export function parseOffset(
  raw: string | null,
  pageSize: number = REVIEWS_PAGE_SIZE,
): number {
  const parsed = Number(raw);
  if (!raw || !Number.isFinite(parsed) || parsed < 0) return 0;
  // Snap to a page boundary, so Previous and Next stay on the same grid as
  // the rows already on screen.
  return Math.floor(parsed / pageSize) * pageSize;
}

/**
 * A repo id is only usable if it looks like the UUID the backend parses.
 * Anything else would 422 — and unlike a bad status, we cannot tell a typo'd
 * id from one belonging to a repository the caller cannot see, so both
 * degrade to the unfiltered list.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseRepoId(raw: string | null): string | undefined {
  return raw && UUID_RE.test(raw) ? raw : undefined;
}

/**
 * Reuses `isValidPrNumber` rather than `Number(raw)`, which reads "1e3" as
 * 1000 and "0x10" as 16 — the same reason the trigger form does not use it.
 */
export function parsePrNumber(raw: string | null): number | undefined {
  return raw && isValidPrNumber(raw) ? Number(raw.trim()) : undefined;
}

export function parseStatus(raw: string | null): ReviewStatus | undefined {
  return raw && (REVIEW_STATUSES as readonly string[]).includes(raw)
    ? (raw as ReviewStatus)
    : undefined;
}

/**
 * Unlike the others this has no "absent" state — a list is always in some
 * order — so an unreadable value falls back to the default rather than to
 * no sort at all.
 */
export function parseSort(raw: string | null): ReviewSort {
  return raw === "oldest" ? "oldest" : "newest";
}

/** Every filter the reviews list reads out of the URL. */
export interface ReviewFilters {
  repoId?: string;
  prNumber?: number;
  status?: ReviewStatus;
  sort: ReviewSort;
}

export function parseReviewFilters(params: URLSearchParams): ReviewFilters {
  return {
    repoId: parseRepoId(params.get("repo")),
    prNumber: parsePrNumber(params.get("pr")),
    status: parseStatus(params.get("status")),
    sort: parseSort(params.get("sort")),
  };
}

/** True when anything is narrowing the list — what "Clear filters" keys off. */
export function hasActiveFilters(filters: ReviewFilters): boolean {
  return (
    filters.repoId !== undefined ||
    filters.prNumber !== undefined ||
    filters.status !== undefined ||
    filters.sort !== "newest"
  );
}
