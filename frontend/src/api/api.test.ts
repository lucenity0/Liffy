import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "@/mocks/server";
import { fixtureRepoIndexed, fixtureReviewCompleted } from "@/mocks/fixtures";
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

  it("disconnectRepo does not choke on the 204's empty body", async () => {
    await expect(disconnectRepo(fixtureRepoIndexed.id)).resolves.toBeUndefined();
  });
});

describe("reviews", () => {
  it("listReviews resolves typed items", async () => {
    const reviews = await listReviews({ limit: 2 });
    expect(reviews).toHaveLength(2);
  });

  it("getReview maps a full detail fixture including comments", async () => {
    const review = await getReview(fixtureReviewCompleted.id);
    expect(review.comments).toHaveLength(8);
    expect(review.comments[0].file_path).toBe("setup-windows.bat");
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
