---
title: How comments reach your pull request
aliases: inline comments! / posting comments / github comments / wrong line / no comments posted
related: how-liffy-works, review-failed, settings-and-env
---

Liffy posts its review as comments on the pull request, anchored to the lines
the model cited.

A comment can only be attached to a line that appears in the diff — that is
GitHub's rule, not Liffy's. Anything the model says about code outside the diff
is kept in the review summary instead of being dropped.

The model is given the real line numbers in the left gutter of every hunk and
told to copy them rather than count. A correct finding on the wrong line reads
to the author as a wrong finding, which is worse than no finding at all.

If reviews complete in Liffy but nothing appears on GitHub, check whether
posting is enabled in settings, and whether your GitHub token still has write
access to that repository. Reviews are always readable in Liffy either way.
