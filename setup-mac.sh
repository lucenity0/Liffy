#!/bin/bash

# ─────────────────────────────────────────────
#  Liffy — macOS Setup Script
#  Installs everything from scratch and starts the app.
# ─────────────────────────────────────────────

set -euo pipefail 2>/dev/null || true  # best-effort strict mode

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # no colour

log()    { echo -e "${CYAN}[liffy]${NC} $1"; }
success(){ echo -e "${GREEN}[done]${NC}  $1"; }
warn()   { echo -e "${YELLOW}[warn]${NC}  $1"; }
error()  { echo -e "${RED}[error]${NC} $1"; exit 1; }

echo ""
echo "  ██╗     ██╗███████╗███████╗██╗   ██╗"
echo "  ██║     ██║██╔════╝██╔════╝╚██╗ ██╔╝"
echo "  ██║     ██║█████╗  █████╗   ╚████╔╝ "
echo "  ██║     ██║██╔══╝  ██╔══╝    ╚██╔╝  "
echo "  ███████╗██║██║     ██║        ██║   "
echo "  ╚══════╝╚═╝╚═╝     ╚═╝        ╚═╝   "
echo ""
echo "  macOS Setup"
echo "  ──────────────────────────────────────"
echo ""

# ── 1. Homebrew ───────────────────────────────────────────────────────────────
log "Checking Homebrew..."
if ! command -v brew &>/dev/null; then
    log "Homebrew not found — installing..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

    # Add Homebrew to PATH for Apple Silicon Macs
    if [[ -f /opt/homebrew/bin/brew ]]; then
        eval "$(/opt/homebrew/bin/brew shellenv)"
        echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
    fi
else
    success "Homebrew already installed"
fi

# ── 2. PostgreSQL ─────────────────────────────────────────────────────────────
log "Checking PostgreSQL..."
if ! brew list postgresql@15 &>/dev/null; then
    log "Installing PostgreSQL 15..."
    brew install postgresql@15
fi

export PATH="/opt/homebrew/opt/postgresql@15/bin:$PATH"

if pg_isready -q 2>/dev/null; then
    success "PostgreSQL already running"
elif ! brew services list | grep postgresql@15 | grep started &>/dev/null; then
    log "Starting PostgreSQL service..."
    brew services start postgresql@15 2>/dev/null || true
    sleep 3
    pg_isready -q 2>/dev/null && success "PostgreSQL ready" || warn "PostgreSQL may not have started — check with: brew services list"
else
    success "PostgreSQL ready"
fi

# ── 3. Redis ──────────────────────────────────────────────────────────────────
log "Checking Redis..."
if ! brew list redis &>/dev/null; then
    log "Installing Redis..."
    brew install redis
fi

if ! brew services list | grep redis | grep started &>/dev/null; then
    log "Starting Redis service..."
    brew services start redis
fi
success "Redis ready"

# ── 4. Python 3.11 ────────────────────────────────────────────────────────────
log "Checking Python 3.11..."
if ! brew list python@3.11 &>/dev/null; then
    log "Installing Python 3.11..."
    brew install python@3.11
fi

PYTHON=$(brew --prefix python@3.11)/bin/python3.11
success "Python ready → $($PYTHON --version)"

# ── 5. Node.js via nvm ────────────────────────────────────────────────────────
log "Checking Node.js..."
export NVM_DIR="$HOME/.nvm"

if [ ! -d "$NVM_DIR" ]; then
    log "Installing nvm..."
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
fi

# Load nvm into current shell session
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"

if ! command -v nvm &>/dev/null; then
    error "nvm failed to load. Please close this terminal, reopen it, and run this script again."
fi

nvm install 22.12 --silent
nvm use 22.12 --silent
success "Node ready → $(node --version)"

# ── 6. Create database ────────────────────────────────────────────────────────
log "Setting up database..."
if ! psql -lqt 2>/dev/null | cut -d \| -f 1 | grep -qw liffy; then
    createdb liffy
    success "Database 'liffy' created"
else
    success "Database 'liffy' already exists"
fi

# ── 7. Environment files ──────────────────────────────────────────────────────
log "Setting up environment files..."
if [ ! -f backend/.env ]; then
    if [ -f backend/.env.example ]; then
        cp backend/.env.example backend/.env
        # Generate a random JWT secret
        JWT_SECRET=$(python3 -c "import secrets; print(secrets.token_hex(32))")
        sed -i '' "s/JWT_SECRET_KEY=.*/JWT_SECRET_KEY=$JWT_SECRET/" backend/.env
        success "Created backend/.env with a generated JWT secret"
        warn "Open backend/.env and fill in GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, and OPENAI_API_KEY"
    else
        error "backend/.env.example not found. Are you in the Liffy root directory?"
    fi
else
    success "backend/.env already exists — skipping"
fi

# The frontend needs one too, and it is just as gitignored — so a fresh clone
# has neither. Without VITE_API_BASE_URL every call becomes root-relative and
# lands on the Vite dev server instead of the API, including the "Continue with
# GitHub" link: Vite's SPA fallback answers /auth/github with index.html, the
# router matches its catch-all behind RequireAuth, and an anonymous visitor is
# redirected back to /login having never reached GitHub. No secrets in this
# one, so there is nothing to fill in afterwards.
if [ ! -f frontend/.env ]; then
    if [ -f frontend/.env.example ]; then
        cp frontend/.env.example frontend/.env
        success "Created frontend/.env"
    else
        error "frontend/.env.example not found. Are you in the Liffy root directory?"
    fi
else
    success "frontend/.env already exists — skipping"
fi

# ── 8. Python virtual environment + dependencies ──────────────────────────────
log "Setting up Python virtual environment..."
cd backend
if [ ! -d .venv ]; then
    $PYTHON -m venv .venv
fi
source .venv/bin/activate
pip install --upgrade pip --quiet
pip install -r requirements.txt --quiet
success "Python dependencies installed"

# ── 9. Database migrations ────────────────────────────────────────────────────
log "Running database migrations..."
if [ ! -f alembic.ini ]; then
    warn "alembic.ini not found in backend/ — skipping migrations."
    warn "Run: alembic init migrations  inside backend/ and commit alembic.ini to the repo."
else
    alembic upgrade head
    success "Migrations applied"
fi
cd ..

# ── 10. Frontend dependencies ─────────────────────────────────────────────────
log "Installing frontend dependencies..."
cd frontend
npm install --silent
success "Frontend dependencies installed"
cd ..

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "  ──────────────────────────────────────"
success "Setup complete! Starting Liffy..."
echo "  ──────────────────────────────────────"
echo ""
echo "  Frontend  →  http://localhost:5173"
echo "  API       →  http://localhost:8000"
echo "  Swagger   →  http://localhost:8000/docs"
echo ""
warn "Three terminal windows will open. Close all three to stop Liffy."
echo ""
sleep 2

# ── 11. Launch all three services ────────────────────────────────────────────
# Open three separate Terminal windows (more reliable than tabs)
LIFFY_ROOT="$(pwd)"

osascript <<APPLESCRIPT
tell application "Terminal"
    do script "cd '${LIFFY_ROOT}/backend' && source .venv/bin/activate && uvicorn app.main:app --reload"
    delay 2
    do script "cd '${LIFFY_ROOT}/backend' && source .venv/bin/activate && celery -A app.workers.celery_app worker --loglevel=info"
    delay 2
    do script "cd '${LIFFY_ROOT}/frontend' && npm run dev"
    activate
end tell
APPLESCRIPT

success "All services started. Check the Terminal tabs."