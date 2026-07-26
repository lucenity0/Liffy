import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { routes } from "@/routes";

/**
 * Mounting `routes` through a memory router rather than `<App />` is what
 * lets a test pick its own URL — a module-level createBrowserRouter would
 * pin every test to jsdom's location.
 */
function renderAt(path: string) {
  return render(
    <RouterProvider router={createMemoryRouter(routes, { initialEntries: [path] })} />,
  );
}

describe("app shell", () => {
  it("renders the wordmark and both primary tabs", () => {
    renderAt("/");

    expect(screen.getByRole("link", { name: /liffy — home/i })).toBeInTheDocument();

    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(nav).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Dashboard" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Reviews" })).toBeInTheDocument();
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
