import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { PageShell } from "@/components/layout/PageShell";
import { Dashboard } from "@/pages/Dashboard";
import { Reviews } from "@/pages/Reviews";
import { ReviewDetail } from "@/pages/Reviewdetail";
import { RepoDetail } from "@/pages/RepoDetail";
import { NotFound } from "@/pages/NotFound";

export const router = createBrowserRouter([
  {
    element: <PageShell />,
    children: [
      { path: "/", element: <Dashboard />, handle: { title: "Dashboard" } },
      { path: "/reviews", element: <Reviews />, handle: { title: "Reviews" } },
      {
        path: "/reviews/:reviewId",
        element: <ReviewDetail />,
        handle: { title: "Review Detail" },
      },
      {
        path: "/repos/:repoId",
        element: <RepoDetail />,
        handle: { title: "Repo Detail" },
      },
      { path: "*", element: <NotFound />, handle: { title: "Not Found" } },
    ],
  },
]);

export default function App() {
  return <RouterProvider router={router} />;
}
