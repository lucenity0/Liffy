import type { RouteObject } from "react-router-dom";
import { AppShell } from "@/components/layout/AppShell";
import { RouteError } from "@/components/layout/RouteError";
import { Dashboard } from "@/pages/Dashboard";
import { Reviews } from "@/pages/Reviews";
import { ReviewDetail } from "@/pages/ReviewDetail";
import { RepoDetail } from "@/pages/RepoDetail";
import { NotFound } from "@/pages/NotFound";

/**
 * Exported as an array rather than a built router so tests can mount any
 * route through `createMemoryRouter(routes, { initialEntries: [...] })`.
 * A module-level `createBrowserRouter` would pin every test to jsdom's URL.
 */
export const routes: RouteObject[] = [
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
      { path: "*", element: <NotFound />, handle: { title: "Not found" } },
    ],
  },
];
