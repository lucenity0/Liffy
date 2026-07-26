import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge has to be taught this theme, because index.css closes the
 * default namespaces and replaces them. Without the `theme` extension below,
 * `text-ink` is an unknown class that twMerge guesses is a font-size — so
 * `cn("text-md", "text-ink")` would drop the size. Registering the custom
 * scales is what makes conflict resolution correct rather than lucky.
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      color: [
        "paper",
        "card",
        "recessed",
        "rule",
        "rule-strong",
        "ink",
        "ink-dim",
        "ink-sub",
        "oxide",
        "sage",
        "ochre",
        "payne",
        "oxide-tint",
        "sage-tint",
        "ochre-tint",
        "payne-tint",
        "neutral-tint",
        "diff-add",
        "diff-del",
      ],
      font: ["hand", "ui", "code"],
      text: ["2xs", "md"],
      radius: ["chip", "sheet"],
      shadow: ["hard", "hard-lg"],
      leading: ["rule"],
      tracking: ["label"],
      container: ["prose", "app"],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * The API can serialise timestamps without an offset (SQLite in the test
 * suite, and Postgres depending on column config). `new Date("…T00:00:00")`
 * is parsed as *local* time while `"…Z"` is UTC, so relative times would
 * silently drift by the viewer's offset. Everything goes through here.
 */
export function ensureUtc(iso: string): Date {
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(iso);
  return new Date(hasZone ? iso : `${iso}Z`);
}

const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 60 * 60],
  ["month", 30 * 24 * 60 * 60],
  ["day", 24 * 60 * 60],
  ["hour", 60 * 60],
  ["minute", 60],
  ["second", 1],
];

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** "3 minutes ago" / "in 2 days". Past is the overwhelmingly common case. */
export function formatRelative(iso: string, now: Date = new Date()): string {
  const seconds = (ensureUtc(iso).getTime() - now.getTime()) / 1000;
  const abs = Math.abs(seconds);

  if (abs < 45) return "just now";

  for (const [unit, unitSeconds] of RELATIVE_UNITS) {
    if (abs >= unitSeconds) {
      return rtf.format(Math.round(seconds / unitSeconds), unit);
    }
  }
  return "just now";
}

/** Full timestamp for the `title` attribute behind a relative time. */
export function formatAbsolute(iso: string): string {
  return ensureUtc(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** "1,204" — token counts and chunk counts read better grouped. */
export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

/** Elapsed time between two API timestamps, e.g. "42s" or "3m 12s". */
export function formatDuration(fromIso: string, toIso: string): string {
  const ms = ensureUtc(toIso).getTime() - ensureUtc(fromIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";

  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}
