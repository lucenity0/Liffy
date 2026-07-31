# ADR 004 — Approval rate and false-positive rate are complements

**Status:** accepted · **Date:** 2026-07-31 · **Issue:** #191

## Context

Report §8.1 defines two of Liffy's five quality metrics like this:

| Metric | Computation | Target |
|---|---|---|
| User approval rate | % of comments rated thumbs up by the PR author | **> 70%** |
| False positive rate | % of comments marked as not an issue | **< 20%** |

Report §5 defines the table those numbers come from. `comment_feedback` has
exactly one column carrying signal — `rating`, a `SmallInteger` holding `1` or
`-1`. There is nowhere to record *why* somebody gave a thumbs-down.

That has a consequence the spec does not acknowledge:

> **`false_positive_rate == 1 - approval_rate`, exactly.**

Every thumbs-down is counted as a false positive, because a thumbs-down is the
only negative signal that exists. So the two metrics are one metric and its
arithmetic complement, and **the two targets cannot both be met**: 71% approval
implies 29% false positives, which fails a target of <20%. The only approval
rate satisfying both is >80%, which is not what §8.1 says.

This is a contradiction in the specification, not in the implementation. It has
to be resolved somewhere, and resolving it silently is the thing worth avoiding
— a system that quietly cannot hit its own published targets is worse than one
that says why.

## Options considered

**(a) Treat them as complements.** Store both, because `eval_scores` has both
columns and report §5 is the schema of record. Document that they are
dependent, and treat **>70% approval as the operative target**.

**(b) Distinguish "wrong" from "not useful".** Add a nullable `reason` to
`comment_feedback` (`not_an_issue` | `not_useful` | `null`). False-positive rate
then counts only `not_an_issue` and is genuinely narrower than disapproval, both
targets become satisfiable, and §8.2's "patterns in low-scoring comments inform
prompt iteration" gets a signal it can actually act on. Costs a migration and a
second click in the rating UI.

**(c) Read §8.1 literally.** Approval rate counts only the *PR author's*
ratings; false-positive rate counts everyone's. Defensible from the wording.

## Decision

**(a).**

The reasoning is about what each option buys today:

- (c) is the weakest. It is a real distinction on a large team and no
  distinction at all here: Liffy has two users, and only a repository's owner
  can reach its comments through the API, so the PR author is the only rater
  in every case that currently exists. It would add a filter that changes no
  number while implying a precision the data does not have.

- (b) is the right answer *eventually*, and it is recorded below as the
  follow-up. It is not the right answer now: it blocks the entire evaluation
  milestone on a schema change and a UI change, in order to improve a
  measurement over a sample of eight comments. The value of a narrower
  false-positive rate scales with how much feedback exists, and right now
  almost none does.

- (a) ships today, is honest about what it measures, and its cost is a
  redundant column that report §5 already mandates. The redundancy is
  documented rather than hidden, which is the part that matters.

**>70% approval is the operative target.** `false_positive_rate` is still
computed and still stored, because `eval_scores.false_positive_rate` is
`Float NOT NULL` and dropping it would be a deviation from report §5 for no
gain. It is not a second signal, and nothing should treat it as one.

## Consequences

- **The UI shows approval only.** Rendering both rates against both targets
  puts a contradiction on screen: "71% approval ✓" beside "29% false positives
  ✗", derived from the same eight ratings. #199 shows approval with a footnote.

- **`null` is not `0.0`, and this matters more than the choice above.** Zero
  ratings is not zero approval. `compute_review_scores` returns `None` for both
  rates when nothing has been rated, and `0.0` only when every rating was
  negative. The endpoint this replaced returned a hardcoded `0.0` for an unrated
  review, which read as a measurement and was not one. Preserving that
  distinction is a hard requirement on every consumer downstream.

- **The denominator is rated comments, not all comments.** A good review with
  one rating scores 100%, not 12.5%. Otherwise the metric punishes reviews for
  going unread, which is a fact about the reader.

- **Ratings from multiple users all count.** Not reachable through the API
  today — `repositories` has a single `user_id` — but the table permits it and
  the arithmetic should not silently drop one.

## Follow-up

Option (b), when there is enough feedback for the distinction to pay for
itself. It needs: a nullable `reason` column and migration, a reason picker in
the rating control, `false_positive_rate` recomputed over `not_an_issue` only,
and this ADR superseded rather than edited.

The signal it unlocks is §8.2's, not §8.1's: "this comment is wrong" and "this
comment is right but not worth making" call for different prompt changes, and
today they are the same click.
