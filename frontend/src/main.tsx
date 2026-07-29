import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import "./index.css";
import App from "./App.tsx";
import { createQueryClient } from "./lib/queryClient";

const queryClient = createQueryClient();

function render() {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
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
/**
 * VITE_DEMO=true is the separate, explicit opt-in for a *static* build with no
 * backend behind it — the GitHub Pages showcase. It is deliberately not the
 * same flag as VITE_USE_MSW above: that one is DEV-gated precisely so mock
 * data can never reach a real deployment by accident, and relaxing it would
 * throw that guarantee away. A demo build has to ask for it by name, and says
 * so on screen (see DemoBanner).
 */
const useMocks =
  (import.meta.env.DEV && import.meta.env.VITE_USE_MSW === "true") ||
  import.meta.env.VITE_DEMO === "true";

if (useMocks) {
  const { worker } = await import("./mocks/browser");
  await worker.start({ onUnhandledRequest: "bypass" });
  render();
} else {
  render();
}
