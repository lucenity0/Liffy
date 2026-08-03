import { useState } from "react";
import { SECTIONS, type SectionId } from "@/lib/settingsSections";
import { cn } from "@/lib/utils";

/**
 * Settings' own navigation, local to the page.
 *
 * Deliberately plain: text, a thin left bar for the current section, and
 * nothing else. It sits inside the content plane rather than on the chrome
 * rail — it navigates *within* a page, and dressing it like the global nav
 * would make the app look like it had two of them.
 *
 * Only sections with real sub-groups get a disclosure. Providers splits by
 * runtime and Infrastructure by concern; Review, GitHub and Secrets are flat
 * lists, and a chevron on those would be a control that does nothing.
 */
export function SettingsNav({
  active,
  onSelect,
}: {
  active: SectionId;
  onSelect: (id: SectionId, group?: string) => void;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({});

  // The section you are in is open by default; an explicit choice wins. Same
  // tri-state as the global rail, for the same reason — a Set could not tell
  // "collapsed" from "never touched", so collapsing the current section did
  // nothing at all.
  const isOpen = (id: SectionId) => open[id] ?? id === active;

  return (
    <nav aria-label="Settings sections" className="flex flex-col gap-0.5">
      <p className="label px-2 pb-1 text-ink-sub">Settings</p>

      {SECTIONS.map((section) => {
        const current = section.id === active;
        const expanded = isOpen(section.id);

        return (
          <div key={section.id} className="flex flex-col">
            <div className="flex items-center">
              <button
                type="button"
                onClick={() => onSelect(section.id)}
                aria-current={current ? "true" : undefined}
                className={cn(
                  "min-w-0 flex-1 rounded-chip border-l-2 px-2 py-1.5 text-left text-base",
                  "transition-colors duration-100",
                  current
                    ? "border-ink bg-neutral-tint text-ink"
                    : "border-transparent text-ink-dim hover:bg-neutral-tint hover:text-ink",
                )}
              >
                {section.label}
              </button>

              {section.groups && (
                <button
                  type="button"
                  onClick={() =>
                    setOpen((prev) => ({ ...prev, [section.id]: !expanded }))
                  }
                  aria-expanded={expanded}
                  aria-label={`${expanded ? "Collapse" : "Expand"} ${section.label}`}
                  className="shrink-0 rounded-chip px-1.5 py-1.5 text-ink-sub hover:bg-neutral-tint hover:text-ink"
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "inline-block text-sm transition-transform duration-100",
                      expanded && "rotate-90",
                    )}
                  >
                    ›
                  </span>
                </button>
              )}
            </div>

            {section.groups && expanded && (
              <ul className="flex flex-col">
                {section.groups.map((group) => (
                  <li key={group.id}>
                    <button
                      type="button"
                      onClick={() => onSelect(section.id, group.id)}
                      className="block w-full rounded-chip py-1 pr-2 pl-6 text-left text-sm text-ink-dim hover:bg-neutral-tint hover:text-ink"
                    >
                      {group.label}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </nav>
  );
}
