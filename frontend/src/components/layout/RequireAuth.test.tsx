import { screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderWithAuth } from "@/test/renderWithProviders";
import type { AuthStatus } from "@/hooks/useAuth";
import { RequireAuth } from "./RequireAuth";

const RETURN_TO_KEY = "liffy.return_to";

/**
 * A two-route tree — one guarded, one not — so a redirect is observable as a
 * change in what renders rather than by poking at router internals.
 */
function renderGuard(status: AuthStatus, route = "/reviews") {
  return renderWithAuth(
    <Routes>
      <Route element={<RequireAuth />}>
        <Route path="/reviews" element={<p>Guarded content</p>} />
        <Route path="/reviews/:id" element={<p>Guarded detail</p>} />
      </Route>
      <Route path="/login" element={<p>Login page</p>} />
    </Routes>,
    { route, auth: { status } },
  );
}

beforeEach(() => {
  window.sessionStorage.clear();
});

afterEach(() => {
  window.sessionStorage.clear();
});

describe("RequireAuth", () => {
  it("renders a splash while loading", () => {
    renderGuard("loading");

    expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();
    // The important half of this test: it must NOT redirect. Bouncing to
    // /login while the session is still rehydrating is exactly what makes the
    // login page flash on every refresh.
    expect(screen.queryByText("Login page")).not.toBeInTheDocument();
    expect(screen.queryByText("Guarded content")).not.toBeInTheDocument();
  });

  it("does not stash a return path while still loading", () => {
    renderGuard("loading");
    // Stashing here would overwrite a real destination with a page the user
    // was never actually refused.
    expect(window.sessionStorage.getItem(RETURN_TO_KEY)).toBeNull();
  });

  it("redirects to /login when anonymous", () => {
    renderGuard("anonymous");

    expect(screen.getByText("Login page")).toBeInTheDocument();
    expect(screen.queryByText("Guarded content")).not.toBeInTheDocument();
  });

  it("renders children when authenticated", () => {
    renderGuard("authenticated");

    expect(screen.getByText("Guarded content")).toBeInTheDocument();
    expect(screen.queryByText("Login page")).not.toBeInTheDocument();
  });

  it("stashes the attempted path for post-login return", () => {
    renderGuard("anonymous", "/reviews/abc");

    expect(window.sessionStorage.getItem(RETURN_TO_KEY)).toBe("/reviews/abc");
  });

  it("keeps the query string on the stashed path", () => {
    renderGuard("anonymous", "/reviews?offset=40");

    // Losing the query drops the user on page one of a list they had paged
    // into, which reads as the deep link having silently failed.
    expect(window.sessionStorage.getItem(RETURN_TO_KEY)).toBe("/reviews?offset=40");
  });

  it("keeps the fragment on the stashed path", () => {
    renderGuard("anonymous", "/reviews/abc#comment-5");

    // `ReviewComment` renders `id={commentAnchorId(comment.id)}`, so
    // `#comment-<id>` addresses a real element. A link to one specific
    // comment, pasted into Slack, is exactly the deep link this exists for.
    expect(window.sessionStorage.getItem(RETURN_TO_KEY)).toBe("/reviews/abc#comment-5");
  });

  it("keeps a query and a fragment together", () => {
    renderGuard("anonymous", "/reviews?offset=40#comment-5");

    expect(window.sessionStorage.getItem(RETURN_TO_KEY)).toBe(
      "/reviews?offset=40#comment-5",
    );
  });

  it("does not stash anything when authenticated", () => {
    renderGuard("authenticated", "/reviews/abc");
    expect(window.sessionStorage.getItem(RETURN_TO_KEY)).toBeNull();
  });
});
