import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import "./index.css";
import App from "./App.tsx";
import { AuthProvider } from "./contexts/AuthContext";
import { applyAppearance, readAppearance } from "./hooks/useAppearance";
import { createQueryClient } from "./lib/queryClient";

const queryClient = createQueryClient();

/**
 * Reconcile the workspace variables with the stored config, once.
 *
 * The boot script in index.html has normally done this already, from the
 * stylesheet cached beside the config — this is the path for when it could
 * not: a config imported in another tab, a cache cleared on its own, a first
 * load after upgrading from a version that had no such cache. Idempotent, and
 * a no-op on a default install, so running it unconditionally is cheaper than
 * working out whether it is needed.
 */
applyAppearance(readAppearance());

function render() {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      {/* Inside QueryClientProvider: the provider's rehydration call goes out
          through the same axios client every query uses, and AUTH-8's guard
          has to see the session before any guarded page mounts a query. */}
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}

/**
 * VITE_USE_MSW=true runs the whole UI against fixtures with no backend,
 * Postgres, Redis, Chroma or LLM key running — every screen's loading,
 * empty, error and populated states are reachable by editing mocks/
 * fixtures.ts. DEV-gated so this branch never ships in a production build.
 */
if (import.meta.env.DEV && import.meta.env.VITE_USE_MSW === "true") {
  const { worker } = await import("./mocks/browser");
  await worker.start({
    onUnhandledRequest: "bypass",
    // MSW defaults to registering /mockServiceWorker.js at the site root. Under
    // a --base the file lives beneath that base, so registration 404s and no
    // request is ever intercepted. BASE_URL is "/" by default, so this only
    // changes anything for a sub-path build.
    serviceWorker: { url: `${import.meta.env.BASE_URL}mockServiceWorker.js` },
  });

  // Sign the mock session in.
  //
  // The handlers answer `/auth/me` with 401 unless a request carries an
  // Authorization header, which is right for tests — each one sets up the auth
  // state it wants. In a browser it meant `dev:mock` opened on the login
  // screen, and Login went to the *real* OAuth flow and bounced to whichever
  // port the backend's redirect URI names. So the one mode that exists to run
  // without a backend was the one mode that required one.
  //
  // Seeding the store rather than loosening the handler keeps the real auth
  // path in play: the client attaches the header, `/auth/me` answers, and the
  // session behaves as it does in production.
  const { hasTokens, setTokens } = await import("./lib/tokenStore");
  if (!hasTokens()) {
    setTokens({
      access_token: "msw-access-token",
      refresh_token: "msw-refresh-token",
    });
  }

  render();
} else {
  render();
}
