import { render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { routes } from "@/routes";
import { createWrapper } from "@/test/renderWithProviders";
import type { AuthContextValue } from "@/hooks/useAuth";

/**
 * Mounting `routes` through a memory router rather than `<App />` is what
 * lets a test pick its own URL — a module-level createBrowserRouter would
 * pin every test to jsdom's location.
 *
 * The QueryClientProvider is not optional here even though these are shell
 * tests: the pages behind these routes fetch, and a page that throws "No
 * QueryClient set" renders the router's errorElement instead of the shell.
 */
function renderAt(path: string, auth?: Partial<AuthContextValue>) {
  const { Wrapper } = createWrapper({ auth });

  return render(
    <Wrapper>
      <RouterProvider
        router={createMemoryRouter(routes, { initialEntries: [path] })}
      />
    </Wrapper>,
  );
}

describe("app shell", () => {
  it("renders the wordmark and all three primary tabs", () => {
    renderAt("/");

    expect(screen.getByRole("link", { name: /liffy — home/i })).toBeInTheDocument();

    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(nav).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Dashboard" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Reviews" })).toBeInTheDocument();
    // Third since #200. Still a tab strip, still no sidebar.
    expect(screen.getByRole("link", { name: "Analytics" })).toBeInTheDocument();
  });

  it("reaches analytics from the nav, and marks it current", () => {
    renderAt("/analytics");

    expect(screen.getByRole("link", { name: "Analytics" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("heading", { name: "Analytics" })).toBeInTheDocument();
  });

  it("titles the analytics route from its handle", () => {
    renderAt("/analytics");
    expect(document.title).toBe("Analytics · Liffy");
  });

  it("marks the active tab with aria-current", () => {
    renderAt("/reviews");

    expect(screen.getByRole("link", { name: "Reviews" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "Dashboard" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("shows no breadcrumb on the index route", () => {
    renderAt("/");
    expect(screen.queryByRole("navigation", { name: "Breadcrumb" })).toBeNull();
  });

  it("breadcrumbs the route title on deeper routes", () => {
    renderAt("/reviews");

    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(crumbs).toHaveTextContent("Reviews");
  });

  it("renders the 404 page for an unmatched path, inside the shell", () => {
    renderAt("/definitely-not-a-route");

    expect(screen.getByRole("heading", { name: /nothing filed here/i })).toBeInTheDocument();
    expect(screen.getByText("/definitely-not-a-route")).toBeInTheDocument();
    // Still framed by the shell, so the user can navigate away.
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeInTheDocument();
  });

  it("syncs the document title from the route handle", async () => {
    renderAt("/reviews");
    expect(document.title).toBe("Reviews · Liffy");
  });
});

/**
 * The guard exercised through the *real* route tree rather than a synthetic
 * one, because the thing most likely to go wrong is the wiring in routes.tsx
 * — which subtree sits behind `RequireAuth` — not the guard's own logic.
 */
describe("route protection", () => {
  afterEach(() => {
    window.sessionStorage.clear();
  });

  it("sends an anonymous deep link to /login", async () => {
    renderAt("/reviews", { status: "anonymous", user: null });

    expect(
      await screen.findByRole("link", { name: "Continue with GitHub" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Primary" })).toBeNull();
  });

  /**
   * The page shows aggregate data about private repositories, so it belongs
   * inside the guard. Asserted through the real route tree because the thing
   * that goes wrong is which subtree a route was added to, not the guard.
   */
  it("sends an anonymous visitor away from /analytics", async () => {
    renderAt("/analytics", { status: "anonymous", user: null });

    expect(
      await screen.findByRole("link", { name: "Continue with GitHub" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Analytics" })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Primary" })).toBeNull();
  });

  it("remembers the deep link it refused", async () => {
    renderAt("/reviews/abc", { status: "anonymous", user: null });

    await waitFor(() =>
      expect(window.sessionStorage.getItem("liffy.return_to")).toBe("/reviews/abc"),
    );
  });

  it("renders a deep-linked page when authenticated", () => {
    renderAt("/reviews");

    expect(screen.getByRole("navigation", { name: "Primary" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent(
      "Reviews",
    );
  });

  it("shows no authenticated chrome on the way to /login", () => {
    renderAt("/", { status: "anonymous", user: null });

    // The guard wraps the shell rather than sitting inside it, so an
    // anonymous visitor never renders a frame of the tab strip.
    expect(screen.queryByRole("navigation", { name: "Primary" })).toBeNull();
  });

  it("does not redirect while the session is still loading", () => {
    renderAt("/reviews", { status: "loading", user: null });

    expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();
    // No login flash on refresh — the whole reason status is three-valued.
    expect(screen.queryByRole("link", { name: "Continue with GitHub" })).toBeNull();
  });

  it("leaves /login reachable while anonymous, with no redirect loop", () => {
    renderAt("/login", { status: "anonymous", user: null });

    expect(
      screen.getByRole("link", { name: "Continue with GitHub" }),
    ).toBeInTheDocument();
  });

  it("keeps the style guide reachable without a session", () => {
    // It has no data layer behind it, so gating it would only make the design
    // system harder to review.
    renderAt("/_styleguide", { status: "anonymous", user: null });

    expect(screen.queryByRole("link", { name: "Continue with GitHub" })).toBeNull();
    expect(document.title).toBe("Style guide · Liffy");
  });
});
