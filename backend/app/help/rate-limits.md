---
title: Rate limits and quota
aliases: rate limit! / quota / usage limit / out of allowance / limit reached
related: review-failed, subscription-providers, providers
---

A review that fails with a limit message is not misconfigured. The account is
out of allowance for the moment and the limit resets on its own — Liffy reports
this separately from a real error precisely so you can tell "wait" apart from
"something is broken".

On a subscription provider the limit is your plan's usage window. On an API key
it is either a rate limit (requests too close together) or spent credits.

Retrying immediately spends more of the same allowance, so it rarely helps. If
you need a review now, switch provider on the settings page — the change applies
to the next review.
