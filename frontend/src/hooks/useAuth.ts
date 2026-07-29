import { createContext, useContext } from "react";
import type { TokenPair, UserOut } from "@/types/api";

/**
 * The context object and its hook, split out from `contexts/AuthContext.tsx`
 * so that file exports nothing but the provider component. Mixing component
 * and non-component exports in one module breaks Vite's fast refresh — the
 * provider would remount on every edit, dropping the session.
 *
 * It lives here rather than beside the provider because a sibling named
 * `authContext.ts` differs from `AuthContext.tsx` only in case, and on
 * Windows and macOS the two resolve to the same file: the provider ends up
 * importing itself and renders as `undefined`.
 */

/**
 * Three states, not a boolean.
 *
 * `isAuthenticated: false` cannot distinguish "not logged in" from "we
 * haven't checked yet", and that ambiguity is exactly what makes a route
 * guard flash the login page for a split second on every refresh before the
 * session rehydrates.
 */
export type AuthStatus = "loading" | "authenticated" | "anonymous";

export interface AuthContextValue {
  /** Null unless `status === "authenticated"`. */
  user: UserOut | null;
  status: AuthStatus;
  /**
   * Establish a session from a freshly issued pair. Called by the OAuth
   * callback page once it has read the tokens out of the URL fragment.
   *
   * The Login *page* does not call this — it is a plain link to the backend's
   * authorize endpoint, because starting OAuth is a full-page navigation
   * rather than something React does.
   */
  login: (pair: TokenPair) => Promise<void>;
  /** Revoke server-side, clear locally. Never rejects. */
  logout: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (value === null) {
    throw new Error("useAuth must be used within an <AuthProvider>");
  }
  return value;
}
