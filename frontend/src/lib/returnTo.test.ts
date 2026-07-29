import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_RETURN_TO, stashReturnTo, takeReturnTo } from "./returnTo";

const RETURN_TO_KEY = "liffy.return_to";

beforeEach(() => {
  window.sessionStorage.clear();
});

afterEach(() => {
  window.sessionStorage.clear();
});

describe("stashReturnTo / takeReturnTo", () => {
  it("round-trips a path", () => {
    stashReturnTo("/reviews/abc");
    expect(takeReturnTo()).toBe("/reviews/abc");
  });

  it("keeps a query string and fragment intact", () => {
    stashReturnTo("/reviews?offset=40#top");
    expect(takeReturnTo()).toBe("/reviews?offset=40#top");
  });

  it("consumes the value, so a later login goes home", () => {
    stashReturnTo("/reviews/abc");
    expect(takeReturnTo()).toBe("/reviews/abc");
    expect(takeReturnTo()).toBe(DEFAULT_RETURN_TO);
  });

  it("falls back to the dashboard when nothing was stashed", () => {
    expect(takeReturnTo()).toBe(DEFAULT_RETURN_TO);
  });

  it("does not stash the dashboard itself", () => {
    // Storing the default only to read it back is noise.
    stashReturnTo("/");
    expect(window.sessionStorage.getItem(RETURN_TO_KEY)).toBeNull();
  });
});

/**
 * One case per vector.
 *
 * The prefix check this replaced looked obviously correct — which is exactly
 * why the backslash forms survived review. Browsers normalise `\` to `/` and
 * strip control characters while parsing, so all three of the "newly closed"
 * entries below satisfied `startsWith("/") && !startsWith("//")` and all
 * three resolved to `http://evil.com/`.
 */
describe("open-redirect vectors", () => {
  const allowed = [
    ["a plain path", "/reviews/abc"],
    ["a path with a query and fragment", "/reviews?q=1#frag"],
    ["a nested path", "/repos/some-owner/some-name"],
    ["a path that merely looks like a host", "/evil.com"],
  ] as const;

  const blocked = [
    ["a protocol-relative URL", "//evil.com"],
    ["an absolute URL", "https://evil.com"],
    ["a backslash in place of the second slash", "/\\evil.com"],
    ["a backslash-slash pair", "/\\/evil.com"],
    ["a control character before a protocol-relative URL", "/\n//evil.com"],
    ["a tab before a protocol-relative URL", "/\t//evil.com"],
    ["a javascript: URL", "javascript:alert(1)"],
    ["a double backslash", "\\\\evil.com"],
    ["a relative path", "reviews"],
    ["the empty string", ""],
  ] as const;

  it.each(allowed)("allows %s", (_label, path) => {
    stashReturnTo(path);
    expect(takeReturnTo()).toBe(path);
  });

  it.each(blocked)("blocks %s", (_label, path) => {
    stashReturnTo(path);
    // Rejected on the way in...
    expect(window.sessionStorage.getItem(RETURN_TO_KEY)).toBeNull();
    expect(takeReturnTo()).toBe(DEFAULT_RETURN_TO);
  });

  it.each(blocked)("blocks %s even when written straight to storage", (_label, path) => {
    // The key is writable by any script on the origin, so the check on the
    // way out has to hold on its own — it cannot rely on stashReturnTo
    // having been the one to put the value there.
    window.sessionStorage.setItem(RETURN_TO_KEY, path);
    expect(takeReturnTo()).toBe(DEFAULT_RETURN_TO);
  });

  it("blocks anything that leaves the origin, checked against the URL parser", () => {
    // A second, independent expression of the same rule: whatever survives
    // must resolve to this origin. If the implementation ever drifts back to
    // prefix matching, this fails alongside the cases above.
    for (const [, path] of blocked) {
      window.sessionStorage.setItem(RETURN_TO_KEY, path);
      const result = takeReturnTo();
      expect(new URL(result, window.location.origin).origin).toBe(
        window.location.origin,
      );
    }
  });
});
