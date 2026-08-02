---
title: Choosing a model provider
aliases: provider! / llm provider / which model / switch model / change model
related: subscription-providers, where-your-code-goes, ollama
---

The provider decides who runs the model that writes your review. Set it on the
settings page — the model dropdown then offers what that provider actually has,
so there is no way to pair a provider with a model it does not know.

- **`anthropic`** — Claude via an API key, billed to Anthropic Console credits.
- **`openai`** — OpenAI, or anything OpenAI-compatible. Pointing its endpoint at
  a local server is how you run Ollama.
- **`claude_code`** — the Claude Code CLI, on your own Claude subscription
  rather than credits.
- **`codex`** — the Codex CLI, on a ChatGPT subscription.

The API providers are fastest and simplest. The subscription providers cost no
money if you already pay for the subscription, but they are slower and they
need the CLI installed where the worker runs.

Changing the provider takes effect on the next review. Nothing re-runs
automatically.
