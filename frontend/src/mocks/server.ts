import { setupServer } from "msw/node";
import { handlers } from "./handlers";

/** The Vitest-side MSW server. Wired into lifecycle hooks in setupTests.ts. */
export const server = setupServer(...handlers);
