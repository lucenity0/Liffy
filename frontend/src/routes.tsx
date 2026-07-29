import type { RouteObject } from "react-router-dom";
import { AppShell } from "@/components/layout/AppShell";
import { RouteError } from "@/components/layout/RouteError";
import { Dashboard } from "@/pages/Dashboard";
import { Reviews } from "@/pages/Reviews";
import { ReviewDetail } from "@/pages/ReviewDetail";
import { RepoDetail } from "@/pages/RepoDetail";
import { NotFound } from "@/pages/NotFound";
import { StyleGuide } from "@/pages/StyleGuide";
import { Login } from "@/pages/Login";
import { AuthCallback } from "@/pages/AuthCallback";

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
  {
    element: <AppShell />,
    errorElement: <RouteError />,
    children: [
      { path: "/", element: <Dashboard />, handle: { title: "Dashboard" } },
      { path: "/reviews", element: <Reviews />, handle: { title: "Reviews" } },
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
      ...(import.meta.env.DEV ? [styleGuideRoute] : []),
      { path: "*", element: <NotFound />, handle: { title: "Not found" } },
    ],
  },
];
