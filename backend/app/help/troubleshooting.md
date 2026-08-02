---
title: Nothing is working — where do I start?
aliases: troubleshooting! / broken / nothing works / debug / diagnose / start here
related: review-failed, webhooks, signing-in, getting-started
---

Work outward from the thing that is quiet.

**Nothing happens when a PR opens.** The webhook is not arriving. Check the
repository's *Recent Deliveries* on GitHub — it records every attempt and the
response.

**Reviews queue but never start.** The worker is not running. `docker compose
ps` should show `worker` as `Up`.

**Reviews fail immediately.** The reason is on the review itself. A missing
credential and a missing CLI both look like "failed" from the list and are
completely different fixes.

**Reviews succeed but nothing appears on GitHub.** Posting is disabled, or the
token lost write access.

**Comments are vague or wrong.** The repository is probably not indexed, so the
model is reviewing the diff with no context.

`./liffy.sh check` reports what is configured and what is missing, which is
usually faster than any of the above.
