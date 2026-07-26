import { act, renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { server } from "@/mocks/server";
import {
  fixtureRepoIndexed,
  fixtureRepoIndexing,
  fixtureReviewCompleted,
  fixtureReviewProcessing,
} from "@/mocks/fixtures";
import { createWrapper } from "@/test/renderWithProviders";
import { keys } from "./keys";
import { useRepos } from "./useRepos";
import { useRepoStatus } from "./useRepoStatus";
import { useReview } from "./useReview";
import { useReviews } from "./useReviews";
import { useConnectRepo, useDisconnectRepo } from "./useRepoMutations";
import { useTriggerReview } from "./useReviewMutations";

describe("useRepos", () => {
  it("returns the fixture repos", async () => {
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useRepos(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(2);
    expect(result.current.data?.[0].full_name).toBe("lucenity0/Liffy");
  });
});

describe("useReviews", () => {
  it("infers hasNextPage from a full page and hasPreviousPage from the offset", async () => {
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useReviews({ limit: 2, offset: 2 }), {
      wrapper: Wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // 4 fixtures, limit 2, offset 2 -> a full page, so there *may* be more.
    expect(result.current.data).toHaveLength(2);
    expect(result.current.hasNextPage).toBe(true);
    expect(result.current.hasPreviousPage).toBe(true);
  });

  it("reports no next page when the API returns a short page", async () => {
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useReviews({ limit: 20, offset: 0 }), {
      wrapper: Wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(4);
    expect(result.current.hasNextPage).toBe(false);
    expect(result.current.hasPreviousPage).toBe(false);
  });
});

describe("polling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Advances timers and lets the resulting promises settle inside act(). */
  const tick = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };

  it("useReview polls every 3s while processing, then stops on completed", async () => {
    let fetchCount = 0;
    server.use(
      http.get("*/reviews/:reviewId", () => {
        fetchCount += 1;
        // processing, processing, then completed
        return HttpResponse.json(
          fetchCount < 3
            ? { ...fixtureReviewProcessing, status: "processing" }
            : { ...fixtureReviewProcessing, status: "completed" },
        );
      }),
    );

    const { Wrapper } = createWrapper();
    renderHook(() => useReview(fixtureReviewProcessing.id), { wrapper: Wrapper });

    await tick(0);
    expect(fetchCount).toBe(1);

    await tick(3000);
    expect(fetchCount).toBe(2);

    await tick(3000);
    expect(fetchCount).toBe(3); // this response is `completed`

    // Well past two more intervals: the poll must be off, not merely slower.
    await tick(9000);
    expect(fetchCount).toBe(3);
  });

  it("useReview never polls a review that is already completed", async () => {
    let fetchCount = 0;
    server.use(
      http.get("*/reviews/:reviewId", () => {
        fetchCount += 1;
        return HttpResponse.json(fixtureReviewCompleted);
      }),
    );

    const { Wrapper } = createWrapper();
    renderHook(() => useReview(fixtureReviewCompleted.id), { wrapper: Wrapper });

    await tick(0);
    expect(fetchCount).toBe(1);

    await tick(15000);
    expect(fetchCount).toBe(1);
  });

  it("useRepoStatus polls every 5s while not_indexed, then stops once indexed", async () => {
    let fetchCount = 0;
    server.use(
      http.get("*/repos/:repoId/status", () => {
        fetchCount += 1;
        return HttpResponse.json({
          id: fixtureRepoIndexing.id,
          full_name: fixtureRepoIndexing.full_name,
          status: fetchCount < 2 ? "not_indexed" : "indexed",
          indexed_at: fetchCount < 2 ? null : "2026-07-26T10:00:00Z",
          chunk_count: fetchCount < 2 ? 0 : 88,
        });
      }),
    );

    const { Wrapper } = createWrapper();
    renderHook(() => useRepoStatus(fixtureRepoIndexing.id), { wrapper: Wrapper });

    await tick(0);
    expect(fetchCount).toBe(1);

    await tick(5000);
    expect(fetchCount).toBe(2); // now indexed

    await tick(15000);
    expect(fetchCount).toBe(2);
  });

  it("useRepoStatus does not fetch at all when disabled", async () => {
    let fetchCount = 0;
    server.use(
      http.get("*/repos/:repoId/status", () => {
        fetchCount += 1;
        return HttpResponse.json({
          id: fixtureRepoIndexed.id,
          full_name: fixtureRepoIndexed.full_name,
          status: "indexed",
          indexed_at: "2026-07-20T10:00:00Z",
          chunk_count: 176,
        });
      }),
    );

    const { Wrapper } = createWrapper();
    renderHook(() => useRepoStatus(fixtureRepoIndexed.id, { enabled: false }), {
      wrapper: Wrapper,
    });

    await tick(10000);
    expect(fetchCount).toBe(0);
  });
});

describe("mutations", () => {
  it("useConnectRepo invalidates the repos tree on success", async () => {
    const { Wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useConnectRepo(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.mutateAsync("owner/name");
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: keys.repos.all });
  });

  it("useConnectRepo surfaces a 503 as an error without retrying", async () => {
    let attempts = 0;
    server.use(
      http.post("*/repos", () => {
        attempts += 1;
        return HttpResponse.json({ detail: "no token" }, { status: 503 });
      }),
    );

    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useConnectRepo(), { wrapper: Wrapper });

    await act(async () => {
      await result.current.mutateAsync("no-token/repo").catch(() => {});
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    // Mutations do not retry by default — one attempt, no storm.
    expect(attempts).toBe(1);
  });

  it("useDisconnectRepo drops the dead repo's status query instead of refetching it", async () => {
    const { Wrapper, queryClient } = createWrapper();
    const removeSpy = vi.spyOn(queryClient, "removeQueries");

    const { result } = renderHook(() => useDisconnectRepo(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.mutateAsync(fixtureRepoIndexed.id);
    });

    expect(removeSpy).toHaveBeenCalledWith({
      queryKey: keys.repos.status(fixtureRepoIndexed.id),
    });
  });

  it("useTriggerReview invalidates the reviews tree", async () => {
    const { Wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useTriggerReview(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.mutateAsync({
        owner: "lucenity0",
        repo: "Liffy",
        pr_number: 58,
      });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: keys.reviews.all });
  });
});
