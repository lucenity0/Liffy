---
title: Re-running a review
aliases: re review / rerun / retry / run again / try again
related: review-failed, review-states
---

**Re-review** runs the whole pipeline again from the start: fetch the diff,
retrieve context from the index, call the model, parse the result, post the
comments. It does not resume a failed run and does not reuse anything from it.

That matters for cost. A re-review is a full review — on an API provider it
bills again, and on a subscription provider it spends quota again. If a review
failed for a reason that will not have changed (no credential, provider not
installed), fix that first; re-running it will fail the same way.

It also creates a *new* review rather than reviving the old one, so the failed
attempt stays in the list as a record of what happened.
