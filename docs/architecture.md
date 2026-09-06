# Architecture

The map. [`docs/decisions/`](decisions/) says *why* each of these choices was
made; [`docs/llm-pipeline.md`](llm-pipeline.md) says how one review is produced;
this file says how the pieces fit together, which is the thing you need before
reading either.

## The shape of it

Four processes and two stores. Nothing here is optional — a review needs all of
them.

```text
  browser              api                 queue            worker
  ───────              ───                 ─────            ──────
  React SPA  ──HTTP──▶ FastAPI  ──enqueue──▶ Redis ──────────▶ Celery
  (Vite)               (uvicorn)                               │
                          │                                    │
                          ▼                                    ▼
                     PostgreSQL ◀───────────────────────── ChromaDB
                     users, repos, PRs,                    one collection
                     reviews, comments,                    per repository
                     eval scores, settings

  GitHub ──webhook──▶ /webhook/github        worker ──comments──▶ GitHub PR
```

The API never calls a model. Every LLM call and every embedding happens on the
worker, because a review takes minutes and an HTTP request must not — see
[ADR 001](decisions/001-celery-for-async.md).

## Backend, by package

`backend/app/`

| Package | What lives there |
| :--- | :--- |
| `api/` | FastAPI routers, one per surface: `auth`, `repos`, `reviews`, `webhook`, `feedback`, `analytics`, `settings`, `help`. `deps.py` holds the shared dependencies (DB session, current user). Routers validate and delegate; they hold no business logic. |
| `services/` | Where the work happens. `review_service` orchestrates a review, `indexer` + `chunker` build the vector store, `rag_service` retrieves from it, `diff_parser` reads a diff, `github_service` talks to GitHub, `review_publisher` turns a finished review into PR comments, `auth_service` mints and checks tokens, `eval_service` scores reviews after the fact. |
| `workers/` | Celery. `celery_app` is the app and the beat schedule; `review_worker`, `index_worker`, `eval_worker` and `pr_state_worker` are the four tasks. |
| `llm/` | The model seam. `chain.py` (providers + the review chain), `embeddings.py`, `prompts.py`, `output_parser.py`, plus the two subscription-CLI adapters. |
| `models/` | SQLAlchemy tables. |
| `schemas/` | Pydantic request/response shapes. Distinct from `models/` on purpose: the wire format is allowed to differ from the table. |
| `help/` | The 30-page help corpus, markdown with YAML front-matter, served by `help_service`'s in-memory BM25 index. No embeddings, no model — `/help` is search, not a chatbot. |

## A review, end to end

1. **It is asked for.** Either a human presses the button (`POST` through
   `api/reviews.py`) or GitHub delivers a push to `api/webhook.py`, whose HMAC
   is verified against `GITHUB_WEBHOOK_SECRET` before anything else happens.
   `review_service.resolve_repo_owner` decides whose instance this belongs to.
2. **A row is created and a task is queued.** `enqueue_review` puts
   `liffy.review_pr` on Redis. The request returns immediately with a review in
   `pending`; the UI polls.
3. **The worker picks it up.** `review_worker` → `review_service.run_review`.
4. **The diff is fetched and read.** `github_service` pulls it with the
   *signed-in user's own* OAuth token — Liffy has no bot identity —
   and `diff_parser` turns it into per-file diffs.
   `redact_secret_files` drops anything that looks like a credential file
   before it can reach a model.
5. **Context is retrieved.** For each changed file, `rag_service` embeds the
   diff and queries that repository's own Chroma collection for the nearest
   chunks. Collections are per-repo and never shared —
   [ADR 003](decisions/003-per-repo-rag-isolation.md).
6. **The model is called.** `llm/chain.py` builds the prompt from
   `llm/prompts.py`, sends it through whichever provider `get_llm()` selected,
   and `output_parser.py` validates the answer against `LLMReviewOutput`.
   A response that does not validate is retried, not patched.
7. **It is stored, then posted.** Comments land in PostgreSQL. If
   `POST_REVIEWS_TO_GITHUB` is on, `review_publisher` maps the verdict onto a
   GitHub review event and writes the comments back to the PR.
8. **It is scored later.** A weekly beat job runs `eval_worker`, which fills
   `eval_scores` — the numbers behind
   [ADR 008](decisions/008-review-quality-measurement.md).

Indexing is the other half and runs on its own track: `index_worker` →
`indexer.index_repository` → `chunker` → embeddings → Chroma. It runs once when
a repo is connected and then only on change. What it does and does not cover is
measured in [`docs/indexing.md`](indexing.md).

## The provider seam

Both model-facing dependencies sit behind a `typing.Protocol`, and this is the
one structural rule in the backend worth stating outright:

```python
# backend/app/llm/chain.py
class ReviewLLM(Protocol):
    model_name: str
    def complete(self, system: str, user: str) -> LLMResponse: ...

# backend/app/llm/embeddings.py
class EmbeddingProvider(Protocol):
    def embed_texts(self, texts: list[str]) -> list[list[float]]: ...
```

Four implementations satisfy the first — `AnthropicReviewLLM`,
`OpenAIReviewLLM` (which also covers Ollama, Gemini and anything else speaking
the OpenAI wire format), `ClaudeCodeReviewLLM` and `CodexReviewLLM` — and
`get_llm()` is the only place that chooses between them.

**Adding a provider should mean writing one class and a branch in `get_llm()`,
and touching nothing else.** If you find yourself editing `review_service.py` to
add a provider, something has gone wrong; say so in the issue rather than
working around it. The same goes for `get_embedding_provider()`.

One asymmetry worth knowing: `LLMResponse.tokens_used` is `int | None`, and
`None` means *unknown*, not zero. A provider that cannot report usage must
return `None` — a fabricated `0` reads as "this review was free" and silently
corrupts the metrics that divide by it.

## Frontend

`frontend/src/`

| Path | What lives there |
| :--- | :--- |
| `routes.tsx` | React Router v7 route table. Every real route sits behind `RequireAuth` inside `AppShell`. |
| `pages/` | One component per route, each with its `*.test.tsx` beside it. `StyleGuide.tsx` is the living design system at `/_styleguide` in dev. |
| `components/` | Grouped by surface (`dashboard/`, `review/`, `repo/`, `analytics/`, `settings/`, `help/`, `layout/`) plus `ui/`, the primitives. |
| `index.css` | **The design system, and the single source of colour truth.** Five themes as CSS custom properties, the type and spacing scale, the texture utilities. Tailwind v4, CSS-first — there is no `tailwind.config.*`, and Tailwind's default palette is deliberately removed. |
| `lib/` | Non-React logic: `themes.ts`, `colors.ts`, `cafeScene.ts` (the pixel-art canvas illustration). |
| `api/` | The typed client. |

`index.css` reaches further than the app: `build-site.py` parses its theme
blocks and substitutes them into the marketing pages, so the front door and the
product are guaranteed the same ink. Changing a palette token changes both.

## The static site

Not a framework. `docs/landing.src.html`, `docs/report.src.html` and
`docs/404.src.html` are hand-authored body fragments; a local generator wraps
each in a shared `<head>`, substitutes the fonts and the palette, and writes
`frontend/public/*.html`, which is what ships. The generated files say
"GENERATED FILE — do not edit" at the top and mean it: edit the `.src.html`.

## Where to look first

| If you are changing… | Start at |
| :--- | :--- |
| What a review says | `llm/prompts.py`, then [ADR 005](decisions/005-prompt-iteration.md) and [ADR 006](decisions/006-review-quality-mechanisms.md) |
| What gets retrieved | `services/chunker.py`, `services/rag_service.py`, [`docs/indexing.md`](indexing.md) |
| Adding a model provider | `llm/chain.py` only — see the provider seam above |
| How a review reaches the PR | `services/review_publisher.py` |
| Anything visual | `frontend/src/index.css` and `/_styleguide` |
| An endpoint | `api/`, then [`docs/api.md`](api.md) |
| Why a review failed | [`docs/failure-modes.md`](failure-modes.md) |
