---
title: Time to review, and queue wait
aliases: time to review! / how long / speed / latency / slow / duration / queue wait
related: analytics, review-states, subscription-providers
---

Measured from the moment the webhook arrives to the moment the review
completes, against a target of under 90 seconds.

Only webhook-triggered reviews carry it. A manual trigger or a re-review has no
webhook receipt to measure from, and Liffy will not substitute the pipeline
clock — that would report an internal duration as an end-to-end one and
flatter the number.

**Pipeline alone** is shown beside it. That is the same review measured from
inside the worker, so it cannot see the time the job spent waiting in the
queue. The difference between the two *is* the queue wait, and it is the number
that says whether a missed target is Liffy's pipeline or a busy worker.

The 90-second target assumes an API provider. The subscription providers drive
a local CLI and are much slower — several minutes on a large pull request is
normal there, and a miss against this target on `claude_code` says more about
the provider than about Liffy.
