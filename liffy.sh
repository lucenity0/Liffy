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

# Which compose files are in play — see select_compose_files.
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

# Build the compose file list. Deliberately independent of which provider is
# selected — that is the whole point.
#
# It used to key off the resolved provider: subscription overlay only for
# `claude_code`/`codex`, Codex overlay only for `codex`. That made the *worker
# container* single-provider, so switching provider in the settings page meant
# re-running the launcher to get a container that could serve the new choice —
# and switching between the API-key and subscription families swapped a 949MB
# image for a 2.5GB one. Meanwhile the code underneath was already fully
# runtime-dispatched: `review_pr_task` calls `refresh_overrides()` before
# `get_llm()`, so the provider is re-read from the database at the top of every
# single task. Only the container was pinned.
#
# So build one worker that can serve every provider and let that existing
# dispatch decide. A provider change in the page now applies to the next review
# with no restart at all.
#
# Idempotent: rebuilds the array rather than appending to it, so the repeated
# calls across the subcommands below cannot stack duplicate -f flags.
select_compose_files() {
    COMPOSE_FILES=(-f docker-compose.yml)

    # The CLIs cost ~1.6GB of Node and two npm packages on top of the plain
    # worker. Worth it as the default, because the alternative is a rebuild
    # every time somebody touches the provider dropdown — but somebody who
    # knows they will only ever use an API key can decline.
    if [ "${LIFFY_SLIM_WORKER:-}" = "1" ]; then
        warn "LIFFY_SLIM_WORKER=1 — worker built without the claude/codex CLIs. Selecting a subscription provider will fail until you unset it."
    else
        COMPOSE_FILES+=(-f docker-compose.subscription.yml)
    fi

    # Mounted whenever the host has a Codex store, not only when Codex is the
    # selected provider, so that selecting it later needs no restart.
    #
    # Guarded on existence because Compose creates a missing bind-mount source
    # as a root-owned directory — an unrequested ~/.codex on a machine that
    # never installed the CLI. Compose cannot express the condition itself,
    # which is why it lives here rather than in the overlay.
    if [ "${LIFFY_NO_CODEX_MOUNT:-}" = "1" ]; then
        :
    elif [ -d "$HOME/.codex" ]; then
        COMPOSE_FILES+=(-f docker-compose.codex.yml)
    fi
}

# Warn about the one thing that will otherwise fail: a subscription provider
# selected with no credential to authenticate it.
#
# Called *after* the stack is up, unlike the compose-file selection it used to
# be fused with. That fusion forced this check to run before `docker compose
# up`, where on a cold start Postgres is not yet running and `resolved_setting`
# can only see backend/.env — so a provider chosen in the settings page read as
# absent. Nothing about the compose files depends on the provider any more, so
# the check is free to run at the point where the database can actually answer.
check_provider_credentials() {
    local provider credential
    provider=$(resolved_setting llm_provider LLM_PROVIDER)
    case "$provider" in
        # The two providers need different things, because the two CLIs offer
        # different things: Claude Code reads a token from the environment,
        # Codex only reads a credential directory.
        claude_code) credential=$(resolved_setting claude_code_oauth_token CLAUDE_CODE_OAUTH_TOKEN) ;;
        codex)       credential=$(resolved_setting codex_home CODEX_HOME) ;;
        *)           return 0 ;;
    esac

    if [ "${LIFFY_SLIM_WORKER:-}" = "1" ]; then
        warn "LLM_PROVIDER=$provider needs the CLIs, but LIFFY_SLIM_WORKER=1 built the worker without them. Unset it and rerun ./liffy.sh."
        return 0
    fi

    [ -n "$credential" ] && return 0

    if [ "$provider" = "claude_code" ]; then
        warn "CLAUDE_CODE_OAUTH_TOKEN is empty in backend/.env. Run 'claude setup-token' on this machine and paste the result there — the worker will refuse to start without it."
    elif [ ! -d "$HOME/.codex" ]; then
        warn "No ~/.codex on this machine, so the worker has no Codex credentials mounted. Run 'codex login' here, then rerun ./liffy.sh."
    elif [ ! -f "$HOME/.codex/auth.json" ]; then
        warn "No ~/.codex/auth.json found. Run 'codex login' on this machine before starting the Codex worker."
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
        [ -f backend/.env.example ] || error "backend/.env.example not found. Are you in the Liffy root directory?"
        cp backend/.env.example backend/.env
        JWT_SECRET=$(python3 -c "import secrets; print(secrets.token_hex(32))" 2>/dev/null || echo "dev-only-insecure-secret-change-me-before-deploy")
        sed -i '' "s/JWT_SECRET_KEY=.*/JWT_SECRET_KEY=$JWT_SECRET/" backend/.env 2>/dev/null || \
            sed -i "s/JWT_SECRET_KEY=.*/JWT_SECRET_KEY=$JWT_SECRET/" backend/.env
        success "Created backend/.env with a generated JWT secret"
        warn "Open backend/.env and fill in GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET / an LLM key when you're ready for real runs"
    else
        success "backend/.env already exists — skipping"
    fi
}

# The frontend needs a dotfile of its own, for the same reason the backend does:
# `frontend/.env` is gitignored, so a fresh clone has none.
#
# Without VITE_API_BASE_URL every call becomes root-relative and lands on the
# Vite dev server instead of the API — including the "Continue with GitHub"
# link, which `Login.tsx` builds as `${base}/auth/github`. Vite's SPA fallback
# answers /auth/github with index.html, the router matches its catch-all
# (behind RequireAuth), and an anonymous visitor is redirected straight back to
# /login. Sign-in reads as silently broken rather than as a missing file, and
# the browser never reaches GitHub at all.
#
# A straight copy with nothing to fill in afterwards: unlike backend/.env this
# file holds no secrets, only the API's URL.
ensure_frontend_env_file() {
    if [ -f frontend/.env ]; then
        success "frontend/.env already exists — skipping"
        return 0
    fi
    [ -f frontend/.env.example ] || error "frontend/.env.example not found. Are you in the Liffy root directory?"
    cp frontend/.env.example frontend/.env
    success "Created frontend/.env"
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
    ensure_frontend_env_file
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
    # After the stack is up, so the settings page's choice is readable — see
    # the note on the function.
    check_provider_credentials
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
