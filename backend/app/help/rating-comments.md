---
title: Rating a comment, and why it matters
aliases: rating! / thumbs up / thumbs down / score a comment / feedback on comments / vote
related: approval-rate, analytics
---

Every comment has a thumbs up and a thumbs down. That rating is the only signal
Liffy has about whether it is being useful.

Nothing about a rating is shared. There is no Liffy server, so it goes in your
own database and feeds your own Analytics page.

Your rating is yours: the API returns *your* rating on a comment and never
anyone else's. Re-rating replaces the previous one rather than adding to it.

A thumbs-down records no reason. That is a deliberate limit rather than an
oversight — it keeps the rating a single honest click instead of a form nobody
fills in — but it is why the false-positive rate is only the inverse of the
approval rate, and why a run of thumbs-downs tells you *that* something is
wrong without telling you what.
