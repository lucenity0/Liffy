import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { routes } from "@/routes";

/**
 * `basename` follows Vite's --base. Without it a build served from anywhere
 * other than "/" renders nothing: --base only rewrites asset URLs, so the
 * router keeps matching against "/reviews" while the browser is actually at
 * "/<base>/reviews" and no route matches. BASE_URL is "/" in dev and in a
 * default build, so this is a no-op unless --base was passed.
 */
const router = createBrowserRouter(routes, {
  basename: import.meta.env.BASE_URL,
});

export default function App() {
  return <RouterProvider router={router} />;
}
