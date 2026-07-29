import { apiClient } from "./client";
import type { UserOut } from "@/types/api";

/**
 * Typed wrappers for the auth endpoints, mirroring `backend/app/api/auth.py`.
 *
 * `refreshTokens` is re-exported from `./client` rather than defined here:
 * the response interceptor is its principal caller, and defining it there
 * keeps the two modules from importing each other.
 */
export { refreshTokens } from "./client";

/**
 * Revoke the refresh token server-side. Idempotent — the backend answers 204
 * whether or not the token was still live, so logging out twice is fine.
 *
 * The caller must clear local state regardless of whether this resolves. A
 * user who clicks Log out ends up logged out even when the network does not
 * cooperate.
 */
export async function logoutRequest(refreshToken: string): Promise<void> {
  // 204 No Content — response.data is "" here, never JSON.
  await apiClient.post("/auth/logout", { refresh_token: refreshToken });
}

/**
 * Who the caller is. Used by AUTH-7's `AuthContext` to rehydrate a session on
 * page load. Goes through `apiClient` on purpose: if the stored access token
 * has expired, the interceptor refreshes and retries transparently, which is
 * exactly what rehydration wants.
 */
export async function getCurrentUser(): Promise<UserOut> {
  const { data } = await apiClient.get<UserOut>("/auth/me");
  return data;
}
