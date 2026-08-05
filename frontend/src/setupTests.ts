import "@testing-library/jest-dom/vitest";
import { afterAll, afterEach, beforeAll } from "vitest";
import { cleanup } from "@testing-library/react";
import { resetFeedback, resetSettings } from "./mocks/handlers";
import { server } from "./mocks/server";

// jsdom has no layout, so it throws "Not implemented" for these. React
// Router's <ScrollRestoration> calls scrollTo on every navigation.
// scrollBy is absent outright rather than stubbed to throw — the live
// preview scrolls its own container with it.
window.scrollTo = () => {};
Element.prototype.scrollIntoView = () => {};
Element.prototype.scrollBy = () => {};

// Vitest's `globals: true` does not imply RTL auto-cleanup.
afterEach(() => {
  cleanup();
});

// "error" (not the browser worker's "bypass") so a typo'd URL in a handler
// or a component fails the test loudly instead of silently hitting the network.
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
// `resetHandlers` restores handler *definitions*; the feedback handler also
// keeps a map of what has been rated, which it knows nothing about. Without
// the second call one test's thumbs-up shows up in the next test's fixtures.
afterEach(() => {
  server.resetHandlers();
  resetFeedback();
  resetSettings();
});
afterAll(() => server.close());
