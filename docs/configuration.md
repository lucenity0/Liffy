# Configuration

Every environment variable Liffy reads, grouped by what it is for.

**This is a map, not the reference.** `backend/.env.example` is the canonical
per-variable documentation — it carries the defaults, the generator commands,
and the reasons behind the awkward ones, right next to the values you are
editing. Restating that here would give you two copies to keep in step and no
way to tell which one had drifted, so this page deliberately does not.

What it gives you instead is the thing `.env.example` cannot: the shape. Which
variables exist, which group they belong to, and — the part that actually costs
people an afternoon — **which ones you need for the path you have chosen**.

Copy the templates first:

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
```

`./liffy.sh` (or `liffy.ps1` on Windows) does this on a fresh clone and
generates the two secrets for you.

## Backend — `backend/.env`

### Stores

| Variable | For |
| :--- | :--- |
| `DATABASE_URL` | PostgreSQL. Users, repos, PRs, reviews, comments, eval scores, settings. |
| `REDIS_URL` | The Celery broker. |

Chroma is not configured here — it is a directory on disk (`chroma/`), by
[ADR 002](decisions/002-chroma-over-pinecone.md).

### GitHub OAuth — required to sign in at all

| Variable | For |
| :--- | :--- |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | The OAuth App. |
| `GITHUB_REDIRECT_URI` | Must **byte-match** the callback URL on the OAuth App: same scheme, host, port and path, no trailing slash. Also decides whether the built-in development JWT secret is allowed. |
| `FRONTEND_URL` | Where the callback hands the browser back to. Must be where the SPA is served. |
| `ALLOWED_GITHUB_LOGINS` | Extra logins permitted besides the owner. Liffy is single-tenant — the first account through the handshake claims the instance ([ADR 007](decisions/007-single-tenant-security-model.md)). Empty means owner only. |
| `GITHUB_TOKEN` | **Not used.** Kept so an existing `.env` does not look broken. Every request to GitHub is made with the signed-in user's own OAuth token. |

### Webhooks — required for automatic reviews on push

| Variable | For |
| :--- | :--- |
| `GITHUB_WEBHOOK_SECRET` | Until it is set, `/webhook/github` answers 503 and refuses every delivery. An empty value is not "no verification" — it is HMAC with an empty key, which anyone can forge. The same value goes into the webhook's settings on GitHub. |

Manual reviews from the dashboard work without this. Only push-triggered ones
need it.

### Auth and tokens

| Variable | For |
| :--- | :--- |
| `JWT_SECRET_KEY` | At least 32 bytes. The app refuses to mint tokens with a shorter key, and refuses to start at all on the built-in dev default once `GITHUB_REDIRECT_URI` points anywhere but localhost. |
| `JWT_ALGORITHM` | HS256. |
| `ACCESS_TOKEN_EXPIRE_MINUTES`, `REFRESH_TOKEN_EXPIRE_DAYS` | Token lifetimes. |

### Review LLM — pick one path

`LLM_PROVIDER` selects the transport, and it is the only variable in this file
that changes which of the others you need:

| `LLM_PROVIDER` | Also needs | Costs |
| :--- | :--- | :--- |
| `anthropic` *(default)* | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `ANTHROPIC_EFFORT` | Metered API billing |
| `openai` | `OPENAI_API_KEY`, `OPENAI_MODEL`; `OPENAI_BASE_URL` for anything that is not OpenAI itself | Depends where you point it |
| `openai` → **local Ollama** | `OPENAI_BASE_URL=http://localhost:11434/v1`, `OPENAI_API_KEY=ollama`, a coder model, `OPENAI_USE_JSON_SCHEMA=true` | **Nothing.** No account, offline |
| `claude_code` | Nothing — drives the Claude Code CLI you are already signed into | Your existing subscription |
| `codex` | Nothing — drives the Codex CLI you are already signed into | Your existing subscription |

Shared across all four: `LLM_MAX_TOKENS`.

Three things worth knowing before you pick:

- **The two CLI providers need no key at all.** They drive a locally installed,
  already-signed-in CLI. In Docker they need extra mounting, and `codex` has no
  token to hand it — `./liffy.sh` handles both. Read the notes in
  `.env.example` before running either in a container.
- **`openai` covers more than OpenAI.** Ollama and Gemini both speak the wire
  format. `OPENAI_BASE_URL_ALLOWED` is the allowlist that decides which
  endpoints your code may be sent to; a rejected value refuses the review
  rather than quietly falling back to the OpenAI default.
- **A 7B model is too small.** It cites files that are not in the diff. The
  `.env.example` note names the sizes that work.

### Embeddings

| Variable | For |
| :--- | :--- |
| `EMBEDDING_PROVIDER` | `local` (default) runs `BAAI/bge-small-en-v1.5` in-process: no key, no quota, no billing. First use downloads ~90 MB. |
| `LOCAL_EMBEDDING_MODEL` | Which local model, when `local`. |
| `EMBEDDING_MODEL` | Which remote model, when `openai`. |

**Switching provider is not free.** The vector dimension changes (384 vs 1536),
so it requires dropping the Chroma collection and re-indexing every repo. There
is no migration path. Embeddings stay local by default whatever you choose for
the review model — so even on a paid provider, your code is only ever sent to
one place.

### Serving

| Variable | For |
| :--- | :--- |
| `DEBUG` | Controls whether the OAuth state cookie is marked `Secure`, so it must stay `True` when serving over plain HTTP. It does **not** license the development JWT secret — `GITHUB_REDIRECT_URI` decides that. |
| `CORS_ORIGINS` | Comma-separated origins allowed to call the API. The Vite dev server, in development. |

### Posting reviews back to GitHub

| Variable | For |
| :--- | :--- |
| `POST_REVIEWS_TO_GITHUB` | **Off by default.** Writing to somebody's pull request is not something a merge should silently switch on. |
| `GITHUB_REVIEW_EVENT_MODE` | `comment_only` (default) posts every review as a COMMENT. `native` sends approve / request_changes as real GitHub review events — which blocks a human's merge, so it is opt-in. |

## Frontend — `frontend/.env`

| Variable | For |
| :--- | :--- |
| `VITE_API_BASE_URL` | Where the API is. Usually the only one you touch. |
| `VITE_USE_MSW` | `true` runs the UI against MSW fixtures with no backend at all — useful for frontend work and for the tests. |

## The minimum that works

A local instance that reviews on demand, costs nothing, and never sends your
code anywhere:

```bash
DATABASE_URL=…            # your local postgres
REDIS_URL=…               # your local redis
GITHUB_CLIENT_ID=…        # from your own OAuth App
GITHUB_CLIENT_SECRET=…
JWT_SECRET_KEY=…          # python -c "import secrets; print(secrets.token_urlsafe(48))"
LLM_PROVIDER=claude_code  # or codex, or openai against a local Ollama
EMBEDDING_PROVIDER=local
```

Everything else has a working default. Add `GITHUB_WEBHOOK_SECRET` when you want
reviews to fire on push, and `POST_REVIEWS_TO_GITHUB=True` when you want them to
land on the pull request.

## See also

- [`docs/SETUP.md`](SETUP.md) — the full macOS and Windows walkthrough, and the errors people usually hit
- [`docs/architecture.md`](architecture.md) — what all of this is configuring
- [`README.md`](../README.md#-choosing-a-model) — the longer argument about which model to run
