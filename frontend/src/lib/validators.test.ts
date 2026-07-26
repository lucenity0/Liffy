import { describe, expect, it } from "vitest";
import {
  isValidFullName,
  isValidPrNumber,
  normalizeFullName,
  splitFullName,
} from "./validators";

describe("isValidFullName", () => {
  const cases: [input: string, valid: boolean, why: string][] = [
    ["lucenity0/Liffy", true, "the ordinary case"],
    ["a/b", true, "single characters are still owner/name"],
    [" a/b ", true, "the backend strips surrounding whitespace"],
    ["/a/b/", true, "and surrounding slashes, so this is 'a/b' to both of us"],
    ["ab", false, "no separator"],
    ["/b", false, "strips to 'b' — no owner"],
    ["a/", false, "strips to 'a' — no name"],
    ["a/b/c", false, "two separators"],
    ["a//b", false, "an empty segment between them"],
    ["", false, "nothing at all"],
    ["   ", false, "whitespace is nothing at all"],
  ];

  it.each(cases)("%j → %s (%s)", (input, valid) => {
    expect(isValidFullName(input)).toBe(valid);
  });
});

describe("normalizeFullName", () => {
  it("is what gets sent to the API, not the raw field value", () => {
    expect(normalizeFullName("  /lucenity0/Liffy/  ")).toBe("lucenity0/Liffy");
  });

  it("leaves an already-clean name alone", () => {
    expect(normalizeFullName("lucenity0/Liffy")).toBe("lucenity0/Liffy");
  });
});

describe("isValidPrNumber", () => {
  it.each([
    ["1", true],
    ["58", true],
    ["0", false],
    ["-1", false],
    ["1.5", false],
    ["abc", false],
    ["", false],
    ["  ", false],
    // Number() would happily take these; a PR number is not in that language.
    ["1e3", false],
    ["0x10", false],
  ])("%j → %s", (input, valid) => {
    expect(isValidPrNumber(input)).toBe(valid);
  });

  it("accepts a number as readily as its string", () => {
    expect(isValidPrNumber(58)).toBe(true);
    expect(isValidPrNumber(0)).toBe(false);
    expect(isValidPrNumber(Number.NaN)).toBe(false);
  });
});

describe("splitFullName", () => {
  it("splits what the API wants out of what the user typed", () => {
    expect(splitFullName("  lucenity0/Liffy  ")).toEqual({
      owner: "lucenity0",
      repo: "Liffy",
    });
  });
});
