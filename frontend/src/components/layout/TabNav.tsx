import { NavLink } from "react-router-dom";

export interface Tab {
  to: string;
  label: string;
  /** Renders GitHub's counter chip. Omit while the count is unknown. */
  count?: number;
  /** `end` matching, for the index route. */
  end?: boolean;
}

/**
 * GitHub's underline tab strip. The active underline is pulled down by one
 * pixel (`-mb-px`) so it sits *on* the header's bottom hairline rather than
 * above it — that overlap is what makes the tab read as attached to the page.
 */
export function TabNav({ tabs }: { tabs: Tab[] }) {
  return (
    <nav aria-label="Primary" className="-mb-px flex gap-1">
      {tabs.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          end={tab.end}
          className={({ isActive }) =>
            [
              "group flex items-center gap-2 border-b-2 px-3 py-2.5 text-sm",
              "transition-colors duration-100",
              isActive
                ? "border-ink text-ink"
                : "border-transparent text-ink-dim hover:border-rule-strong hover:text-ink",
            ].join(" ")
          }
        >
          {({ isActive }) => (
            <>
              <span>{tab.label}</span>
              {tab.count !== undefined && (
                <span
                  data-numeric
                  className={[
                    "rounded-full px-1.5 py-px text-2xs leading-normal",
                    isActive
                      ? "bg-ink text-paper"
                      : "bg-recessed text-ink-dim group-hover:bg-rule",
                  ].join(" ")}
                >
                  {tab.count}
                </span>
              )}
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}
