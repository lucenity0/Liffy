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
 * that looks like Liffy.
 *
 * **Resolved by the URL parser, not by matching prefixes.** String checks on
 * this look obviously correct and are not: browsers normalise `\` to `/`
 * while parsing, and strip control characters first, so `/\evil.com`,
 * `/\/evil.com` and `/<newline>//evil.com` all satisfy
 * `startsWith("/") && !startsWith("//")` and all three resolve to
 * `http://evil.com/`. Asking the same parser the browser uses is the only
 * version that cannot drift out of sync with it.
 *
 * The `startsWith("/")` below is a *shape* constraint, not the security
 * check — it rejects relative values like `reviews` and the empty string,
 * and can only ever narrow what the parser already allowed.
 */
function isSafePath(path: string): boolean {
  if (!path.startsWith("/")) return false;
  try {
    return new URL(path, window.location.origin).origin === window.location.origin;
  } catch {
    return false;
  }
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
/**
 * Forget any stashed destination.
 *
 * For an *explicit* logout. `RequireAuth` stashes on every anonymous render,
 * and logging out produces one — so without this, the next person to sign in
 * on the same machine lands on the previous user's page. That URL is scoped
 * to its owner, so they get a 404 immediately after a successful login:
 * working as designed, reading as broken.
 *
 * A session that merely *expired* must still stash, which is why the guard
 * cannot make this distinction itself — only the logout call site knows
 * which of the two happened.
 */
export function clearReturnTo(): void {
  try {
    window.sessionStorage.removeItem(RETURN_TO_KEY);
  } catch {
    // Blocked storage had nothing to clear.
  }
}

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
