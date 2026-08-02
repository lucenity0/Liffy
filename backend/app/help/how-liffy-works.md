---
title: How Liffy works
aliases: how it works! / what does liffy do / overview / pipeline / explain liffy / what happens
related: indexing, webhooks, providers, pr-comments
figure: how-it-works
---

You do step one. Liffy does the rest.

**Connect a repo.** Point Liffy at a repository you can access on GitHub.

**It reads everything.** Every file is chunked, embedded, and stored so Liffy
can find code related to a change later. This is the step that makes the
difference — a reviewer that has read the whole codebase notices things a
reviewer looking only at the diff cannot.

**A PR arrives.** GitHub sends a webhook. Liffy fetches the diff, searches its
index for code related to what changed, sends both to the model, and posts the
comments back on the pull request.

**You score it.** A thumbs up or down on each comment. That is what the
Analytics page measures, and it is the only way Liffy knows whether it is
being useful.

The part worth understanding is the third step. Two files that never mention
each other can still depend on each other, and a diff alone cannot show that.
Retrieval is what lets a comment say "this breaks the assumption in
`billing.py`" about a file the pull request never touched.
