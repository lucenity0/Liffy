/**
 * Mirrors `RepoConnectRequest._owner_slash_name` in
 * `backend/app/schemas/repo.py`, deliberately down to the odd bits: the
 * backend strips surrounding whitespace *and* surrounding slashes before
 * counting, so "/owner/name/" is valid there and must be valid here too.
 *
 * Validating client-side is only worth doing if it agrees with the server.
 * A rule that is stricter than the backend's rejects input the API would
 * have accepted, which is worse than not validating at all.
 */

export function normalizeFullName(value: string): string {
  return value.trim().replace(/^\/+|\/+$/g, "");
}

/** Exactly one slash, with something on both sides of it. */
export function isValidFullName(value: string): boolean {
  const parts = normalizeFullName(value).split("/");
  return parts.length === 2 && parts.every((part) => part.length > 0);
}

export const FULL_NAME_HINT = "owner/name, as it appears in the GitHub URL.";

/** Splits a validated full name. Call `isValidFullName` first. */
export function splitFullName(value: string): { owner: string; repo: string } {
  const [owner, repo] = normalizeFullName(value).split("/");
  return { owner, repo };
}

/**
 * Mirrors `pr_number: int = Field(gt=0)` on TriggerReviewRequest.
 *
 * Deliberately a digits test rather than `Number.isInteger(Number(value))`:
 * Number() reads "1e3" as 1000 and "0x10" as 16, so the loose version would
 * quietly send a review request for a pull request the user never named.
 * Rejecting is the only honest answer to input we cannot read back.
 */
export function isValidPrNumber(value: string | number): boolean {
  if (typeof value === "number") return Number.isInteger(value) && value > 0;
  return /^\d+$/.test(value.trim()) && Number(value) > 0;
}
