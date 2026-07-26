import axios from "axios";

/**
 * The one axios instance every endpoint wrapper imports. No response
 * interceptor normalizing errors here — `normalizeApiError` (lib/errors.ts)
 * does that at the call site instead, because the right *message* for a 422
 * depends on which form is showing it (connect-repo vs. trigger-review use
 * different copy for the same status code).
 */
export const apiClient = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL,
  // TODO(auth milestone): attach a request interceptor once OAuth lands.
});
