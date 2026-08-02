# Liffy — local setup guide

Everything you need to get Liffy running on your machine, macOS or Windows.
(Moved here from the README to keep the front page readable — nothing was cut.)

---

## Prerequisites

### macOS

Install Homebrew if you don't have it:
```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Install core dependencies:
```bash
brew install postgresql@15 redis python@3.11
brew services start postgresql@15
brew services start redis
```

Install nvm (Node version manager):
```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
```

Restart your terminal, then:
```bash
nvm install 22.12
nvm use 22.12
```

### Windows

**PostgreSQL:**
Download and install from https://www.postgresql.org/download/windows/
- During setup, set a password for the `postgres` user — write it down
- Default port: 5432, leave as-is
- After install, open pgAdmin or psql and create the database (see step below)

**Redis:**
Download the Windows port from https://github.com/tporadowski/redis/releases
- Download the `.msi` installer, run it
- Redis will run as a Windows service automatically

**Python 3.11:**
Download from https://www.python.org/downloads/release/python-3110/
- ✅ Check "Add Python to PATH" during install
- Verify: open Command Prompt and run `python --version`

**Node.js:**
Install nvm for Windows from https://github.com/coreybutler/nvm-windows/releases
- Download `nvm-setup.exe`, run it
- Then in Command Prompt (as Administrator):
```cmd
nvm install 22.12.0
nvm use 22.12.0
```

**Git:**
Download from https://git-scm.com/download/win
- Use default options during install
- Use Git Bash for all commands below

---

## Setup

### 1. Clone the repo

```bash
git clone https://github.com/lucenity0/Liffy.git
cd Liffy
```

### 2. Environment files

Copy the example env file:

**macOS:**
```bash
cp .env.example backend/.env
```

**Windows (Git Bash):**
```bash
cp .env.example backend/.env
```

Open `backend/.env` and fill in your values — see the Environment Variables section below for what each one means. For local dev, the defaults work except for `JWT_SECRET_KEY` which you should set to any random string.

### 3. Create the database

**macOS:**
```bash
createdb liffy
```

**Windows:**
Open Command Prompt and run:
```cmd
psql -U postgres
```
Then inside psql:
```sql
CREATE DATABASE liffy;
\q
```

If your DATABASE_URL needs a password on Windows, update it in `backend/.env`:
```
DATABASE_URL=postgresql://postgres:yourpassword@localhost/liffy
```

### 4. Backend setup

**macOS:**
```bash
cd backend
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

**Windows (Command Prompt):**
```cmd
cd backend
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

**Windows (Git Bash):**
```bash
cd backend
python -m venv .venv
source .venv/Scripts/activate
pip install -r requirements.txt
```

### 5. Run database migrations

Make sure your venv is active, then from the `backend/` directory:

```bash
alembic upgrade head
```

### 6. Frontend setup

```bash
cd ../frontend
npm install
```

---

## Running locally

You need **three terminals** running simultaneously.

### Terminal 1 — FastAPI server

**macOS:**
```bash
cd backend
source .venv/bin/activate
uvicorn app.main:app --reload
```

**Windows:**
```cmd
cd backend
.venv\Scripts\activate
uvicorn app.main:app --reload
```

API runs at: `http://localhost:8000`
Swagger docs at: `http://localhost:8000/docs`

---

### Terminal 2 — Celery worker

**macOS:**
```bash
cd backend
source .venv/bin/activate
celery -A app.workers.celery_app worker --loglevel=info --pool=solo
```

**Windows:**
```cmd
cd backend
.venv\Scripts\activate
celery -A app.workers.celery_app worker --loglevel=info --pool=solo
```

> ⚠️ **macOS and Windows both require `--pool=solo`.** On Windows, Celery's
> default prefork pool is unsupported outright. On macOS it starts but the
> forked child aborts before the task runs — the worker imports chromadb,
> which loads onnxruntime and initialises Objective-C runtime state in the
> parent, and `fork()` after that is unsafe:
>
> ```
> objc[…]: +[NSCharacterSet initialize] may have been in progress in another
> thread when fork() was called. … Crashing instead.
> WorkerLostError: Worker exited prematurely: signal 6 (SIGABRT)
> ```
>
> It surfaces as a lost task rather than an import error, so it reads like a
> bug in the task body. Linux is unaffected — the Docker worker needs no change.

---

### Terminal 3 — Frontend

```bash
cd frontend
npm run dev
```

Frontend runs at: `http://localhost:5173`

---

## Verify everything is working

Once all three terminals are running:

| Check | URL | Expected |
|-------|-----|----------|
| API health | http://localhost:8000 | JSON response |
| Swagger UI | http://localhost:8000/docs | Interactive API docs |
| Frontend | http://localhost:5173 | React app loads |

---

## Running without an API key (Ollama)

Liffy's LLM providers all sit behind one `ReviewLLM` protocol, and
`LLM_PROVIDER=openai` speaks the OpenAI wire format — so it also drives
anything that emulates it, including a local [Ollama](https://ollama.com).
Embeddings are already local by default, so this gives you a complete review
pipeline with **no account, no key, no quota and no billing**, where nothing
leaves your machine.

It needs no code changes.

```bash
brew install ollama            # or https://ollama.com/download
ollama serve &                 # or: brew services start ollama
ollama pull qwen2.5-coder:14b
```

Then in `backend/.env`:

```bash
LLM_PROVIDER=openai
OPENAI_BASE_URL=http://localhost:11434/v1
OPENAI_API_KEY=ollama          # ignored by Ollama, but the client needs non-empty
OPENAI_MODEL=qwen2.5-coder:14b
OPENAI_USE_JSON_SCHEMA=true    # see below — effectively required for local models
EMBEDDING_PROVIDER=local       # already the default
```

### Model size matters more than you would expect

Liffy asks the model for **strict JSON matching a fixed schema**, and comments
whose file or line numbers do not exist in the diff are dropped rather than
shown. Small models fail both bars, and they fail quietly.

Measured on real PR #58 (4 files):

| Setup | Result |
|---|---|
| `qwen2.5-coder:7b`, `json_object` | Failed validation on all 3 attempts — returned valid JSON of its own design, wrapping everything in a `"review"` key with an invented `"strengths"` array |
| `qwen2.5-coder:7b`, `json_schema` | Schema-valid, but every comment cited a file not in the diff — **4 produced, 4 dropped, 0 shown to the user** |
| `claude-opus-5` (API) | Valid on the first attempt, 8 comments, 0 dropped |

So `OPENAI_USE_JSON_SCHEMA=true` is what makes a local model produce the right
*shape* — it constrains generation to the schema instead of merely demanding
valid JSON. It cannot make a model reason well enough to cite real files.

**7B is not enough.** Prefer 14B or larger, and treat an empty review as a
signal that the model is too small rather than that your code is clean. If you
have the memory, a 32B coder model is a better starting point.

> `OPENAI_USE_JSON_SCHEMA` is off by default because support varies across
> OpenAI-compatible endpoints. Ollama and OpenAI implement it; an endpoint that
> does not will reject the request outright rather than silently degrade.

---

## Running on a subscription instead of an API key

If you already pay for Claude or ChatGPT, Liffy can review through the CLI you
have already signed into — no API key and no metered billing. This is the other
way to avoid the ~$0.35-per-PR cost of the API path, and unlike Ollama it does
not need a large model on your own hardware.

```bash
# Claude
npm install -g @anthropic-ai/claude-code && claude   # sign in
# ChatGPT
npm install -g @openai/codex && codex login
```

Then in `backend/.env`, one of:

```bash
LLM_PROVIDER=claude_code
LLM_PROVIDER=codex
```

That is the whole setup **when you run the backend and worker directly on your
machine** — the CLI reads its own credentials from your home directory.

### In Docker

`./liffy.sh` runs the worker in a container, which has no home directory holding
those credentials. Two things change.

**1. The worker image that has the CLIs installed.** `./liffy.sh` uses it always,
not only when a subscription provider is selected, so that switching provider in
the settings page never means a rebuild — the review task re-reads `llm_provider`
from the database at the start of every run, and one worker carrying every CLI is
what makes that enough. By hand it is

```bash
docker compose -f docker-compose.yml -f docker-compose.subscription.yml up --build
```

The CLIs cost roughly 1.6GB of Node on top of the plain worker. If you know you
will only ever use an API-key provider, `LIFFY_SLIM_WORKER=1 ./liffy.sh` builds
without them — at the price of a rebuild the day you change your mind.

**2. Credentials the container can reach**, and this differs per provider.

*Claude Code* takes a token. Mint it on the host:

```bash
claude setup-token          # → CLAUDE_CODE_OAUTH_TOKEN=...
```

Paste it into **Settings → Secrets → Connect** and you are done — it is checked
with Anthropic, stored in Liffy's database, and picked up by the worker on the
next review with no restart. Putting it in `backend/.env` as
`CLAUDE_CODE_OAUTH_TOKEN` still works and takes precedence in the sense that it
is what a disconnect falls back to; use it if you would rather every credential
lived in one file.

*Codex* has no token login. Measured against codex-cli 0.146: there is no auth
environment variable, and `codex login --with-access-token` rejects a ChatGPT
subscription token because it expects an agent-identity JWT. The only thing that
authenticates the CLI is a real `auth.json`, so the container needs the
credential *directory*:

`./liffy.sh` adds `docker-compose.codex.yml` whenever `~/.codex` exists on the
host — not only when Codex is the selected provider, so that selecting it later
needs no restart. That overlay mounts `${HOME}/.codex` read-only at `/codex-auth`
in the backend and worker and sets `CODEX_HOME=/codex-auth`. Inspect that file
before starting if you want to review the credential access. For a manual
Compose invocation, add it as a third file:

```bash
docker compose -f docker-compose.yml \
  -f docker-compose.subscription.yml \
  -f docker-compose.codex.yml up --build
```

That mount lets anything in the worker container read your ChatGPT access,
refresh, and ID tokens — including on runs that never invoke Codex, since the
overlay is applied on the directory existing rather than on the provider being
selected. `:ro` means the CLI cannot refresh them in place either, so when the
token expires you re-run `codex login` on the host. If that trade is not one you
want, `LIFFY_NO_CODEX_MOUNT=1 ./liffy.sh` declines it and you restart when you
switch to Codex; `claude_code` reaches the same place with a revocable token, and
running the worker on the host needs none of it.

Miss any of this and the worker **refuses to start**, with a message naming the
fix. That is deliberate: the previous behaviour was a setting that looked
supported and failed mid-review with a subprocess error.

### Things to know

- **Local, personal use.** One person, their own subscription. Automating a
  subscription for a shared or multi-user deployment falls under different terms
  — read your Anthropic or OpenAI agreement first.
- **No rate-limit contract.** Exhausting the subscription mid-review fails that
  review. Liffy reports it as a limit rather than as a parse error, but it cannot
  prevent it.
- **Not usable in CI.** No Liffy test depends on a signed-in CLI.
- **On an API key, use the API.** Claude Code adds ~17k tokens of its own system
  prompt per call. On a subscription that costs quota; on a key it costs money
  for nothing.

## Environment Variables

All variables go in `backend/.env`. Never commit this file.

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `REDIS_URL` | Yes | Redis connection string |
| `GITHUB_CLIENT_ID` | For auth | From GitHub OAuth App settings |
| `GITHUB_CLIENT_SECRET` | For auth | From GitHub OAuth App settings |
| `GITHUB_WEBHOOK_SECRET` | For webhooks | Any random string, must match GitHub webhook config |
| `JWT_SECRET_KEY` | Yes | Any random string, keep it secret |
| `JWT_ALGORITHM` | Yes | Leave as `HS256` |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | Yes | Leave as `15` |
| `REFRESH_TOKEN_EXPIRE_DAYS` | Yes | Leave as `30` |
| `OPENAI_API_KEY` | For LLM features | From platform.openai.com |
| `CLAUDE_CODE_OAUTH_TOKEN` | `claude_code` in Docker | From `claude setup-token` on the host |
| `CODEX_HOME` | `codex` in Docker | Path the mounted `~/.codex` appears at, e.g. `/codex-auth` |
| `DEBUG` | Yes | `True` for local dev |

### Getting GitHub OAuth credentials

1. Go to https://github.com/settings/developers
2. Click **New OAuth App**
3. Set Homepage URL to `http://localhost:5173`
4. Set Authorization callback URL to `http://localhost:8000/auth/github/callback`
5. Copy Client ID and Client Secret into `backend/.env`

---

## Running tests

```bash
cd backend
source .venv/bin/activate        # macOS
# or .venv\Scripts\activate      # Windows

pytest
```

---

## Common issues

**`celery: command not found`**
Your venv is not active. Run `source .venv/bin/activate` (macOS) or `.venv\Scripts\activate` (Windows) first.

**`createdb: command not found` (macOS)**
PostgreSQL@15 is keg-only and not on PATH. Run:
```bash
export PATH="/opt/homebrew/opt/postgresql@15/bin:$PATH"
```
Add this line to your `~/.zshrc` to make it permanent.

**`psql: error: connection refused` (macOS)**
PostgreSQL service isn't running. Run `brew services start postgresql@15`.

**`connection refused` on DATABASE_URL (Windows)**
Make sure PostgreSQL service is running. Open Services (Win+R → `services.msc`) and check that `postgresql-x64-15` is running.

**Celery worker crashes immediately, or tasks die with `WorkerLostError` (macOS / Windows)**
Add `--pool=solo` to the celery command. Windows does not support the default
prefork pool at all; on macOS the fork is unsafe once onnxruntime has loaded
(see the note in the Celery section above). On macOS the failure looks like
`signal 6 (SIGABRT)` and a lost task, not an import error.

**`Module not found` errors in FastAPI**
Make sure you're running uvicorn from inside the `backend/` directory with the venv active.

**Frontend `npm run dev` fails with Node version error**
You need Node 22.12+. Run `nvm use 22.12` before starting the frontend.

---
