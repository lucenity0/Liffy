import { Button } from "@/components/ui/Button";
import { useTheme } from "@/hooks/useTheme";

/**
 * Paper ⇄ graphite, as one button in the top bar.
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
  const { theme, toggle } = useTheme();
  const graphite = theme === "graphite";

  return (
    <Button
      variant="ghost"
      onClick={toggle}
      aria-pressed={graphite}
      aria-label="Graphite mode"
      title={graphite ? "Switch to paper" : "Switch to graphite"}
      className="px-1.5"
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
    </Button>
  );
}
