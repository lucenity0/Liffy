import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { routes } from "@/routes";

/**
 * `basename` follows Vite's --base. Without it a build served from a sub-path
 * (GitHub Pages project sites, preview deploys) renders nothing: --base only
 * rewrites asset URLs, so the router still matches against "/reviews" while
 * the browser is actually at "/<base>/reviews" and nothing matches. BASE_URL
 * is "/" in dev, which makes this a no-op there.
 */
const router = createBrowserRouter(routes, {
  basename: import.meta.env.BASE_URL,
});

export default function App() {
  return <RouterProvider router={router} />;
}
