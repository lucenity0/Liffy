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
