import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  // The rail persists which sections are expanded, so a leaked value would
  // decide the outcome of the disclosure tests below.
  beforeEach(() => localStorage.clear());

  it("renders the wordmark and all three primary tabs", () => {
    renderAt("/");

    // Two: one on the mobile bar, one on the rail. They are mutually
    // exclusive by media query, which jsdom does not apply — so this asserts
    // the count rather than pretending only one is in the tree.
    expect(screen.getAllByRole("link", { name: /liffy — home/i })).toHaveLength(2);

    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(nav).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Dashboard" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Reviews" })).toBeInTheDocument();
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

  /**
   * A breadcrumb only where there is a trail. A top-level page's crumb would
   * carry the same string as the <h1> immediately below it, so the page
   * announced itself twice and the bar holding the duplicate was spare
   * chrome.
   */
  it("shows no breadcrumb on the index route", () => {
    renderAt("/");
    expect(screen.queryByRole("navigation", { name: "Breadcrumb" })).toBeNull();
  });

  it("shows no breadcrumb on a top-level page, whose h1 already names it", () => {
    renderAt("/reviews");

    expect(screen.queryByRole("navigation", { name: "Breadcrumb" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Reviews" })).toBeInTheDocument();
  });

  it("breadcrumbs the way back on a detail route", () => {
    renderAt("/reviews/abc");

    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    // The section, linked, then where you actually are.
    expect(crumbs).toHaveTextContent("Reviews");
    expect(within(crumbs).getByRole("link", { name: "Reviews" })).toHaveAttribute(
      "href",
      "/reviews",
    );
  });

  /**
   * The label navigates and the chevron expands. Two jobs, two controls —
   * a row doing both would make "show me what is in here" and "take me
   * there" the same click.
   */
  /**
   * Settings, not Dashboard. Dashboard's sub-items are gone: every section of
   * that page is on screen when you land, so three rows of anchors bought
   * nothing but rail height.
   */
  it("expands a nav section without navigating, and remembers it", async () => {
    const user = userEvent.setup();
    renderAt("/reviews");

    const disclosure = screen.getByRole("button", { name: /expand settings/i });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link", { name: "Appearance" })).toBeNull();

    await user.click(disclosure);

    expect(screen.getByRole("link", { name: "Appearance" })).toHaveAttribute(
      "href",
      "/settings?section=appearance",
    );
    // Expanding is not navigating: still on Reviews.
    expect(screen.getByRole("heading", { name: "Reviews" })).toBeInTheDocument();
    // Tri-state, so an explicit collapse is distinguishable from "never
    // touched" — a Set could only say "expanded", which made collapsing the
    // section you were standing in a no-op.
    expect(JSON.parse(localStorage.getItem("liffy-nav-expanded")!)).toEqual({
      "/settings": true,
    });
  });

  it("collapses the section you are in, which a set-based state could not", async () => {
    const user = userEvent.setup();
    renderAt("/settings");

    expect(screen.getByRole("link", { name: "Appearance" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /collapse settings/i }));

    expect(screen.queryByRole("link", { name: "Appearance" })).toBeNull();
    expect(JSON.parse(localStorage.getItem("liffy-nav-expanded")!)).toEqual({
      "/settings": false,
    });
  });

  /** A collapsed *current* section would hide the only sub-items reachable
   *  from where you are, so the active one opens regardless of preference. */
  it("opens the section you are in even with nothing stored", () => {
    renderAt("/settings");

    expect(screen.getByRole("link", { name: "Appearance" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /collapse settings/i }),
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("has no disclosure on Dashboard, whose sections are all on the page", () => {
    renderAt("/");

    expect(screen.queryByRole("button", { name: /dashboard/i })).toBeNull();
  });

  /**
   * Below `lg` the rail is a drawer. jsdom applies no media queries, so these
   * assert the state machine — open, dismissed, closed by navigating — rather
   * than which copy is visible at which width.
   */
  it("opens and dismisses the nav drawer", async () => {
    const user = userEvent.setup();
    renderAt("/");

    const hamburger = screen.getByRole("button", { name: "Navigation menu" });
    expect(hamburger).toHaveAttribute("aria-expanded", "false");

    await user.click(hamburger);
    expect(hamburger).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("button", { name: "Close navigation" }),
    ).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(hamburger).toHaveAttribute("aria-expanded", "false");
  });

  it("closes the drawer when you navigate, not leaving it over the page", async () => {
    const user = userEvent.setup();
    renderAt("/");

    await user.click(screen.getByRole("button", { name: "Navigation menu" }));
    await user.click(screen.getByRole("link", { name: "Reviews" }));

    // The single most common bug in this pattern: the drawer standing over
    // the page you just asked for.
    expect(
      await screen.findByRole("button", { name: "Navigation menu" }),
    ).toHaveAttribute("aria-expanded", "false");
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
    expect(screen.getByRole("heading", { name: "Reviews" })).toBeInTheDocument();
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
