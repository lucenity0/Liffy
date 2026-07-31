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

require_docker() {
    command -v docker &>/dev/null || error "Docker not found. Install Docker Desktop: https://www.docker.com/products/docker-desktop/"
    docker info &>/dev/null || error "Docker isn't running. Start Docker Desktop and try again."
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

    log "Starting docker services: ${ALL_SERVICES[*]}"
    docker compose up -d --build "${ALL_SERVICES[@]}"

    wait_for_backend

    log "Running database migrations..."
    docker compose exec -T backend alembic upgrade head && success "Migrations applied" || warn "Migrations failed — check: docker compose logs backend"

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
    echo "  Stop:            ./liffy.sh down"
    echo "  Check data:      ./liffy.sh check"
    echo ""
}

cmd_down() {
    stop_frontend
    docker compose stop "${ALL_SERVICES[@]}" 2>/dev/null || true
    success "All services stopped (data volumes kept — nothing was deleted)"
}

cmd_logs() {
    docker compose logs -f "${ALL_SERVICES[@]}"
}

cmd_check() {
    require_docker
    log "Checking whether repo data survived (Postgres + ChromaDB)..."

    if ! docker compose ps postgres 2>/dev/null | grep -q "Up\|running"; then
        error "Postgres isn't running. Run ./liffy.sh first."
    fi

    REPOS=$(docker compose exec -T postgres psql -U liffy -d liffy -tAc "SELECT count(*) FROM repositories;" 2>/dev/null || echo "?")
    PRS=$(docker compose exec -T postgres psql -U liffy -d liffy -tAc "SELECT count(*) FROM pull_requests;" 2>/dev/null || echo "?")
    REVIEWS=$(docker compose exec -T postgres psql -U liffy -d liffy -tAc "SELECT count(*) FROM reviews;" 2>/dev/null || echo "?")
    EMBEDDINGS=$(docker compose exec -T postgres psql -U liffy -d liffy -tAc "SELECT count(*) FROM repo_embeddings;" 2>/dev/null || echo "?")

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
