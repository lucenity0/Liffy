import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "@/mocks/server";
import {
  fixtureEvalRated,
  fixtureEvalUnrated,
  fixtureRepoIndexed,
  fixtureReviewCompleted,
  reviewPage,
} from "@/mocks/fixtures";
import { getReviewEval } from "./analytics";
import { connectRepo, disconnectRepo, listRepos } from "./repos";
import { getReview, listReviews, triggerReview } from "./reviews";
import { normalizeApiError } from "@/lib/errors";

describe("repos", () => {
  it("listRepos resolves the typed fixture array", async () => {
    const repos = await listRepos();
    expect(repos).toHaveLength(2);
    expect(repos[0]).toMatchObject({ full_name: "lucenity0/Liffy" });
  });

  it("connectRepo sends {full_name} and returns the created repo", async () => {
    let receivedBody: unknown;
    server.use(
      http.post("*/repos", async ({ request }) => {
        receivedBody = await request.json();
        return HttpResponse.json({ ...fixtureRepoIndexed, full_name: "a/b" }, { status: 201 });
      }),
    );

    const repo = await connectRepo("a/b");
    expect(receivedBody).toEqual({ full_name: "a/b" });
    expect(repo.full_name).toBe("a/b");
  });

  it("connectRepo surfaces a 422 as a validation ApiError", async () => {
    await expect(connectRepo("not-a-full-name")).rejects.toSatisfy((err: unknown) => {
      const normalized = normalizeApiError(err);
      return normalized.kind === "validation" && normalized.status === 422;
    });
  });

  it("connectRepo surfaces a 502 as an upstream ApiError", async () => {
    await expect(connectRepo("nonexistent/nope")).rejects.toSatisfy((err: unknown) => {
      const normalized = normalizeApiError(err);
      return normalized.kind === "upstream" && normalized.status === 502;
    });
  });

  it("connectRepo surfaces a 503 as an unavailable ApiError", async () => {
    await expect(connectRepo("no-token/repo")).rejects.toSatisfy((err: unknown) => {
      const normalized = normalizeApiError(err);
      return normalized.kind === "unavailable" && normalized.status === 503;
    });
  });

  it("connectRepo surfaces a 429 as rate_limited, and never says reconnect", async () => {
    // #209: GitHub answers 403 for a rate limit as well as for an auth
    // failure. The backend tells them apart; this asserts the distinction
    // survives to the user-facing message, because "reconnect your account" is
    // the one instruction with no action behind it when you are merely
    // throttled.
    server.use(
      http.post("*/repos", () =>
        HttpResponse.json(
          { detail: "GitHub rate limit reached. Retry after 60s." },
          { status: 429, headers: { "Retry-After": "60" } },
        ),
      ),
    );

    await expect(connectRepo("octo/demo")).rejects.toSatisfy((err: unknown) => {
      const normalized = normalizeApiError(err);
      return (
        normalized.kind === "rate_limited" &&
        normalized.status === 429 &&
        !normalized.message.toLowerCase().includes("reconnect")
      );
    });
  });

  it("disconnectRepo does not choke on the 204's empty body", async () => {
    await expect(disconnectRepo(fixtureRepoIndexed.id)).resolves.toBeUndefined();
  });
});

describe("reviews", () => {
  it("listReviews resolves a page of typed items alongside the full total", async () => {
    const page = await listReviews({ limit: 2 });

    expect(page.items).toHaveLength(2);
    // The count is of the whole set, not the window — that gap is the reason
    // the endpoint returns an envelope at all.
    expect(page.total).toBe(4);
  });

  it("listReviews leaves unset filters out of the query string", async () => {
    let sent: string | null = null;
    server.use(
      http.get("*/reviews", ({ request }) => {
        sent = new URL(request.url).search;
        return HttpResponse.json(reviewPage([]));
      }),
    );

    await listReviews({ limit: 5 });

    // Not `repo_id=undefined` or `status=`: FastAPI answers 422 to the first
    // and a list page that 422s is a blank screen with nothing to correct.
    expect(sent).toBe("?limit=5&offset=0");
  });

  it("listReviews sends the filters it is given", async () => {
    let sent: URLSearchParams | null = null;
    server.use(
      http.get("*/reviews", ({ request }) => {
        sent = new URL(request.url).searchParams;
        return HttpResponse.json(reviewPage([]));
      }),
    );

    await listReviews({
      repoId: fixtureRepoIndexed.id,
      prNumber: 58,
      status: "failed",
      sort: "oldest",
    });

    expect(sent!.get("repo_id")).toBe(fixtureRepoIndexed.id);
    expect(sent!.get("pr_number")).toBe("58");
    expect(sent!.get("status")).toBe("failed");
    expect(sent!.get("sort")).toBe("oldest");
  });

  it("getReview maps a full detail fixture including comments", async () => {
    const review = await getReview(fixtureReviewCompleted.id);
    expect(review.comments).toHaveLength(2);
    expect(review.comments[0].file_path).toBe("src/lib/diff.ts");
    expect(review.raw_diff).toContain("diff --git");
  });

  it("getReview on an unknown id rejects with a 404 ApiError", async () => {
    await expect(getReview("00000000-0000-0000-0000-000000000000")).rejects.toSatisfy(
      (err: unknown) => normalizeApiError(err).kind === "not_found",
    );
  });

  it("triggerReview posts the exact payload", async () => {
    let receivedBody: unknown;
    server.use(
      http.post("*/reviews/trigger", async ({ request }) => {
        receivedBody = await request.json();
        return HttpResponse.json(
          { status: "queued", repo: "lucenity0/Liffy", pr_number: 58 },
          { status: 202 },
        );
      }),
    );

    const result = await triggerReview({ owner: "lucenity0", repo: "Liffy", pr_number: 58 });
    expect(receivedBody).toEqual({ owner: "lucenity0", repo: "Liffy", pr_number: 58 });
    // The 202 body deliberately carries no review id.
    expect(result).toEqual({ status: "queued", repo: "lucenity0/Liffy", pr_number: 58 });
  });
});

describe("analytics", () => {
  it("getReviewEval hits /reviews/{id}/eval", async () => {
    let url = "";
    server.use(
      http.get("*/reviews/:reviewId/eval", ({ request, params }) => {
        url = new URL(request.url).pathname;
        return HttpResponse.json({
          review_id: params.reviewId,
          total_comments: 8,
          rated_comments: 6,
          approval_rate: 0.8333333333333334,
          false_positive_rate: 0.16666666666666663,
        });
      }),
    );

    await getReviewEval(fixtureReviewCompleted.id);
    expect(url).toBe(`/reviews/${fixtureReviewCompleted.id}/eval`);
  });

  /**
   * The one thing this wrapper must not do. `null` means nobody has rated;
   * `0` means every rating was negative. Anything that coerces on the way in
   * destroys the distinction before the UI ever gets a chance to branch on it.
   */
  it("parses null rates without coercing them to zero", async () => {
    server.use(
      http.get("*/reviews/:reviewId/eval", () =>
        HttpResponse.json(fixtureEvalUnrated),
      ),
    );

    const scores = await getReviewEval(fixtureReviewCompleted.id);
    expect(scores.approval_rate).toBeNull();
    expect(scores.false_positive_rate).toBeNull();
    expect(scores.approval_rate).not.toBe(0);
  });

  it("keeps the rate unrounded, so rounding happens once at render", async () => {
    server.use(
      http.get("*/reviews/:reviewId/eval", () =>
        HttpResponse.json(fixtureEvalRated),
      ),
    );

    const scores = await getReviewEval(fixtureReviewCompleted.id);
    expect(scores.approval_rate).toBe(0.8333333333333334);
  });

  it("surfaces a 404 as not_found rather than a zero score", async () => {
    server.use(
      http.get("*/reviews/:reviewId/eval", () =>
        HttpResponse.json({ detail: "Review not found" }, { status: 404 }),
      ),
    );

    await expect(getReviewEval("00000000-0000-0000-0000-000000000000")).rejects.toSatisfy(
      (err: unknown) => normalizeApiError(err).kind === "not_found",
    );
  });
});

describe("normalizeApiError", () => {
  it("classes a connection failure as network, not unknown", async () => {
    server.use(http.get("*/repos", () => HttpResponse.error()));
    await expect(listRepos()).rejects.toSatisfy(
      (err: unknown) => normalizeApiError(err).kind === "network",
    );
  });

  it("passes through a non-axios error as unknown", () => {
    const normalized = normalizeApiError(new Error("boom"));
    expect(normalized).toEqual({
      kind: "unknown",
      status: null,
      message: "boom",
      detail: null,
    });
  });
});
