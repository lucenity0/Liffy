import { REVIEWS_PAGE_SIZE } from "@/hooks/useReviews";

/**
 * `offset` lives in the URL so a page survives a refresh, a back button and a
 * pasted link. That also means it has to survive whatever someone types in
 * the address bar: the backend declares `offset: int = Query(ge=0)` and
 * answers 422 to anything else, and a 422 on a list page is a blank screen
 * rather than a field to correct. Anything unusable snaps back to page one.
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
