# ADR 008 — What the review-quality milestone actually reduced

**Status:** accepted · **Date:** 2026-08-26 · **Issue:** #273

## Context

Four mechanisms shipped on the theory that they cut noise: the multi-angle
sweep (#267), the correctness-over-cleanup ranking rule (#268), the mandatory
`failure_scenario` (#270), and the confidence/severity split (#271). ADR 006
recorded what they *were*. This one records what they **did**, because the
milestone closes honestly or it does not close.

Three of the four questions have answers. One does not, and the reason it does
not is itself the most useful finding here.

## 1. Does `plausible` rate worse than `confirmed`? — **Unanswerable**

The issue asked for ~30 rated comments. There are **three**.

| confidence | comments | rated | 👍 | 👎 |
|---|---|---|---|---|
| `confirmed` | 11 | 1 | 1 | 0 |
| `plausible` | 7 | 2 | 2 | 0 |
| `null` (pre-#271) | 80 | 80 | 77 | 3 |

83 ratings exist and 80 of them are on comments written before `confidence`
existed. The ratings and the field they would have to discriminate barely
overlap, so **there is no number to report** — a 100% approval rate over one
`confirmed` comment and two `plausible` ones is not evidence of anything, and
recording it as though the confidence split were vindicated would be worse
than recording nothing.

Two further limits on that column, both structural rather than bad luck:

- **One rater.** `users` has a single row, so every rating is one person's, and
  the 96.3% baseline approval rate is that person's disposition as much as the
  reviewer's quality. ADR 004 already separates approval from correctness; this
  is the same distinction arriving as a sampling problem.
- **Self-selected.** People rate what they feel strongly about. The denominator
  is not "comments", it is "comments someone bothered to judge".

**This is left open deliberately.** #273 stays open on this bullet alone, and
#302 carries the re-measurement.

### The field is being used, which is the precondition

The issue's own gotcha: a 100%-`confirmed` distribution would mean the model is
complying with a schema, not expressing confidence. Observed:

| day | `confirmed` | `plausible` |
|---|---|---|
| 2026-08-21 | 7 | 1 |
| 2026-08-22 | 4 | 6 |

11 / 7 overall — 61% / 39%, and moving. The model is discriminating rather than
defaulting. That does not show the split *earns its place*; it shows the
measurement is not dead on arrival, which is the only claim available.

## 2. Findings per review, before vs after — **2.71 → 1.80 (−34%)**

Held to `model_used = 'claude-opus-5'` and `status = 'completed'`, per the
instruction not to compare across a model change:

| period | reviews | comments | per review |
|---|---|---|---|
| before | 28 | 76 | **2.71** |
| after | 10 | 18 | **1.80** |

**The cut is 2026-08-21 13:55:50Z, not a merge date.** The first review carrying
a `confidence` value predates PR #285's merge (15:16:30Z) by 81 minutes — the
mechanism was exercised before the PR landed. Cutting on the merge timestamp
puts three post-mechanism reviews in the "before" bucket and understates the
change. The observable behaviour, not the git history, is what the data records.

Approval rate over the same cut is 96.3% before (n=80) against 100% after
(n=3). **The second figure is not reportable** — see §1.

What this cannot do is attribute. #267, #268 and #270 all landed inside this
window and none of the first two leaves a per-comment trace. The aggregate moved
the right way; which mechanism moved it is not recoverable from these rows.

## 3. Is the required `failure_scenario` costing retries? — **No, so far**

| model | reviews | instrumented | median `raw_attempts` | max |
|---|---|---|---|---|
| `claude-opus-5` | 38 | 7 | **1** | **1** |
| `(null)`, pre-milestone | 15 | 1 | 3 | 3 |

Every instrumented review on the current provider validated first try. The lone
3-attempt row has no `model_used` and predates the instrumentation the milestone
added, so it is not evidence about `failure_scenario`.

n=7 and one provider. The subprocess transports (`claude_code`, `codex`), where
a retry storm is expensive enough that #270's docstring calls it out, have no
instrumented rows at all. **The cost is unobserved, not shown to be absent.**

## 4. `openai_use_json_schema=true` — **verified working, no bug to file**

The fault line the issue predicted is real and **already fixed**:
`strict_schema()` (`backend/app/llm/chain.py:114`) rewrites the wire schema for
this transport only. Checked programmatically against the live
`LLMReviewOutput.model_json_schema()`: every property appears in `required`,
`additionalProperties` is `false` at every level, and `default` — an error in
strict mode rather than an ignored keyword — is stripped throughout. Zero
violations.

The caveat in that docstring matters to this ADR specifically: under the flag,
non-nullable defaulted fields become **mandatory in generation**, so the model
always picks a `confidence` instead of falling through to `confirmed`. A
distribution gathered on that transport is therefore not comparable with the
other three providers'. It does not contaminate §1 — only two reviews ever ran
an OpenAI-shaped model (`gpt-5.6-luna`), both before the milestone, both with no
`confidence` rows — but it will contaminate the re-measurement if that flag is
ever switched on mid-window.

## Recommendation per mechanism

| # | mechanism | verdict |
|---|---|---|
| #267 | multi-angle sweep | **keep, unattributed** |
| #268 | ranking rule | **keep, unattributed** |
| #270 | mandatory `failure_scenario` | **keep** |
| #271 | confidence split | **undecided — re-measure** |
| #272 | showing both in the UI | not measurable; out of scope |

- **#267 / #268 — keep, unattributed.** The only signal either can produce is the
  aggregate in §2, and it moved 34% in the intended direction. Neither is
  separable from the other or from #270. Keeping them is a judgement that a
  34% noise reduction is worth three prompt mechanisms, not a finding that each
  earned its third.
- **#270 — keep.** The one cost it was suspected of carrying is not visible on
  the provider that has data. Revisit if the subprocess transports ever get
  instrumented rows.
- **#271 — undecided, and that is not "keep".** It is being used (§1) and it is
  cheap, so nothing argues for reverting it today. But the question the
  milestone asked about it is unanswered, and calling that "keep" would convert
  an absence of evidence into a pass. Follow-up in #302: re-measure at ≥30
  rated confidence-bearing comments.

## What would settle §1

Nothing in the pipeline. 18 confidence-bearing comments exist and 3 are rated;
the gap closes by someone reading the other 15 and rating them, and then by the
next few dozen reviews accumulating ratings the same way. **The ratings have to
be somebody's actual judgement of the comment** — a rating written to make the
column populated measures the writer, and this table is the only ground truth
Liffy has about its own false positives. Backfilling it is the one edit that
would make the question permanently unanswerable, for the same reason
`duration_ms` and `raw_attempts` were left NULL on rows that predate them.
