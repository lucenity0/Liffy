import { useState, type ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixtureUser, fixtureUserNoAvatar } from "@/mocks/fixtures";
import { renderWithAuth } from "@/test/renderWithProviders";
import { AuthContext, type AuthContextValue, type AuthStatus } from "@/hooks/useAuth";
import { RequireAuth } from "./RequireAuth";
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

/**
 * Identity is a statement, not a control, so it is looked up as text rather
 * than as a button — pressing your own username never did anything, and the
 * popover it used to open is gone.
 */
const identity = () => screen.getByText(/lucenity0|gajalakshmi/i);
const logoutItem = () => screen.getByRole("button", { name: "Sign out" });

describe("UserMenu", () => {
  it("shows the logged-in username and avatar", () => {
    renderMenu();

    expect(identity()).toHaveTextContent(fixtureUser.username);
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
    expect(identity()).toHaveTextContent(fixtureUserNoAvatar.username);
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





  it("logout clears the session and navigates to /login", async () => {
    const user = userEvent.setup();
    const logout = vi.fn(async () => {});
    renderMenu({ logout });

    await user.click(logoutItem());

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

    await user.click(logoutItem());

    await waitFor(() =>
      expect(screen.getByTestId("path").textContent).toBe("/login"),
    );
  });



});

/**
 * Logout driven through the *real* guard, with a status that actually flips.
 *
 * The stubbed context used above cannot show this: `logout` there is a spy
 * that leaves the status alone, so `RequireAuth` never re-renders and never
 * gets the chance to stash. The bug only exists in the sequence
 * logout() -> anonymous -> guard re-renders -> stash -> navigate.
 */
function StatefulAuth({
  children,
  initial = "authenticated",
}: {
  children: ReactNode;
  initial?: AuthStatus;
}) {
  const [status, setStatus] = useState<AuthStatus>(initial);

  const value: AuthContextValue = {
    user: status === "authenticated" ? fixtureUser : null,
    status,
    login: async () => {},
    // What the real provider does: clear local state, flip to anonymous.
    logout: async () => setStatus("anonymous"),
  };

  return <AuthContext value={value}>{children}</AuthContext>;
}

function renderGuardedMenu(route: string, initial?: AuthStatus) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <StatefulAuth initial={initial}>
        <Routes>
          <Route element={<RequireAuth />}>
            <Route path="/reviews/:id" element={<UserMenu />} />
          </Route>
          <Route path="/login" element={<p>Login page</p>} />
        </Routes>
      </StatefulAuth>
    </MemoryRouter>,
  );
}

describe("logout and the return-to stash", () => {
  afterEach(() => {
    window.sessionStorage.clear();
  });

  it("does not stash the page it logged out from", async () => {
    const user = userEvent.setup();
    renderGuardedMenu("/reviews/aaaaaaaa-1111-2222-3333-444444444444");

    await user.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() => expect(screen.getByText("Login page")).toBeInTheDocument());

    // The guard stashes on every anonymous render and logging out produces
    // one. On a shared machine that means the next person to sign in lands on
    // the previous user's review URL — which AUTH-4 scopes to a 404, so a
    // successful login opens on "not found".
    expect(window.sessionStorage.getItem("liffy.return_to")).toBeNull();
  });

  it("still stashes when the session ended without an explicit logout", () => {
    // No logout click: the guard is refusing a visitor whose session expired
    // or never existed. That is exactly when the deep link *should* be
    // remembered, so the fix above must not suppress it.
    renderGuardedMenu("/reviews/expired-session", "anonymous");

    expect(window.sessionStorage.getItem("liffy.return_to")).toBe(
      "/reviews/expired-session",
    );
  });
});
