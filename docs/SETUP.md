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

