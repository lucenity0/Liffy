import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { server } from "@/mocks/server";
import { fixtureUser } from "@/mocks/fixtures";
import { clearTokens, endSession, getAccessToken, setTokens } from "@/lib/tokenStore";
import { AuthProvider } from "./AuthContext";
import { useAuth } from "@/hooks/useAuth";

const SEEDED = { access_token: "seeded-access", refresh_token: "seeded-refresh" };

/**
 * Surfaces the whole context as text so each assertion reads the real value
 * rather than a component's interpretation of it.
 */
function Probe() {
  const { user, status, logout } = useAuth();
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="user">{user?.username ?? "none"}</span>
      <button onClick={() => void logout()}>Log out</button>
    </div>
  );
}

const status = () => screen.getByTestId("status").textContent;
const username = () => screen.getByTestId("user").textContent;

function renderProvider() {
  return render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
}

beforeEach(() => {
  clearTokens();
});

afterEach(() => {
  clearTokens();
});

describe("AuthProvider", () => {
  it("starts in loading state", () => {
    setTokens(SEEDED);
    // Deliberately not awaited: the assertion is about the first paint,
    // before /auth/me has had a chance to resolve.
    renderProvider();
    expect(status()).toBe("loading");
  });

  it("resolves to anonymous when no token is stored", async () => {
    renderProvider();
    await waitFor(() => expect(status()).toBe("anonymous"));
    expect(username()).toBe("none");
  });

  it("rehydrates the user from /auth/me when a token exists", async () => {
    setTokens(SEEDED);
    renderProvider();

    await waitFor(() => expect(status()).toBe("authenticated"));
    expect(username()).toBe(fixtureUser.username);
  });

  it("resolves to anonymous when /auth/me returns 401", async () => {
    setTokens(SEEDED);
    server.use(
      http.get("*/auth/me", () =>
        HttpResponse.json({ detail: "Not authenticated" }, { status: 401 }),
      ),
      // The interceptor will try to refresh first; deny that too, so the
      // session is genuinely unrecoverable rather than merely stale.
      http.post("*/auth/refresh", () =>
        HttpResponse.json({ detail: "Revoked" }, { status: 401 }),
      ),
    );

    renderProvider();

    await waitFor(() => expect(status()).toBe("anonymous"));
    expect(username()).toBe("none");
    // Tokens that cannot buy a /auth/me are dropped rather than left to fail
    // every subsequent request.
    expect(getAccessToken()).toBeNull();
  });

  it("flips to anonymous when the session-ended callback fires", async () => {
    setTokens(SEEDED);
    renderProvider();
    await waitFor(() => expect(status()).toBe("authenticated"));

    // What the HTTP layer does when a refresh fails mid-flight.
    endSession();

    await waitFor(() => expect(status()).toBe("anonymous"));
    expect(username()).toBe("none");
  });
});

describe("logout", () => {
  it("revokes server-side and clears the local session", async () => {
    setTokens(SEEDED);
    let revoked: unknown;
    server.use(
      http.post("*/auth/logout", async ({ request }) => {
        revoked = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );

    renderProvider();
    await waitFor(() => expect(status()).toBe("authenticated"));

    await userEvent.click(screen.getByRole("button", { name: "Log out" }));

    await waitFor(() => expect(status()).toBe("anonymous"));
    expect(revoked).toEqual({ refresh_token: SEEDED.refresh_token });
    expect(getAccessToken()).toBeNull();
  });

  it("still clears the local session when the logout request fails", async () => {
    setTokens(SEEDED);
    server.use(
      http.post("*/auth/logout", () =>
        HttpResponse.json({ detail: "boom" }, { status: 500 }),
      ),
    );

    renderProvider();
    await waitFor(() => expect(status()).toBe("authenticated"));

    await userEvent.click(screen.getByRole("button", { name: "Log out" }));

    // A user who clicks Log out ends up logged out regardless of whether the
    // server was reachable.
    await waitFor(() => expect(status()).toBe("anonymous"));
    expect(getAccessToken()).toBeNull();
  });
});

describe("useAuth", () => {
  it("throws outside a provider rather than handing back a silent null", () => {
    // React logs the thrown error; silence it so the run stays readable.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/within an <AuthProvider>/);
    spy.mockRestore();
  });
});
