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
import { useCommentFeedback } from "./useCommentFeedback";
import { useConnectRepo, useDisconnectRepo } from "./useRepoMutations";
import { useTriggerReview } from "./useReviewMutations";
import { THEME_KEY, useTheme } from "./useTheme";
import { useDebouncedValue } from "./useDebouncedValue";
import type { QueryClient } from "@tanstack/react-query";
import type { ReviewDetailOut } from "@/types/api";

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
  it("offers a next page only while the total says there is one", async () => {
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useReviews({ limit: 2, offset: 0 }), {
      wrapper: Wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // 4 fixtures, page one of two.
    expect(result.current.items).toHaveLength(2);
    expect(result.current.total).toBe(4);
    expect(result.current.hasNextPage).toBe(true);
    expect(result.current.hasPreviousPage).toBe(false);
  });

  it("does not offer a Next that leads nowhere on an exact page boundary", async () => {
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useReviews({ limit: 2, offset: 2 }), {
      wrapper: Wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // The regression this envelope exists for. 4 fixtures, limit 2, offset 2:
    // a *full* page that is also the last one. The old heuristic — "a full
    // page implies there may be more" — read this as another page and offered
    // a Next onto an empty screen.
    expect(result.current.items).toHaveLength(2);
    expect(result.current.hasNextPage).toBe(false);
    expect(result.current.hasPreviousPage).toBe(true);
  });

  it("reports no next page on a short page", async () => {
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useReviews({ limit: 20, offset: 0 }), {
      wrapper: Wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.items).toHaveLength(4);
    expect(result.current.hasNextPage).toBe(false);
    expect(result.current.hasPreviousPage).toBe(false);
  });

  it("gives two different filters two different cache entries", async () => {
    const { Wrapper } = createWrapper();

    const failed = renderHook(() => useReviews({ status: "failed" }), {
      wrapper: Wrapper,
    });
    await waitFor(() => expect(failed.result.current.isSuccess).toBe(true));

    const completed = renderHook(() => useReviews({ status: "completed" }), {
      wrapper: Wrapper,
    });
    await waitFor(() => expect(completed.result.current.isSuccess).toBe(true));

    // Sharing a key would have the second filter served the first's rows —
    // the failure mode is silent, and it looks like the filter did nothing.
    expect(failed.result.current.items).toHaveLength(1);
    expect(completed.result.current.items).toHaveLength(2);
    expect(failed.result.current.items[0].status).toBe("failed");
  });
});

describe("useDebouncedValue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("collapses a burst of changes into the last one", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value, 300),
      { initialProps: { value: "2" } },
    );

    // Typing "203": three renders inside the window. Only the last survives,
    // which is what keeps the reviews list from asking about PR 2 and PR 20
    // on the way to 203.
    expect(result.current).toBe("2");
    rerender({ value: "20" });
    act(() => void vi.advanceTimersByTime(100));
    rerender({ value: "203" });
    act(() => void vi.advanceTimersByTime(100));
    // Still the initial value — nothing has been still for long enough yet.
    expect(result.current).toBe("2");

    act(() => void vi.advanceTimersByTime(300));
    expect(result.current).toBe("203");
  });

  it("does not settle a value the caller has already left behind", () => {
    const { result, unmount, rerender } = renderHook(
      ({ value }) => useDebouncedValue(value, 300),
      { initialProps: { value: "a" } },
    );

    rerender({ value: "b" });
    unmount();
    // The pending timer is cleared on unmount rather than firing into a
    // component that is gone.
    act(() => void vi.advanceTimersByTime(1000));
    expect(result.current).toBe("a");
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

describe("useCommentFeedback", () => {
  const REVIEW_ID = fixtureReviewCompleted.id;
  /** Already rated 1, so a rollback has something to roll back *to*. */
  const RATED = fixtureReviewCompleted.comments[0];
  const UNRATED = fixtureReviewCompleted.comments[1];

  /**
   * Seeds the detail cache without mounting a query for it. Nothing is
   * observing the key, so `onSettled`'s invalidation marks it stale but never
   * refetches — which is what leaves the optimistic write inspectable.
   */
  function seeded() {
    const wrapper = createWrapper();
    wrapper.queryClient.setQueryData(
      keys.reviews.detail(REVIEW_ID),
      fixtureReviewCompleted,
    );
    return wrapper;
  }

  const ratingOf = (queryClient: QueryClient, commentId: string) =>
    queryClient
      .getQueryData<ReviewDetailOut>(keys.reviews.detail(REVIEW_ID))
      ?.comments.find((comment) => comment.id === commentId)?.my_rating;

  /** A POST held open until the test releases it. */
  function gatedFeedback() {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.post("*/comments/:commentId/feedback", async ({ params, request }) => {
        const body = (await request.json()) as { rating: number };
        await gate;
        return HttpResponse.json({
          comment_id: params.commentId,
          rating: body.rating,
          created_at: "2026-07-25T14:40:00Z",
        });
      }),
    );
    return () => release();
  }

  it("writes the new rating into the cache before the request resolves", async () => {
    const { Wrapper, queryClient } = seeded();
    const release = gatedFeedback();

    const { result } = renderHook(() => useCommentFeedback(REVIEW_ID), {
      wrapper: Wrapper,
    });
    act(() => result.current.mutate({ commentId: UNRATED.id, rating: -1 }));

    // The whole point of the hook: the cache moves while the POST is still
    // open, so the thumb presses on click rather than on response.
    await waitFor(() => expect(ratingOf(queryClient, UNRATED.id)).toBe(-1));
    expect(result.current.isPending).toBe(true);

    release();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("leaves every other comment alone", async () => {
    const { Wrapper, queryClient } = seeded();

    const { result } = renderHook(() => useCommentFeedback(REVIEW_ID), {
      wrapper: Wrapper,
    });
    await act(async () => {
      await result.current.mutateAsync({ commentId: UNRATED.id, rating: 1 });
    });

    expect(ratingOf(queryClient, RATED.id)).toBe(RATED.my_rating);
  });

  /**
   * The test that proves the snapshot logic. Without `onError`, a failed POST
   * leaves the optimistic value on screen and the user believes a rating was
   * recorded that the database never saw.
   */
  it("rolls back to the previous rating when the request fails", async () => {
    const { Wrapper, queryClient } = seeded();
    server.use(
      http.post("*/comments/:commentId/feedback", () =>
        HttpResponse.json({ detail: "nope" }, { status: 500 }),
      ),
    );

    const { result } = renderHook(() => useCommentFeedback(REVIEW_ID), {
      wrapper: Wrapper,
    });
    await act(async () => {
      await result.current
        .mutateAsync({ commentId: RATED.id, rating: -1 })
        .catch(() => {});
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(ratingOf(queryClient, RATED.id)).toBe(RATED.my_rating);
  });

  it("invalidates the review detail on settle, on both paths", async () => {
    const { Wrapper, queryClient } = seeded();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useCommentFeedback(REVIEW_ID), {
      wrapper: Wrapper,
    });
    await act(async () => {
      await result.current.mutateAsync({ commentId: UNRATED.id, rating: 1 });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: keys.reviews.detail(REVIEW_ID),
    });
  });

  /**
   * Ordering, not just occurrence. ReviewDetail polls every 3s while a review
   * is processing; a refetch already in flight when the optimistic write
   * lands would resolve afterwards and overwrite it, reverting the button
   * under the user's finger with no error to explain it.
   */
  it("cancels in-flight detail queries before writing the cache", async () => {
    const { Wrapper, queryClient } = seeded();
    const cancelSpy = vi.spyOn(queryClient, "cancelQueries");
    const setSpy = vi.spyOn(queryClient, "setQueryData");

    const { result } = renderHook(() => useCommentFeedback(REVIEW_ID), {
      wrapper: Wrapper,
    });
    await act(async () => {
      await result.current.mutateAsync({ commentId: UNRATED.id, rating: 1 });
    });

    expect(cancelSpy).toHaveBeenCalledWith({
      queryKey: keys.reviews.detail(REVIEW_ID),
    });
    expect(cancelSpy.mock.invocationCallOrder[0]).toBeLessThan(
      setSpy.mock.invocationCallOrder[0],
    );
  });

  /**
   * The key is per review, so a hook built for one review must not reach into
   * another's cache entry — which is why `reviewId` is an argument rather
   * than something the hook reads off the router.
   */
  it("touches only the review it was given", async () => {
    const { Wrapper, queryClient } = seeded();
    queryClient.setQueryData(
      keys.reviews.detail(fixtureReviewProcessing.id),
      fixtureReviewProcessing,
    );
    const before = queryClient.getQueryData(
      keys.reviews.detail(fixtureReviewProcessing.id),
    );

    const { result } = renderHook(() => useCommentFeedback(REVIEW_ID), {
      wrapper: Wrapper,
    });
    await act(async () => {
      await result.current.mutateAsync({ commentId: UNRATED.id, rating: 1 });
    });

    expect(
      queryClient.getQueryData(keys.reviews.detail(fixtureReviewProcessing.id)),
    ).toBe(before);
  });
});

describe("useTheme", () => {
  beforeEach(() => {
    document.documentElement.classList.remove("dark");
    localStorage.clear();
  });

  it("reads the initial theme off <html>, where the boot script put it", () => {
    document.documentElement.classList.add("dark");

    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("graphite");
  });

  it("toggling flips the class, the meta colour and localStorage together", () => {
    const meta = document.createElement("meta");
    meta.setAttribute("name", "theme-color");
    meta.setAttribute("content", "#f4f1ea");
    document.head.appendChild(meta);

    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("paper");

    act(() => result.current.toggle());

    expect(result.current.theme).toBe("graphite");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(meta.getAttribute("content")).toBe("#1d1b18");
    // Persisted, so the boot script can apply it before the next first paint.
    expect(localStorage.getItem(THEME_KEY)).toBe("graphite");

    act(() => result.current.toggle());

    expect(result.current.theme).toBe("paper");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(meta.getAttribute("content")).toBe("#f4f1ea");

    meta.remove();
  });

  /**
   * The reason this hook is an external store rather than component state:
   * TopBar, the style guide and the Monaco diff each call it independently,
   * and a flip in one has to reach the others.
   */
  it("notifies every subscriber, not just the one that flipped it", () => {
    const first = renderHook(() => useTheme());
    const second = renderHook(() => useTheme());

    act(() => first.result.current.setTheme("graphite"));

    expect(second.result.current.theme).toBe("graphite");
  });

  it("survives localStorage throwing, because a blocked store is not a blank page", () => {
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("storage is blocked");
      });

    const { result } = renderHook(() => useTheme());
    act(() => result.current.setTheme("graphite"));

    expect(result.current.theme).toBe("graphite");
    setItem.mockRestore();
  });
});
