import { Link } from "react-router-dom";
import type { ReactNode } from "react";
import { Breadcrumb, type Crumb } from "./Breadcrumb";
import { TabNav, type Tab } from "./TabNav";

const TABS: Tab[] = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/reviews", label: "Reviews" },
];

/**
 * The whole of Liffy's chrome: a wordmark, a breadcrumb, an actions slot,
 * and the tab strip. No sidebar — the app has two top-level surfaces, which
 * is one fewer than a sidebar can justify.
 */
export function TopBar({
  crumbs,
  actions,
}: {
  crumbs: Crumb[];
  actions?: ReactNode;
}) {
  return (
    <header className="sticky top-0 z-20 border-b border-rule bg-card">
      <div className="mx-auto w-full max-w-app px-4 sm:px-6">
        <div className="flex h-14 items-center gap-3">
          <Link
            to="/"
            className="font-hand text-xl leading-none text-ink shrink-0"
            aria-label="Liffy — home"
          >
            Liffy
          </Link>

          {crumbs.length > 0 && (
            <>
              <span aria-hidden="true" className="text-ink-sub select-none">
                /
              </span>
              <Breadcrumb segments={crumbs} />
            </>
          )}

          {actions && (
            <div className="ml-auto flex items-center gap-2">{actions}</div>
          )}
        </div>

        <TabNav tabs={TABS} />
      </div>
    </header>
  );
}
