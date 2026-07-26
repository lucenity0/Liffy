import { isAxiosError } from "axios";

/**
 * Every error the API surface can produce, normalized to one shape so pages
 * never inspect an axios error directly. `kind` is what a page switches on;
 * `message` is what a page shows.
 */
export interface ApiError {
  kind: "validation" | "unavailable" | "upstream" | "not_found" | "network" | "unknown";
  status: number | null;
  message: string;
  /** The raw `{detail: string}` body, when the API sent one. */
  detail: string | null;
}

/**
 * Maps the specific status codes this API actually returns to a message a
 * user can act on. 422 (bad `owner/name`), 503 (no GitHub token configured)
 * and 502 (GitHub itself failed) come from `POST /repos` and `POST /reviews/
 * trigger`; 404 comes from every single-resource GET.
 */
export function normalizeApiError(error: unknown): ApiError {
  if (!isAxiosError(error)) {
    return {
      kind: "unknown",
      status: null,
      message: error instanceof Error ? error.message : "Something went wrong.",
      detail: null,
    };
  }

  if (!error.response) {
    return {
      kind: "network",
      status: null,
      message: "Couldn't reach the Liffy API. Check that the backend is running.",
      detail: null,
    };
  }

  const status = error.response.status;
  const detail =
    typeof error.response.data?.detail === "string" ? error.response.data.detail : null;

  switch (status) {
    case 422:
      return {
        kind: "validation",
        status,
        message: detail ?? "That doesn't look like owner/name.",
        detail,
      };
    case 503:
      return {
        kind: "unavailable",
        status,
        message: "Server has no GitHub token configured.",
        detail,
      };
    case 502:
      return {
        kind: "upstream",
        status,
        message: "GitHub couldn't find that repository (is it private?).",
        detail,
      };
    case 404:
      return {
        kind: "not_found",
        status,
        message: detail ?? "Not found.",
        detail,
      };
    default:
      return {
        kind: "unknown",
        status,
        message: detail ?? `Request failed (${status}).`,
        detail,
      };
  }
}
