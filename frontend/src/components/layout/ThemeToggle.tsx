import { useTheme } from "@/hooks/useTheme";
import { themeSpec } from "@/lib/themes";

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
