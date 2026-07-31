# ADR 005 — Say that an empty review is a good review

**Status:** accepted · **Date:** 2026-07-31 · **Issue:** #202

## Context

Report §8.2's fourth bullet says patterns in low-scoring comments should inform
prompt iteration. Nothing had ever been iterated, and there was no recorded
output to iterate *against* — so "the prompt got better" was unfalsifiable by
construction.

The first job was therefore not to change the prompt. It was to record what the
prompt currently does, over PRs varied enough that the answer is not about one
kind of change: `backend/scripts/prompt_baseline.py`, five real PRs, artifacts
in `docs/prompt-eval/`.

One of the five is load-bearing. **PR #211 is documentation only** — a static
HTML page, a favicon, two `.gitignore` lines. There is no code in it to be
wrong. If the model manufactures findings there, nothing but the prompt can
explain it.

It manufactured four, and called the result `comment` rather than `approve`.

## What the baseline actually showed

Thirteen comments across five PRs, each one then assessed by hand against the
files on `main` — the three-way split #164 used, because **"unverifiable" is a
distinct failure from "wrong"** and collapsing them hides the thing worth
fixing.

| | count |
|---|---|
| correct | 7 |
| false | 3 |
| unverifiable | 3 |

Six of thirteen were noise. The pattern in them was not subtle:

- **Self-refuting.** A `security/warning` on piping `curl` to `bash` that
  concedes in its own text that this is "a widely-used pattern for Homebrew/nvm
  installers" — which is precisely what the script is doing.
- **Conditionals about files not in the diff.** "If `.env.example` doesn't
  contain a `JWT_SECRET_KEY=` line, this silently does nothing." Three comments
  had this shape. None can be settled by anything the model was given.
- **Editorial critique of prose.** On the docs PR, a comment arguing that
  shipping a documented specification contradiction "is odd" — a contradiction
  that is resolved, in ADR 004, which that PR links.
- **The same point twice.** The docs PR's genuine finding (the generator script
  is gitignored and therefore uncommitted) was raised once against `.gitignore`
  and again against the generated file.

And the prompt's own text explains it. The nearest thing to a restraint was:

```
- Do not invent issues. Fewer, higher-confidence comments beat exhaustive nitpicks.
```

That is *comparative*. It ranks fewer above more; it never says that **none** is
a permitted answer. A model handed a JSON schema containing a `comments` array
will fill the array.

## Decision

One bullet, in `Rules`:

> Returning zero comments is a valid and good outcome. If nothing in the diff is
> worth a reviewer's attention, return an empty comments array with verdict
> "approve" and say so in the summary. A change that is simply fine deserves an
> empty review; padding one with observations, restatements of what the diff
> already says, or preferences phrased as "consider..." makes the review worse,
> not more thorough.

Same five PRs, same index, same provider, same retrieval budget, same effort.
`prompts.py` was the only thing that moved.

| PR | before | after |
|---|---|---|
| #58 setup scripts | `comment`, 5 comments | `comment`, 2 |
| #203 backend bug fix | `approve`, 0 | `approve`, 0 |
| #204 backend + migration | `comment`, 2 | `approve`, 0 |
| #185 frontend TypeScript | `approve`, 2 | `approve`, 0 |
| #211 **docs only** | `comment`, 4 | **`approve`, 1** |

| | before | after |
|---|---|---|
| comments | 13 | 3 |
| correct | 7 | 3 |
| false | 3 | **0** |
| unverifiable | 3 | **0** |
| tokens | 157,413 | 135,854 |

Every false and every unverifiable comment is gone. The three survivors were
each checked against the file rather than taken on the model's word, and all
three are real: `/opt/homebrew` hardcoded in `setup-mac.sh` so Intel Macs get no
`pg` tools on PATH; `psql -U postgres` in `setup-windows.bat` with no `-w` and
no `PGPASSWORD`, which hangs a script advertised as unattended; and a second
`<title>` element sitting inside `<body>` in the generated report page.

Two of those three were independently found by a separate Opus run over the same
PR, which is the closest thing to corroboration available at this sample size.

## What this cost, stated plainly

**Four of the seven correct comments were also lost.** The trade is not free and
should not be reported as though it were.

They were the low-value end — "consider a debug-level log when the clock skews",
the theme-script duplication, the `pytest` entry left in `requirements.txt`.
Losing them to lose all six noise comments is a trade worth making for a review
a person reads voluntarily. It is still a real loss, and if approval rate ever
drops after this ships, this is the first place to look.

## The severity rewrite: written, measured, rejected

The second candidate was that `critical = must fix before merge; warning =
should fix; info = optional` is a vibe rather than a scale — "should fix" is not
a test anyone can apply. The baseline supported the suspicion: **zero `critical`
across thirteen comments**, with `warning` and `info` assigned inconsistently to
comparable findings.

So it was written — three levels defined by effect on running code — and run
over the same five PRs **twice**, because the model is non-deterministic and
`temperature` cannot be set on this family.

It made things worse, reproducibly:

| | change 1 | severity run 1 | severity run 2 |
|---|---|---|---|
| comments | 3 | 4 | 4 |
| #211 verdict | **`approve`** | `comment` | `comment` |
| #58 verdict | `comment` | `request_changes` | `comment` |
| #211 tokens | 75,622 | 151,369 | 75,349 |

It lost the headline win on both runs — the docs-only PR stopped being approved.
It brought back exactly the comment shape change 1 had removed ("If
`.env.example` contains multiple lines...", "worth confirming the generator
handles this"). It dropped both real `setup` defects. It produced two different
verdicts for the same PR under an identical configuration. And on one run it
doubled the token cost of the cheapest PR in the set.

The likely mechanism is dilution: replacing a one-line severity note with a
six-line rubric made the block that contains the zero-comments rule longer and
that rule proportionally less prominent. That is a hypothesis, not a finding.

**It is reverted.** The test that was written to specify it
(`test_prompt_defines_severity_by_effect_not_by_urgency`) is replaced by one
that only asserts all three levels are defined at all — a suite that asserted
the shape of a change this evidence rejected would argue against its own
findings.

Being able to reject a plausible change is the entire return on building the
baseline. Without `before.json` this would have shipped on the strength of
sounding right.

## The finding neither change fixes

**Every correct comment carried a wrong line number.**

| claim | real line | reported |
|---|---|---|
| `/opt/homebrew` hardcoded | `setup-mac.sh:40-42, 55` | 68 |
| `psql -U postgres` hangs | `setup-windows.bat:111, 113` | 123-129 |
| `sc query Redis` vs Memurai | `setup-windows.bat:82, 85-87` | 68 |
| duplicate `<title>` | `report.html:98` | 71 |

Not a consistent offset in either direction — just unreliable, by 12 to 27
lines, on claims that are otherwise correct.

This is not a prompt problem and no wording fixes it. It matters more than it
looks: **#196 posts these comments to real pull requests**, where a wrong line
either anchors the comment to unrelated code or is rejected outright by
GitHub's API. #195's `is_line_commentable` guard will catch the second case and
silently drop the comment; it cannot catch the first.

Filed as #227 rather than fixed here — it is a diff-parsing and
line-attribution question, not prompt iteration, and #202 is the latter.

## Consequences

- Trivial PRs get `approve` with no comments, which is the correct review.
- False and unverifiable comments went to zero at this sample size.
- Four low-value correct comments were lost with them.
- Severity remains undefined by effect. The gap is real and recorded; the
  specific fix attempted is rejected on evidence.
- Line anchoring is unreliable even when the finding is right, and that lands
  on #196's posting path.

## Caveats that belong on every number above

- **n = 5 PRs, one run each** for the headline comparison (two for the rejected
  change). This is evidence, not measurement.
- **Measured on `claude-sonnet-5`; Liffy ships on `claude-opus-5`.** Sonnet was
  chosen because the whole exercise fits in about a dollar. The gap is not
  hypothetical — an earlier Opus run gave PR #203 three comments where Sonnet
  approved it with zero, on the same prompt and the same index.
- **The assessments are one person's judgement**, which is why
  `prompt_compare.py` reports the three counts and deliberately computes no
  "improvement score" over them. A judgement dressed as a metric is worse than
  the judgement alone.
- **Retrieval was held constant, not validated.** Nothing here says the right
  context was retrieved — only that every run saw the same context.
