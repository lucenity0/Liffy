import "@testing-library/jest-dom/vitest";
import { afterAll, afterEach, beforeAll } from "vitest";
import { cleanup } from "@testing-library/react";
import { server } from "./mocks/server";

// jsdom has no layout, so it throws "Not implemented" for these. React
// Router's <ScrollRestoration> calls scrollTo on every navigation.
window.scrollTo = () => {};
Element.prototype.scrollIntoView = () => {};

// Vitest's `globals: true` does not imply RTL auto-cleanup.
afterEach(() => {
  cleanup();
});

// "error" (not the browser worker's "bypass") so a typo'd URL in a handler
// or a component fails the test loudly instead of silently hitting the network.
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
