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

### `GET /reviews/{review_id}/eval` — §6.4, with nullable rates

In §6, but worth one note: `approval_rate` and `false_positive_rate` are
`null` rather than `0.0` when nothing has been rated. Zero ratings is not zero
approval. `docs/decisions/004-approval-vs-false-positive.md` records why the
two rates are complements and why §8.1's two targets cannot both be met.
