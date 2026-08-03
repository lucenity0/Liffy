import { useEffect, useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { ThemePicker } from "./ThemeToggle";
import { UserMenu } from "./UserMenu";
import { cn } from "@/lib/utils";

export interface NavChild {
  /** A route, or a route plus a hash for a section of one. */
  to: string;
  label: string;
}

export interface NavItem {
  to: string;
  label: string;
  /** `end` matching, for the index route. */
  end?: boolean;
  children?: NavChild[];
}

/**
 * The two halves of the product, and the line between them.
 *
 * Above: what Liffy has done — the surfaces you come here to read. Below:
 * how it is configured, and the manual. The separator is the whole reason a
 * rail beats the old tab strip; a horizontal strip could only queue these in
 * one run and hope the order implied the grouping.
 *
 * Sub-items are the sections of the page they hang under. They are added as
 * each page rework lands rather than up front — a nav entry pointing at a
 * heading that does not exist yet is worse than no entry, which is the same
 * reason Repositories is not here until its route is.
 */
const WORKSPACE: NavItem[] = [
  // No sub-items. The dashboard is one short page and every one of its
  // sections is already on screen when you land — a disclosure listing three
  // anchors to content you can see is a control that costs three rows of the
  // rail to scroll you somewhere you already are.
  { to: "/", label: "Dashboard", end: true },
  { to: "/reviews", label: "Reviews" },
  { to: "/repositories", label: "Repositories" },
  { to: "/analytics", label: "Analytics" },
];

const SYSTEM: NavItem[] = [
  {
    to: "/settings",
    label: "Settings",
    children: [
      { to: "/settings", label: "Review" },
      { to: "/settings?section=github", label: "GitHub" },
      { to: "/settings?section=providers", label: "Providers" },
      { to: "/settings?section=secrets", label: "Secrets" },
      { to: "/settings?section=infrastructure", label: "Infrastructure" },
      { to: "/settings?section=appearance", label: "Appearance" },
    ],
  },
  { to: "/help", label: "Help" },
];

const EXPANDED_KEY = "liffy-nav-expanded";

/**
 * Per-item open state, where *absent* is meaningfully different from `false`.
 *
 * A Set could only say "expanded", so "collapsed" and "never touched" were
 * the same value — and since the active section defaults to open, collapsing
 * the section you were standing in did nothing at all: the default kept
 * winning and the chevron appeared stuck. Tri-state fixes it: absent defers
 * to the default, `false` is an explicit collapse that beats it.
 */
type NavState = Record<string, boolean>;

function readExpanded(): NavState {
  try {
    const raw = localStorage.getItem(EXPANDED_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    // Tolerates the older array form by reading it as "these were expanded".
    if (Array.isArray(parsed)) {
      return Object.fromEntries(
        parsed.filter((v) => typeof v === "string").map((v) => [v as string, true]),
      );
    }
    return parsed && typeof parsed === "object" ? (parsed as NavState) : {};
  } catch {
    // A collapsed-state preference is never worth throwing over.
    return {};
  }
}

/**
 * A left rail, drawn on the chrome plane.
 *
 * It replaces a `bg-card` top bar that sat 1.06:1 off the page — chrome that
 * dissolved into the content it was supposed to frame. The rail is a
 * different *material* rather than a slightly different sheet: on paper an
 * inked column with paper drawn on it, under a dark theme a plane stepped
 * away from the page in the other direction. That inversion is what gives
 * the app an actual frame, and it is the senior's "sidebar should be darker".
 *
 * Everything inside inherits the chrome palette from `chrome-surface`, so the
 * controls here are the same Button, UserMenu and ThemeToggle the page uses.
 *
 * **Below `lg` it is a drawer behind a hamburger**, not a horizontal strip.
 * The strip was cheaper — one flex direction and no focus to manage — but it
 * cost a permanent row at the top of every phone screen and could only ever
 * show top-level items, so Settings' sub-navigation simply vanished at narrow
 * widths. One nav, one markup tree, revealed rather than reshaped.
 */
export function SideNav() {
  const { pathname } = useLocation();
  const [expanded, setExpanded] = useState<NavState>(readExpanded);
  const [open, setOpen] = useState(false);

  /**
   * Picking a destination closes the drawer — a drawer left standing over the
   * page you just asked for is the single most common bug in this pattern.
   *
   * Delegated off the nav rather than run from an effect on `pathname`.
   * Closing in an effect means rendering the drawer open over the new page
   * and then closing it, which is a visible flash and what
   * `react-hooks/set-state-in-effect` is warning about. Scoped to links, so
   * the disclosure chevrons — whose whole job is to reveal more of this
   * menu — do not dismiss it.
   */
  function onNavClick(event: React.MouseEvent<HTMLElement>) {
    if ((event.target as HTMLElement).closest("a")) setOpen(false);
  }

  // Escape closes it, because it behaves like a dialog while it is over the
  // page. Bound only while open, so the app is not listening for keystrokes
  // it has no use for.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  /**
   * The section you are in starts open, because a collapsed *current* section
   * hides the only sub-items reachable from where you are. It is a default,
   * not a lock — an explicit choice always wins.
   */
  const isOpen = (item: NavItem) =>
    expanded[item.to] ?? isSectionActive(item, pathname);

  function toggle(item: NavItem) {
    // Toggle against what is actually on screen, so the first click always
    // does the opposite of what the user is looking at rather than the
    // opposite of an absent stored value.
    const next = { ...expanded, [item.to]: !isOpen(item) };
    setExpanded(next);
    try {
      localStorage.setItem(EXPANDED_KEY, JSON.stringify(next));
    } catch {
      // Session-only, then.
    }
  }

  return (
    <>
      {/* The bar the hamburger lives on. Only below `lg`, where the rail is
          hidden — it carries the wordmark too, so the app still says its own
          name when the rail is shut. */}
      <div className="chrome-surface sticky top-0 z-30 flex items-center gap-2 border-b border-chrome-rule px-3 py-2 lg:hidden">
        <button
          type="button"
          onClick={() => setOpen((was) => !was)}
          aria-expanded={open}
          aria-controls="side-nav"
          // A constant name with the state on `aria-expanded`, which is the
          // disclosure convention — and it stops this colliding with the
          // drawer's own close button, which really is named for one action.
          aria-label="Navigation menu"
          className="rounded-chip -ml-1 px-2 py-1.5 text-chrome-ink hover:bg-chrome-active"
        >
          {/* Three rules, drawn rather than typed: a glyph would ride the
              text baseline and sit off-centre against the wordmark. */}
          <span aria-hidden="true" className="flex w-4 flex-col gap-1">
            <span className="h-0.5 bg-current" />
            <span className="h-0.5 bg-current" />
            <span className="h-0.5 bg-current" />
          </span>
        </button>
        <Link
          to="/"
          aria-label="Liffy — home"
          className="font-hand text-xl leading-none text-chrome-ink"
        >
          Liffy
        </Link>
      </div>

      {/* Dismiss-by-tapping-away, and the scrim that says the page behind is
          not the thing you are using. Not focusable: Escape and the close
          button are the keyboard paths, and a tabbable div in between them
          would just be a stop that does nothing visible. */}
      {open && (
        <div
          onClick={() => setOpen(false)}
          aria-hidden="true"
          className="fixed inset-0 z-30 bg-black/50 lg:hidden"
        />
      )}

      <aside
        id="side-nav"
        // Appearance's "Compact" narrows the rail through a rule keyed on
        // `html[data-nav]` in index.css, rather than by threading a setting
        // down here — the width has to be settled before first paint, and a
        // prop cannot be.
        data-liffy-rail=""
        className={[
          "chrome-surface shrink-0 border-chrome-rule",
          // Below lg: an off-canvas drawer. `fixed` rather than a collapsing
          // strip, so opening it never reflows the page underneath.
          "fixed inset-y-0 left-0 z-40 w-64 flex-col items-stretch gap-6 overflow-y-auto border-r px-3 py-4",
          open ? "flex" : "hidden",
          // lg and up: the rail proper, always present.
          "lg:sticky lg:top-0 lg:z-auto lg:flex lg:h-dvh lg:w-56 lg:border-r",
        ].join(" ")}
      >
        {/* The drawer needs its own way out for anyone who opened it by touch
            and never reaches the keyboard. No wordmark beside it — the bar
            behind the drawer is still showing one, and two live "Liffy — home"
            links on screen at once is a duplicate for anyone tabbing. */}
        <div className="flex justify-end lg:hidden">
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close navigation"
            className="rounded-chip px-2 py-1 text-lg leading-none text-chrome-ink-dim hover:bg-chrome-active hover:text-chrome-ink"
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>

        <Link
          to="/"
          aria-label="Liffy — home"
          className="hidden shrink-0 px-2 font-hand text-xl leading-none text-chrome-ink lg:block"
        >
          Liffy
        </Link>

        {/* One <nav>, not two: the separator groups the items visually, but
            they are a single primary navigation and should be announced as
            one. Two landmarks with the same name would be worse than none.

            A column at every width now the drawer replaced the strip, which
            is what lets the sub-items exist on a phone at all — they used to
            be `lg:` only, because a one-row strip had nowhere to open into. */}
        <nav
          aria-label="Primary"
          onClick={onNavClick}
          className="flex min-w-0 flex-1 flex-col gap-0.5"
        >
          {WORKSPACE.map((item) => (
            <NavRow
              key={item.to}
              item={item}
              open={isOpen(item)}
              onToggle={() => toggle(item)}
            />
          ))}

          {/* Drawn on --chrome-ink-dim rather than --chrome-rule: this splits
              *what Liffy has done* from *how it is configured*, which is the
              one real division in the nav, and a hairline did not carry it. */}
          <hr className="my-2 h-0.5 border-0 bg-chrome-ink-dim opacity-60" />

          {SYSTEM.map((item) => (
            <NavRow
              key={item.to}
              item={item}
              open={isOpen(item)}
              onToggle={() => toggle(item)}
            />
          ))}
        </nav>

      {/* The footer used to float at the bottom of the content column with no
          background and no edge, which is what made it read as detached.
          Inside the rail it gets a casing for free.

          Theme and account are separate rows rather than a cluster of icon
          buttons: on a column of named rows, two unlabelled glyphs were the
          only things you had to hover to identify, and the account one hid
          Sign out inside a popover that the rail's own scroll container
          clipped off the bottom of the screen. */}
        <div className="flex shrink-0 flex-col items-stretch gap-0.5">
          <div className="mb-1 border-t border-chrome-rule" />
          <ThemePicker />
          <UserMenu />
          <p className="label px-2 pt-2 text-2xs">
            Liffy · self-hosted code review
          </p>
        </div>
      </aside>
    </>
  );
}

/** Whether `pathname` sits inside this item's section. */
function isSectionActive(item: NavItem, pathname: string): boolean {
  if (item.end) return pathname === item.to;
  return pathname === item.to || pathname.startsWith(`${item.to}/`);
}

const ROW_BASE =
  "rounded-chip shrink-0 px-2 py-1.5 text-base whitespace-nowrap no-underline transition-colors duration-100";

/** A left bar on the current item. One axis now the nav is always a column. */
const MARKER = "border-l-2";

function NavRow({
  item,
  open,
  onToggle,
}: {
  item: NavItem;
  open: boolean;
  onToggle: () => void;
}) {
  const hasChildren = (item.children?.length ?? 0) > 0;

  return (
    <>
      {/* The label navigates and the chevron expands — two jobs, two
          controls. A row that did both would make "show me what is in here"
          and "take me there" the same click, and there is no way to want the
          first without triggering the second. */}
      <div className="flex shrink-0 items-center">
        <NavLink
          to={item.to}
          end={item.end}
          // The component registry's `sidebar-item` — what Appearance's
          // inspector highlights and what its override rules select on.
          data-liffy="sidebar-item"
          className={({ isActive }) =>
            cn(
              ROW_BASE,
              MARKER,
              "min-w-0 flex-1",
              isActive
                ? "border-chrome-ink bg-chrome-active text-chrome-ink"
                : "border-transparent text-chrome-ink-dim hover:bg-chrome-active hover:text-chrome-ink",
            )
          }
        >
          {item.label}
        </NavLink>

        {/* Only where there are real sub-items. Dashboard has none: every
            section of it is on screen the moment you land, so a disclosure
            offering to scroll you there was three rows spent on nothing. */}
        {hasChildren && (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            aria-label={`${open ? "Collapse" : "Expand"} ${item.label}`}
            className="shrink-0 rounded-chip px-1.5 py-1.5 text-chrome-ink-dim hover:bg-chrome-active hover:text-chrome-ink"
          >
            <span
              aria-hidden="true"
              className={cn(
                "inline-block text-sm transition-transform duration-100",
                open && "rotate-90",
              )}
            >
              ›
            </span>
          </button>
        )}
      </div>

      {hasChildren && open && (
        <ul className="flex flex-col">
          {item.children!.map((child) => (
            <li key={child.to}>
              {/* NavLink would mark these active on the parent route
                  regardless of hash, so they are plain links: a section
                  anchor has no "current" state the router can see. */}
              <Link
                to={child.to}
                className="block rounded-chip py-1 pr-2 pl-6 text-sm text-chrome-ink-dim no-underline hover:bg-chrome-active hover:text-chrome-ink"
              >
                {child.label}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
