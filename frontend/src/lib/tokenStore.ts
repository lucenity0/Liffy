import type { TokenPair } from "@/types/api";

/**
 * The single owner of the access/refresh pair.
 *
 * Everything that needs a token goes through here rather than touching
 * `localStorage` directly, for three reasons: the storage choice stays
 * swappable, tests stub one module instead of poking global state, and there
 * is exactly one place to look when asking "where do tokens live".
 *
 * The React layer (AUTH-7) owns the *user*; this owns the *tokens*. Keeping
 * them in one place each is what stops the two drifting apart.
 *
 * Trade-off, deliberately made: `localStorage` is readable by any script on
 * the origin, so an XSS becomes a token theft. HttpOnly cookies would be
 * stronger, but need CSRF handling and a same-site deployment story that
 * Liffy does not have. This is a reasoned trade, not an oversight.
 */

const ACCESS_KEY = "liffy.access_token";
const REFRESH_KEY = "liffy.refresh_token";

/**
 * Safari in private mode, and any browser with storage disabled, throw on
 * `localStorage` access rather than returning null. A thrown getter here
 * would take down every request in the app, so absent storage degrades to an
 * in-memory session instead — the user gets logged out on reload, which is
 * far better than a blank page.
 */
const memoryFallback = new Map<string, string>();

function readKey(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return memoryFallback.get(key) ?? null;
  }
}

function writeKey(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    memoryFallback.set(key, value);
  }
}

function removeKey(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    memoryFallback.delete(key);
  }
}

export function getAccessToken(): string | null {
  return readKey(ACCESS_KEY);
}

export function getRefreshToken(): string | null {
  return readKey(REFRESH_KEY);
}

/** Persist a freshly issued pair. Called by the OAuth callback and by refresh. */
export function setTokens(pair: Pick<TokenPair, "access_token" | "refresh_token">): void {
  writeKey(ACCESS_KEY, pair.access_token);
  writeKey(REFRESH_KEY, pair.refresh_token);
  // A stored pair means a live session, so a later expiry has to broadcast
  // again — without this, a second login in the same tab would never announce
  // its own expiry and the UI would stay stuck looking logged in.
  //
  // Re-arming here rather than through a separate `beginSession()` keeps one
  // way to write tokens. A second entry point would silently skip the reset
  // whenever anyone reached for the older one.
  sessionEnded = false;
}

export function clearTokens(): void {
  removeKey(ACCESS_KEY);
  removeKey(REFRESH_KEY);
}

export function hasTokens(): boolean {
  return getAccessToken() !== null;
}

// ── Session-ended notification ───────────────────────────────────────────────

/**
 * How the HTTP layer tells the UI layer that the session is unrecoverable —
 * a failed refresh, or a 401 that survived a retry.
 *
 * A callback registry rather than a React context because this file must stay
 * importable from outside the component tree: requests fire from query
 * clients and event handlers that have no hooks available. AUTH-7's
 * `AuthContext` subscribes to this and flips itself to `anonymous`.
 */
type SessionEndedListener = () => void;

const listeners = new Set<SessionEndedListener>();

/**
 * Whether the current session has already been announced as over.
 *
 * Guards the listener loop, which is *not* naturally idempotent even though
 * clearing storage is. Three concurrent requests sharing one failed refresh
 * all reach the give-up path, so without this every subscriber runs three
 * times — harmless for a state setter, three redirects or three toasts for
 * anything with a visible effect. Re-armed by `setTokens`.
 */
let sessionEnded = false;

/** Returns an unsubscribe function, so a React effect can clean up after itself. */
export function onSessionEnded(listener: SessionEndedListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Clear the tokens and tell everyone who cares.
 *
 * Genuinely idempotent, listeners included: call it three times for one
 * expired session and subscribers hear about it once. Storage is cleared on
 * every call regardless, since that costs nothing and keeps the "no tokens
 * afterwards" guarantee unconditional.
 *
 * Iterates a copy so a listener that unsubscribes itself mid-notification
 * does not mutate the set being walked.
 */
export function endSession(): void {
  clearTokens();

  if (sessionEnded) return;
  sessionEnded = true;

  for (const listener of [...listeners]) {
    listener();
  }
}
