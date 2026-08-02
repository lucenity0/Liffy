---
title: Should I reindex after every merge?
aliases: reindex / re index / after merge / keep index fresh / out of date index
related: indexing, review-states
---

No. Indexing is incremental — it hashes chunk contents and skips everything
unchanged — so reindexing after every merge mostly re-reads files to conclude
there is nothing to do.

Reindex when the answer to "would a review have wanted to see this?" is clearly
yes:

- after a large merge, a refactor, or a rename that moved a lot of code
- after adding a directory the index has never seen
- when reviews start citing context that no longer exists

Otherwise leave it. A slightly stale index costs you a little retrieval quality
on the newest code; a reindex costs a worker slot that a review might want.
