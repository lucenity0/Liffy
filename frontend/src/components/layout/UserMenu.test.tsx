import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { fixtureUser, fixtureUserNoAvatar } from "@/mocks/fixtures";
import { renderWithAuth } from "@/test/renderWithProviders";
import type { AuthContextValue } from "@/hooks/useAuth";
import { UserMenu } from "./UserMenu";

function LocationProbe() {
  return <span data-testid="path">{useLocation().pathname}</span>;
}

function renderMenu(auth: Partial<AuthContextValue> = {}) {
  return renderWithAuth(
    <>
      <Routes>
        <Route path="/" element={<UserMenu />} />
        <Route path="/login" element={<p>Login page</p>} />
      </Routes>
      <LocationProbe />
    </>,
    { auth },
  );
}

const trigger = () => screen.getByRole("button", { name: /lucenity0|gajalakshmi/i });

describe("UserMenu", () => {
  it("shows the logged-in username and avatar", () => {
    renderMenu();

    expect(trigger()).toHaveTextContent(fixtureUser.username);
    const avatar = document.querySelector("img");
    expect(avatar).toHaveAttribute("src", fixtureUser.avatar_url);
    // Decorative: the username sits right beside it, so an alt would make a
    // screen reader announce the same person twice.
    expect(avatar).toHaveAttribute("alt", "");
  });

  it("falls back to initials when avatar_url is null", () => {
    renderMenu({ user: fixtureUserNoAvatar });

    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByTestId("avatar-initials")).toHaveTextContent("GA");
    // A missing avatar must not cost the username too.
    expect(trigger()).toHaveTextContent(fixtureUserNoAvatar.username);
  });

  it("falls back to initials when the avatar URL fails to load", () => {
    renderMenu();
    const avatar = document.querySelector("img")!;

    // A 404ing URL is the same problem as no URL — neither should leave a
    // broken-image glyph in the chrome.
    fireEvent.error(avatar);

    expect(screen.getByTestId("avatar-initials")).toBeInTheDocument();
  });

  it("renders nothing when there is no user", () => {
    renderMenu({ user: null, status: "anonymous" });
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("opens and closes on click, and reports its state", async () => {
    const user = userEvent.setup();
    renderMenu();

    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    await user.click(trigger());

    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menu", { name: "Account" })).toBeInTheDocument();

    await user.click(trigger());
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    renderMenu();

    await user.click(trigger());
    expect(screen.getByRole("menu")).toBeInTheDocument();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    // Focus must come back, or Escape silently loses the user's place in the
    // tab order.
    expect(trigger()).toHaveFocus();
  });

  it("closes when a pointer lands outside it", async () => {
    const user = userEvent.setup();
    renderMenu();

    await user.click(trigger());
    expect(screen.getByRole("menu")).toBeInTheDocument();

    await user.click(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("is reachable and operable by keyboard alone", async () => {
    const user = userEvent.setup();
    const logout = vi.fn(async () => {});
    renderMenu({ logout });

    await user.tab();
    expect(trigger()).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(screen.getByRole("menu")).toBeInTheDocument();

    await user.tab();
    await user.keyboard("{Enter}");
    expect(logout).toHaveBeenCalledTimes(1);
  });

  it("logout clears the session and navigates to /login", async () => {
    const user = userEvent.setup();
    const logout = vi.fn(async () => {});
    renderMenu({ logout });

    await user.click(trigger());
    await user.click(screen.getByRole("menuitem", { name: "Log out" }));

    expect(logout).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.getByTestId("path").textContent).toBe("/login"),
    );
  });

  it("still navigates to /login when the logout request failed", async () => {
    const user = userEvent.setup();
    // `AuthContext.logout` swallows a failed revoke and clears locally, so it
    // resolves either way — this asserts the menu does not add a failure path
    // of its own on top of that guarantee.
    const logout = vi.fn(async () => {});
    renderMenu({ logout });

    await user.click(trigger());
    await user.click(screen.getByRole("menuitem", { name: "Log out" }));

    await waitFor(() =>
      expect(screen.getByTestId("path").textContent).toBe("/login"),
    );
  });

  it("labels its controls and wires the menu to its trigger", async () => {
    const user = userEvent.setup();
    renderMenu();

    // The codebase's accessibility convention is structural assertions rather
    // than an axe pass — there is no axe dependency and adding one is outside
    // this issue.
    expect(trigger()).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger()).toHaveAccessibleName();

    await user.click(trigger());

    const menu = screen.getByRole("menu");
    expect(trigger()).toHaveAttribute("aria-controls", menu.id);
    expect(menu).toHaveAccessibleName("Account");
    expect(screen.getByRole("menuitem", { name: "Log out" })).toBeInTheDocument();
  });
});
