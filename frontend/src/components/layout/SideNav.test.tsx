import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SideNav } from "./SideNav";
import { fixtureUser, fixtureUserNotOwner } from "@/mocks/fixtures";
import { renderWithProviders } from "@/test/renderWithProviders";

/**
 * The Settings entry is *decoration*: `require_owner` on the backend is what
 * actually gates those routes. So the question this file answers is which way
 * the nav fails when it cannot tell, and the answer has to be "open".
 */
describe("SideNav settings entry", () => {
  it("shows Settings to the owner", () => {
    renderWithProviders(<SideNav />, { auth: { user: fixtureUser } });
    expect(screen.getAllByText("Settings").length).toBeGreaterThan(0);
  });

  it("hides Settings from a known non-owner", () => {
    renderWithProviders(<SideNav />, { auth: { user: fixtureUserNotOwner } });
    expect(screen.queryByText("Settings")).toBeNull();
  });

  it("shows Settings when ownership is unknown", () => {
    // The regression this exists for. `user?.is_owner ?? false` read "unknown"
    // as "not the owner", so a backend one version behind — serving a `UserOut`
    // with no `is_owner` — silently removed the settings page from the person
    // who owns the instance. A cosmetic filter must fail open; the 403 is the
    // real gate, and one wasted click beats a page that is simply gone.
    const stale = { ...fixtureUser } as Partial<typeof fixtureUser>;
    delete stale.is_owner;
    renderWithProviders(<SideNav />, { auth: { user: stale as typeof fixtureUser } });
    expect(screen.getAllByText("Settings").length).toBeGreaterThan(0);
  });

  it("shows Settings while the session is still loading", () => {
    renderWithProviders(<SideNav />, { auth: { user: null, status: "loading" } });
    expect(screen.getAllByText("Settings").length).toBeGreaterThan(0);
  });
});
