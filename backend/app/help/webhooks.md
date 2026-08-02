---
title: How a pull request triggers a review
aliases: webhook! / automatic review / trigger / does not trigger / no review on pr
related: review-states, getting-started
---

GitHub sends a webhook when a pull request opens or updates, Liffy verifies the
signature, and queues a review. The review appears on the reviews list within a
few seconds of the event.

If nothing happens when you open a pull request, work down this list:

- Is the repository connected in Liffy, and indexed at least once?
- Does the webhook exist on the repository, pointing at your instance?
- Do the secrets match? `GITHUB_WEBHOOK_SECRET` must be identical in
  `backend/.env` and in the GitHub webhook settings — a mismatch is rejected,
  which is the point.
- Can GitHub reach you? A laptop behind a home router cannot receive webhooks
  without a tunnel.

GitHub records every delivery and its response under the webhook's *Recent
Deliveries* tab, which is the fastest place to see whether the event arrived.

You can always start a review by hand from the review page instead.
