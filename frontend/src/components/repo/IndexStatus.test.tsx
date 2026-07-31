import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { IndexStatus } from "./IndexStatus";
import {
  fixtureRepoStatusIndexed,
  fixtureRepoStatusLegacy,
  fixtureRepoStatusNotIndexed,
  fixtureRepoStatusPartial,
} from "@/mocks/fixtures";

/**
 * #210: a partially-failed index must not look identical to a complete one.
 * The count is the signal — *which* files stays in the worker log.
 */
describe("IndexStatus skipped-files caveat", () => {
  it("renders the caveat, with its denominator, when files were skipped", () => {
    render(
      <IndexStatus status={fixtureRepoStatusPartial} fallbackIndexedAt={null} />,
    );

    expect(screen.getByText(/files skipped/i)).toBeInTheDocument();
    expect(screen.getByText("40")).toBeInTheDocument();
    // The denominator: "40 skipped" reads differently out of 45 than out of 4,000.
    expect(screen.getByText("200")).toBeInTheDocument();
  });

  it("omits the caveat on a clean run", () => {
    render(
      <IndexStatus status={fixtureRepoStatusIndexed} fallbackIndexedAt={null} />,
    );

    // "0 files skipped" on a healthy repo is clutter, not information.
    expect(screen.queryByText(/files skipped/i)).not.toBeInTheDocument();
  });

  it("omits the caveat on a legacy repo with null counts", () => {
    // Null means "never measured", which is not a reason to warn anyone.
    render(
      <IndexStatus status={fixtureRepoStatusLegacy} fallbackIndexedAt={null} />,
    );

    expect(screen.queryByText(/files skipped/i)).not.toBeInTheDocument();
  });

  it("still shows the chunk count alongside the caveat", () => {
    render(
      <IndexStatus status={fixtureRepoStatusPartial} fallbackIndexedAt={null} />,
    );

    expect(screen.getByText("160")).toBeInTheDocument();
    expect(screen.getByText(/chunks/)).toBeInTheDocument();
  });

  it("says nothing about skipped files while still indexing", () => {
    render(
      <IndexStatus status={fixtureRepoStatusNotIndexed} fallbackIndexedAt={null} />,
    );

    expect(screen.queryByText(/files skipped/i)).not.toBeInTheDocument();
    expect(screen.getByText(/building the index/i)).toBeInTheDocument();
  });

  it("explains what a skipped file costs, rather than only counting it", () => {
    render(
      <IndexStatus status={fixtureRepoStatusPartial} fallbackIndexedAt={null} />,
    );

    expect(screen.getByTitle(/retrieve no context/i)).toBeInTheDocument();
  });
});
