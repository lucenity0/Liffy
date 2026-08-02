---
title: Comments per review, and what kinds
aliases: comments per review! / how many comments / too many comments / category distribution / severity / noisy
related: analytics, approval-rate, rating-comments
---

Total comments divided by completed reviews, with the category breakdown beside
it.

**There is no target, deliberately.** A low number on clean code is the system
working; the same number on a broken pull request is the system missing things.
No threshold can tell those apart, so this is a figure to watch rather than a
score to pass.

Reviews that found nothing count in the denominator. An empty review on clean
code is the right answer, not a miss, and excluding them would quietly inflate
the average.

The categories are the ones the model is asked to use: logic errors, security,
performance, architecture, convention, and improvement. A distribution heavy in
`improvement` and light in `logic_error` usually means the model is padding —
which is worth knowing, and is exactly the kind of thing the shape shows and
the count does not.
