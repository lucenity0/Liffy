import { Outlet, ScrollRestoration, useLocation } from "react-router-dom";
import { usePageTitle } from "@/hooks/usePageTitle";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { PaperBackdrop } from "./PaperBackdrop";
import { PageBar } from "./PageBar";
import { SideNav } from "./SideNav";
import type { Crumb } from "./Breadcrumb";

/** First path segment → the section it belongs to. */
const SECTIONS: Record<string, { label: string; to: string }> = {
  reviews: { label: "Reviews", to: "/reviews" },
  repositories: { label: "Repositories", to: "/repositories" },
  analytics: { label: "Analytics", to: "/analytics" },
  settings: { label: "Settings", to: "/settings" },
  help: { label: "Help", to: "/help" },
};

/**
 * A breadcrumb only where there is a trail to show.
 *
 * A top-level page gets none. It used to get exactly one crumb carrying the
 * route's title — which is the same string the page's own <h1> renders
 * directly beneath it, so every page opened by saying its name twice in a
 * row, and the bar holding the duplicate read as a spare strip of chrome.
 *
 * A detail page does have somewhere to go back to, and the route table is
 * flat (`/reviews` and `/reviews/:id` are siblings, not parent and child),
 * so the parent is recovered from the first path segment rather than from
 * the match chain.
 */
function crumbsFor(pathname: string, title: string): Crumb[] {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length < 2) return [];

  const section = SECTIONS[segments[0]];
  if (!section) return [];

  return [{ label: section.label, to: section.to }, { label: title }];
}

/**
 * The shell owns the paper texture, the chrome and the content column.
 *
 * `relative z-1` is load-bearing: PaperBackdrop paints two fixed layers at
 * z-index 0 and the grain multiplies, so content has to sit above it.
 *
 * Rail beside content rather than bar above it. Below `lg` the rail becomes a
 * horizontal strip in the same chrome fill — the flex direction is the whole
 * of the responsive story, so there is no drawer to open, nothing to trap
 * focus in, and no second copy of the nav to keep in step.
 */
export function AppShell() {
  const title = usePageTitle();
  const { pathname } = useLocation();
  useDocumentTitle(title);

  const crumbs = crumbsFor(pathname, title);

  return (
    <>
      <PaperBackdrop />
      <ScrollRestoration />

      <div className="relative z-1 flex min-h-dvh flex-col lg:flex-row">
        {/* First thing in the tab order, invisible until it has focus. The
            nav rail is short, but the reviews table is not — and neither is
            a diff. */}
        <a
          href="#main"
          className="rounded-chip sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-30 focus:border focus:border-rule-strong focus:bg-card focus:px-3 focus:py-1.5 focus:text-ink"
        >
          Skip to content
        </a>

        <SideNav />

        {/* min-w-0 so a wide diff inside a grid child scrolls in its own
            container instead of stretching the column past the viewport. */}
        <div className="flex min-w-0 flex-1 flex-col">
          <PageBar crumbs={crumbs} />

          <main
            id="main"
            tabIndex={-1}
            className="mx-auto w-full max-w-app flex-1 px-4 py-8 sm:px-6"
          >
            <Outlet />
          </main>
        </div>
      </div>
    </>
  );
}
