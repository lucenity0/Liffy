/**
 * Where to send someone after they finish logging in.
 *
 * If a visitor deep-links to `/reviews/abc` while logged out, they should land
 * on `/reviews/abc` after signing in — not on the dashboard, having lost the
 * thing they were actually trying to reach.
 *
 * `sessionStorage`, not `localStorage`: the value is per-tab and dead the
 * moment the tab closes. It survives the round trip through GitHub because
 * that is a navigation within the same tab.
 */

const RETURN_TO_KEY = "liffy.return_to";

export const DEFAULT_RETURN_TO = "/";

/**
 * Only same-origin *paths* are storable.
 *
 * Without this check the stash is an open redirect: anything that can write
 * the key — or a future caller that passes a value straight from a query
 * string — could bounce a freshly-authenticated user to an attacker's page
 * that looks like Liffy. `//evil.com` is the case a naive `startsWith("/")`
 * misses, since browsers read it as protocol-relative and treat it as an
 * absolute URL.
 */
function isSafePath(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//");
}

export function stashReturnTo(path: string): void {
  if (!isSafePath(path) || path === DEFAULT_RETURN_TO) return;
  try {
    window.sessionStorage.setItem(RETURN_TO_KEY, path);
  } catch {
    // Blocked storage costs the deep link, not the login.
  }
}

/**
 * Read the stashed path and consume it, so a later login does not bounce
 * somewhere the user has since navigated away from. Falls back to the
 * dashboard.
 */
export function takeReturnTo(): string {
  try {
    const stored = window.sessionStorage.getItem(RETURN_TO_KEY);
    window.sessionStorage.removeItem(RETURN_TO_KEY);
    // Re-checked on the way out, not just on the way in: the key is
    // attacker-writable from any script on the origin.
    return stored && isSafePath(stored) ? stored : DEFAULT_RETURN_TO;
  } catch {
    return DEFAULT_RETURN_TO;
  }
}
