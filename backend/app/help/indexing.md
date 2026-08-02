---
title: What indexing does
aliases: index! / indexing / embeddings / chroma / context / retrieval
related: reindex-after-merge, where-your-code-goes
figure: indexing
---

Indexing reads every file in a repository, splits it into chunks, embeds them,
and stores the vectors in Chroma. When a review runs, Liffy searches that index
for code similar to the diff and puts what it finds in front of the model — so
a review can notice that a change duplicates logic elsewhere, or breaks an
assumption in code the diff never touched.

Embeddings are computed locally by default (`BAAI/bge-small-en-v1.5` via
onnxruntime), so indexing does not send your code anywhere. See *where your
code goes* for what a review does.

Indexing is incremental: chunks are keyed by content hash, so a second run over
an unchanged repository adds nothing and costs almost nothing. A first run over
a large repository is the slow one.

Indexing and reviewing share the worker's two slots, so a large index job can
delay a review by a minute or two.
