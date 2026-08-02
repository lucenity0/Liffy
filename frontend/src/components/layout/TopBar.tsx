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
  // Last two, and deliberately in this order. The first three are *what Liffy
  // has done*; Settings is how it is configured; Help is about neither — it is
  // the manual. Each is its own category, which is why they queue at the end
  // rather than interleaving with the reports.
  { to: "/settings", label: "Settings" },
  { to: "/help", label: "Help" },
];

/**
 * The whole of Liffy's chrome: a wordmark, a breadcrumb, an actions slot,
 * and the tab strip.
 *
 * Still no sidebar. Settings (#236) makes this four top-level surfaces —
 * the count this comment has now been rewritten around twice, which is
 * itself the useful signal: the rule is not about the number. A sidebar has
 * to earn a permanent column of the viewport, and four destinations that fit
 * comfortably in one strip do not. Revisit it when a tab has to be dropped
 * to make room, not when one is added.
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
