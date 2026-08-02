---
title: Why a review failed
aliases: failed! / failure / error / did not finish / gave up / broken review
related: review-states, re-review, subscription-providers
---

The reason is recorded on the review itself and shown on the failed panel — you
should not need to read container logs to find out what happened.

Common reasons, and what each one means:

- **`'claude' is not on PATH`** — the provider is set to `claude_code` but the
  worker has no Claude Code CLI. In Docker this means the worker is running the
  plain image instead of the subscription one. Start with `./liffy.sh`, which
  selects the right overlay, rather than a bare `docker compose up`.
- **Rate limit or quota** — the subscription or API key is out of allowance.
  Nothing is misconfigured; it resets on its own.
- **`No JSON object found in model output`** — the model replied with something
  that was not the review. Usually worth one re-review.
- **A missing key** — the selected provider has no credential. The settings
  page reports which credentials are set and where they came from.

If the panel shows no reason at all, the review predates the change that
started recording one; re-run it and the failure will explain itself.
