/**
 * Reading the palette back out of the browser.
 *
 * index.css is the single source of truth for colour, and half of it is
 * declared with `color-mix()` — so anything that needs a concrete value
 * (Monaco's theme API takes hex strings; the style guide prints them) has to
 * ask the browser to resolve it rather than duplicating the table in TS,
 * where it would quietly drift.
 */

/**
 * Resolves a CSS custom property to a `#rrggbb` string.
 *
 * `theme` puts the probe inside a wrapper carrying that `data-theme`, which
 * is what lets *any* theme's value be read while the page is wearing a
 * different one — Monaco has to build an editor theme for whichever palette
 * is active without flipping the document, and the style guide prints every
 * palette at once. Omit it to read the ambient value.
 *
 * This used to take a `.light`/`.dark` class name, which could only address
 * two palettes and answered the wrong question once there were more: two
 * dark themes share a polarity but not a single colour.
 */
export function resolveColor(
  variable: string,
  fallback: string,
  theme?: string,
  /**
   * Measure inside an existing element instead of a fresh one.
   *
   * The theme editor resolves a palette that is not in any stylesheet yet —
   * the values live in a `style` attribute on a scratch node — so it needs
   * the probe mounted *there* rather than in a wrapper of our own.
   */
  within?: HTMLElement,
): string {
  try {
    const host = within ?? document.createElement("div");
    if (theme) host.dataset.theme = theme;
    if (!within) host.style.display = "none";

    const probe = document.createElement("span");
    probe.style.color = `var(${variable})`;
    host.appendChild(probe);
    if (!within) document.body.appendChild(host);

    const computed = getComputedStyle(probe).color;
    if (within) probe.remove();
    else host.remove();

    const rgb = computed.match(/\d+(\.\d+)?/g);
    if (!rgb || rgb.length < 3) return fallback;

    return `#${rgb
      .slice(0, 3)
      .map((part) => Math.round(Number(part)).toString(16).padStart(2, "0"))
      .join("")}`;
  } catch {
    return fallback;
  }
}

/** WCAG 2.1 relative luminance. Expects `#rgb` or `#rrggbb`. */
function luminance(hex: string): number {
  const raw = hex.replace("#", "");
  const full =
    raw.length === 3
      ? raw
          .split("")
          .map((c) => c + c)
          .join("")
      : raw;

  const [r, g, b] = [0, 2, 4]
    .map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));

  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * WCAG contrast ratio, 1–21. Both themes were locked against this, and the
 * style guide prints it live so the numbers cannot go stale the way a
 * hardcoded table does.
 */
export function contrastRatio(foreground: string, background: string): number {
  const a = luminance(foreground);
  const b = luminance(background);
  const [lighter, darker] = a > b ? [a, b] : [b, a];
  return (lighter + 0.05) / (darker + 0.05);
}
