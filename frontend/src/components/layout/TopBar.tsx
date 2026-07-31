import { Link } from "react-router-dom";
import type { ReactNode } from "react";
import { Breadcrumb, type Crumb } from "./Breadcrumb";
import { TabNav, type Tab } from "./TabNav";
import { ThemeToggle } from "./ThemeToggle";
import { UserMenu } from "./UserMenu";

const TABS: Tab[] = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/reviews", label: "Reviews" },
  { to: "/analytics", label: "Analytics" },
];

/**
 * The whole of Liffy's chrome: a wordmark, a breadcrumb, an actions slot,
 * and the tab strip.
 *
 * Still no sidebar. Analytics (#200) made this three top-level surfaces
 * rather than two, which was the number this comment used to lean on — but
 * three tabs is not the argument for a sidebar either, and the strip carries
 * them without changing shape. The rule is the same one, restated: a sidebar
 * has to earn a permanent column of the viewport, and three destinations do
 * not.
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

          {/* Always rendered, even with no page actions — the theme toggle
              and the user menu are chrome, not something a page opts into.
              `UserMenu` renders nothing when there is no user, so the shell
              stays usable in the style guide and in tests that mount it
              without a session. */}
          <div className="ml-auto flex items-center gap-2">
            {actions}
            <ThemeToggle />
            <UserMenu />
          </div>
        </div>

        <TabNav tabs={TABS} />
      </div>
    </header>
  );
}
