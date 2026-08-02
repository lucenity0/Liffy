---
title: Running a local model with Ollama
aliases: ollama! / local model / offline / self hosted model / lm studio
related: providers, where-your-code-goes
---

Set the provider to `openai` and point its endpoint at your local server —
Ollama speaks the OpenAI wire format, so no separate provider is needed.

The endpoint field is on the settings page. A localhost URL there is what keeps
your code on your own hardware; the page asks you to confirm when you change it
for exactly that reason.

Two things to expect. Small local models are noticeably worse at following the
review schema, which shows up as reviews that fail to parse — Liffy can
constrain generation to the schema where the server supports it, which fixes
most of it. And a model large enough to review well needs enough memory to run
well; an underpowered one produces vague comments rather than wrong ones.
