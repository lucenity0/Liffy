---
title: Approval rate, and false positives
aliases: approval rate! / false positive / thumbs / rating quality / accuracy / is it correct
related: rating-comments, analytics, comments-per-review
---

The share of rated comments you gave a thumbs up. The target is above 70%.

It counts **rated** comments only, and the tile shows that denominator beside
the percentage on purpose — a good review with one rating scores 100%, which
means nothing. Read the two together.

Blank means nobody has rated anything yet. That is different from 0%, which
means every rating was negative, and Liffy keeps the two apart deliberately:
reporting "0% approval" for a review nobody has read would be a lie about the
quality of the work.

**False positives are the inverse of this number, not a second measurement.**
A thumbs-down records no reason — Liffy has nowhere to store *why* you
disagreed — so "false positive rate" is exactly one minus the approval rate.
It is shown as a caption rather than its own tile because two tiles would put
the same clicks on screen twice, and between 70% and 80% approval they would
show a pass and a fail for the same data.
