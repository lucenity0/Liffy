import { useState } from "react";
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
  {
    to: "/",
    label: "Dashboard",
    end: true,
    children: [
      { to: "/#repositories", label: "Repositories" },
      { to: "/#recent-reviews", label: "Recent reviews" },
    ],
  },
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
 */
export function SideNav() {
  const { pathname } = useLocation();
  const [expanded, setExpanded] = useState<NavState>(readExpanded);

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
    <aside
      className={[
        "chrome-surface shrink-0 border-chrome-rule",
        // Below lg: a horizontal strip across the top. A rail that kept its
        // column here would stack five items down a phone screen and push
        // the page itself below the fold.
        "flex flex-row items-center gap-3 border-b px-3 py-2",
        // lg and up: the rail proper.
        "lg:sticky lg:top-0 lg:h-dvh lg:w-56 lg:flex-col lg:items-stretch lg:gap-6 lg:overflow-y-auto lg:border-r lg:border-b-0 lg:px-3 lg:py-4",
      ].join(" ")}
    >
      <Link
        to="/"
        aria-label="Liffy — home"
        className="shrink-0 px-2 font-hand text-xl leading-none text-chrome-ink"
      >
        Liffy
      </Link>

      {/* One <nav>, not two: the separator groups the items visually, but
          they are a single primary navigation and should be announced as
          one. Two landmarks with the same name would be worse than none.
          Scrolls horizontally on a narrow screen rather than wrapping — a
          nav that changes height as the viewport narrows moves the page
          under the reader. */}
      <nav
        aria-label="Primary"
        className="flex min-w-0 flex-1 flex-row gap-0.5 overflow-x-auto lg:flex-col lg:overflow-visible"
      >
        {WORKSPACE.map((item) => (
          <NavRow
            key={item.to}
            item={item}
            open={isOpen(item)}
            onToggle={() => toggle(item)}
          />
        ))}

        {/* Vertical tick between the groups on a strip, a full rule on the
            rail — the same separation rotated with the layout. Drawn on
            --chrome-ink-dim rather than --chrome-rule: this splits *what
            Liffy has done* from *how it is configured*, which is the one
            real division in the nav, and a hairline did not carry it. */}
        <hr className="mx-1 h-auto w-px shrink-0 self-stretch border-0 bg-chrome-ink-dim opacity-60 lg:mx-0 lg:my-2 lg:h-0.5 lg:w-auto lg:self-auto" />

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
      <div className="flex shrink-0 items-center gap-1 lg:flex-col lg:items-stretch lg:gap-0.5">
        <div className="hidden lg:mb-1 lg:block lg:border-t lg:border-chrome-rule" />
        <ThemePicker />
        <UserMenu />
        {/* The strip has no room for a tagline, and it is not worth a line
            of a phone's viewport. */}
        <p className="label hidden px-2 pt-2 text-2xs lg:block">
          Liffy · self-hosted code review
        </p>
      </div>
    </aside>
  );
}

/** Whether `pathname` sits inside this item's section. */
function isSectionActive(item: NavItem, pathname: string): boolean {
  if (item.end) return pathname === item.to;
  return pathname === item.to || pathname.startsWith(`${item.to}/`);
}

const ROW_BASE =
  "rounded-chip shrink-0 px-2 py-1.5 text-base whitespace-nowrap no-underline transition-colors duration-100";

/**
 * The active marker follows the layout: an underline on the strip, a left bar
 * on the rail. Same idea, rotated with the axis it sits on.
 */
const MARKER = "border-b-2 lg:border-b-0 lg:border-l-2";

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

        {/* Sub-items only on the rail. The strip is one row tall by design,
            and a disclosure there would have nowhere to open into. */}
        {hasChildren && (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            aria-label={`${open ? "Collapse" : "Expand"} ${item.label}`}
            className="hidden shrink-0 rounded-chip px-1.5 py-1.5 text-chrome-ink-dim hover:bg-chrome-active hover:text-chrome-ink lg:block"
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
        <ul className="hidden flex-col lg:flex">
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
