import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { delay, http, HttpResponse } from "msw";
import { server } from "@/mocks/server";
import {
  fixtureRepos,
  fixtureTokenPair,
  fixtureUser,
  reviewPage,
} from "@/mocks/fixtures";
import {
  clearTokens,
  getAccessToken,
  getRefreshToken,
  onSessionEnded,
  setTokens,
} from "@/lib/tokenStore";
import { getCurrentUser, logoutRequest, refreshTokens } from "./auth";
import { listRepos } from "./repos";
import { listReviews } from "./reviews";
import { getRepoStatus } from "./repos";
import { normalizeApiError } from "@/lib/errors";

/**
 * The interceptors in `api/client.ts` hold module-level state (the in-flight
 * refresh promise) and read module-level state (`tokenStore`). Both survive
 * between tests in the same file, so every test starts from a known-empty
 * store and every `onSessionEnded` subscription is torn down.
 */

const SEEDED = { access_token: "seeded-access", refresh_token: "seeded-refresh" };

let unsubscribers: Array<() => void> = [];

function trackSessionEnd() {
  const spy = vi.fn();
  unsubscribers.push(onSessionEnded(spy));
  return spy;
}

beforeEach(() => {
  clearTokens();
});

afterEach(() => {
  unsubscribers.forEach((off) => off());
  unsubscribers = [];
  clearTokens();
});

describe("request interceptor", () => {
  it("attaches bearer token when present", async () => {
    setTokens(SEEDED);
    let seen: string | null = null;
    server.use(
      http.get("*/repos", ({ request }) => {
        seen = request.headers.get("Authorization");
        return HttpResponse.json(fixtureRepos);
      }),
    );

    await listRepos();
    expect(seen).toBe(`Bearer ${SEEDED.access_token}`);
  });

  it("omits authorization header when no token", async () => {
    let seen: string | null = "not-read-yet";
    server.use(
      http.get("*/repos", ({ request }) => {
        seen = request.headers.get("Authorization");
        return HttpResponse.json(fixtureRepos);
      }),
    );

    await listRepos();
    expect(seen).toBeNull();
  });
});

describe("refresh on 401", () => {
  it("refreshes once and retries the original request on 401", async () => {
    setTokens(SEEDED);
    let refreshCalls = 0;
    let refreshed = false;
    const bearersSeen: Array<string | null> = [];

    server.use(
      http.get("*/repos", ({ request }) => {
        bearersSeen.push(request.headers.get("Authorization"));
        if (!refreshed) {
          return HttpResponse.json({ detail: "Token expired" }, { status: 401 });
        }
        return HttpResponse.json(fixtureRepos);
      }),
      http.post("*/auth/refresh", () => {
        refreshCalls += 1;
        refreshed = true;
        return HttpResponse.json(fixtureTokenPair);
      }),
    );

    const repos = await listRepos();

    expect(repos).toHaveLength(2);
    expect(refreshCalls).toBe(1);
    // The retry must carry the *new* token, not the expired one.
    expect(bearersSeen).toEqual([
      `Bearer ${SEEDED.access_token}`,
      `Bearer ${fixtureTokenPair.access_token}`,
    ]);
    // And the rotated pair is what is now stored.
    expect(getAccessToken()).toBe(fixtureTokenPair.access_token);
    expect(getRefreshToken()).toBe(fixtureTokenPair.refresh_token);
  });

  /**
   * The test this whole issue exists for.
   *
   * Refresh tokens rotate and revoke on use, so a second concurrent refresh
   * would replay a dead token and 401 — logging the user out via the
   * mechanism meant to keep them in. Three requests, one refresh.
   */
  it("concurrent 401s trigger exactly one refresh call", async () => {
    setTokens(SEEDED);
    let refreshCalls = 0;
    let refreshed = false;

    const guard = () =>
      refreshed
        ? null
        : HttpResponse.json({ detail: "Token expired" }, { status: 401 });

    server.use(
      http.get("*/repos", () => guard() ?? HttpResponse.json(fixtureRepos)),
      http.get("*/reviews", () => guard() ?? HttpResponse.json(reviewPage([]))),
      http.get(
        "*/repos/:repoId/status",
        () =>
          guard() ??
          HttpResponse.json({
            id: "11111111-1111-1111-1111-111111111111",
            full_name: "lucenity0/Liffy",
            status: "indexed",
            indexed_at: "2026-07-20T10:00:00Z",
            chunk_count: 176,
          }),
      ),
      http.post("*/auth/refresh", async () => {
        refreshCalls += 1;
        // A real refresh is a round trip. The delay holds the window open so
        // the other two 401s land while this one is still in flight — which
        // is exactly the race the single-flight queue exists to close.
        await delay(20);
        refreshed = true;
        return HttpResponse.json(fixtureTokenPair);
      }),
    );

    const [repos, reviews, status] = await Promise.all([
      listRepos(),
      listReviews(),
      getRepoStatus("11111111-1111-1111-1111-111111111111"),
    ]);

    expect(refreshCalls).toBe(1);
    // All three original requests still resolve — none was sacrificed.
    expect(repos).toHaveLength(2);
    expect(reviews.items).toEqual([]);
    expect(status.chunk_count).toBe(176);
  });

  it("clears tokens and signals logout when refresh fails", async () => {
    setTokens(SEEDED);
    const onEnd = trackSessionEnd();

    server.use(
      http.get("*/repos", () =>
        HttpResponse.json({ detail: "Token expired" }, { status: 401 }),
      ),
      http.post("*/auth/refresh", () =>
        HttpResponse.json({ detail: "Refresh token revoked" }, { status: 401 }),
      ),
    );

    await expect(listRepos()).rejects.toSatisfy((err: unknown) => {
      // The caller sees the *original* 401, not the refresh failure.
      const normalized = normalizeApiError(err);
      return normalized.status === 401 && normalized.detail === "Token expired";
    });

    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(getAccessToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
  });

  it("notifies session-ended listeners once, not once per failed request", async () => {
    setTokens(SEEDED);
    const onEnd = trackSessionEnd();

    server.use(
      http.get("*/repos", () =>
        HttpResponse.json({ detail: "Token expired" }, { status: 401 }),
      ),
      http.get("*/reviews", () =>
        HttpResponse.json({ detail: "Token expired" }, { status: 401 }),
      ),
      http.get("*/repos/:repoId/status", () =>
        HttpResponse.json({ detail: "Token expired" }, { status: 401 }),
      ),
      http.post("*/auth/refresh", async () => {
        await delay(20);
        return HttpResponse.json({ detail: "Refresh token revoked" }, { status: 401 });
      }),
    );

    await Promise.allSettled([
      listRepos(),
      listReviews(),
      getRepoStatus("11111111-1111-1111-1111-111111111111"),
    ]);

    // Three requests share one failing refresh, so all three reach the
    // give-up path. Storage is idempotent, but a listener that redirects or
    // raises a toast is not — three redirects on one expiry.
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("notifies again after a new session is established", async () => {
    setTokens(SEEDED);
    const onEnd = trackSessionEnd();

    server.use(
      http.get("*/repos", () =>
        HttpResponse.json({ detail: "Token expired" }, { status: 401 }),
      ),
      http.post("*/auth/refresh", () =>
        HttpResponse.json({ detail: "Revoked" }, { status: 401 }),
      ),
    );

    await expect(listRepos()).rejects.toThrow();
    expect(onEnd).toHaveBeenCalledTimes(1);

    // Logging in again must re-arm the notification, or a second expiry in
    // the same tab would go unannounced and the UI would never log out.
    setTokens({ access_token: "second-access", refresh_token: "second-refresh" });

    await expect(listRepos()).rejects.toThrow();
    expect(onEnd).toHaveBeenCalledTimes(2);
  });

  it("does not retry a request that already retried", async () => {
    setTokens(SEEDED);
    const onEnd = trackSessionEnd();
    let repoCalls = 0;
    let refreshCalls = 0;

    server.use(
      // Never satisfied, even with a brand-new token: the account is gone,
      // not the token expired. A naive interceptor loops here forever.
      http.get("*/repos", () => {
        repoCalls += 1;
        return HttpResponse.json({ detail: "Not authenticated" }, { status: 401 });
      }),
      http.post("*/auth/refresh", () => {
        refreshCalls += 1;
        return HttpResponse.json(fixtureTokenPair);
      }),
    );

    await expect(listRepos()).rejects.toSatisfy(
      (err: unknown) => normalizeApiError(err).status === 401,
    );

    // Original + exactly one retry. Anything higher is the infinite loop.
    expect(repoCalls).toBe(2);
    expect(refreshCalls).toBe(1);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(getAccessToken()).toBeNull();
  });

  it("does not attempt refresh for a 401 on /auth/refresh itself", async () => {
    setTokens(SEEDED);
    let refreshCalls = 0;

    server.use(
      http.post("*/auth/refresh", () => {
        refreshCalls += 1;
        return HttpResponse.json({ detail: "Refresh token revoked" }, { status: 401 });
      }),
    );

    await expect(refreshTokens("dead-token")).rejects.toSatisfy(
      (err: unknown) => normalizeApiError(err).status === 401,
    );

    // One call: the direct one. A refresh that recursed would show more.
    expect(refreshCalls).toBe(1);
  });

  it("passes through non-401 errors untouched", async () => {
    setTokens(SEEDED);
    let refreshCalls = 0;

    server.use(
      http.get("*/repos", () =>
        HttpResponse.json({ detail: "Database is on fire" }, { status: 500 }),
      ),
      http.post("*/auth/refresh", () => {
        refreshCalls += 1;
        return HttpResponse.json(fixtureTokenPair);
      }),
    );

    await expect(listRepos()).rejects.toSatisfy(
      (err: unknown) => normalizeApiError(err).status === 500,
    );

    expect(refreshCalls).toBe(0);
    // A 500 is not a session problem — the tokens stay put.
    expect(getAccessToken()).toBe(SEEDED.access_token);
  });

  it("does not refresh or end the session for an anonymous 401", async () => {
    const onEnd = trackSessionEnd();
    let refreshCalls = 0;

    server.use(
      http.get("*/repos", () =>
        HttpResponse.json({ detail: "Not authenticated" }, { status: 401 }),
      ),
      http.post("*/auth/refresh", () => {
        refreshCalls += 1;
        return HttpResponse.json(fixtureTokenPair);
      }),
    );

    await expect(listRepos()).rejects.toSatisfy(
      (err: unknown) => normalizeApiError(err).status === 401,
    );

    expect(refreshCalls).toBe(0);
    // Nothing to broadcast: there was never a session to end.
    expect(onEnd).not.toHaveBeenCalled();
  });
});

describe("auth endpoint wrappers", () => {
  it("getCurrentUser returns the typed user", async () => {
    setTokens(SEEDED);
    const user = await getCurrentUser();
    expect(user).toMatchObject({ username: fixtureUser.username });
  });

  it("refreshTokens sends {refresh_token} and returns the rotated pair", async () => {
    let body: unknown;
    server.use(
      http.post("*/auth/refresh", async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(fixtureTokenPair);
      }),
    );

    const pair = await refreshTokens("seeded-refresh");
    expect(body).toEqual({ refresh_token: "seeded-refresh" });
    expect(pair.access_token).toBe(fixtureTokenPair.access_token);
  });

  it("logoutRequest sends {refresh_token} and tolerates a 204", async () => {
    let body: unknown;
    server.use(
      http.post("*/auth/logout", async ({ request }) => {
        body = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await expect(logoutRequest("seeded-refresh")).resolves.toBeUndefined();
    expect(body).toEqual({ refresh_token: "seeded-refresh" });
  });
});
