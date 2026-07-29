import axios, { isAxiosError } from "axios";
import type { TokenPair } from "@/types/api";
import {
  endSession,
  getAccessToken,
  getRefreshToken,
  setTokens,
} from "@/lib/tokenStore";

declare module "axios" {
  export interface InternalAxiosRequestConfig {
    /**
     * Set before a request is re-issued after a successful refresh. A request
     * carrying this flag that 401s *again* is given up on rather than
     * refreshed a second time — without it, a persistently-401ing endpoint
     * loops forever and hangs the tab instead of failing loudly.
     */
    _retry?: boolean;
  }
}

const baseURL = import.meta.env.VITE_API_BASE_URL;

/**
 * The one axios instance every endpoint wrapper imports. No response
 * interceptor normalizing errors here — `normalizeApiError` (lib/errors.ts)
 * does that at the call site instead, because the right *message* for a 422
 * depends on which form is showing it (connect-repo vs. trigger-review use
 * different copy for the same status code).
 *
 * It *does* carry the auth interceptors below: attaching the bearer token and
 * transparently refreshing it are identical for every caller, so unlike error
 * copy they belong here.
 */
export const apiClient = axios.create({ baseURL });

/**
 * A second, deliberately bare instance used only to spend a refresh token.
 *
 * `/auth/refresh` must never travel through the interceptors below: a 401
 * from the refresh call means the refresh token itself is dead, and feeding
 * that into the refresh-on-401 path is an infinite regress. Routing it
 * through a client that *has no interceptor* makes that structurally
 * impossible rather than a rule someone has to remember.
 */
export const authClient = axios.create({ baseURL });

/**
 * Spend the refresh token for a fresh pair.
 *
 * Lives here rather than in `api/auth.ts` because the interceptor below is
 * its main caller, and importing it the other way round would make the two
 * modules circular. `api/auth.ts` re-exports it as the public wrapper.
 */
export async function refreshTokens(refreshToken: string): Promise<TokenPair> {
  const { data } = await authClient.post<TokenPair>("/auth/refresh", {
    refresh_token: refreshToken,
  });
  return data;
}

// ── Request: attach the bearer token ─────────────────────────────────────────

apiClient.interceptors.request.use((config) => {
  const token = getAccessToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// ── Response: single-flight refresh on 401 ───────────────────────────────────

/**
 * The in-flight refresh, or null when none is running.
 *
 * This variable is the entire point of the issue. The dashboard fires several
 * requests at once; when the access token expires they all 401 within a few
 * milliseconds of each other. Refresh tokens **rotate and revoke on use**
 * (`auth_service.rotate_refresh_token`), so N naive parallel refreshes means
 * the first succeeds and the rest replay an already-revoked token and get
 * 401s — logging the user out via the very mechanism meant to keep them in.
 *
 * So: the first 401 starts one refresh, every other 401 awaits that same
 * promise.
 */
let refreshPromise: Promise<string> | null = null;

function refreshOnce(): Promise<string> {
  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    const stored = getRefreshToken();
    if (!stored) {
      throw new Error("No refresh token to spend");
    }
    const pair = await refreshTokens(stored);
    // Persist before returning: the retried requests read the new access
    // token back out of the store via the request interceptor.
    setTokens(pair);
    return pair.access_token;
  })().finally(() => {
    // `finally`, not `.then` — if a refresh *fails* and this variable stays
    // set, every subsequent request awaits a permanently rejected promise and
    // the app wedges with no way back short of a reload.
    refreshPromise = null;
  });

  return refreshPromise;
}

apiClient.interceptors.response.use(
  (response) => response,
  async (error: unknown) => {
    if (!isAxiosError(error) || error.response?.status !== 401 || !error.config) {
      // Non-401s (a 500, a network failure) pass through untouched — they are
      // `normalizeApiError`'s problem, not ours.
      throw error;
    }

    const config = error.config;

    if (config._retry) {
      // Already refreshed once for this request and still unauthorized. The
      // token is fresh; this caller genuinely is not allowed.
      endSession();
      throw error;
    }

    if (!getRefreshToken()) {
      // Nothing to refresh with. An orphaned access token still gets cleared,
      // so the app stops presenting a credential it cannot renew; a 401 with
      // no tokens at all is just an anonymous request and needs no
      // session-ended broadcast.
      if (getAccessToken()) {
        endSession();
      }
      throw error;
    }

    config._retry = true;

    let accessToken: string;
    try {
      accessToken = await refreshOnce();
    } catch {
      endSession();
      throw error; // the original 401, not the refresh failure
    }

    // The request interceptor would attach this anyway, but setting it
    // explicitly keeps the retry correct even if interceptor order changes.
    config.headers.Authorization = `Bearer ${accessToken}`;
    return apiClient.request(config);
  },
);
