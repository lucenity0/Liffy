# Authoring the help corpus

Every `.md` file here is one page, answering one question. The search over them
is lexical — it matches words, not meaning — so the words you choose *are* the
retrieval. There is no model to paper over a gap.

## The shape of a file

```markdown
---
title: Queued vs processing
aliases: queued / pending / stuck / waiting / not starting!
related: re-review, worker-concurrency
---

Prose. The whole body is shown in the reading pane, rendered as markdown.
```

`title` — sentence case, and it must read as the answer to a question rather
than as a category. "Queued vs processing" beats "Review states".

`aliases` — `/`-separated phrases this page answers to. This is the vocabulary
lesson: write the words a confused person types, not the words the codebase
uses. Someone whose review is stuck types "stuck", never "lifecycle".

`related` — comma-separated slugs, shown as links under the passage.

## Two rules that matter

**A word should belong to one page.** If "token" appears in the aliases of both
the credential page and the token-accounting page, both rank for it and neither
wins convincingly. Give the word to whichever page most askers mean.

**Mark the owner with `!` when a word genuinely is contested.** `queued!` on
this page means: when someone types "queued", this is the page they want, even
if another page mentions the word more often. Use it sparingly — it outranks
frequency, which is a big hammer.

## Writing the body

Answer in the first sentence. The list pane shows the opening ~180 characters
of every match, so a page that clears its throat first is a page whose snippet
says nothing.

Prefer what someone can *do* over what is true. "Reviews can sit in queued for
a minute or two while an indexing job holds a worker slot" is useful; "the
worker uses a prefork pool" is trivia.

Fifteen good pages beat sixty stubs. If you cannot write a real answer, the
honest state is no page — the search says "nothing matched", which is true and
sends people to the docs, rather than a stub that wastes the one search they
were willing to try.
