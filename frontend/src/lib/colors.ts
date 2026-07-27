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
 * `scope` puts the probe inside a wrapper carrying that class, which is what
 * lets the *graphite* value be read while the page is still light — the
 * Monaco setup defines both themes in one pass and cannot flip the document
 * to do it.
 */
export function resolveColor(
  variable: string,
  fallback: string,
  scope?: string,
): string {
  try {
    const host = document.createElement("div");
    if (scope) host.className = scope;
    host.style.display = "none";

    const probe = document.createElement("span");
    probe.style.color = `var(${variable})`;
    host.appendChild(probe);
    document.body.appendChild(host);

    const computed = getComputedStyle(probe).color;
    host.remove();

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
