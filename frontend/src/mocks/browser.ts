import { setupWorker } from "msw/browser";
import { handlers } from "./handlers";

/**
 * The dev-mode browser worker, started from main.tsx only when
 * VITE_USE_MSW=true. `onUnhandledRequest: "bypass"` here (vs. "error" in
 * tests) because a strict mode in the browser would flag Vite's own HMR
 * websocket and font requests as unhandled.
 */
export const worker = setupWorker(...handlers);
