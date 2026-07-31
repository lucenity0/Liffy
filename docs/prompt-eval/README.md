# Prompt evaluation artifacts

Recorded review output from `backend/scripts/prompt_baseline.py`, kept so a
prompt change can be compared against something rather than against a memory.

Report §8.2's fourth bullet says patterns in low-scoring comments inform prompt
iteration. **Without a recorded baseline, "the prompt got better" is
unfalsifiable** — which is the only reason these files are committed.

## Files

| File | What it is |
|---|---|
| `before.json` | Five PRs reviewed on the prompt as it stood at the start of #202 |
| `after-zero-comments.json` | The same five PRs after change 1 — "returning zero comments is a valid outcome" |
| `after-severity.json` | Change 2 — severity defined by effect on running code. **Rejected** |
| `after-severity-run2.json` | Change 2 again, because one run of a non-deterministic model is not a result |

Two changes, measured **separately and in sequence**: run, measure, change, run,
measure. That is not a violation of one-change-at-a-time — it is the discipline.
Landing both and running once would have told us the pair did something and
nothing about which one.

**Change 1 shipped. Change 2 was reverted on this evidence** — it lost change
1's headline win on both runs, brought back the speculative comments change 1
had removed, and gave two different verdicts for the same PR under an identical
configuration. ADR 005 has the tables. The `after-severity*` files are kept
precisely *because* the change was rejected: a baseline that only records the
changes that worked cannot be used to argue against the next plausible idea.

## Method

```bash
cd backend
# The script talks to the compose stack, not to a local Postgres: backend/.env
# points DATABASE_URL at a passwordless localhost database, and GITHUB_TOKEN is
# not in backend/.env at all. Both must be supplied here or the run dies before
# it reaches the model — which is the cheap way to fail, but only if you know
# that is what happened.
export DATABASE_URL=postgresql://liffy:liffy@localhost:5432/liffy
export GITHUB_TOKEN="$(gh auth token)"
export LLM_PROVIDER=anthropic ANTHROPIC_MODEL=claude-sonnet-5

PYTHONPATH=. python scripts/prompt_baseline.py before
#  …change exactly one thing in app/llm/prompts.py…
PYTHONPATH=. python scripts/prompt_baseline.py after
PYTHONPATH=. python scripts/prompt_compare.py before after
```

Everything except `prompts.py` is pinned between the two runs: the same five
PRs, the same repository index (indexed once, before either run), the same
provider and model, the same retrieval budget. A second variable would make
the comparison worthless.

## The five PRs, and why these five

One kind of PR would only teach us how Liffy reviews that kind.

| PR | Why it is in the set |
|---|---|
| #58 | The anchor — already assessed on #164, so it is the one data point with a known answer |
| #203 | Backend Python containing a real bug fix (a `KeyError` that aborted whole index runs) |
| #204 | Backend Python with real logic and a migration |
| #185 | Frontend TypeScript |
| #211 | Docs only — **should produce `approve` with zero comments** |

The last one is the cheapest and clearest signal in the set: if the model
manufactures nitpicks on a documentation change, that is a prompt problem and
nothing else can explain it.

## `assessment` is filled in by hand

Each comment carries `"assessment": null` until a human writes `correct`,
`false` or `unverifiable` into it — the same three-way split #164 used.

The split matters: **"unverifiable" is a distinct failure from "wrong"**, and
collapsing them hides the thing actually worth fixing. A wrong comment means
the model reasoned badly; an unverifiable one means it speculated about code it
could not see, which is a retrieval question as often as a prompt one.

`prompt_compare.py` reports these counts and deliberately computes no
"improvement score" over them — a human judgement dressed up as a metric is
worse than the judgement on its own.

## Caveats that belong on any number taken from here

- **n is tiny.** Five PRs, one run each. The model is non-deterministic and
  `temperature` cannot be set on this family (it 400s, which is why
  `AnthropicReviewLLM` does not pass one), so a single run is not a
  measurement. Close results were re-run.
- **These runs are on `claude-sonnet-5`, and Liffy ships on `claude-opus-5`**
  (`config.py` defaults `anthropic_model` to Opus). Sonnet was chosen because
  the whole before/after fits in about a dollar; the same exercise on Opus is
  roughly five times that. So a result here is evidence that the prompt change
  did something, **not** evidence about the numbers production will show. The
  gap is not hypothetical: the first attempt at this baseline ran on Opus via
  `claude_code` and PR #203 drew three `improvement` comments, where Sonnet
  approved it with zero. Same PR, same prompt, same index.
- **Effort is `medium`,** the production default. Thinking is on by default on
  this family and bills as output tokens, so effort — not `max_tokens` — is the
  cost lever, and changing it would change what is being measured.
- **Retrieval is held constant, not validated.** These runs say nothing about
  whether the right context was retrieved — only that both runs saw the same
  context. A comment that is unverifiable because the relevant code was never
  retrieved is a `MAX_CONTEXT_CHUNKS` problem, and no prompt change fixes it.
