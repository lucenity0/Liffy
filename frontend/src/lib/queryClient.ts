import { QueryClient } from "@tanstack/react-query";

/**
 * One factory so the app and the tests agree on defaults. Tests override
 * `retry` to false — a retrying query turns an expected 404 into a multi-
 * second timeout and makes failures read as flakes.
 */
export function createQueryClient(overrides?: {
  retry?: number | false;
}): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: overrides?.retry ?? 1,
        refetchOnWindowFocus: false,
      },
    },
  });
}
