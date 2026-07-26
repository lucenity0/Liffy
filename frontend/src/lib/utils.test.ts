import { describe, expect, it } from "vitest";
import {
  cn,
  ensureUtc,
  formatCount,
  formatDuration,
  formatRelative,
} from "./utils";

const NOW = new Date("2026-07-26T12:00:00Z");
const ago = (seconds: number) =>
  new Date(NOW.getTime() - seconds * 1000).toISOString();

describe("ensureUtc", () => {
  it("treats a zone-less timestamp as UTC, not local", () => {
    // The bug this exists to prevent: new Date("…T12:00:00") is parsed in the
    // viewer's zone, so every relative time drifts by their UTC offset.
    expect(ensureUtc("2026-07-26T12:00:00").toISOString()).toBe(
      "2026-07-26T12:00:00.000Z",
    );
  });

  it("leaves an explicit zone alone", () => {
    expect(ensureUtc("2026-07-26T12:00:00Z").toISOString()).toBe(
      "2026-07-26T12:00:00.000Z",
    );
    expect(ensureUtc("2026-07-26T14:00:00+02:00").toISOString()).toBe(
      "2026-07-26T12:00:00.000Z",
    );
  });
});

describe("formatRelative", () => {
  it.each([
    [0, "just now"],
    [44, "just now"],
    [45, "45 seconds ago"],
    [59, "59 seconds ago"],
    [60, "1 minute ago"],
    // Math.round breaks a .5 tie upward, which for a negative offset means
    // toward zero — 90s reads as 1 minute, not 2.
    [90, "1 minute ago"],
    [100, "2 minutes ago"],
    [59 * 60, "59 minutes ago"],
    [60 * 60, "1 hour ago"],
    [24 * 60 * 60 - 1, "24 hours ago"],
    [24 * 60 * 60, "yesterday"],
    [3 * 24 * 60 * 60, "3 days ago"],
    [30 * 24 * 60 * 60, "last month"],
    [365 * 24 * 60 * 60, "last year"],
  ])("%i seconds ago → %s", (seconds, expected) => {
    expect(formatRelative(ago(seconds), NOW)).toBe(expected);
  });

  it("handles a timestamp in the future without saying '-2 minutes ago'", () => {
    const future = new Date(NOW.getTime() + 120 * 1000).toISOString();
    expect(formatRelative(future, NOW)).toBe("in 2 minutes");
  });

  it("reads a zone-less timestamp as UTC, like everything else", () => {
    expect(formatRelative("2026-07-26T11:00:00", NOW)).toBe("1 hour ago");
  });
});

describe("formatDuration", () => {
  it("drops the minutes when there are none", () => {
    expect(formatDuration("2026-07-26T12:00:00Z", "2026-07-26T12:00:42Z")).toBe(
      "42s",
    );
  });

  it("shows both units past a minute", () => {
    expect(formatDuration("2026-07-26T12:00:00Z", "2026-07-26T12:03:12Z")).toBe(
      "3m 12s",
    );
  });

  it("refuses to render a negative duration", () => {
    // completed_at before created_at means clock skew, not a fast review.
    expect(formatDuration("2026-07-26T12:00:42Z", "2026-07-26T12:00:00Z")).toBe(
      "—",
    );
  });
});

describe("formatCount", () => {
  it("groups thousands", () => {
    expect(formatCount(4213)).toBe("4,213");
    expect(formatCount(176)).toBe("176");
  });
});

describe("cn", () => {
  it("knows this theme's scales, so a colour cannot eat a font size", () => {
    // Without the extendTailwindMerge config, twMerge guesses text-ink is a
    // size and drops text-md.
    expect(cn("text-md", "text-ink")).toBe("text-md text-ink");
  });

  it("still resolves genuine conflicts, last one winning", () => {
    expect(cn("bg-card", "bg-recessed")).toBe("bg-recessed");
  });
});
