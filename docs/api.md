# API

The routers live in `backend/app/api/`. FastAPI serves an always-current
reference at `/docs` (Swagger) and `/redoc` when the backend is running — that
is the canonical description of every route, generated from the Pydantic models
rather than maintained by hand here.

This file documents only the endpoints that are **not** in report §6, so the
deviations from the spec are written down somewhere a reader will find them.

## Deviations from report §6

### `GET /analytics/summary` — added by #194

Report §6.4 lists only the two feedback routes. This endpoint is a deliberate
addition.

**Why it exists.** The analytics page (#200, #201) renders all five of report
§8.1's metrics at once. Without this route it would have to issue one
`GET /reviews/{id}/eval` per review and average them client-side — an N+1
across the network, and the wrong arithmetic besides: §8.1 says "% of
comments", so the ratings have to pool rather than being averaged per review.

**Shape.** Every §8.1 metric with its target and whether it is met, scoped to
the caller's repositories. `Depends(get_current_user)` — it exposes aggregate
data about private repositories.

- Every rate is nullable. `null` means "nobody has rated yet"; `0.0` means
  every rating was negative. `met` is `null` when the value is, so the three
  states are met / missed / **unknown**.
- Each metric carries its own `target` and `comparison`, so the frontend never
  hardcodes `0.70`.
- `time_to_review_ms` is report §8.1's figure, from `reviews.total_ms` (webhook
  receipt → complete). `pipeline_duration_ms_median` is `reviews.duration_ms` —
  `run_review` internals, excluding queue wait — and carries **no target**,
  because presenting it against the 90s line would flatter the system by
  exactly the queue wait.
- `category_distribution` always has all six `ReviewCategory` keys including
  zeros; a seventh, `other`, appears only when non-zero.
- `severity_calibration` reports `prs_still_open`, **not** a blocked-merge
  rate: GitHub's REST `state` is `open`/`closed` and does not distinguish
  merged from closed-without-merging. Every row carries its sample size.
- `flagged_reviews` reads `eval_scores`, the weekly snapshot written by the
  beat job (#192), so it is empty until that job has run and can lag a rating
  by up to a week. Everything else in the response is computed live. Capped at
  20, with `flagged_reviews_total` carrying the true count.

An account with no repositories returns `200` with zeros and nulls — not a 404
and not a 500.

### `GET /analytics/models`

Per-model performance, and pull requests that two or more *different* models
both reviewed.

Its own route rather than more of `/summary`: both aggregates scan every
completed review and every rating, and only one of the Analytics tabs asks for
them — folding them in would make the tab nobody opened pay for the one they
did.

- Ratings live in `comment_feedback`, not on `review_comments`, and that join
  fans out — a comment rated by two people would otherwise count twice. The
  comment counts come from their own subquery for the same reason: a single
  query with both joins multiplies the token average by the comment count.
- `useful_rate` is `null` when nothing in that model's reviews has been rated.
  Never `0.0`.
- A comparison needs two **different** models. Re-running one model against the
  same PR is a retry, and listing it here would invite reading it as
  disagreement.

### `GET /analytics/activity?days=` — the dashboard strip

Counts — reviews, findings, repositories — over a recent window. Report §6 has
nothing like it, and neither does `/summary`, which reports rates: an approval
rate of 88% reads identically on a busy week and on a dead one, so it cannot
answer the question the dashboard opens with.

Its own route rather than fields on `/summary` because it loads on the
most-visited screen in the app, and `/summary` computes every §8.1 rate plus
the flagged-review list to answer questions only the analytics page asks.

- Everything is windowed on `reviews.created_at`, findings included — they are
  counted *through* their review rather than by their own timestamp, so
  "these findings came from these reviews" stays true.
- Every review in the window counts, failed ones included. This is how much
  work arrived, not how much succeeded; reporting `0` for a week whose reviews
  all failed would hide the outage the failures are evidence of.
- `repositories` is repositories **with a review in the window**, not
  repositories connected. Under a "this week" heading a connection count from
  eight months ago is not an activity figure.
- `days` is bounded to 1–90 and echoed back in the response. Unbounded it is a
  full-table scan with a friendly name; echoed, a strip headed "this week"
  rendering a month of data fails loudly instead of looking fine.

### `GET /repos` — `review_count` and `last_review_at`

The list returns `RepoListItemOut`, which is `RepoOut` plus the two fields, from
one grouped subquery in the same round trip. The alternative is a paginated
reviews query per repository, which is an N+1 growing with exactly the thing
the Repositories table is for.

`POST /repos` still answers a bare `RepoOut`, deliberately: reconnecting an
existing repository would otherwise report `review_count: 0` for a repository
with a hundred reviews behind it, and a wrong count is worse than an absent
one. `last_review_at` is `null` on a repository nothing has reviewed — never
the connection date standing in for a review that never happened.

### `GET /repos/{repo_id}/pulls`

Proxies GitHub's pull request list so the review trigger can offer a picker
instead of a number field. Acts as the **caller**, not the server identity —
the server PAT would list pull requests the caller's own token cannot see.

`total` is `null` when the page came back full: at that point the count is
genuinely unknown without paging the rest, and a tab reading "OPEN 50" on a
repository with 200 open pull requests is worse than one reading "OPEN".

### `GET /reviews/{review_id}/eval` — §6.4, with nullable rates

In §6, but worth one note: `approval_rate` and `false_positive_rate` are
`null` rather than `0.0` when nothing has been rated. Zero ratings is not zero
approval. `docs/decisions/004-approval-vs-false-positive.md` records why the
two rates are complements and why §8.1's two targets cannot both be met.
