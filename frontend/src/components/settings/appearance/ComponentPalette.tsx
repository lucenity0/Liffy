import { useMemo, useState } from "react";
import { searchComponents, type ComponentSpec } from "@/lib/theme/components";
import { cn } from "@/lib/utils";

/**
 * ⌘K over the component registry.
 *
 * The alternative this replaces is a list of nineteen CSS variables and the
 * job of working out which of them draws the thing you are looking at. Here
 * you type what you would call it — "review card", "badge", "sidebar" — and
 * the answer is the component itself, which then highlights in the preview so
 * you can confirm you found the right one before changing anything.
 *
 * The open/closed split is two components on purpose. State that should not
 * survive a close — the query, the cursor — lives in the inner one, which
 * only exists while the palette is open, so closing it discards that state by
 * unmounting rather than by an effect that resets four fields and has to be
 * kept in step with them.
 */
export function ComponentPalette({
  open,
  onOpenChange,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (spec: ComponentSpec) => void;
}) {
  if (!open) return null;
  return <Palette onOpenChange={onOpenChange} onSelect={onSelect} />;
}

function Palette({
  onOpenChange,
  onSelect,
}: {
  onOpenChange: (open: boolean) => void;
  onSelect: (spec: ComponentSpec) => void;
}) {
  const [query, setQuery] = useState("");
  const [wanted, setWanted] = useState(0);

  const results = useMemo(() => searchComponents(query), [query]);

  /**
   * The cursor, clamped where it is read rather than corrected after the fact.
   *
   * It indexes a list that shrinks as you type, so it can point past the end
   * at any moment — and an effect that pulled it back would be a second render
   * for something the first one already knows. `wanted` is where the arrow
   * keys have taken it; this is where that lands.
   */
  const cursor = Math.min(wanted, Math.max(0, results.length - 1));

  const choose = (spec: ComponentSpec) => {
    onSelect(spec);
    onOpenChange(false);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-paper/70 p-4 pt-[12vh]"
      // A backdrop click is the expected way out of a command palette; the
      // Escape key below covers the keyboard.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onOpenChange(false);
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search components"
        className="rounded-sheet shadow-hard-lg flex w-full max-w-lg flex-col overflow-hidden border border-rule-strong bg-card"
      >
        <input
          type="text"
          // Safe here in a way it would not be on a persistent element: this
          // input is created by the open transition, so it takes focus once,
          // when the palette appears.
          autoFocus
          value={query}
          placeholder="Search components…"
          aria-label="Search components"
          aria-controls="component-palette-results"
          onChange={(event) => {
            setQuery(event.target.value);
            setWanted(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              onOpenChange(false);
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              setWanted(Math.min(cursor + 1, results.length - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setWanted(Math.max(cursor - 1, 0));
            } else if (event.key === "Enter" && results[cursor]) {
              event.preventDefault();
              choose(results[cursor]);
            }
          }}
          className="border-b border-rule bg-transparent px-3 py-2.5 text-base text-ink outline-none placeholder:text-ink-sub"
        />

        <ul id="component-palette-results" className="max-h-80 overflow-y-auto">
          {results.length === 0 && (
            <li className="px-3 py-3 text-sm text-ink-sub">
              Nothing matches “{query}”. The inspector covers the eight
              components that can be overridden — everything else follows the
              theme.
            </li>
          )}
          {results.map((spec, index) => (
            <li key={spec.id}>
              <button
                type="button"
                onMouseEnter={() => setWanted(index)}
                onClick={() => choose(spec)}
                className={cn(
                  "flex w-full items-baseline gap-2 px-3 py-2 text-left",
                  index === cursor ? "bg-neutral-tint" : "hover:bg-neutral-tint",
                )}
              >
                <span className="text-sm text-ink">{spec.label}</span>
                <span className="min-w-0 flex-1 truncate text-2xs text-ink-sub">
                  {spec.note}
                </span>
                <span className="shrink-0 font-code text-2xs text-ink-sub">
                  {spec.id}
                </span>
              </button>
            </li>
          ))}
        </ul>

        <p className="border-t border-rule px-3 py-1.5 text-2xs text-ink-sub">
          ↑↓ to move · ↵ to open · esc to close
        </p>
      </div>
    </div>
  );
}
