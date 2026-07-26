import { Outlet, ScrollRestoration, useLocation } from "react-router-dom";
import { usePageTitle } from "@/hooks/usePageTitle";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { PaperBackdrop } from "./PaperBackdrop";
import { TopBar } from "./TopBar";
import type { Crumb } from "./Breadcrumb";

/**
 * The shell owns the paper texture, the chrome and the content column.
 *
 * `relative z-1` is load-bearing: PaperBackdrop paints two fixed layers at
 * z-index 0 and the grain multiplies, so content has to sit above it.
 */
export function AppShell() {
  const title = usePageTitle();
  const { pathname } = useLocation();
  useDocumentTitle(title);

  // The index route is already represented by the wordmark; anything deeper
  // gets one crumb. Pages that know more (a repo, a PR number) render their
  // own richer heading in the page body.
  const crumbs: Crumb[] = pathname === "/" ? [] : [{ label: title }];

  return (
    <>
      <PaperBackdrop />
      <ScrollRestoration />

      <div className="relative z-1 flex min-h-screen flex-col">
        <TopBar crumbs={crumbs} />

        <main className="mx-auto w-full max-w-app flex-1 px-4 py-8 sm:px-6">
          <Outlet />
        </main>

        <footer className="mx-auto w-full max-w-app px-4 pb-8 sm:px-6">
          <p className="label border-t border-rule pt-4">
            Liffy · self-hosted code review
          </p>
        </footer>
      </div>
    </>
  );
}
