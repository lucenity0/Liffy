# ADR 006 — Two axes on a finding: what breaks, and how sure

**Status:** accepted, partially measured · **Date:** 2026-08-21 · **Issues:** #269, #270, #271, #272, #273

## Context

Liffy's review output asked the model to be specific and never checked. The
prompt said *"be specific and actionable; reference identifiers from the code,
not generalities"*, which a model satisfies by **sounding** specific — and
`severity` was carrying two questions at once: how bad is this if it is real,
and how sure is the model that it is. A `critical` finding the model guessed at
and one it can trigger on demand rendered identically.

Four mechanisms were proposed. Two shipped, two were scrapped before any code
was written, and that split is the most useful thing recorded here.

## What was scrapped, and why

**#267 — sweep the diff by five angles instead of six categories.** Ported from
Claude Code's `/code-review` skill, which does a different job: it reviews your
own uncommitted changes, with no repository index, in a loop where you dismiss
a false positive in a second because it is your code. Its taxonomy is tuned for
author slips — wrong-variable copy-paste, closure-captured loop vars,
unescaped regex metacharacters. Liffy reviews someone else's finished pull
request with full RAG context, where what matters is whether a change breaks a
caller or violates a convention set elsewhere — which the six existing
`ReviewCategory` values already target and the index exists to serve.

The premise was also never established. `SYSTEM_PROMPT` already says returning
zero comments is a good outcome and that fewer, higher-confidence comments beat
exhaustive nitpicks, so a low finding count is that choice working. Across
three passes on #274 it produced 8 findings and all 8 were correct.

**#268 — "correctness outranks cleanup when the output cap forces a cut".**
Liffy has no output cap. There is no `max_comments` in `review_service.py`,
`review_publisher.py` or `output_parser.py`, so the rule governs a truncation
that cannot happen. It was inert when it was filed, on the strength of a caveat
written into its own issue body.

Both are closed and should stay closed. If a missed-bug complaint ever arrives,
#267 is worth revisiting; if an output cap is ever introduced, #268 comes back
as part of that change, where it would do something.

## What shipped

**`failure_scenario`, required (#270).** The concrete inputs or state that make
a finding bite, and the wrong result that follows — paired with a prompt rule
to drop any finding you cannot write one for. Required rather than defaulted,
because an optional field gets omitted and the discard rule stops biting. This
is the only mechanism in the milestone that is *enforced* rather than
requested: Pydantic rejects a comment without one, on every provider.

**`confidence`, defaulted (#271).** `confirmed` / `plausible`, on the axis
`severity` never answered. Defaulted, unlike the above — a response in the
older shape still validates, because confidence degrades presentation while the
scenario is the review, and only one of those is worth a retry. The default
leans to `confirmed`, the less conservative option, because defaulting to
`plausible` would mark every older-shaped response as uncertain — a claim about
the model the response never made.

Nothing filters on confidence. `partition_comments` and `resolve_event` are
untouched; a plausible finding posts like any other, visually marked.

## What the numbers say

Three live reviews after the milestone — two under `anthropic`, one under
`claude_code`, both resolving to `claude-opus-5` — across PRs #261, #274, #277.
Eight findings.

| | |
|---|---|
| Findings carrying a `failure_scenario` | **8 of 8** |
| `raw_attempts` | **1**, on all three reviews, both providers |
| `dropped_comments` | **0** |
| Confidence split | **7 confirmed / 1 plausible** (87.5% / 12.5%) |
| Mean scenario length | 339 chars, against 616-char comments |

**The required field costs nothing.** `raw_attempts` was 1 every time: the
model complies on the first attempt, so the retry storm the issue warned about
— three calls and a failed review, expensive on `claude_code` and `codex` where
each attempt is a 600s-timeout subprocess — did not materialise. This is the
number to keep watching; a median above 1 in a provider would change the
verdict.

**The scenarios are real.** They name inputs and results rather than restating
the comment — *"A PR with 120 commits whose last completed review has head_sha
= commit 120. The endpoint returns commits 1–100; commit 120 is not among them,
so `seen_boundary` stays false and the fallback marks all 100 returned commits
`is_new=true`."* At 339 characters against 616-character comments they are
substantive rather than a sentence appended to satisfy a validator.

**The confidence split is working, barely measurably.** The first four findings
came back 100% `confirmed`, which is the distribution #271 says means the
prompt is not working. It was a sample-size artefact: the fifth review produced
a `plausible` that correctly ended its scenario with what would settle it. But
one of those first four also read as plausible by the prompt's own definition
— it ended *"if Safari <16.4 is out of support, this is a non-issue"* — and was
labelled `confirmed`. So the model can write a plausible-shaped scenario and
still mark the finding confirmed, at least sometimes.

## What is not measured, and why the issue stays open

**#273 cannot be closed.** It asks for the thumbs-up rate on `confirmed` versus
`plausible` across at least ~30 rated comments. There are 8 post-milestone
comments and **0 ratings on them**. A rate computed over that is not a number,
it is a shape, and the issue says explicitly to leave itself open rather than
report one. The before/after comparison of findings-per-review has the same
problem from the other side.

Two things blocking it that are worth fixing regardless:

1. **`raw_attempts` is not persisted.** It exists on `LLMResult`
   (`chain.py:1158`) and is never written to a column, so #273's "check the
   `raw_attempts` distribution per provider" asks for a number nothing records.
   The figures above were obtained by wrapping `generate_review` in a
   throwaway script. Recording it is a small change and the only way this ever
   becomes a distribution rather than three anecdotes.
2. **`openai_use_json_schema=true` sends a schema strict mode rejects** —
   filed as #280. Four properties sit outside `required` (`changes`, `files`,
   `suggestion`, `confidence`). **Pre-existing:** the first three predate this
   milestone and would break that path alone; `confidence` joined the fault
   line without creating it. Confirmed by inspection against OpenAI's
   documented rule, *not* against a live endpoint — the configured key is not
   an OpenAI key and no local Ollama was running.

## Recommendation per mechanism

| Mechanism | Verdict |
|---|---|
| #267 five-angle sweep | **Stay scrapped.** Wrong tool for this job, and the recall problem it fixes was never demonstrated. |
| #268 ranking rule | **Stay scrapped.** Returns with an output cap, if one is ever introduced. |
| #270 `failure_scenario` | **Keep.** 100% compliance, zero retry cost, substantive output. The clearest win in the milestone. |
| #271 `confidence` | **Keep, and re-measure.** The split is non-degenerate but the sample is 8, and there is a known miscall in it. Do not filter on it until #273 has real data. |
| #272 dashboard rendering | **Keep.** Presentation only. |

## Adjacent, and larger than the milestone

Verifying the above surfaced a separate bug in a shipped metric, filed and
fixed as #279. The severity calibration table reported 50% / 67% / 65% of pull
requests "still open" on a repository where every pull request is merged:
`pull_requests.status` was written once at review time and never re-synced, so
every row read `open` forever. The footnote under it blamed GitHub's API for
being unable to distinguish a merge from a close — which was never true;
`merged_at` is on every pull request payload and was simply never read.

After the fix: 0% / 0% / 0%, across 18 pull requests, all closed, all 18
merged. Recorded here because it is the sharpest available reminder that a
metric nobody has checked against reality is not evidence — which is the same
argument #273 makes about the numbers above.
