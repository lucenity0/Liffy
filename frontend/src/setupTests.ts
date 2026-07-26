import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// jsdom has no layout, so it throws "Not implemented" for these. React
// Router's <ScrollRestoration> calls scrollTo on every navigation.
window.scrollTo = () => {};
Element.prototype.scrollIntoView = () => {};

// Vitest's `globals: true` does not imply RTL auto-cleanup.
afterEach(() => {
  cleanup();
});
