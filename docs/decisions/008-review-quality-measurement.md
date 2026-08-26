# ADR 008 — What the review-quality milestone actually reduced

**Status:** accepted · **Date:** 2026-08-26 · **Issue:** #273

## Context

Four mechanisms shipped on the theory that they cut noise: the multi-angle
sweep (#267), the correctness-over-cleanup ranking rule (#268), the mandatory
`failure_scenario` (#270), and the confidence/severity split (#271). ADR 006
recorded what they *were*. This one records what they **did**, because the
milestone closes honestly or it does not close.

All four questions have answers. One of them could not be answered from the
thumbs — the ratings and the field they would have to discriminate barely
overlap — so it was answered by hand against the code instead, the way ADR 005
answered its own. The thumbs table was left untouched, and why is recorded in
§1.

## 1. Does `plausible` rate worse than `confirmed`? — **Yes, by adjudication**

**The thumbs cannot answer this.** 83 ratings exist and 80 sit on comments
written before `confidence` existed, leaving **three** rated confidence-bearing
comments against the ~30 this issue asked for. Two further limits are structural
rather than bad luck: `users` has a single row, so every rating is one person's
disposition as much as a quality signal, and ratings are self-selected — the
denominator is "comments someone bothered to judge", not "comments".

So the question was answered the way ADR 005 answered its own: **by hand, against
the code**, using the three-way split from #164 — because "unverifiable" is a
distinct failure from "wrong" and collapsing them hides the thing worth fixing.
All 18 confidence-bearing comments were adjudicated against the repository at
each review's own `head_sha`. The record is
`docs/prompt-eval/confidence-adjudication.json`, one entry per comment with the
evidence that settled it.

| | correct | false | unverifiable | n |
|---|---|---|---|---|
| `confirmed` | **11** | 0 | 0 | 11 |
| `plausible` | 5 | 1 | 1 | 7 |

**100% against 71%. Every error was in `plausible`; no `confirmed` finding was
wrong.** Fisher's exact, two-tailed: **p = 0.137**. The direction is exactly what
#271 predicted and the effect is not significant at n=18 — two misses is not a
rate. This is evidence, not proof, and the honest reading is that the split is
behaving as designed on the sample available.

### What the two misses were, because the shape matters more than the count

- `f9fed0c3` (**false**) claimed `ensure_env_file` in `liffy.sh` still only
  rewrote `JWT_SECRET_KEY`. At its own sha the file contains six occurrences of
  `GITHUB_WEBHOOK_SECRET` and does generate it. The comment says in its own text
  that it reasoned from *retrieved context* rather than the diff — **the RAG
  snippet was stale relative to the commit under review.** That is a specific,
  fixable retrieval bug, not general model unreliability.
- `8bf8415a` (**unverifiable**) correctly observed that `setup-mac.sh`'s `sed` is
  unanchored where `setup-windows.bat` anchors and justifies the anchor in a
  `REM`. The predicted harm needs a second `GITHUB_WEBHOOK_SECRET=` occurrence
  inside a comment in `.env.example`; there is exactly one occurrence, the
  assignment. Real inconsistency, hypothetical failure.

**Both misses named their own falsification test** — "What settles it: …" — and
running that test is precisely what dismissed them. That is the mechanism
working: a hedged finding that tells the reader how to kill it costs a grep, and
an unhedged wrong one costs a debugging session. Five of the seven `plausible`
findings survived their own tests and were real, several of them subtle
(`8c35a148` on the unchecked refresh path, `41aa2139` on the selection/rows
divergence).

Worth recording against the milestone's own worry: `8bbe6e5f`, marked
`confirmed`/`critical`, **reproduces exactly** — `newline='\\n'` truncates
`backend\.env` to zero bytes and then raises `ValueError: illegal newline value`,
and the batch script reports success anyway. The confidence field is not
decorative on the high end.

### On who did the adjudicating

One adjudicator, and that adjudicator is a language model assessing another
language model's output — a weak instrument in a known direction, since it may
agree with reasoning that resembles its own. Two things limit the damage: every
verdict is anchored to a named file, symbol or reproduction rather than to an
opinion, so each one is auditable and falsifiable by anyone who disagrees; and
the two adverse verdicts were both reached by *running the finding's own stated
test*, which is the least discretionary judgement available.

**This is not a substitute for the thumbs and does not touch them.**
`comment_feedback` is unchanged — it remains the only record of what a *person*
thought, and backfilling it would have destroyed the one instrument that can
check this adjudication. #302 carries that measurement.

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
| #271 | confidence split | **keep** — confirm at n≥30 |
| #272 | showing both in the UI | not measurable; out of scope |

- **#267 / #268 — keep, unattributed.** The only signal either can produce is the
  aggregate in §2, and it moved 34% in the intended direction. Neither is
  separable from the other or from #270. Keeping them is a judgement that a
  34% noise reduction is worth three prompt mechanisms, not a finding that each
  earned its third.
- **#270 — keep.** The one cost it was suspected of carrying is not visible on
  the provider that has data. Revisit if the subprocess transports ever get
  instrumented rows.
- **#271 — keep.** Adjudication puts `confirmed` at 11/11 and `plausible` at
  5/7, with every error on the hedged side (§1). It is being used rather than
  defaulted, the hedge is legible enough that both misses were killed by running
  the test the comment itself named, and the field is cheap. The effect is not
  significant at n=18 (p = 0.137), so this is "keep on current evidence" rather
  than a settled result — #302 confirms it at n≥30 against *human* ratings,
  which is the instrument this ADR could not use.

## What would settle §1 properly

The adjudication in §1 is one model's reading of another model's output, and it
agrees with #271's prediction — which is exactly the combination that deserves
an independent check rather than a victory lap. The check is human ratings, and
nothing in the pipeline produces them.

18 confidence-bearing comments exist and 3 are rated. The gap closes by someone
reading the other 15 and rating them, and by the next few dozen reviews
accumulating ratings the same way. **The ratings have to be somebody's actual
judgement of the comment.** A rating written to make the column populated
measures the writer, and `comment_feedback` is the only ground truth Liffy has
about its own false positives — and now also the only thing that can audit the
adjudication above. Backfilling it is the one edit that would make the question
permanently unanswerable, for the same reason `duration_ms` and `raw_attempts`
were left NULL on rows that predate them.

Two smaller things worth carrying forward:

- **The RAG snippet that produced the one false finding was stale relative to
  the commit under review** (§1, `f9fed0c3`). That is worth its own issue: a
  retrieval layer that serves pre-diff context invites exactly this failure, and
  it is invisible in the aggregate because the model hedged correctly and the
  finding was dismissible in one grep.
- **Six of the 18 were spot-checked against `main` to see whether anybody acted
  on them. Four are fixed, two are still live.** `855fda6b` (commit pagination)
  and `8bbe6e5f` (the truncating `newline`) were both fixed, and the fix
  docstrings restate the finding's own reasoning almost verbatim — the strongest
  evidence in this document that `confirmed` findings are worth reading, since
  they changed the code. `f0d158fa` and `b4979eea` were fixed with the exact
  suggestion the comment carried. Still live: `9789880c` (`_MODULE_KIND_NODES`
  is unchanged on `main`, so `<script>` blocks and `@media` rules are still
  labelled `function`) and `6549706a` (the report link still passes only a
  title, so "the log below goes with it" remains a promise the code does not
  keep). Both are worth their own issues.

  This is a **spot check of six, not a rate over eighteen** — the other twelve
  were not checked and no acted-on percentage should be quoted from it.
