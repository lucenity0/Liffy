import { useState } from "react";
import { useTheme } from "@/hooks/useTheme";
import { cn } from "@/lib/utils";
import { themeSpec, THEMES } from "@/lib/themes";

/**
 * Light ⇄ dark, as one button in the chrome.
 *
 * Flips *polarity*, not a named pair — it lands on whichever theme was last
 * used on the other side, so someone who chose Carbon does not get bounced
 * back to a default every time they toggle. Choosing a specific theme is the
 * picker's job; this is the one-click affordance.
 *
 * A half-filled disc rather than a sun/moon pair: the palette is monochrome
 * paper, and this is the same contrast mark the rest of the chrome is drawn
 * with. Inline SVG on `currentColor`, so it inherits the ghost button's
 * hover the way a glyph would, without adding an icon dependency for one use.
 *
 * `aria-pressed` rather than a swapped label — the control is one toggle in
 * two states, so the name should stay put while the state changes under it.
 */
export function ThemeToggle() {
  const { theme, polarity, toggle } = useTheme();
  const dark = polarity === "dark";

  return (
    // A labelled row rather than a bare icon button. In a top bar a lone disc
    // was legible as chrome; in a column of named rows it was the one control
    // you had to hover to identify. The label also gives the theme *name* a
    // home, which is where the picker lands.
    <button
      type="button"
      onClick={toggle}
      aria-pressed={dark}
      aria-label="Dark mode"
      title={dark ? "Switch to light" : "Switch to dark"}
      className="flex items-center gap-2 rounded-chip px-2 py-1.5 text-left text-sm text-ink-dim hover:bg-recessed hover:text-ink"
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        className="size-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
      >
        <circle cx="8" cy="8" r="5.5" />
        {/* The filled half, drawn as a path so it stays crisp at 16px. */}
        <path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor" stroke="none" />
      </svg>
      <span className="min-w-0 truncate">{themeSpec(theme).label}</span>
    </button>
  );
}

/**
 * The full ladder, as a rail row per theme.
 *
 * Not a popover. The account menu used to be one and its panel opened past
 * the bottom of a full-height rail where the scroll container clipped it —
 * a list of five would have the same problem and worse. Rows expand in
 * place; the rail already scrolls.
 */
export function ThemePicker() {
  const { theme, setTheme, prefs, matchSystem } = useTheme();
  const [open, setOpen] = useState(false);

  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        aria-expanded={open}
        className="flex items-center gap-2 rounded-chip px-2 py-1.5 text-left text-sm text-ink-dim hover:bg-recessed hover:text-ink"
      >
        <Disc />
        <span className="min-w-0 flex-1 truncate">{themeSpec(theme).label}</span>
        <span
          aria-hidden="true"
          className={cn("shrink-0 transition-transform duration-100", open && "rotate-90")}
        >
          ›
        </span>
      </button>

      {open && (
        <ul className="flex flex-col">
          {THEMES.map((spec) => (
            <li key={spec.id}>
              <button
                type="button"
                onClick={() => setTheme(spec.id)}
                aria-current={theme === spec.id ? "true" : undefined}
                className={cn(
                  "w-full rounded-chip py-1 pr-2 pl-8 text-left text-sm",
                  theme === spec.id
                    ? "bg-recessed text-ink"
                    : "text-ink-dim hover:bg-recessed hover:text-ink",
                )}
              >
                {spec.label}
              </button>
            </li>
          ))}
          {/* Only when there is one. An entry that opens an empty palette
              would be a control that does nothing. */}
          {prefs.custom && (
            <li>
              <button
                type="button"
                onClick={() => setTheme("custom")}
                aria-current={theme === "custom" ? "true" : undefined}
                className={cn(
                  "w-full rounded-chip py-1 pr-2 pl-8 text-left text-sm",
                  theme === "custom"
                    ? "bg-recessed text-ink"
                    : "text-ink-dim hover:bg-recessed hover:text-ink",
                )}
              >
                Custom
              </button>
            </li>
          )}
          <li>
            <button
              type="button"
              onClick={matchSystem}
              aria-current={prefs.mode === "system" ? "true" : undefined}
              className={cn(
                "w-full rounded-chip py-1 pr-2 pl-8 text-left text-sm",
                prefs.mode === "system"
                  ? "bg-recessed text-ink"
                  : "text-ink-sub hover:bg-recessed hover:text-ink",
              )}
            >
              Match system
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}

/** The half-filled disc, shared by the toggle and the picker. */
function Disc() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="size-4 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
    >
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor" stroke="none" />
    </svg>
  );
}
