---
title: Queued vs processing
aliases: queued! / pending / stuck / waiting / not starting / nothing happening
related: review-failed, re-review, indexing
---

A review sits in **queued** until a worker picks it up, then moves to
**processing** while it runs. Both are normal; neither means anything is wrong.

Queued for a minute or two is expected on a busy worker. Liffy runs the worker
with a concurrency of 2, and a repository indexing job can hold one of those
slots for a while, so a review triggered just after a reindex waits its turn.

The review page updates itself every 3 seconds while a review is queued or
processing — there is no refresh button because there is nothing to refresh.

How long processing takes depends entirely on the provider. An API provider
usually finishes in well under a minute. The subscription providers
(`claude_code`, `codex`) drive a local CLI and are much slower: on a large pull
request the CLI alone can take four minutes, on top of a minute or two spent
fetching the diff and retrieving context. Six minutes there is a healthy run,
not a stuck one.

If it never leaves queued, the worker is not running. Check it with
`docker compose ps` — the `worker` service should be `Up`.
