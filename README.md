<div align="center">
  <img src="./assets/header.svg" alt="Liffy — AI-powered peer code review, self-hosted" width="100%" />
</div>

<br />

```text
~ $ cat liffy.txt
──────────────────────────────────────────────────
  your AI senior engineer  ·  open source  ·  self-hosted
  connects to github, reads your pull requests, and
  writes structured, senior-engineer-level feedback.
  your repos, your llm keys, your infrastructure.
──────────────────────────────────────────────────
```

<img src="./assets/divider.svg" width="100%" alt="" />

### `// features`

**Reads PRs like a person** — pulls the diff, walks the changed files, and leaves line-anchored comments: what's wrong, why it matters, and how to fix it.
<br /><sub>`diff parsing` · `structured output` · `severity levels`</sub>

**RAG over your codebase** — indexes your repo into a vector store so reviews are grounded in *your* conventions and surrounding code, not generic advice.
<br /><sub>`ChromaDB` · `embeddings` · `LangChain chains`</sub>

**Runs without an API key** — point it at a local Ollama and the whole pipeline is free: no account, no quota, no billing, nothing leaving your machine. Embeddings are already local by default. Or bring a key and use Claude, Gemini's free tier, or your own Claude Code subscription.
<br /><sub>`local models` · `BYO LLM` · `prompt caching`</sub>

**GitHub-native** — OAuth sign-in, webhook-triggered reviews on every push, feedback posted right where you already argue about code.
<br /><sub>`OAuth` · `webhooks` · `HMAC-verified`</sub>

**Async by design** — reviews run as background jobs, so a 40-file PR doesn't block anything. Watch it work from the dashboard.
<br /><sub>`Celery` · `Redis` · `job status`</sub>

**One-command setup** — bootstrap scripts for macOS *and* Windows get you from clone to running in minutes.

<img src="./assets/divider.svg" width="100%" alt="" />

### `// how it works`

```text
push to PR ──▶ github webhook ──▶ celery queue
                                      │
              chroma (your codebase) ─┼─▶ RAG context
                                      ▼
                            llm review chain
                                      │
                                      ▼
              structured feedback ──▶ posted to the PR
```

<img src="./assets/divider.svg" width="100%" alt="" />

### `// stack`

`FastAPI` &nbsp;`Celery` &nbsp;`PostgreSQL` &nbsp;`Redis` &nbsp;·&nbsp; `React` &nbsp;`TypeScript` &nbsp;`Vite` &nbsp;`Tailwind` &nbsp;·&nbsp; `ChromaDB` &nbsp;`LangChain`

```text
liffy/
├── backend/      FastAPI + Celery + PostgreSQL + Redis
├── frontend/     React + TypeScript + Vite + Tailwind
├── chroma/       ChromaDB vector store (gitignored, auto-created)
└── docs/         Setup guide, architecture decisions, API reference
```

<img src="./assets/divider.svg" width="100%" alt="" />

### `// quickstart`

```bash
git clone https://github.com/lucenity0/Liffy.git
cd Liffy
```

**One command, everything in Docker.** Needs Docker Desktop and Node — no
Postgres, Redis, or Python on your machine. The launcher creates `backend/.env`
with a generated JWT secret on first run.

```bash
./liffy.sh          # macOS / Linux
```
```cmd
liffy               :: Windows
```

Both take the same subcommands: `down` to stop, `logs` to tail, `check` to
confirm your repo data survived a rebuild. On Windows `liffy.bat` is a shim
around `liffy.ps1` — use it rather than the `.ps1` directly, or PowerShell's
execution policy blocks the script before it starts.

**Or run the services yourself** — `cp .env.example backend/.env`, fill in your
keys, then three terminals (from the right directories, with the backend venv
active):
- `cd backend && uvicorn app.main:app --reload`
- `cd backend && celery -A app.workers.celery_app worker --loglevel=info` (macOS and Windows: add `--pool=solo`)
- `cd frontend && npm run dev`

Full walkthrough (macOS + Windows, prerequisites, env vars, common issues): **[docs/SETUP.md](docs/SETUP.md)**

<img src="./assets/divider.svg" width="100%" alt="" />

### `// choosing a model`

Every provider sits behind one `ReviewLLM` protocol, so switching is config, not code.

| Provider | Cost | Account | `LLM_PROVIDER` |
|---|---|---|---|
| **Ollama** (local) | free | **none** | `openai` + `OPENAI_BASE_URL=http://localhost:11434/v1` |
| **Gemini** free tier | free | free Google account | `openai` + Gemini's compat URL |
| **Claude Code** | your subscription | one you already pay for | `claude_code` |
| **Codex** | your subscription | one you already pay for | `codex` |
| **Anthropic API** | metered | API key | `anthropic` *(default)* |

Embeddings are local by default and never need a key, whichever LLM you pick.

> **On local models:** Liffy asks for strict JSON matching a fixed schema, and small models struggle with it. `qwen2.5-coder:7b` was measured returning comments anchored to files that aren't in the diff — every one gets dropped, leaving an empty review. Set `OPENAI_USE_JSON_SCHEMA=true` to constrain generation to the schema, and prefer a larger model. See **[docs/SETUP.md](docs/SETUP.md#running-without-an-api-key-ollama)**.

<img src="./assets/divider.svg" width="100%" alt="" />

### `// reviewing on a subscription you already pay for`

The honest number: the first live run at `high` effort cost **~$0.35 for a single
pull request**. If you are just trying Liffy out, that is a real reason not to.

`LLM_PROVIDER=claude_code` and `LLM_PROVIDER=codex` remove that cost entirely.
Both drive a CLI you have already signed into, so the review runs against your
Claude or ChatGPT subscription — no API key, no metered billing, nothing to top
up.

**Running Liffy directly on your machine** — install the CLI, sign in, set
`LLM_PROVIDER`, done. The CLI reads its own credentials from your home directory
and Liffy never touches them.

**Running Liffy through `./liffy.sh`** — `liffy` on Windows — (Docker) needs one
extra step, because the worker container has no home directory holding those
credentials. The launcher always builds the worker image with both CLIs installed
— so changing provider in the settings page applies to the next review with no
restart, and no rebuild. By hand that is

```bash
docker compose -f docker-compose.yml -f docker-compose.subscription.yml up --build
```

For **`claude_code`**, mint a token on the host:

```bash
claude setup-token          # → CLAUDE_CODE_OAUTH_TOKEN=...
```

Then either paste it into **Settings → Secrets → Connect**, which stores it in
Liffy and applies from the next review, or put it in `backend/.env` if you would
rather keep every credential in one file. The CLI's login is a browser flow with
no headless mode, so the one command is unavoidable either way — what the page
saves you is the dotfile edit and the restart.

For **`codex`**, there is no equivalent — and that is worth being clear about
rather than papering over. The Codex CLI has no auth environment variable, and
`codex login --with-access-token` refuses a ChatGPT subscription token. The only
thing that authenticates it is a real `auth.json`, so containerised Codex needs
`~/.codex` mounted into the worker. The launcher adds `docker-compose.codex.yml`
whenever that directory exists on the host — which is what keeps a switch to
Codex restart-free, and also means the worker can read your ChatGPT tokens on
runs that never touch Codex. Inspect that file before starting if you want to
review the access, or decline it with `LIFFY_NO_CODEX_MOUNT=1`. For a manual
Compose invocation, add it as a third `-f` file. Running the worker on the host
avoids the mount entirely.

Either way, a missing credential **fails at startup with a message naming the fix**
— not forty seconds into a queued review.

**What these providers are for.** They are for local, personal use: one person,
their own subscription, their own machine. Pointing a subscription at a shared or
multi-user deployment is a different thing under different terms — check your
Anthropic or OpenAI subscription agreement before doing it. Liffy will not stop
you and does not encourage it.

**They are also unavailable in CI.** No test depends on a signed-in CLI, and none
should: every subscription-provider test in `backend/tests/test_llm_chain.py` runs
against captured output.

**Two caveats worth knowing.** Neither CLI offers a rate-limit contract, so
exhausting your subscription mid-review surfaces as a failed review — Liffy names
that case specifically rather than reporting it as a parse error. And Claude Code
injects its own system prompt on every call (~17k tokens of overhead); on a
subscription that spends quota rather than money, which is the trade. On an API
key, calling the API directly is strictly better.

<img src="./assets/divider.svg" width="100%" alt="" />

### `// where your code goes`

Liffy is self-hosted, so there is no Liffy server and no account: **the maintainers
never receive your code, and neither does any Liffy-operated service, because none
exists.** Everything runs on infrastructure you control.

Whether your code leaves your machine at all is decided by one setting —
`LLM_PROVIDER`.

| `LLM_PROVIDER` | Does your code leave your machine? |
|---|---|
| **Ollama** (local, via `openai` + a localhost `OPENAI_BASE_URL`) | **No.** The model runs on your hardware. Liffy makes no outbound request carrying your code. Works with no network at all. |
| **Gemini** (`openai` + Gemini's compat URL) | **Yes** — to Google, under [their terms](https://ai.google.dev/gemini-api/terms). Note that free-tier Gemini may be used to improve their models. |
| **Anthropic** (`anthropic`) | **Yes** — to Anthropic, under [their terms](https://www.anthropic.com/legal/commercial-terms). |
| **Claude Code** (`claude_code`) | **Yes** — the CLI runs locally but still calls Anthropic, under your existing subscription's terms. Running locally is not the same as staying local. |
| **Codex** (`codex`) | **Yes** — to OpenAI, under your existing ChatGPT subscription's terms. Same caveat as Claude Code: a local CLI is still a network call. |

**Embeddings are always local.** The `local` embedding provider is the default and
runs on your machine, so indexing your codebase never sends anything anywhere,
whichever review model you choose.

<details>
<summary><sub>what exactly gets sent, when you use a hosted provider</sub></summary>

<br />

Per review, once, at review time:

- the pull request title
- the **diff** — the actual added and removed lines of the changed files
- the **retrieved context** — a handful of chunks of your existing source code
  that the index matched as relevant, which by design are files *not* in the
  diff (that is the entire point of the retrieval step)

Not sent: your GitHub token, your other repositories, your `.env`, or any part of
the codebase the retrieval step did not select.

Your repositories are indexed into a vector store on your own disk
(`chroma/`, gitignored). That index never leaves the machine.

</details>

If you are reviewing proprietary code and cannot send it to a third party, use
Ollama. That path is free, needs no account, and is the reason it is supported.

<img src="./assets/divider.svg" width="100%" alt="" />

### `// contributing`

PR-based workflow — no direct pushes to `main`.

```text
branch    feat/… · fix/… · chore/… · docs/…
commits   feat: add github webhook endpoint
rules     1 approval min · CI green · small PRs · say what/why/how-to-test
```

Full guide, including the exact commands CI runs: **[CONTRIBUTING.md](CONTRIBUTING.md)**

Found a security problem? Please don't open a public issue — see **[SECURITY.md](SECURITY.md)**.

<img src="./assets/divider.svg" width="100%" alt="" />

### `// docs`

**[ setup ](docs/SETUP.md)** &nbsp;·&nbsp; **[ api reference ](docs/api.md)** &nbsp;·&nbsp; **[ llm pipeline ](docs/llm-pipeline.md)** &nbsp;·&nbsp; **[ indexing coverage ](docs/indexing.md)** &nbsp;·&nbsp; **[ decisions ](docs/decisions/)**

<br />

<div align="center"><sub><a href="LICENSE">MIT licensed</a> &nbsp;·&nbsp; <a href="CONTRIBUTING.md">contributing</a> &nbsp;·&nbsp; <a href="SECURITY.md">security policy</a></sub></div>

<br />

<div align="center"><sub>built by <a href="https://github.com/lucenity0">@lucenity0</a> · self-hosted · run it against a local model and your code never leaves your machine</sub></div>
