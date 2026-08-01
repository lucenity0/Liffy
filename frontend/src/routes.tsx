import type { RouteObject } from "react-router-dom";
import { AppShell } from "@/components/layout/AppShell";
import { RouteError } from "@/components/layout/RouteError";
import { Analytics } from "@/pages/Analytics";
import { Dashboard } from "@/pages/Dashboard";
import { Reviews } from "@/pages/Reviews";
import { Settings } from "@/pages/Settings";
import { ReviewDetail } from "@/pages/ReviewDetail";
import { RepoDetail } from "@/pages/RepoDetail";
import { NotFound } from "@/pages/NotFound";
import { StyleGuide } from "@/pages/StyleGuide";
import { Login } from "@/pages/Login";
import { AuthCallback } from "@/pages/AuthCallback";
import { RequireAuth } from "@/components/layout/RequireAuth";

/**
 * The primitive gallery. Spliced in only under `import.meta.env.DEV`, so it
 * never ships — but it is a real route in dev, which is what makes the whole
 * design system reviewable in one screenshot with no data layer behind it.
 */
const styleGuideRoute: RouteObject = {
  path: "/_styleguide",
  element: <StyleGuide />,
  handle: { title: "Style guide" },
};

/**
 * The shell layout, built twice: once behind the guard for the real app, and
 * once in front of it for the style guide. A shared factory rather than two
 * literals so the chrome and the error boundary cannot drift apart.
 */
const shellRoute = (children: RouteObject[]): RouteObject => ({
  element: <AppShell />,
  errorElement: <RouteError />,
  children,
});

/**
 * Exported as an array rather than a built router so tests can mount any
 * route through `createMemoryRouter(routes, { initialEntries: [...] })`.
 * A module-level `createBrowserRouter` would pin every test to jsdom's URL.
 */
export const routes: RouteObject[] = [
  /**
   * Both sit *outside* `AppShell`. The shell carries the authenticated nav —
   * the Dashboard/Reviews tab strip, breadcrumbs, the user menu — and
   * rendering navigation to places an anonymous visitor cannot go, around the
   * page telling them to sign in, is worse than no chrome at all.
   */
  { path: "/login", element: <Login />, handle: { title: "Sign in" } },
  {
    path: "/auth/callback",
    element: <AuthCallback />,
    handle: { title: "Signing in" },
  },

  /**
   * The style guide sits in front of the guard, not behind it. It has no data
   * layer, so gating it would only make the design system harder to review —
   * you would have to hold a session just to look at a button. Dev-only
   * either way, so it never ships.
   */
  ...(import.meta.env.DEV ? [shellRoute([styleGuideRoute])] : []),

  /**
   * Everything real. The guard wraps the shell rather than sitting inside it,
   * so an anonymous visitor never renders a frame of authenticated chrome on
   * the way to /login.
   *
   * The catch-all lives in here too, deliberately: which paths exist is not
   * something to hand out before someone has signed in.
   */
  {
    element: <RequireAuth />,
    children: [
      shellRoute([
        { path: "/", element: <Dashboard />, handle: { title: "Dashboard" } },
        { path: "/reviews", element: <Reviews />, handle: { title: "Reviews" } },
        {
          path: "/analytics",
          element: <Analytics />,
          handle: { title: "Analytics" },
        },
        {
          path: "/settings",
          element: <Settings />,
          handle: { title: "Settings" },
        },
        {
          path: "/reviews/:reviewId",
          element: <ReviewDetail />,
          handle: { title: "Review" },
        },
        {
          path: "/repos/:repoId",
          element: <RepoDetail />,
          handle: { title: "Repository" },
        },
        { path: "*", element: <NotFound />, handle: { title: "Not found" } },
      ]),
    ],
  },
];
