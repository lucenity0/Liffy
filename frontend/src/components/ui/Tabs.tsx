import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface TabSpec<T extends string> {
  id: T;
  label: string;
  /** GitHub's counter chip. Omit while the count is unknown or meaningless. */
  count?: number;
}

/**
 * An in-page tab strip: the underline idiom the global nav used to wear,
 * kept here where it still fits.
 *
 * Buttons over links because these switch a panel rather than a route — the
 * page owns whether the choice reaches the URL, and the review workspace does
 * put it there so a tab can be deep-linked and "view in diff" can cross from
 * one tab to another.
 *
 * `role="tablist"` with real `aria-controls` wiring: without it a screen
 * reader hears a row of buttons and has no way to know a panel below changed.
 */
export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
  idPrefix,
  className,
}: {
  tabs: readonly TabSpec<T>[];
  active: T;
  onChange: (id: T) => void;
  /** Namespaces the generated ids, so two strips on one page cannot collide. */
  idPrefix: string;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label="Review sections"
      className={cn(
        "-mb-px flex gap-1 overflow-x-auto border-b border-rule",
        className,
      )}
    >
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={tabId(idPrefix, tab.id)}
            aria-selected={selected}
            aria-controls={panelId(idPrefix, tab.id)}
            // Only the selected tab is a tab stop; arrow keys are the
            // in-strip movement ARIA expects, and Tab should leave the strip.
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
            onKeyDown={(event) => {
              const delta =
                event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
              if (!delta) return;
              event.preventDefault();
              const index = tabs.findIndex((t) => t.id === active);
              const next = tabs[(index + delta + tabs.length) % tabs.length];
              onChange(next.id);
              document.getElementById(tabId(idPrefix, next.id))?.focus();
            }}
            className={cn(
              "group flex shrink-0 items-center gap-2 border-b-2 px-3 py-2.5 text-base whitespace-nowrap",
              "transition-colors duration-100",
              selected
                ? "border-ink text-ink"
                : "border-transparent text-ink-dim hover:border-rule-strong hover:text-ink",
            )}
          >
            <span>{tab.label}</span>
            {tab.count !== undefined && (
              <span
                data-numeric
                className={cn(
                  "rounded-full px-1.5 py-px text-2xs leading-normal",
                  selected
                    ? "bg-ink text-paper"
                    : "bg-neutral-tint text-ink-dim group-hover:bg-rule",
                )}
              >
                {tab.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel<T extends string>({
  id,
  active,
  idPrefix,
  children,
}: {
  id: T;
  active: T;
  idPrefix: string;
  children: ReactNode;
}) {
  if (id !== active) return null;
  return (
    <div
      role="tabpanel"
      id={panelId(idPrefix, id)}
      aria-labelledby={tabId(idPrefix, id)}
      // Focusable so the panel is reachable after arrowing along the strip.
      tabIndex={0}
      className="focus-visible:outline-none"
    >
      {children}
    </div>
  );
}

const tabId = (prefix: string, id: string) => `${prefix}-tab-${id}`;
const panelId = (prefix: string, id: string) => `${prefix}-panel-${id}`;
