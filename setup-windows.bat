@echo off
setlocal EnableDelayedExpansion

REM ─────────────────────────────────────────────
REM  Liffy — Windows Setup Script
REM  Run this as Administrator.
REM  Right-click → "Run as administrator"
REM ─────────────────────────────────────────────

title Liffy Setup

echo.
echo   ██╗     ██╗███████╗███████╗██╗   ██╗
echo   ██║     ██║██╔════╝██╔════╝╚██╗ ██╔╝
echo   ██║     ██║█████╗  █████╗   ╚████╔╝
echo   ██║     ██║██╔══╝  ██╔══╝    ╚██╔╝
echo   ███████╗██║██║     ██║        ██║
echo   ╚══════╝╚═╝╚═╝     ╚═╝        ╚═╝
echo.
echo   Windows Setup
echo   ──────────────────────────────────────
echo.

REM ── Check for Admin ──────────────────────────────────────────────────────────
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [error] This script must be run as Administrator.
    echo         Right-click setup-windows.bat and choose "Run as administrator".
    pause
    exit /b 1
)

REM ── Check winget ─────────────────────────────────────────────────────────────
where winget >nul 2>&1
if %errorlevel% neq 0 (
    echo [error] winget not found.
    echo         Update Windows to version 1809 or later, or install "App Installer"
    echo         from the Microsoft Store: https://apps.microsoft.com/store/detail/app-installer/9NBLGGH4NNS1
    pause
    exit /b 1
)

REM ── 1. Python 3.11 ────────────────────────────────────────────────────────────
echo [liffy] Checking Python 3.11...
python --version 2>nul | findstr "3.11" >nul
if %errorlevel% neq 0 (
    echo [liffy] Installing Python 3.11...
    winget install -e --id Python.Python.3.11 --silent --accept-package-agreements --accept-source-agreements
    REM Refresh PATH
    call refreshenv 2>nul
    set "PATH=%LOCALAPPDATA%\Programs\Python\Python311;%LOCALAPPDATA%\Programs\Python\Python311\Scripts;%PATH%"
) else (
    echo [done]  Python 3.11 already installed
)

REM ── 2. Node.js 22 ────────────────────────────────────────────────────────────
echo [liffy] Checking Node.js...
node --version 2>nul | findstr "v22" >nul
if %errorlevel% neq 0 (
    echo [liffy] Installing Node.js 22...
    winget install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
    call refreshenv 2>nul
) else (
    echo [done]  Node.js already installed
)

REM ── 3. PostgreSQL 15 ─────────────────────────────────────────────────────────
echo [liffy] Checking PostgreSQL...
sc query postgresql-x64-15 >nul 2>&1
if %errorlevel% neq 0 (
    echo [liffy] Installing PostgreSQL 15...
    winget install -e --id PostgreSQL.PostgreSQL.15 --silent --accept-package-agreements --accept-source-agreements
    echo [warn]  PostgreSQL installed. Default postgres user password is what you set during install.
    echo         If you set a password, update DATABASE_URL in backend\.env after this script finishes.
    timeout /t 5 >nul
) else (
    echo [done]  PostgreSQL already installed
)

REM ── 4. Redis ─────────────────────────────────────────────────────────────────
echo [liffy] Checking Redis...
sc query Redis >nul 2>&1
if %errorlevel% neq 0 (
    echo [liffy] Installing Redis...
    winget install -e --id Memurai.Memurai --silent --accept-package-agreements --accept-source-agreements
    REM Memurai is a native Windows Redis-compatible server (no WSL needed)
    net start Memurai >nul 2>&1
) else (
    echo [done]  Redis already installed
)

REM ── 5. Git ───────────────────────────────────────────────────────────────────
echo [liffy] Checking Git...
where git >nul 2>&1
if %errorlevel% neq 0 (
    echo [liffy] Installing Git...
    winget install -e --id Git.Git --silent --accept-package-agreements --accept-source-agreements
    call refreshenv 2>nul
) else (
    echo [done]  Git already installed
)

REM ── Refresh PATH after installs ───────────────────────────────────────────────
set "PATH=%LOCALAPPDATA%\Programs\Python\Python311;%LOCALAPPDATA%\Programs\Python\Python311\Scripts;%PATH%"
set "PATH=%ProgramFiles%\PostgreSQL\15\bin;%PATH%"
set "PATH=%ProgramFiles%\Git\cmd;%PATH%"
set "PATH=%ProgramFiles%\nodejs;%PATH%"

REM ── 6. Create database ────────────────────────────────────────────────────────
echo [liffy] Creating database...
psql -U postgres -c "SELECT 1 FROM pg_database WHERE datname='liffy'" 2>nul | findstr "1" >nul
if %errorlevel% neq 0 (
    psql -U postgres -c "CREATE DATABASE liffy;"
    echo [done]  Database 'liffy' created
) else (
    echo [done]  Database 'liffy' already exists
)

REM ── 7. Environment files ──────────────────────────────────────────────────────
echo [liffy] Setting up environment files...
if not exist "backend\.env" (
    if exist "backend\.env.example" (
        copy backend\.env.example backend\.env >nul
        REM Generate a simple random secret using Python
        python -c "import secrets; s=open('backend\\.env').read(); open('backend\\.env','w').write(s.replace('JWT_SECRET_KEY=','JWT_SECRET_KEY='+secrets.token_hex(32)))"
        echo [done]  Created backend\.env
        echo [warn]  Open backend\.env and fill in GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, and OPENAI_API_KEY
    ) else (
        echo [error] backend\.env.example not found. Are you in the Liffy root folder?
        pause
        exit /b 1
    )
) else (
    echo [done]  backend\.env already exists — skipping
)

REM The frontend needs one too, and it is just as gitignored — so a fresh clone
REM has neither. Without VITE_API_BASE_URL every call becomes root-relative and
REM lands on the Vite dev server instead of the API, including the "Continue
REM with GitHub" link: Vite's SPA fallback answers /auth/github with index.html,
REM the router matches its catch-all behind RequireAuth, and an anonymous
REM visitor is redirected back to /login having never reached GitHub. No secrets
REM in this one, so there is nothing to fill in afterwards.
if not exist "frontend\.env" (
    if exist "frontend\.env.example" (
        copy frontend\.env.example frontend\.env >nul
        echo [done]  Created frontend\.env
    ) else (
        echo [error] frontend\.env.example not found. Are you in the Liffy root folder?
        pause
        exit /b 1
    )
) else (
    echo [done]  frontend\.env already exists — skipping
)

REM ── 8. Python venv + dependencies ────────────────────────────────────────────
echo [liffy] Setting up Python virtual environment...
cd backend
if not exist ".venv" (
    python -m venv .venv
)
call .venv\Scripts\activate.bat
python -m pip install --upgrade pip --quiet
pip install -r requirements.txt --quiet
echo [done]  Python dependencies installed

REM ── 9. Database migrations ────────────────────────────────────────────────────
echo [liffy] Running database migrations...
alembic upgrade head
echo [done]  Migrations applied
cd ..

REM ── 10. Frontend dependencies ─────────────────────────────────────────────────
echo [liffy] Installing frontend dependencies...
cd frontend
call npm install --silent
echo [done]  Frontend dependencies installed
cd ..

REM ─────────────────────────────────────────────────────────────────────────────
echo.
echo   ──────────────────────────────────────
echo   Setup complete! Starting Liffy...
echo   ──────────────────────────────────────
echo.
echo   Frontend  -^>  http://localhost:5173
echo   API       -^>  http://localhost:8000
echo   Swagger   -^>  http://localhost:8000/docs
echo.
echo   Three windows will open. Close all three to stop Liffy.
echo.
timeout /t 3 >nul

REM ── 11. Launch all three services in separate windows ────────────────────────
start "Liffy — API Server" cmd /k "cd backend && .venv\Scripts\activate.bat && uvicorn app.main:app --reload"
timeout /t 2 >nul
start "Liffy — Celery Worker" cmd /k "cd backend && .venv\Scripts\activate.bat && celery -A app.workers.celery_app worker --loglevel=info --pool=solo"
timeout /t 2 >nul
start "Liffy — Frontend" cmd /k "cd frontend && npm run dev"

echo [done]  All services started. Check the three windows that opened.
echo.
pause
