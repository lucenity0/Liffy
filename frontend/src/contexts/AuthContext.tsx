import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { getCurrentUser, logoutRequest } from "@/api/auth";
import {
  clearTokens,
  getRefreshToken,
  hasTokens,
  onSessionEnded,
  setTokens,
} from "@/lib/tokenStore";
import type { TokenPair, UserOut } from "@/types/api";
import { AuthContext, type AuthStatus } from "@/hooks/useAuth";

/**
 * Holds "who am I" for the rest of the app.
 *
 * AUTH-6 handles tokens at the HTTP layer; this handles the session at the UI
 * layer. They meet at `tokenStore`, which stays the single owner of the token
 * pair — this provider owns only the *user*. Duplicating the tokens into
 * React state would give two sources of truth that drift the moment the
 * refresh interceptor rotates a pair behind React's back.
 *
 * Plain `useState` rather than react-query: the three-state status below is
 * not the same shape as a query's loading/error/data, and a session is not a
 * cache entry that should be refetched on window focus.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserOut | null>(null);

  /**
   * Seeded during render, not in an effect: whether a token exists is already
   * knowable synchronously, so someone with no token is `anonymous` on the
   * first paint rather than spending a render in `loading` for nothing.
   * `hasTokens` is a pure read, so StrictMode's double invocation is harmless.
   */
  const [status, setStatus] = useState<AuthStatus>(() =>
    hasTokens() ? "loading" : "anonymous",
  );

  // Rehydrate on mount. A stored token means we might still have a session,
  // so ask the server; no token was already settled above.
  useEffect(() => {
    if (!hasTokens()) return;

    let cancelled = false;

    getCurrentUser()
      .then((me) => {
        if (cancelled) return;
        setUser(me);
        setStatus("authenticated");
      })
      .catch(() => {
        // A 401 here has already been through the refresh interceptor, so the
        // session is genuinely unrecoverable. Drop the dead tokens rather
        // than leaving them to fail every subsequent request.
        if (cancelled) return;
        clearTokens();
        setUser(null);
        setStatus("anonymous");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // The HTTP layer's way of saying the session died mid-flight — a refresh
  // that failed, or a 401 that survived a retry. `onSessionEnded` returns its
  // own unsubscribe, which is exactly what an effect cleanup wants.
  useEffect(
    () =>
      onSessionEnded(() => {
        setUser(null);
        setStatus("anonymous");
      }),
    [],
  );

  const login = useCallback(async (pair: TokenPair) => {
    setTokens(pair);
    try {
      const me = await getCurrentUser();
      setUser(me);
      setStatus("authenticated");
    } catch (error) {
      // Tokens that cannot buy a /auth/me are no use to anyone.
      clearTokens();
      setUser(null);
      setStatus("anonymous");
      throw error;
    }
  }, []);

  const logout = useCallback(async () => {
    const refreshToken = getRefreshToken();
    try {
      if (refreshToken) {
        await logoutRequest(refreshToken);
      }
    } catch {
      // Deliberately swallowed. A user who clicks Log out ends up logged out
      // whether or not the server was reachable; the worst case is a refresh
      // token that stays live until it expires on its own.
    } finally {
      clearTokens();
      setUser(null);
      setStatus("anonymous");
    }
  }, []);

  const value = useMemo(
    () => ({ user, status, login, logout }),
    [user, status, login, logout],
  );

  return <AuthContext value={value}>{children}</AuthContext>;
}
