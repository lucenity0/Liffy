# Failure modes seen in practice

Every `status='failed'` review in the development database as of 2026-08-19 — 12 rows, grouped by cause.

Written before the summaries were rewritten, so the **Recorded** blocks below are the original text exactly as the worker wrote it. **This document is now the only copy.** The raw CLI transcript is never persisted, and `review_service` stores only `str(exc)[:400]` into `reviews.summary` — which has since been overwritten for 7 of these rows.

### What was rewritten, 2026-08-19

Seven rows were rewritten in place to the format the code now emits, so the reviews list stops showing raw JSON for historical failures:

- **4 × `init-banner`** → a sentence saying no cause was recorded and why.
- **3 × `stopwatch`** → `Claude Code exited 1: stop_reason=stop_sequence`.

Five rows were left untouched, because their messages already name a cause and rewriting them would churn the record for no reader benefit: both `cli-missing` rows, the `subscription-limit` row (its raw JSON sits in an `Output:` tail *after* a plain-language cause, which is the intended shape), the `infra` row, and the one row with no summary at all.

No row's classification changed. The rewrite is presentation only — nothing here reinterprets what failed.

---

## `stopwatch` — 3 occurrence(s)

The message was timing fields, cause truncated.

**Presentation fixed** — the message now leads with `subtype=` and `stop_reason=`. The underlying `stop_sequence` failure is *not* diagnosed; see below.

- **2026-08-04 08:47:57** · `lucenity0/Liffy` #253 · 24634ms · `09fcb194-b137-41dd-ad4b-8803208657dc`

- **2026-08-18 17:42:33** · `lucenity0/Liffy` #258 · 197455ms · `ca195846-2e74-425c-8e4f-672c93849c4f`

- **2026-08-18 17:53:00** · `lucenity0/Liffy` #258 · 202185ms · `eafeb5d6-8afd-403f-ad1a-ec53e71828b4`

<details><summary>Recorded verbatim</summary>

```
Review failed: Claude Code exited 1: {"is_error": true, "duration_api_ms": 0, "num_turns": 1, "stop_reason": "stop_sequence", "session_id": "079e6a82-42ed-4b9c-9480-4ae1ba4adff4", "total_cost_usd": 0, "usage": {"input_tokens": 0, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0, "output_tokens": 0, "server_tool_use": {"we

Review failed: Claude Code exited 1: {"is_error": true, "duration_api_ms": 1616, "num_turns": 1, "stop_reason": "stop_sequence", "session_id": "6b8a51a5-ee0b-4cc1-95ef-79bf1ebdd728", "total_cost_usd": 0.017537, "usage": {"input_tokens": 0, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0, "output_tokens": 0, "server_tool_

Review failed: Claude Code exited 1: {"is_error": true, "duration_api_ms": 1897, "num_turns": 1, "stop_reason": "stop_sequence", "session_id": "2dbdff84-c890-4e63-bdbe-4df9eeb16cef", "total_cost_usd": 0.017608, "usage": {"input_tokens": 0, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0, "output_tokens": 0, "server_tool_

```

</details>

---

## `init-banner` — 4 occurrence(s)

The message was the CLI's startup banner.

**Fixed** — `_cli_failure_blob` now skips the init banner and prefers the `result` event.

- **2026-08-03 05:07:29** · `lucenity0/Liffy` #252 · 226350ms · `89f70011-9587-49a5-b078-1a3372da21b3`

- **2026-08-03 05:12:30** · `lucenity0/Liffy` #252 · 30963ms · `58d2cccf-3589-4491-92ee-b71b03d09e49`

- **2026-08-03 05:16:48** · `lucenity0/Liffy` #252 · 38906ms · `6d0e0005-e902-4374-81b8-b75dcd01c1eb`

- **2026-08-03 05:20:33** · `lucenity0/Liffy` #252 · 44557ms · `c2933636-3b9e-4d8e-96c5-4432da60edd3`

<details><summary>Recorded verbatim</summary>

```
Review failed: Claude Code exited 1: {"type":"system","subtype":"init","cwd":"/tmp/liffy-review-da50_8ra","session_id":"55667bbd-1872-4513-bc78-c42c4133d03b","tools":[],"mcp_servers":[],"model":"claude-opus-5","permissionMode":"default","slash_commands":["deep-research","design-sync","dataviz","update-config","verify","debug","code-rev

Review failed: Claude Code exited 1: {"type":"system","subtype":"init","cwd":"/tmp/liffy-review-cx__97r0","session_id":"c44dbbce-6313-4f26-9824-46122cd9aad7","tools":[],"mcp_servers":[],"model":"claude-opus-5","permissionMode":"default","slash_commands":["deep-research","design-sync","dataviz","update-config","verify","debug","code-rev

Review failed: Claude Code exited 1: {"type":"system","subtype":"init","cwd":"/tmp/liffy-review-8135spay","session_id":"87152f33-a75b-43ac-a86f-c6461bbfc178","tools":[],"mcp_servers":[],"model":"claude-opus-5","permissionMode":"default","slash_commands":["deep-research","design-sync","dataviz","update-config","verify","debug","code-rev

Review failed: Claude Code exited 1: {"type":"system","subtype":"init","cwd":"/tmp/liffy-review-g7jcktw9","session_id":"0dc9b1e5-637f-4ccb-b290-b8c8c3fa332d","tools":[],"mcp_servers":[],"model":"claude-opus-5","permissionMode":"default","slash_commands":["deep-research","design-sync","dataviz","update-config","verify","debug","code-rev

```

</details>

---

## `no-message` — 1 occurrence(s)

Failed with no message recorded at all.

**Open** — a failed review with an empty `summary` tells the reader nothing at all.

- **2026-08-07 23:11:20** · `lucenity0/askcal` #41 · -ms · `d300e5a2-08dd-4bf1-9f68-60bb8ba61d31`

<details><summary>Recorded verbatim</summary>

```
(null)

```

</details>

---

## `infra` — 1 occurrence(s)

A dependency was not reachable.

**Not a Liffy bug** — a dependency was down. The message is already accurate.

- **2026-08-06 06:18:17** · `lucenity0/Liffy` #253 · 4176ms · `9102f1d2-85bd-430b-b02c-25173d7eba8a`

<details><summary>Recorded verbatim</summary>

```
Review failed: [Errno 111] Connection refused

```

</details>

---

## `subscription-limit` — 1 occurrence(s)

Subscription allowance exhausted.

**Working as intended** — classified correctly and stated in plain language.

- **2026-08-18 17:35:54** · `lucenity0/Liffy` #258 · 202292ms · `da6a20d7-8501-4957-9634-80090bfa1fad`

<details><summary>Recorded verbatim</summary>

```
Review failed: Claude Code hit its subscription rate limit or quota. Nothing is misconfigured — the account is out of allowance for now. Output: {"is_error": true, "duration_api_ms": 1695, "num_turns": 1, "stop_reason": "stop_sequence", "session_id": "cdfdfc3e-f6e6-4056-9e94-a8d1961d3441", "total_cost_usd": 0.017542000000000002, "usage": {"input_tokens": 0, "cache_creation_input_tokens": 0, "cache_read_input_tok

```

</details>

---

## `cli-missing` — 2 occurrence(s)

Provider CLI not installed on the worker.

**Working as intended** — names the cause and the two ways out.

- **2026-08-01 18:21:45** · `lucenity0/Liffy` #241 · 1631ms · `a561e4db-5a94-4f27-85a0-04a2c2b6ca7d`

- **2026-08-07 23:18:53** · `lucenity0/askcal` #41 · 1489ms · `1b672c7c-26cf-48ca-b9ce-c4ab0169af53`

<details><summary>Recorded verbatim</summary>

```
Review failed: 'codex' is not on PATH. Install the Codex CLI and run `codex login`, or set LLM_PROVIDER to a different provider.

Review failed: 'claude' is not on PATH. Install Claude Code and sign in, or set LLM_PROVIDER to a different provider.

```

</details>

---

## The one still undiagnosed

Three failures carry `stop_reason: stop_sequence` with `is_error: true` and `num_turns: 1`. The presentation is fixed; the *cause* is not understood.

What the recorded rows show, which is more than the old message did:

- `input_tokens: 0`, `output_tokens: 0`, `cache_read_input_tokens: 0` — no tokens were billed either way
- `total_cost_usd` is non-zero on at least one (`0.017608`), so a request did reach the API
- `num_turns: 1` — it stopped on the first turn
- `duration_api_ms` ranges from 0 to 1897 across the three

No marker was added to `_LIMIT_MARKERS` or `_AUTH_MARKERS` for this, deliberately: a confident wrong message is worse than an honest generic one. If the meaning is established later, it is one tuple entry away in `backend/app/llm/chain.py`.

## What changed after this was written

`reviews.summary` was doing three jobs: the one-line description the UI renders for *every* review, the failure record, and a 400-character cap. So a rate-limited run reached the screen as a good plain-language sentence with three hundred characters of truncated JSON welded onto the end.

Migration `f0c3a91b47e2` splits it:

| column | holds | read by |
|---|---|---|
| `summary` | the sentence | the reviews list, and the top of the failure panel |
| `failure_detail` | raw provider output, uncapped | the **View log** disclosure, and a bug report |
| `failure_kind` | `limit` / `auth` / `cli_missing` / `infra` / `unknown` | the panel, to choose between advice and a report |

`unknown` is the load-bearing value. It means nothing we could advise would help, so the panel offers **Report this** — prefilled with the repository and PR — instead of sending someone to check a setting that is fine. An unrecognised kind, and every row written before the migration, falls through to the same path, which is the honest default.

**The migration performs this split itself** — `op.execute` moves the `Output: {…}` tail into `failure_detail`, trims the sentence, and classifies what is left from the wording. It is guarded on the `Output: {` shape rather than on `status='failed'`, so it is idempotent and leaves alone the failures that never had a tail. The downgrade welds the detail back onto `summary` before dropping the column, so going back a revision loses formatting rather than information.

That matters beyond this database: without it, every *other* deployment would keep the welded tail, get NULL in both columns, and see the new panel render raw JSON with no **View log** and an unconditional "Report this" — the exact state the change exists to remove.

The 12 rows here were split by hand before the migration was written, and one extra step was needed that the migration cannot do for anyone else: the raw text of 7 rows had already been replaced by an earlier rewrite, and was restored from the pre-rewrite export this document was built from. Eight rows now have a log to view; no failure summary contains JSON any more.

### Still worth doing

`failure_detail` holds whatever `_cli_failure_blob` assembled, not the full transcript — the raw CLI stdout is still discarded when the subprocess returns. For the `stop_sequence` failures that is probably the difference between diagnosing them and not.
