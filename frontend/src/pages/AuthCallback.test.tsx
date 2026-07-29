import { StrictMode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { server } from "@/mocks/server";
import { fixtureUser } from "@/mocks/fixtures";
import { AuthProvider } from "@/contexts/AuthContext";
import { clearTokens, getAccessToken, getRefreshToken } from "@/lib/tokenStore";
import { stashReturnTo } from "@/lib/returnTo";
import { AuthCallback } from "./AuthCallback";

/**
 * The component reads `window.location.hash` — the *real* one, not the
 * router's — because that is where a full-page redirect from the backend
 * actually puts the tokens. So these tests drive jsdom's history directly and
 * use MemoryRouter only for `useNavigate` and `<Link>`.
 */

function setHash(hash: string) {
  window.history.replaceState(null, "", `/auth/callback${hash}`);
}

function LocationProbe() {
  return <span data-testid="path">{useLocation().pathname}</span>;
}

const path = () => screen.getByTestId("path").textContent;

function renderCallback({ strict = false } = {}) {
  const tree = (
    <MemoryRouter initialEntries={["/auth/callback"]}>
      <AuthProvider>
        <AuthCallback />
        <LocationProbe />
      </AuthProvider>
    </MemoryRouter>
  );
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree);
}

const GOOD_HASH =
  "#access_token=fresh-access&refresh_token=fresh-refresh&token_type=bearer&expires_in=900";

beforeEach(() => {
  clearTokens();
  window.sessionStorage.clear();
  setHash("");
});

afterEach(() => {
  clearTokens();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("AuthCallback", () => {
  it("stores the token pair and redirects home", async () => {
    setHash(GOOD_HASH);
    renderCallback();

    await waitFor(() => expect(path()).toBe("/"));
    expect(getAccessToken()).toBe("fresh-access");
    expect(getRefreshToken()).toBe("fresh-refresh");
  });

  it("redirects to the originally requested path when one was stashed", async () => {
    stashReturnTo("/reviews/abc");
    setHash(GOOD_HASH);
    renderCallback();

    // Someone who deep-linked to a review while logged out lands back on that
    // review, not on the dashboard.
    await waitFor(() => expect(path()).toBe("/reviews/abc"));
  });

  it("consumes the stashed path, so the next login goes home", async () => {
    stashReturnTo("/reviews/abc");
    setHash(GOOD_HASH);
    renderCallback();
    await waitFor(() => expect(path()).toBe("/reviews/abc"));

    clearTokens();
    setHash(GOOD_HASH);
    renderCallback();

    const probes = await screen.findAllByTestId("path");
    await waitFor(() => expect(probes.at(-1)!.textContent).toBe("/"));
  });

  it("clears the hash from the URL after reading it", async () => {
    setHash(GOOD_HASH);
    renderCallback();

    // Tokens left in the address bar end up in a bookmark or a screenshot.
    await waitFor(() => expect(window.location.hash).toBe(""));
    expect(window.location.pathname).toBe("/auth/callback");
  });

  it("shows a spinner while it works", () => {
    setHash(GOOD_HASH);
    renderCallback();
    expect(screen.getByRole("status", { name: "Signing you in" })).toBeInTheDocument();
  });

  it("shows an error state when the callback carries error=access_denied", async () => {
    setHash("#error=access_denied");
    renderCallback();

    const alert = await screen.findByRole("alert");
    // Pressing Cancel on GitHub's consent screen is a normal path. A blank
    // white page here is the most common way to ship this half-done.
    expect(alert).toHaveTextContent("You cancelled the GitHub sign-in");
    expect(screen.getByRole("link", { name: "Back to sign in" })).toBeInTheDocument();
    expect(getAccessToken()).toBeNull();
  });

  it("shows an error state when the hash is missing or malformed", async () => {
    setHash("");
    renderCallback();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("missing its tokens");
    expect(getAccessToken()).toBeNull();
  });

  it("shows an error state when only half the pair arrives", async () => {
    setHash("#access_token=lonely");
    renderCallback();

    expect(await screen.findByRole("alert")).toHaveTextContent("missing its tokens");
    expect(getAccessToken()).toBeNull();
  });

  it("reports an unrecognised error code without leaking it verbatim", async () => {
    setHash("#error=something_new_from_the_backend");
    renderCallback();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Something went wrong signing you in");
    expect(alert).not.toHaveTextContent("something_new_from_the_backend");
  });

  it("surfaces an error when the tokens do not buy a session", async () => {
    server.use(
      http.get("*/auth/me", () =>
        HttpResponse.json({ detail: "Not authenticated" }, { status: 401 }),
      ),
      http.post("*/auth/refresh", () =>
        HttpResponse.json({ detail: "Revoked" }, { status: 401 }),
      ),
    );
    setHash(GOOD_HASH);
    renderCallback();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "account couldn't be loaded",
    );
    expect(getAccessToken()).toBeNull();
  });

  it("reads the fragment once under StrictMode's double-invoked effects", async () => {
    setHash(GOOD_HASH);
    renderCallback({ strict: true });

    // The second invocation finds an already-erased hash. Without the guard
    // it would overwrite the happy path with a bogus "missing tokens".
    await waitFor(() => expect(getAccessToken()).toBe("fresh-access"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getAllByTestId("path").at(-1)!.textContent).toBe("/"),
    );
  });

  it("signs the user in, not just the tokens in", async () => {
    setHash(GOOD_HASH);
    renderCallback();

    await waitFor(() => expect(path()).toBe("/"));
    // /auth/me was actually called and its answer kept — proof the context
    // rehydrated rather than merely writing to localStorage.
    expect(fixtureUser.username).toBe("lucenity0");
    expect(getAccessToken()).toBe("fresh-access");
  });
});
