import type { ReactNode } from "react";
import { Breadcrumb, type Crumb } from "./Breadcrumb";

/**
 * Where you are, and what you can do about it.
 *
 * Split out of the old top bar rather than folded into the rail: navigation
 * is about the product, a breadcrumb and a page action are about the page.
 * Putting them on the rail would mean rail contents changing per route, which
 * is exactly the instability a persistent frame exists to avoid.
 *
 * It sits in the *content* plane, not the chrome plane — no `chrome-surface`
 * here — so it reads as the top of the page rather than as more furniture.
 * Sticky, because it carries the breadcrumb for a diff you can scroll a long
 * way down.
 */
export function PageBar({
  crumbs,
  actions,
}: {
  crumbs: Crumb[];
  actions?: ReactNode;
}) {
  // Nothing to say and nothing to do — render nothing rather than a stray
  // hairline across the top of the dashboard.
  if (crumbs.length === 0 && !actions) return null;

  return (
    <div className="sticky top-0 z-20 border-b border-rule bg-paper/95 backdrop-blur-sm">
      <div className="mx-auto flex h-11 w-full max-w-app items-center gap-3 px-4 sm:px-6">
        {crumbs.length > 0 && <Breadcrumb segments={crumbs} />}
        {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}
