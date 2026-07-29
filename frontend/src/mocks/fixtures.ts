import type {
  RepoOut,
  RepoStatusOut,
  ReviewCommentOut,
  ReviewDetailOut,
  ReviewListItem,
} from "@/types/api";

/**
 * Shared fixtures for MSW handlers and component tests. Timestamps carry an
 * explicit `Z` — see `ensureUtc` in lib/utils.ts for why that matters.
 */

export const fixtureRepoIndexed: RepoOut = {
  id: "11111111-1111-1111-1111-111111111111",
  full_name: "lucenity0/Liffy",
  default_branch: "main",
  indexed_at: "2026-07-20T10:00:00Z",
  created_at: "2026-07-01T09:00:00Z",
};

export const fixtureRepoIndexing: RepoOut = {
  id: "22222222-2222-2222-2222-222222222222",
  full_name: "lucenity0/portfolio",
  default_branch: "main",
  indexed_at: null,
  created_at: "2026-07-24T12:00:00Z",
};

export const fixtureRepos: RepoOut[] = [fixtureRepoIndexed, fixtureRepoIndexing];

export const fixtureRepoStatusIndexed: RepoStatusOut = {
  id: fixtureRepoIndexed.id,
  full_name: fixtureRepoIndexed.full_name,
  status: "indexed",
  indexed_at: fixtureRepoIndexed.indexed_at,
  chunk_count: 176,
};

export const fixtureRepoStatusNotIndexed: RepoStatusOut = {
  id: fixtureRepoIndexing.id,
  full_name: fixtureRepoIndexing.full_name,
  status: "not_indexed",
  indexed_at: null,
  chunk_count: 0,
};

// The real unified diff of lucenity0/Liffy#58, so the Monaco viewer renders
// actual code and the comment glyphs anchor to real line numbers.
const REAL_DIFF = `diff --git a/backend/requirements-dev.txt b/backend/requirements-dev.txt
new file mode 100644
index 0000000..41a565b
--- /dev/null
+++ b/backend/requirements-dev.txt
@@ -0,0 +1,20 @@
+# Install with: pip install -r requirements-dev.txt
+# Assumes requirements.txt is already installed.
+
+-r requirements.txt
+
+# ── Testing ────────────────────────────────────────────────────────────────────
+pytest==8.3.3
+pytest-asyncio==0.24.0
+pytest-cov==6.0.0
+httpx==0.27.2                    # AsyncClient for FastAPI test client
+factory-boy==3.3.1               # Test fixtures / model factories
+
+# ── Linting & formatting ───────────────────────────────────────────────────────
+ruff==0.8.2
+black==24.10.0
+
+# ── Type checking ──────────────────────────────────────────────────────────────
+mypy==1.13.0
+types-passlib==1.7.7.20240819
+types-python-jose==3.3.4.20240106
diff --git a/backend/requirements.txt b/backend/requirements.txt
index 1c1cba5..689f88a 100644
--- a/backend/requirements.txt
+++ b/backend/requirements.txt
@@ -1,6 +1,40 @@
-fastapi==0.115.0
-uvicorn==0.30.6
-pydantic==2.9.2
-pydantic-settings==2.5.2
 pytest==8.3.3
-httpx==0.27.2
+# ── Web framework ─────────────────────────────────────────────────────────────
+fastapi==0.115.5
+uvicorn[standard]==0.32.1
+python-multipart==0.0.12
+
+# ── Database ───────────────────────────────────────────────────────────────────
+sqlalchemy==2.0.36
+alembic==1.14.0
+psycopg2-binary==2.9.10          # PostgreSQL driver (binary wheel, works on macOS + Windows)
+
+# ── Task queue ─────────────────────────────────────────────────────────────────
+celery==5.4.0
+redis==5.2.0                     # Redis client (also used as Celery broker/backend)
+
+# ── Auth & security ────────────────────────────────────────────────────────────
+python-jose[cryptography]==3.3.0 # JWT encode/decode
+passlib[bcrypt]==1.7.4           # Password hashing
+httpx==0.27.2                    # Async HTTP — GitHub OAuth flows
+
+# ── GitHub integration ─────────────────────────────────────────────────────────
+PyGithub==2.5.0                  # GitHub REST API client
+pygments==2.18.0                 # Syntax highlighting for diff rendering
+
+# ── LLM & RAG ──────────────────────────────────────────────────────────────────
+langchain==0.3.9
+langchain-openai==0.2.10
+langchain-community==0.3.9
+openai==1.54.4
+chromadb==0.5.18
+tiktoken==0.8.0                  # Token counting for OpenAI models
+
+# ── Config ─────────────────────────────────────────────────────────────────────
+pydantic==2.10.2
+pydantic-settings==2.6.1         # Settings loaded from .env
+python-dotenv==1.0.1
+
+# ── Utilities ──────────────────────────────────────────────────────────────────
+tenacity==9.0.0                  # Retry logic (LLM calls, GitHub API)
+structlog==24.4.0                # Structured logging
diff --git a/setup-mac.sh b/setup-mac.sh
new file mode 100755
index 0000000..57ddac7
--- /dev/null
+++ b/setup-mac.sh
@@ -0,0 +1,186 @@
+#!/bin/bash
+
+# ─────────────────────────────────────────────
+#  Liffy — macOS Setup Script
+#  Installs everything from scratch and starts the app.
+# ─────────────────────────────────────────────
+
+set -e  # exit immediately if any command fails
+
+RED='\\033[0;31m'
+GREEN='\\033[0;32m'
+YELLOW='\\033[1;33m'
+CYAN='\\033[0;36m'
+NC='\\033[0m' # no colour
+
+log()    { echo -e "\${CYAN}[liffy]\${NC} $1"; }
+success(){ echo -e "\${GREEN}[done]\${NC}  $1"; }
+warn()   { echo -e "\${YELLOW}[warn]\${NC}  $1"; }
+error()  { echo -e "\${RED}[error]\${NC} $1"; exit 1; }
+
+echo ""
+echo "  ██╗     ██╗███████╗███████╗██╗   ██╗"
+echo "  ██║     ██║██╔════╝██╔════╝╚██╗ ██╔╝"
+echo "  ██║     ██║█████╗  █████╗   ╚████╔╝ "
+echo "  ██║     ██║██╔══╝  ██╔══╝    ╚██╔╝  "
+echo "  ███████╗██║██║     ██║        ██║   "
+echo "  ╚══════╝╚═╝╚═╝     ╚═╝        ╚═╝   "
+echo ""
+echo "  macOS Setup"
+echo "  ──────────────────────────────────────"
+echo ""
+
+# ── 1. Homebrew ───────────────────────────────────────────────────────────────
+log "Checking Homebrew..."
+if ! command -v brew &>/dev/null; then
+    log "Homebrew not found — installing..."
+    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
+
+    # Add Homebrew to PATH for Apple Silicon Macs
+    if [[ -f /opt/homebrew/bin/brew ]]; then
+        eval "$(/opt/homebrew/bin/brew shellenv)"
+        echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
+    fi
+else
+    success "Homebrew already installed"
+fi
+
+# ── 2. PostgreSQL ─────────────────────────────────────────────────────────────
+log "Checking PostgreSQL..."
+if ! brew list postgresql@15 &>/dev/null; then
+    log "Installing PostgreSQL 15..."
+    brew install postgresql@15
+fi
+
+export PATH="/opt/homebrew/opt/postgresql@15/bin:$PATH"
+
+if ! brew services list | grep postgresql@15 | grep started &>/dev/null; then
+    log "Starting PostgreSQL service..."
+    brew services start postgresql@15
+    sleep 3
+fi
+success "PostgreSQL ready"
+
+# ── 3. Redis ──────────────────────────────────────────────────────────────────
+log "Checking Redis..."
+if ! brew list redis &>/dev/null; then
+    log "Installing Redis..."
+    brew install redis
+fi
+
+if ! brew services list | grep redis | grep started &>/dev/null; then
+    log "Starting Redis service..."
+    brew services start redis
+fi
+success "Redis ready"
+
+# ── 4. Python 3.11 ────────────────────────────────────────────────────────────
+log "Checking Python 3.11..."
+if ! brew list python@3.11 &>/dev/null; then
+    log "Installing Python 3.11..."
+    brew install python@3.11
+fi
+
+PYTHON=$(brew --prefix python@3.11)/bin/python3.11
+success "Python ready → $($PYTHON --version)"
+
+# ── 5. Node.js via nvm ────────────────────────────────────────────────────────
+log "Checking Node.js..."
+export NVM_DIR="$HOME/.nvm"
+
+if [ ! -d "$NVM_DIR" ]; then
+    log "Installing nvm..."
+    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
+fi
+
+# Load nvm into current shell session
+[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"
+
+if ! command -v nvm &>/dev/null; then
+    error "nvm failed to load. Please close this terminal, reopen it, and run this script again."
+fi
+
+nvm install 22.12 --silent
+nvm use 22.12 --silent
+success "Node ready → $(node --version)"
+
+# ── 6. Create database ────────────────────────────────────────────────────────
+log "Setting up database..."
+if ! psql -lqt 2>/dev/null | cut -d \\| -f 1 | grep -qw liffy; then
+    createdb liffy
+    success "Database 'liffy' created"
+else
+    success "Database 'liffy' already exists"
+fi
+
+# ── 7. Environment file ───────────────────────────────────────────────────────
+log "Setting up environment file..."
+if [ ! -f backend/.env ]; then
+    if [ -f .env.example ]; then
+        cp .env.example backend/.env
+        # Generate a random JWT secret
+        JWT_SECRET=$(python3 -c "import secrets; print(secrets.token_hex(32))")
+        sed -i '' "s/JWT_SECRET_KEY=.*/JWT_SECRET_KEY=$JWT_SECRET/" backend/.env
+        success "Created backend/.env with a generated JWT secret"
+        warn "Open backend/.env and fill in GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, and OPENAI_API_KEY"
+    else
+        error ".env.example not found. Are you in the Liffy root directory?"
+    fi
+else
+    success "backend/.env already exists — skipping"
+fi
+
+# ── 8. Python virtual environment + dependencies ──────────────────────────────
+log "Setting up Python virtual environment..."
+cd backend
+if [ ! -d .venv ]; then
+    $PYTHON -m venv .venv
+fi
+source .venv/bin/activate
+pip install --upgrade pip --quiet
+pip install -r requirements.txt --quiet
+success "Python dependencies installed"
+
+# ── 9. Database migrations ────────────────────────────────────────────────────
+log "Running database migrations..."
+alembic upgrade head
+success "Migrations applied"
+cd ..
+
+# ── 10. Frontend dependencies ─────────────────────────────────────────────────
+log "Installing frontend dependencies..."
+cd frontend
+npm install --silent
+success "Frontend dependencies installed"
+cd ..
+
+# ─────────────────────────────────────────────────────────────────────────────
+echo ""
+echo "  ──────────────────────────────────────"
+success "Setup complete! Starting Liffy..."
+echo "  ──────────────────────────────────────"
+echo ""
+echo "  Frontend  →  http://localhost:5173"
+echo "  API       →  http://localhost:8000"
+echo "  Swagger   →  http://localhost:8000/docs"
+echo ""
+warn "Three terminal windows will open. Close all three to stop Liffy."
+echo ""
+sleep 2
+
+# ── 11. Launch all three services ────────────────────────────────────────────
+# Open three Terminal tabs
+osascript <<EOF
+tell application "Terminal"
+    do script "cd '$(pwd)/backend' && source .venv/bin/activate && uvicorn app.main:app --reload"
+    delay 1
+    tell application "System Events" to keystroke "t" using command down
+    do script "cd '$(pwd)/backend' && source .venv/bin/activate && celery -A app.workers.celery_app worker --loglevel=info" in front window
+    delay 1
+    tell application "System Events" to keystroke "t" using command down
+    do script "cd '$(pwd)/frontend' && npm run dev" in front window
+    activate
+end tell
+EOF
+
+success "All services started. Check the Terminal tabs."
diff --git a/setup-windows.bat b/setup-windows.bat
new file mode 100644
index 0000000..f15cc24
--- /dev/null
+++ b/setup-windows.bat
@@ -0,0 +1,184 @@
+@echo off
+setlocal EnableDelayedExpansion
+
+REM ─────────────────────────────────────────────
+REM  Liffy — Windows Setup Script
+REM  Run this as Administrator.
+REM  Right-click → "Run as administrator"
+REM ─────────────────────────────────────────────
+
+title Liffy Setup
+
+echo.
+echo   ██╗     ██╗███████╗███████╗██╗   ██╗
+echo   ██║     ██║██╔════╝██╔════╝╚██╗ ██╔╝
+echo   ██║     ██║█████╗  █████╗   ╚████╔╝
+echo   ██║     ██║██╔══╝  ██╔══╝    ╚██╔╝
+echo   ███████╗██║██║     ██║        ██║
+echo   ╚══════╝╚═╝╚═╝     ╚═╝        ╚═╝
+echo.
+echo   Windows Setup
+echo   ──────────────────────────────────────
+echo.
+
+REM ── Check for Admin ──────────────────────────────────────────────────────────
+net session >nul 2>&1
+if %errorlevel% neq 0 (
+    echo [error] This script must be run as Administrator.
+    echo         Right-click setup-windows.bat and choose "Run as administrator".
+    pause
+    exit /b 1
+)
+
+REM ── Check winget ─────────────────────────────────────────────────────────────
+where winget >nul 2>&1
+if %errorlevel% neq 0 (
+    echo [error] winget not found.
+    echo         Update Windows to version 1809 or later, or install "App Installer"
+    echo         from the Microsoft Store: https://apps.microsoft.com/store/detail/app-installer/9NBLGGH4NNS1
+    pause
+    exit /b 1
+)
+
+REM ── 1. Python 3.11 ────────────────────────────────────────────────────────────
+echo [liffy] Checking Python 3.11...
+python --version 2>nul | findstr "3.11" >nul
+if %errorlevel% neq 0 (
+    echo [liffy] Installing Python 3.11...
+    winget install -e --id Python.Python.3.11 --silent --accept-package-agreements --accept-source-agreements
+    REM Refresh PATH
+    call refreshenv 2>nul
+    set "PATH=%LOCALAPPDATA%\\Programs\\Python\\Python311;%LOCALAPPDATA%\\Programs\\Python\\Python311\\Scripts;%PATH%"
+) else (
+    echo [done]  Python 3.11 already installed
+)
+
+REM ── 2. Node.js 22 ────────────────────────────────────────────────────────────
+echo [liffy] Checking Node.js...
+node --version 2>nul | findstr "v22" >nul
+if %errorlevel% neq 0 (
+    echo [liffy] Installing Node.js 22...
+    winget install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
+    call refreshenv 2>nul
+) else (
+    echo [done]  Node.js already installed
+)
+
+REM ── 3. PostgreSQL 15 ─────────────────────────────────────────────────────────
+echo [liffy] Checking PostgreSQL...
+sc query postgresql-x64-15 >nul 2>&1
+if %errorlevel% neq 0 (
+    echo [liffy] Installing PostgreSQL 15...
+    winget install -e --id PostgreSQL.PostgreSQL.15 --silent --accept-package-agreements --accept-source-agreements
+    echo [warn]  PostgreSQL installed. Default postgres user password is what you set during install.
+    echo         If you set a password, update DATABASE_URL in backend\\.env after this script finishes.
+    timeout /t 5 >nul
+) else (
+    echo [done]  PostgreSQL already installed
+)
+
+REM ── 4. Redis ─────────────────────────────────────────────────────────────────
+echo [liffy] Checking Redis...
+sc query Redis >nul 2>&1
+if %errorlevel% neq 0 (
+    echo [liffy] Installing Redis...
+    winget install -e --id Memurai.Memurai --silent --accept-package-agreements --accept-source-agreements
+    REM Memurai is a native Windows Redis-compatible server (no WSL needed)
+    net start Memurai >nul 2>&1
+) else (
+    echo [done]  Redis already installed
+)
+
+REM ── 5. Git ───────────────────────────────────────────────────────────────────
+echo [liffy] Checking Git...
+where git >nul 2>&1
+if %errorlevel% neq 0 (
+    echo [liffy] Installing Git...
+    winget install -e --id Git.Git --silent --accept-package-agreements --accept-source-agreements
+    call refreshenv 2>nul
+) else (
+    echo [done]  Git already installed
+)
+
+REM ── Refresh PATH after installs ───────────────────────────────────────────────
+set "PATH=%LOCALAPPDATA%\\Programs\\Python\\Python311;%LOCALAPPDATA%\\Programs\\Python\\Python311\\Scripts;%PATH%"
+set "PATH=%ProgramFiles%\\PostgreSQL\\15\\bin;%PATH%"
+set "PATH=%ProgramFiles%\\Git\\cmd;%PATH%"
+set "PATH=%ProgramFiles%\\nodejs;%PATH%"
+
+REM ── 6. Create database ────────────────────────────────────────────────────────
+echo [liffy] Creating database...
+psql -U postgres -c "SELECT 1 FROM pg_database WHERE datname='liffy'" 2>nul | findstr "1" >nul
+if %errorlevel% neq 0 (
+    psql -U postgres -c "CREATE DATABASE liffy;"
+    echo [done]  Database 'liffy' created
+) else (
+    echo [done]  Database 'liffy' already exists
+)
+
+REM ── 7. Environment file ───────────────────────────────────────────────────────
+echo [liffy] Setting up environment file...
+if not exist "backend\\.env" (
+    if exist ".env.example" (
+        copy .env.example backend\\.env >nul
+        REM Generate a simple random secret using Python
+        python -c "import secrets; s=open('backend\\\\.env').read(); open('backend\\\\.env','w').write(s.replace('JWT_SECRET_KEY=','JWT_SECRET_KEY='+secrets.token_hex(32)))"
+        echo [done]  Created backend\\.env
+        echo [warn]  Open backend\\.env and fill in GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, and OPENAI_API_KEY
+    ) else (
+        echo [error] .env.example not found. Are you in the Liffy root folder?
+        pause
+        exit /b 1
+    )
+) else (
+    echo [done]  backend\\.env already exists — skipping
+)
+
+REM ── 8. Python venv + dependencies ────────────────────────────────────────────
+echo [liffy] Setting up Python virtual environment...
+cd backend
+if not exist ".venv" (
+    python -m venv .venv
+)
+call .venv\\Scripts\\activate.bat
+python -m pip install --upgrade pip --quiet
+pip install -r requirements.txt --quiet
+echo [done]  Python dependencies installed
+
+REM ── 9. Database migrations ────────────────────────────────────────────────────
+echo [liffy] Running database migrations...
+alembic upgrade head
+echo [done]  Migrations applied
+cd ..
+
+REM ── 10. Frontend dependencies ─────────────────────────────────────────────────
+echo [liffy] Installing frontend dependencies...
+cd frontend
+call npm install --silent
+echo [done]  Frontend dependencies installed
+cd ..
+
+REM ─────────────────────────────────────────────────────────────────────────────
+echo.
+echo   ──────────────────────────────────────
+echo   Setup complete! Starting Liffy...
+echo   ──────────────────────────────────────
+echo.
+echo   Frontend  -^>  http://localhost:5173
+echo   API       -^>  http://localhost:8000
+echo   Swagger   -^>  http://localhost:8000/docs
+echo.
+echo   Three windows will open. Close all three to stop Liffy.
+echo.
+timeout /t 3 >nul
+
+REM ── 11. Launch all three services in separate windows ────────────────────────
+start "Liffy — API Server" cmd /k "cd backend && .venv\\Scripts\\activate.bat && uvicorn app.main:app --reload"
+timeout /t 2 >nul
+start "Liffy — Celery Worker" cmd /k "cd backend && .venv\\Scripts\\activate.bat && celery -A app.workers.celery_app worker --loglevel=info --pool=solo"
+timeout /t 2 >nul
+start "Liffy — Frontend" cmd /k "cd frontend && npm run dev"
+
+echo [done]  All services started. Check the three windows that opened.
+echo.
+pause
`;

// ─────────────────────────────────────────────────────────────────────────────
// The real review claude-opus-5 produced for lucenity0/Liffy#58 on 2026-07-29,
// captured verbatim from the live run in #164. Kept as the mock fixture so the
// MSW build shows genuine model output rather than invented text.
//
// Assessment recorded on #164: of these 8 comments, 3 were verified correct
// (including the critical one, a real bug that was sitting on main), 1 was
// verified false, and 4 were plausible but unverified.
// ─────────────────────────────────────────────────────────────────────────────

const c = (
  n: number,
  file_path: string,
  line_start: number,
  line_end: number,
  category: ReviewCommentOut["category"],
  severity: ReviewCommentOut["severity"],
  comment_text: string,
  suggestion: string | null,
): ReviewCommentOut => ({
  id: `aaaaaaaa-0000-0000-0000-00000000000${n}`,
  file_path,
  line_start,
  line_end,
  category,
  severity,
  comment_text,
  suggestion,
  created_at: "2026-07-29T16:33:51Z",
});

const realComments: ReviewCommentOut[] = [
  c(8, "setup-windows.bat", 125, 125, "logic_error", "critical",
    "This replaces the substring `JWT_SECRET_KEY=` with `JWT_SECRET_KEY=<hex>`, which *prepends* the generated secret to whatever placeholder value is already in `.env.example` (e.g. it produces `JWT_SECRET_KEY=<hex>changeme`). The macOS script correctly replaces the whole line (`sed \"s/JWT_SECRET_KEY=.*/…/\"`). Rewrite the line, not the key prefix.",
    "python -c \"import re,secrets;p='backend\\\\.env';s=open(p).read();open(p,'w').write(re.sub(r'(?m)^JWT_SECRET_KEY=.*$','JWT_SECRET_KEY='+secrets.token_hex(32),s))\""),
  c(6, "setup-windows.bat", 82, 90, "logic_error", "warning",
    "The check queries a service named `Redis`, but the script installs Memurai, whose service is named `Memurai`. On every re-run the check will fail and winget will be invoked again (and `net start Memurai` re-executed). Query the service that is actually installed.",
    "sc query Memurai >nul 2>&1"),
  c(7, "setup-windows.bat", 111, 117, "logic_error", "warning",
    "`psql -U postgres` will interactively prompt for a password whenever one was set during the PostgreSQL install, and with stdout piped into `findstr` the prompt makes the unattended script appear to hang. Consider setting `PGPASSWORD` from a prompted variable, or detect the failure and print instructions to create the DB manually.",
    "set /p PGPASSWORD=\"Enter the postgres user password (blank if none): \""),
  c(2, "setup-mac.sh", 97, 101, "logic_error", "warning",
    "With `set -e` (line 8), `[ -s \"$NVM_DIR/nvm.sh\" ] && source \"$NVM_DIR/nvm.sh\"` aborts the whole script when the test fails, so the friendly `error \"nvm failed to load…\"` branch on line 100 is unreachable and the user gets a silent exit. Use an explicit `if`.",
    "if [ -s \"$NVM_DIR/nvm.sh\" ]; then\n    source \"$NVM_DIR/nvm.sh\"\nfi"),
  c(4, "setup-mac.sh", 173, 184, "logic_error", "warning",
    "The `keystroke \"t\" using command down` calls require Accessibility permission for the calling app; on a fresh machine this raises `-1743` and the celery/frontend tabs never start — exactly the situation a one-command setup is meant to avoid. Plain `do script \"…\"` opens a new window per command and needs no System Events.",
    null),
  c(1, "backend/requirements.txt", 1, 2, "convention", "warning",
    "`pytest==8.3.3` is left at the top of the production requirements while the new `requirements-dev.txt` already pins the same version. Now that dev deps are split out, remove pytest here so production installs don't pull test tooling (and so the pin can't drift between the two files).",
    null),
  c(3, "setup-mac.sh", 122, 122, "improvement", "info",
    "`python3` here is the system/Xcode Python, not the interpreter the script just resolved. Use `$PYTHON` (set on line 84) so the script does not depend on an unrelated `python3` being on PATH.",
    "JWT_SECRET=$($PYTHON -c \"import secrets; print(secrets.token_hex(32))\")"),
  c(5, "setup-windows.bat", 1, 2, "improvement", "info",
    "The file contains UTF-8 box-drawing/em-dash characters. cmd.exe defaults to codepage 437/1252 and will render these as mojibake. Add `chcp 65001 >nul` right after `@echo off`, or fall back to ASCII separators.",
    "@echo off\nchcp 65001 >nul"),
];

export const fixtureReviewCompleted: ReviewDetailOut = {
  id: "bbbbbbbb-0000-0000-0000-000000000001",
  pr_id: "cccccccc-0000-0000-0000-000000000001",
  pr_number: 58,
  repo_full_name: "lucenity0/Liffy",
  status: "completed",
  summary:
    "Adds one-command bootstrap scripts for macOS and Windows plus a split of prod/dev Python requirements. The overall structure is good, but there are a few functional bugs: the Windows `.env` JWT secret rewrite appends the secret in front of the existing placeholder value instead of replacing it, the Redis presence check queries a service name that never matches what is installed (Memurai), and the macOS script's `[ -s … ] && source …` line will silently abort under `set -e`. Requirements split still leaves `pytest` in the production file.",
  verdict: "request_changes",
  model_used: "claude-opus-5",
  tokens_used: 25043,
  created_at: "2026-07-29T16:31:44Z",
  completed_at: "2026-07-29T16:33:51Z",
  comments: realComments,
  raw_diff: REAL_DIFF,
};

export const fixtureReviewApproved: ReviewDetailOut = {
  id: "bbbbbbbb-0000-0000-0000-000000000002",
  pr_id: "cccccccc-0000-0000-0000-000000000002",
  pr_number: 59,
  repo_full_name: "lucenity0/portfolio",
  status: "completed",
  summary: "Clean change. No issues found.",
  verdict: "approve",
  model_used: "gpt-4o",
  tokens_used: 1802,
  created_at: "2026-07-24T09:00:00Z",
  completed_at: "2026-07-24T09:01:40Z",
  comments: [],
  raw_diff: "diff --git a/README.md b/README.md\n@@ -1 +1 @@\n-old\n+new\n",
};

export const fixtureReviewPending: ReviewDetailOut = {
  id: "bbbbbbbb-0000-0000-0000-000000000003",
  pr_id: "cccccccc-0000-0000-0000-000000000003",
  pr_number: 62,
  repo_full_name: "lucenity0/Liffy",
  status: "pending",
  summary: null,
  verdict: null,
  model_used: null,
  tokens_used: null,
  created_at: "2026-07-26T08:00:00Z",
  completed_at: null,
  comments: [],
  raw_diff: null,
};

export const fixtureReviewProcessing: ReviewDetailOut = {
  ...fixtureReviewPending,
  id: "bbbbbbbb-0000-0000-0000-000000000004",
  pr_id: "cccccccc-0000-0000-0000-000000000004",
  pr_number: 60,
  status: "processing",
};

export const fixtureReviewFailed: ReviewDetailOut = {
  id: "bbbbbbbb-0000-0000-0000-000000000005",
  pr_id: "cccccccc-0000-0000-0000-000000000005",
  pr_number: 61,
  repo_full_name: "lucenity0/Liffy",
  status: "failed",
  summary: null,
  verdict: null,
  model_used: "gpt-4o",
  tokens_used: null,
  created_at: "2026-07-23T11:00:00Z",
  completed_at: "2026-07-23T11:00:42Z",
  comments: [],
  raw_diff: null,
};

/**
 * The list item is the detail minus the two heavy fields. Since #136 put
 * pr_number and repo_full_name on the detail too, this no longer needs them
 * passed in — which also means the two fixtures can never disagree about
 * which PR a review belongs to.
 */
const detailToListItem = (review: ReviewDetailOut): ReviewListItem => ({
  id: review.id,
  pr_id: review.pr_id,
  pr_number: review.pr_number,
  repo_full_name: review.repo_full_name,
  status: review.status,
  summary: review.summary,
  verdict: review.verdict,
  model_used: review.model_used,
  tokens_used: review.tokens_used,
  created_at: review.created_at,
  completed_at: review.completed_at,
});

export const fixtureReviewListItems: ReviewListItem[] = [
  detailToListItem(fixtureReviewFailed),
  detailToListItem(fixtureReviewProcessing),
  detailToListItem(fixtureReviewApproved),
  detailToListItem(fixtureReviewCompleted),
];

export const fixtureReviewDetailById: Record<string, ReviewDetailOut> = {
  [fixtureReviewCompleted.id]: fixtureReviewCompleted,
  [fixtureReviewApproved.id]: fixtureReviewApproved,
  [fixtureReviewPending.id]: fixtureReviewPending,
  [fixtureReviewProcessing.id]: fixtureReviewProcessing,
  [fixtureReviewFailed.id]: fixtureReviewFailed,
};
