---
title: Where your code goes
aliases: privacy! / data / send my code / who sees my code / confidential / leave my machine
related: providers, indexing, ollama
---

It depends on one setting, and it is worth knowing which side of the line you
are on.

**Indexing and embeddings stay local.** The default embedding model runs on your
own machine, so building the index sends nothing anywhere.

**Reviews go wherever the provider is.** A review sends the diff plus the code
chunks retrieved from your index to the model. With `anthropic`, `openai`,
`claude_code` or `codex`, that means the diff and selected source leave your
machine and reach that provider.

**With a local model, nothing leaves.** Point the `openai` provider's endpoint
at Ollama on your own hardware and the whole pipeline — index, retrieval,
review — stays on the machine.

Liffy is self-hosted. There is no Liffy-operated server and the maintainers hold
none of your data; every deployment belongs to whoever runs it.
