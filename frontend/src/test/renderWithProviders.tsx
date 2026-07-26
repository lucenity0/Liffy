import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { render } from "@testing-library/react";
import { createQueryClient } from "@/lib/queryClient";

/**
 * Wrappers for hook and component tests. Each call builds a *fresh*
 * QueryClient — a shared one leaks cached data between tests and makes
 * ordering matter. `retry: false` so an expected 404 fails immediately
 * instead of retrying into a timeout.
 */

export function createWrapper() {
  const queryClient = createQueryClient({ retry: false });

  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  }

  return { Wrapper, queryClient };
}

export function renderWithProviders(
  ui: ReactNode,
  { route = "/" }: { route?: string } = {},
) {
  const queryClient = createQueryClient({ retry: false });

  const result = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );

  return { ...result, queryClient };
}
