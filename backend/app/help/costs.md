---
title: What a review costs
aliases: cost! / price / pricing / how much / billing / expensive / spend / money
related: providers, subscription-providers, token-efficiency, rate-limits
---

It depends entirely on the provider, and Liffy never charges anything itself —
there is no Liffy service to pay for.

- **API providers** bill per token, to your own account. A review sends the
  diff plus retrieved context, so cost scales with the size of the pull request
  rather than the size of the repository.
- **Subscription providers** cost nothing extra if you already pay for Claude
  or ChatGPT. They spend your plan's usage allowance instead of money.
- **A local model** costs electricity.

Two things cost more than people expect. **Re-review is a full review** — it
re-runs the entire pipeline and bills again. And on the subscription providers
the CLI adds its own system prompt and tooling to every call, which is a real
overhead on top of your prompt.

Indexing is free of model cost either way: embeddings are computed locally by
default.

Watch **token efficiency** on the Analytics page rather than raw token counts.
Tokens spent on a review you approved of are not the same as tokens spent on
one you rejected.
