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
if (import.meta.env.DEV && import.meta.env.VITE_USE_MSW === "true") {
  const { worker } = await import("./mocks/browser");
  await worker.start({ onUnhandledRequest: "bypass" });
  render();
} else {
  render();
}
