#!/bin/bash
# ─────────────────────────────────────────────
#  Liffy — one-command launcher
#
#  ./liffy.sh          start everything (docker services + frontend)
#  ./liffy.sh down     stop everything
#  ./liffy.sh check    confirm repo/PR data survived the last build
#  ./liffy.sh logs     tail docker service logs
# ─────────────────────────────────────────────

set -euo pipefail 2>/dev/null || true

CYAN='\033[0;36m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()     { echo -e "${CYAN}[liffy]${NC} $1"; }
success() { echo -e "${GREEN}[done]${NC}  $1"; }
warn()    { echo -e "${YELLOW}[warn]${NC}  $1"; }
error()   { echo -e "${RED}[error]${NC} $1"; exit 1; }

cd "$(dirname "${BASH_SOURCE[0]}")"
LIFFY_ROOT="$(pwd)"
FRONTEND_PID_FILE="$LIFFY_ROOT/.liffy-frontend.pid"
FRONTEND_LOG_FILE="$LIFFY_ROOT/.liffy-frontend.log"

# Every docker-compose service: data stores + API + the workers that
# actually execute reviews (worker) and the weekly scheduler (beat).
ALL_SERVICES=(postgres redis chromadb backend worker beat)

# Which compose files are in play. The subscription overlay gets appended when
# backend/.env selects a CLI provider — see select_compose_files.
COMPOSE_FILES=(-f docker-compose.yml)

compose() { docker compose "${COMPOSE_FILES[@]}" "$@"; }

require_docker() {
    command -v docker &>/dev/null || error "Docker not found. Install Docker Desktop: https://www.docker.com/products/docker-desktop/"
    docker info &>/dev/null || error "Docker isn't running. Start Docker Desktop and try again."
}

# Read one key out of backend/.env, or nothing if it is not there.
#
# Deliberately not `source`: that file holds secrets with characters bash would
# try to interpret, and it is not a script.
#
# The `|| line=""` is load-bearing. A key that is simply absent — which is the
# normal case, since none of these are in .env.example uncommented — makes grep
# exit 1, `set -o pipefail` propagates it, and `set -e` then kills the whole
# launcher on the assignment at the call site. That shipped once: ./liffy.sh
# printed the .env line and exited silently before starting a single container.
env_setting() {
    local line=""
    [ -f backend/.env ] || return 0
    line=$(grep -E "^${1}=" backend/.env 2>/dev/null | tail -1) || line=""
    [ -n "$line" ] || return 0
    printf '%s' "${line#*=}" | tr -d "\"'" | sed 's/[[:space:]]*$//'
}

# Read a setting the settings page has overridden, if the database is up.
#
# `.env` is no longer the only place these live. The page writes overrides to
# the `settings` table and the worker applies them at the start of every task,
# so a launcher that consults only the dotfile is reading a stale answer for
# anybody who used the UI — which is the entire point of the UI.
#
# Empty when the database is not running yet, which is the honest answer at
# that moment: the caller falls back to `.env`.
db_setting() {
    docker compose ps postgres 2>/dev/null | grep -q "Up\|running" || return 0
    docker compose exec -T postgres psql -U liffy -d liffy -tAc \
        "select value from settings where key='$1';" 2>/dev/null \
        | tr -d ' \r' | head -1 || true
}

# What the *next review* will actually use: the page's choice if there is one,
# otherwise the dotfile's.
resolved_setting() {
    local value=""
    value=$(db_setting "$1") || value=""
    [ -n "$value" ] || value=$(env_setting "$2")
    printf '%s' "$value"
}

# Pick the worker image and warn about the one thing that will otherwise fail.
#
# The subscription providers authenticate against credentials in the user's
# home directory, which the container does not have. Selecting `claude_code` in
# the settings page and then running a plain `docker compose up` gives a worker
# with no CLI and no credentials, and the review dies on `'claude' is not on
# PATH` — which is exactly what happened when the provider was set in the page
# and this function only ever looked at `.env`.
select_compose_files() {
    local provider credential
    provider=$(resolved_setting llm_provider LLM_PROVIDER)
    case "$provider" in
        # The two providers need different things, because the two CLIs offer
        # different things: Claude Code reads a token from the environment,
        # Codex only reads a credential directory.
        claude_code) credential=$(resolved_setting claude_code_oauth_token CLAUDE_CODE_OAUTH_TOKEN) ;;
        codex)
            credential=$(resolved_setting codex_home CODEX_HOME)
            # Codex has no token environment variable. The dedicated overlay
            # mounts the host's signed-in credential directory and sets
            # CODEX_HOME inside both containers. Keep it separate from the
            # Claude overlay so Claude users do not expose ~/.codex.
            COMPOSE_FILES+=(-f docker-compose.codex.yml)
            ;;
        *)           return 0 ;;
    esac

    COMPOSE_FILES+=(-f docker-compose.subscription.yml)
    log "LLM_PROVIDER=$provider — building the worker with the CLIs installed"

    if [ -z "$credential" ]; then
        if [ "$provider" = "claude_code" ]; then
            warn "CLAUDE_CODE_OAUTH_TOKEN is empty in backend/.env. Run 'claude setup-token' on this machine and paste the result there — the worker will refuse to start without it."
        else
            # liffy.sh supplies CODEX_HOME and the bind mount through the
            # Codex overlay. Only warn when the host has no credential store.
            [ -f "$HOME/.codex/auth.json" ] || warn "No ~/.codex/auth.json found. Run 'codex login' on this machine before starting the Codex worker."
        fi
    fi
}

# Discoverability: a subscription provider removes the cost barrier entirely,
# and until now the only place it was written down was a commented-out line in
# .env.example.
suggest_subscription_providers() {
    # Plain strings rather than an array: macOS still ships bash 3.2, where
    # ${#arr[@]} on an empty array trips `set -u`.
    local provider="" found=""
    # Resolved, not `env_setting`: the settings page writes the provider to the
    # database, so reading only the dotfile suggests switching to a provider the
    # user already switched to.
    provider=$(resolved_setting llm_provider LLM_PROVIDER)
    case "$provider" in claude_code|codex) return 0 ;; esac

    command -v claude &>/dev/null && found="$found    • LLM_PROVIDER=claude_code — the 'claude' CLI is installed\n"
    command -v codex  &>/dev/null && found="$found    • LLM_PROVIDER=codex — the 'codex' CLI is installed\n"
    [ -z "$found" ] && return 0

    echo ""
    echo "  Reviews can run on a subscription you already pay for, with no API key:"
    printf "%b" "$found"
    echo "    In Docker each also needs a token in backend/.env — see the README."
    echo ""
}

ensure_env_file() {
    if [ ! -f backend/.env ]; then
        [ -f .env.example ] || error ".env.example not found. Are you in the Liffy root directory?"
        cp .env.example backend/.env
        JWT_SECRET=$(python3 -c "import secrets; print(secrets.token_hex(32))" 2>/dev/null || echo "dev-only-insecure-secret-change-me-before-deploy")
        sed -i '' "s/JWT_SECRET_KEY=.*/JWT_SECRET_KEY=$JWT_SECRET/" backend/.env 2>/dev/null || \
            sed -i "s/JWT_SECRET_KEY=.*/JWT_SECRET_KEY=$JWT_SECRET/" backend/.env
        success "Created backend/.env with a generated JWT secret"
        warn "Open backend/.env and fill in GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET / an LLM key when you're ready for real runs"
    else
        success "backend/.env already exists — skipping"
    fi
}

wait_for_backend() {
    log "Waiting for backend to become healthy..."
    for _ in $(seq 1 30); do
        if curl -sf http://localhost:8000/health &>/dev/null; then
            success "Backend is up"
            return 0
        fi
        sleep 2
    done
    warn "Backend didn't report healthy in time — check: docker compose logs backend"
}

start_frontend() {
    if [ -f "$FRONTEND_PID_FILE" ] && kill -0 "$(cat "$FRONTEND_PID_FILE")" 2>/dev/null; then
        success "Frontend already running (PID $(cat "$FRONTEND_PID_FILE"))"
        return 0
    fi
    log "Installing frontend dependencies..."
    (cd frontend && npm install --silent)
    log "Starting frontend dev server..."
    (cd frontend && nohup npm run dev >"$FRONTEND_LOG_FILE" 2>&1 &)
    sleep 1
    FRONTEND_PID=$(lsof -ti tcp:5173 2>/dev/null | head -1 || true)
    [ -n "$FRONTEND_PID" ] && echo "$FRONTEND_PID" > "$FRONTEND_PID_FILE"
    success "Frontend starting → logs: $FRONTEND_LOG_FILE"
}

stop_frontend() {
    if [ -f "$FRONTEND_PID_FILE" ]; then
        PID=$(cat "$FRONTEND_PID_FILE")
        kill "$PID" 2>/dev/null || true
        rm -f "$FRONTEND_PID_FILE"
        success "Frontend stopped"
    fi
    # Fallback: anything still holding Vite's port.
    lsof -ti tcp:5173 2>/dev/null | xargs -r kill 2>/dev/null || true
}

cmd_up() {
    require_docker
    ensure_env_file
    select_compose_files

    log "Starting docker services: ${ALL_SERVICES[*]}"
    compose up -d --build "${ALL_SERVICES[@]}"

    wait_for_backend

    log "Running database migrations..."
    compose exec -T backend alembic upgrade head && success "Migrations applied" || warn "Migrations failed — check: docker compose logs backend"

    start_frontend

    echo ""
    echo "  ──────────────────────────────────────"
    success "Liffy is up"
    echo "  ──────────────────────────────────────"
    echo "  Frontend  →  http://localhost:5173"
    echo "  API       →  http://localhost:8000"
    echo "  Swagger   →  http://localhost:8000/docs"
    echo ""
    warn "Real reviews will call your configured LLM and (if POST_REVIEWS_TO_GITHUB=true) post to GitHub — check backend/.env before connecting a real repo."
    suggest_subscription_providers
    echo "  Stop:            ./liffy.sh down"
    echo "  Check data:      ./liffy.sh check"
    echo ""
}

cmd_down() {
    stop_frontend
    select_compose_files >/dev/null 2>&1
    compose stop "${ALL_SERVICES[@]}" 2>/dev/null || true
    success "All services stopped (data volumes kept — nothing was deleted)"
}

cmd_logs() {
    select_compose_files >/dev/null 2>&1
    compose logs -f "${ALL_SERVICES[@]}"
}

cmd_check() {
    require_docker
    select_compose_files >/dev/null 2>&1
    log "Checking whether repo data survived (Postgres + ChromaDB)..."

    if ! compose ps postgres 2>/dev/null | grep -q "Up\|running"; then
        error "Postgres isn't running. Run ./liffy.sh first."
    fi

    REPOS=$(compose exec -T postgres psql -U liffy -d liffy -tAc "SELECT count(*) FROM repositories;" 2>/dev/null || echo "?")
    PRS=$(compose exec -T postgres psql -U liffy -d liffy -tAc "SELECT count(*) FROM pull_requests;" 2>/dev/null || echo "?")
    REVIEWS=$(compose exec -T postgres psql -U liffy -d liffy -tAc "SELECT count(*) FROM reviews;" 2>/dev/null || echo "?")
    EMBEDDINGS=$(compose exec -T postgres psql -U liffy -d liffy -tAc "SELECT count(*) FROM repo_embeddings;" 2>/dev/null || echo "?")

    echo ""
    echo "  Postgres (survives docker compose down / rebuild via the pgdata volume):"
    echo "    repositories   : $REPOS"
    echo "    pull_requests  : $PRS"
    echo "    reviews        : $REVIEWS"
    echo "    repo_embeddings: $EMBEDDINGS"

    CHROMA_COLLECTIONS=$(curl -sf http://localhost:8001/api/v2/tenants/default_tenant/databases/default_database/collections 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d))" 2>/dev/null || echo "?")
    echo ""
    echo "  ChromaDB collections: $CHROMA_COLLECTIONS"
    echo ""

    if [ "$REPOS" != "?" ] && [ "$REPOS" -gt 0 ] 2>/dev/null; then
        success "Repo data exists — persistence looks good."
    else
        warn "No repositories found yet. Connect a repo through the app first, then rerun ./liffy.sh check (ideally after a docker compose down + up to prove it survives a rebuild)."
    fi
}

case "${1:-up}" in
    up)    cmd_up ;;
    down)  cmd_down ;;
    logs)  cmd_logs ;;
    check) cmd_check ;;
    *) error "Unknown command '$1'. Usage: ./liffy.sh [up|down|logs|check]" ;;
esac
