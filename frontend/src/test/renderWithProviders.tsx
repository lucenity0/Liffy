import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { render } from "@testing-library/react";
import { createQueryClient } from "@/lib/queryClient";
import { AuthContext, type AuthContextValue } from "@/hooks/useAuth";
import { fixtureUser } from "@/mocks/fixtures";

/**
 * Wrappers for hook and component tests. Each call builds a *fresh*
 * QueryClient — a shared one leaks cached data between tests and makes
 * ordering matter. `retry: false` so an expected 404 fails immediately
 * instead of retrying into a timeout.
 */

/**
 * A session supplied directly, rather than rehydrated through `AuthProvider`.
 *
 * Since AUTH-8 the shell reads `useAuth`, and the guard has three states to
 * cover — two of which (`loading`, `anonymous`) are awkward to reach by
 * seeding storage and waiting on `/auth/me`. Stubbing the context value makes
 * each one a single argument, and keeps guard tests about the guard rather
 * than about the provider; `contexts/AuthContext.test.tsx` already covers the
 * real rehydration path.
 *
 * The default is an authenticated session, because that is the state almost
 * every other test needs in order to reach the thing it is actually testing.
 */
function authValue(overrides: Partial<AuthContextValue> = {}): AuthContextValue {
  return {
    user: fixtureUser,
    status: "authenticated",
    login: async () => {},
    logout: async () => {},
    ...overrides,
  };
}

export function createWrapper({
  auth,
}: { auth?: Partial<AuthContextValue> } = {}) {
  const queryClient = createQueryClient({ retry: false });
  const value = authValue(auth);

  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <AuthContext value={value}>{children}</AuthContext>
      </QueryClientProvider>
    );
  }

  return { Wrapper, queryClient, auth: value };
}

/**
 * Where the router starts.
 *
 * A plain path covers almost every test. The object form exists for the cases
 * that turn on router *state* rather than the URL — a failed review handing its
 * log to the report form, for one — which cannot be expressed as a string and
 * must not be smuggled into the query string instead.
 */
export type RenderRoute =
  | string
  | { pathname: string; search?: string; state?: unknown };

export function renderWithProviders(
  ui: ReactNode,
  {
    route = "/",
    auth,
  }: { route?: RenderRoute; auth?: Partial<AuthContextValue> } = {},
) {
  const queryClient = createQueryClient({ retry: false });
  const value = authValue(auth);

  const result = render(
    <QueryClientProvider client={queryClient}>
      <AuthContext value={value}>
        <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
      </AuthContext>
    </QueryClientProvider>,
  );

  return { ...result, queryClient, auth: value };
}

/**
 * `renderWithProviders` with the session made explicit at the call site.
 * Same thing underneath — this name exists so a guard test reads as being
 * about auth rather than about providers in general.
 */
export const renderWithAuth = renderWithProviders;
