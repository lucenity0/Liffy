---
title: The Dashboard
aliases: dashboard! / home page / front page / repo list / what am i looking at
related: connecting-a-repo, indexing, reviews-list
---

The dashboard is your repositories and the state of each one.

Each repository shows whether it has been indexed, when, and how many chunks it
holds. A chunk count of zero on a repository that claims to be indexed means
the run found nothing indexable — usually a repository of files Liffy skips.

**Skipped files** are called out separately when the last index run failed to
read some. That matters because the index is then *partial*: reviews touching
those files retrieve no context and quietly get worse, which is exactly the
kind of degradation that is invisible unless something says so.

A dash rather than a zero means never measured, not measured-as-none.
