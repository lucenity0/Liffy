# ─────────────────────────────────────────────
#  Liffy — one-command launcher (Windows)
#
#  .\liffy.ps1          start everything (docker services + frontend)
#  .\liffy.ps1 down     stop everything
#  .\liffy.ps1 check    confirm repo/PR data survived the last build
#  .\liffy.ps1 logs     tail docker service logs
#
#  The port of liffy.sh. Same four subcommands, same compose files, same
#  environment variables (LIFFY_SLIM_WORKER, LIFFY_NO_CODEX_MOUNT) — set those
#  with `$env:LIFFY_SLIM_WORKER = '1'` before running.
#
#  If PowerShell refuses to run this ("running scripts is disabled on this
#  system"), use liffy.bat next to it, which does nothing but invoke this file
#  with the policy bypassed for that one process.
#
#  Written against Windows PowerShell 5.1 — the one that ships with Windows 10
#  and 11 — so that nothing here needs PowerShell 7 installed first. That rules
#  out `??`, ternaries, and `Test-Json`.
#
#  KEEP THIS FILE SAVED AS UTF-8 *WITH* BOM. 5.1 decodes a BOM-less .ps1 as
#  ANSI/cp1252, and the em dashes and box-drawing characters below both contain
#  byte 0x94 — which cp1252 reads as a right double quotation mark. PowerShell
#  honours smart quotes as string delimiters, so without the BOM the file picks
#  up ~200 stray quote characters and dies with a dozen "Missing closing '}'"
#  parse errors that point at perfectly balanced braces. PowerShell 7 defaults
#  to UTF-8 and so never shows this, which is what makes it easy to reintroduce.
# ─────────────────────────────────────────────

param(
    [Parameter(Position = 0)]
    [string]$Command = 'up'
)

# Deliberately NOT 'Stop'. In PowerShell 5.1 a native command that writes to
# stderr under `$ErrorActionPreference = 'Stop'` raises NativeCommandError and
# kills the script — and `docker compose ps` on a stopped stack, `psql` against
# a missing table, and `npm install` on a warning all write to stderr as a
# matter of course. Every failure that actually matters below is checked
# explicitly via $LASTEXITCODE or try/catch.
$ErrorActionPreference = 'Continue'

function Write-Log     { param([string]$Message) Write-Host '[liffy]' -ForegroundColor Cyan   -NoNewline; Write-Host " $Message" }
function Write-Success { param([string]$Message) Write-Host '[done] ' -ForegroundColor Green  -NoNewline; Write-Host " $Message" }
function Write-Warn    { param([string]$Message) Write-Host '[warn] ' -ForegroundColor Yellow -NoNewline; Write-Host " $Message" }
function Write-Err     { param([string]$Message) Write-Host '[error]' -ForegroundColor Red    -NoNewline; Write-Host " $Message"; exit 1 }

Set-Location -Path $PSScriptRoot
$LiffyRoot        = $PSScriptRoot
$FrontendPidFile  = Join-Path $LiffyRoot '.liffy-frontend.pid'
$FrontendLogFile  = Join-Path $LiffyRoot '.liffy-frontend.log'
$FrontendDir      = Join-Path $LiffyRoot 'frontend'
$FrontendPort     = 5173

# docker-compose.codex.yml mounts `${HOME}/.codex`, and HOME is a Unix
# convention that Windows does not set — PowerShell has USERPROFILE. Left
# alone, Compose interpolates the empty string and the overlay asks to
# bind-mount `/.codex`, which is not the user's credential directory and on a
# fresh machine gets *created* as an empty one. The mount then succeeds and
# Codex silently has no credentials.
#
# Forward slashes rather than the native `C:\Users\...`, because the value is
# about to be concatenated with `/.codex` inside a YAML volume spec; `C:/Users/x`
# is the form Docker Desktop parses without ambiguity.
if (-not $env:HOME -or -not (Test-Path $env:HOME)) {
    $env:HOME = $env:USERPROFILE
}
$env:HOME = ($env:HOME -replace '\\', '/')

# The same directory the codex overlay will mount, so the existence check below
# and the bind-mount source cannot disagree.
$UserHome = $env:HOME

# Every docker-compose service: data stores + API + the workers that
# actually execute reviews (worker) and the weekly scheduler (beat).
$AllServices = @('postgres', 'redis', 'chromadb', 'backend', 'worker', 'beat')

# Which compose files are in play — see Select-ComposeFiles.
$ComposeFiles = @('-f', 'docker-compose.yml')

function Invoke-Compose {
    & docker compose @ComposeFiles @args
}

function Assert-Docker {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        Write-Err "Docker not found. Install Docker Desktop: https://www.docker.com/products/docker-desktop/"
    }

    docker info *> $null
    if ($LASTEXITCODE -ne 0) {
        Write-Err "Docker isn't running. Start Docker Desktop, wait for the whale icon to stop animating, and try again."
    }

    # `docker compose` (the v2 plugin) rather than the standalone `docker-compose`
    # v1 binary. Every compose file here uses `env_file:` with the `path:`/
    # `required:` mapping syntax, which v1 cannot parse — it fails with a schema
    # error naming a line rather than the version, so say it plainly here.
    docker compose version *> $null
    if ($LASTEXITCODE -ne 0) {
        Write-Err "'docker compose' is unavailable — this needs Compose v2. Update Docker Desktop to 4.x or newer."
    }
}

# The frontend is the one piece this launcher runs on the host rather than in a
# container, so Node is a real prerequisite of the Docker path too. Checked up
# front because the alternative is a stack that comes up fine and then fails at
# the last step with 'npm is not recognized'.
function Assert-Node {
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        Write-Err "npm not found, and the frontend runs on the host. Install Node.js: winget install -e --id OpenJS.NodeJS.LTS  (then open a new terminal so PATH refreshes)"
    }
}

# Read one key out of backend\.env, or nothing if it is not there.
#
# Deliberately not dot-sourcing: that file holds secrets with characters
# PowerShell would try to interpret, and it is not a script.
function Get-EnvSetting {
    param([string]$Key)

    $envPath = Join-Path $LiffyRoot 'backend\.env'
    if (-not (Test-Path $envPath)) { return '' }

    $line = Get-Content $envPath -ErrorAction SilentlyContinue |
        Where-Object { $_ -match ('^' + [regex]::Escape($Key) + '=') } |
        Select-Object -Last 1
    if (-not $line) { return '' }

    # Everything after the first '=', minus surrounding quotes and trailing
    # whitespace — the same shape as the shell's ${line#*=}.
    $value = $line.Substring($line.IndexOf('=') + 1)
    return $value.Trim().Trim('"').Trim("'")
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
function Get-DbSetting {
    param([string]$Key)

    $status = Invoke-Compose ps postgres 2>$null
    if ($LASTEXITCODE -ne 0) { return '' }
    if (-not ($status -match 'Up|running')) { return '' }

    $result = Invoke-Compose exec -T postgres psql -U liffy -d liffy -tAc "select value from settings where key='$Key';" 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $result) { return '' }

    return (@($result)[0] -replace '[\s\r]', '')
}

# What the *next review* will actually use: the page's choice if there is one,
# otherwise the dotfile's.
function Get-ResolvedSetting {
    param([string]$DbKey, [string]$EnvKey)

    $value = Get-DbSetting $DbKey
    if (-not $value) { $value = Get-EnvSetting $EnvKey }
    return $value
}

# Build the compose file list. Deliberately independent of which provider is
# selected — that is the whole point, and the long version of why lives in
# liffy.sh above the same function. In short: the worker is built to serve every
# provider, because `review_pr_task` re-reads the provider from the database at
# the top of every task, so pinning the container to one provider only forced
# rebuilds that changed nothing.
#
# Idempotent: rebuilds the array rather than appending to it, so the repeated
# calls across the subcommands below cannot stack duplicate -f flags.
function Select-ComposeFiles {
    $files = @('-f', 'docker-compose.yml')

    # The CLIs cost ~1.6GB of Node and two npm packages on top of the plain
    # worker. Worth it as the default, because the alternative is a rebuild
    # every time somebody touches the provider dropdown — but somebody who
    # knows they will only ever use an API key can decline.
    if ($env:LIFFY_SLIM_WORKER -eq '1') {
        Write-Warn "LIFFY_SLIM_WORKER=1 — worker built without the claude/codex CLIs. Selecting a subscription provider will fail until you unset it."
    }
    else {
        $files += @('-f', 'docker-compose.subscription.yml')
    }

    # Mounted whenever the host has a Codex store, not only when Codex is the
    # selected provider, so that selecting it later needs no restart.
    #
    # Guarded on existence because Compose creates a missing bind-mount source
    # as a directory — an unrequested .codex folder on a machine that never
    # installed the CLI. Compose cannot express the condition itself, which is
    # why it lives here rather than in the overlay.
    if ($env:LIFFY_NO_CODEX_MOUNT -eq '1') {
        # declined
    }
    elseif (Test-Path (Join-Path $UserHome '.codex')) {
        $files += @('-f', 'docker-compose.codex.yml')
    }

    $script:ComposeFiles = $files
}

# Warn about the one thing that will otherwise fail: a subscription provider
# selected with no credential to authenticate it.
#
# Called *after* the stack is up, so that Get-DbSetting can actually reach
# Postgres — on a cold start the settings page's choice is unreadable and a
# provider chosen in the UI would read as absent.
function Test-ProviderCredentials {
    $provider = Get-ResolvedSetting 'llm_provider' 'LLM_PROVIDER'

    # The two providers need different things, because the two CLIs offer
    # different things: Claude Code reads a token from the environment, Codex
    # only reads a credential directory.
    switch ($provider) {
        'claude_code' { $credential = Get-ResolvedSetting 'claude_code_oauth_token' 'CLAUDE_CODE_OAUTH_TOKEN' }
        'codex'       { $credential = Get-ResolvedSetting 'codex_home' 'CODEX_HOME' }
        default       { return }
    }

    if ($env:LIFFY_SLIM_WORKER -eq '1') {
        Write-Warn "LLM_PROVIDER=$provider needs the CLIs, but LIFFY_SLIM_WORKER=1 built the worker without them. Clear it with: Remove-Item Env:\LIFFY_SLIM_WORKER   then rerun .\liffy.ps1"
        return
    }

    if ($credential) { return }

    $codexDir = Join-Path $UserHome '.codex'
    if ($provider -eq 'claude_code') {
        Write-Warn "CLAUDE_CODE_OAUTH_TOKEN is empty in backend\.env. Run 'claude setup-token' on this machine and paste the result there — the worker will refuse to start without it."
    }
    elseif (-not (Test-Path $codexDir)) {
        Write-Warn "No $codexDir on this machine, so the worker has no Codex credentials mounted. Run 'codex login' here, then rerun .\liffy.ps1."
    }
    elseif (-not (Test-Path (Join-Path $codexDir 'auth.json'))) {
        Write-Warn "No $codexDir\auth.json found. Run 'codex login' on this machine before starting the Codex worker."
    }
}

# Discoverability: a subscription provider removes the cost barrier entirely,
# and until now the only place it was written down was a commented-out line in
# .env.example.
function Show-SubscriptionProviders {
    # Resolved, not Get-EnvSetting: the settings page writes the provider to the
    # database, so reading only the dotfile suggests switching to a provider the
    # user already switched to.
    $provider = Get-ResolvedSetting 'llm_provider' 'LLM_PROVIDER'
    if ($provider -eq 'claude_code' -or $provider -eq 'codex') { return }

    $found = @()
    if (Get-Command claude -ErrorAction SilentlyContinue) { $found += "    - LLM_PROVIDER=claude_code - the 'claude' CLI is installed" }
    if (Get-Command codex  -ErrorAction SilentlyContinue) { $found += "    - LLM_PROVIDER=codex - the 'codex' CLI is installed" }
    if ($found.Count -eq 0) { return }

    Write-Host ''
    Write-Host '  Reviews can run on a subscription you already pay for, with no API key:'
    $found | ForEach-Object { Write-Host $_ }
    Write-Host '    In Docker each also needs a token in backend\.env — see the README.'
    Write-Host ''
}

# 32 random bytes as hex, matching what secrets.token_hex(32) produces on the
# macOS path. Done with the .NET RNG rather than by shelling out to Python:
# liffy.sh can assume `python3`, and Windows cannot — python.org installs
# `python.exe`, the Store stub installs a `python3.exe` that opens the Store,
# and neither is guaranteed to be on PATH at all. Nothing else in this script
# needs Python, and this was the only reason it would have.
function New-JwtSecret {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
}

function Initialize-EnvFile {
    $envPath = Join-Path $LiffyRoot 'backend\.env'
    if (Test-Path $envPath) {
        Write-Success "backend\.env already exists — skipping"
        return
    }

    $examplePath = Join-Path $LiffyRoot 'backend\.env.example'
    if (-not (Test-Path $examplePath)) {
        Write-Err "backend\.env.example not found. Are you in the Liffy root directory?"
    }

    $lines = Get-Content $examplePath -Encoding UTF8
    $lines = $lines -replace '^JWT_SECRET_KEY=.*', ("JWT_SECRET_KEY=" + (New-JwtSecret))

    # Written through .NET rather than Set-Content for two properties Compose
    # cares about and Set-Content will not give you on 5.1:
    #
    #   - UTF-8 with no BOM. Set-Content's default on 5.1 is ANSI and on 7 is
    #     BOM-less UTF-8; a BOM here would attach itself to the first key, so
    #     `env_file` would read the first variable as `\ufeffDATABASE_URL` and
    #     the container would come up with no database URL at all.
    #   - LF endings. CRLF would leave a trailing \r on every value, and a
    #     secret with an invisible carriage return at the end fails
    #     authentication somewhere far away from here.
    $text = ($lines -join "`n") + "`n"
    [System.IO.File]::WriteAllText($envPath, $text, (New-Object System.Text.UTF8Encoding($false)))

    Write-Success "Created backend\.env with a generated JWT secret"
    Write-Warn "Open backend\.env and fill in GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET / an LLM key when you're ready for real runs"
}

# The frontend needs a dotfile of its own, for the same reason the backend does:
# `frontend\.env` is gitignored, so a fresh clone has none.
#
# Without VITE_API_BASE_URL every call becomes root-relative and lands on the
# Vite dev server instead of the API - including the "Continue with GitHub"
# link, which Login.tsx builds as "$base/auth/github". Vite's SPA fallback
# answers /auth/github with index.html, the router matches its catch-all
# (behind RequireAuth), and an anonymous visitor is redirected straight back to
# /login. Sign-in reads as silently broken rather than as a missing file, and
# the browser never reaches GitHub at all.
#
# Written through .NET for the same two reasons Initialize-EnvFile is: no BOM,
# and LF endings. A BOM here would make Vite read the first key as
# `\ufeffVITE_API_BASE_URL` and the variable would be undefined anyway - the
# exact bug this function exists to prevent, reintroduced by the writer.
function Initialize-FrontendEnvFile {
    $envPath = Join-Path $FrontendDir '.env'
    if (Test-Path $envPath) {
        Write-Success "frontend\.env already exists - skipping"
        return
    }

    $examplePath = Join-Path $FrontendDir '.env.example'
    if (-not (Test-Path $examplePath)) {
        Write-Err "frontend\.env.example not found. Are you in the Liffy root directory?"
    }

    $text = ((Get-Content $examplePath -Encoding UTF8) -join "`n") + "`n"
    [System.IO.File]::WriteAllText($envPath, $text, (New-Object System.Text.UTF8Encoding($false)))

    Write-Success "Created frontend\.env"
}

function Wait-Backend {
    Write-Log "Waiting for backend to become healthy..."
    foreach ($attempt in 1..30) {
        try {
            $response = Invoke-WebRequest -Uri 'http://localhost:8000/health' -UseBasicParsing -TimeoutSec 3
            if ($response.StatusCode -eq 200) {
                Write-Success "Backend is up"
                return
            }
        }
        catch {
            # Not up yet. The stack takes a while on first build; keep polling.
        }
        Start-Sleep -Seconds 2
    }
    Write-Warn "Backend didn't report healthy in time — check: docker compose logs backend"
}

# Which process is listening on a port. This is what liffy.sh gets from
# `lsof -ti tcp:PORT`, which Windows has no equivalent of.
#
# Get-NetTCPConnection is the modern answer and needs no elevation, but it comes
# from the NetTCPIP module that a few Windows editions and Server Core installs
# ship without — hence the netstat fallback, which is present everywhere.
function Get-ListenerPid {
    param([int]$Port)

    try {
        $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1
        if ($connection) { return [int]$connection.OwningProcess }
    }
    catch {
        # No NetTCPIP module, or nothing listening. Fall through.
    }

    # `:PORT` followed by whitespace, so that :5173 does not also match :51730.
    $line = netstat -ano -p TCP 2>$null |
        Where-Object { $_ -match 'LISTENING' -and $_ -match (':' + $Port + '\s') } |
        Select-Object -First 1
    if ($line -and $line -match '(\d+)\s*$') { return [int]$Matches[1] }

    return $null
}

function Start-Frontend {
    # Note: never `$pid` for a process id in PowerShell — that is the automatic
    # variable holding *this* script's process, and assigning to it here would
    # make the stop path below target the launcher itself.
    $running = Get-ListenerPid -Port $FrontendPort
    if ($running) {
        Write-Success "Frontend already running (PID $running)"
        Set-Content -Path $FrontendPidFile -Value $running
        return
    }

    Write-Log "Installing frontend dependencies..."
    Push-Location $FrontendDir
    try {
        & npm install --silent
        if ($LASTEXITCODE -ne 0) {
            Write-Warn "npm install exited $LASTEXITCODE — the dev server may fail to start. Check the output above."
        }
    }
    finally {
        Pop-Location
    }

    Write-Log "Starting frontend dev server..."
    # Through cmd.exe so that the whole `> log 2>&1` redirection is one shell's
    # job. Start-Process can redirect natively, but it refuses to point stdout
    # and stderr at the same file, and the interleaved single log is what
    # liffy.sh produces and what the message below promises.
    #
    # ArgumentList as ONE string on purpose: given an array, PowerShell re-quotes
    # any element containing spaces, which would wrap the redirection in quotes
    # and hand cmd a command it cannot parse.
    $cmdLine = '/c npm run dev > "' + $FrontendLogFile + '" 2>&1'
    Start-Process -FilePath 'cmd.exe' -ArgumentList $cmdLine -WorkingDirectory $FrontendDir -WindowStyle Hidden

    # Poll rather than sleep once. What we want recorded is the pid of *node*
    # holding the port, not of the cmd.exe that launched it — killing the
    # launcher would leave Vite running and the port bound. Vite needs a few
    # seconds to bind, and a single sleep loses the race often enough to matter.
    $frontendPid = $null
    foreach ($attempt in 1..30) {
        Start-Sleep -Seconds 1
        $frontendPid = Get-ListenerPid -Port $FrontendPort
        if ($frontendPid) { break }
    }

    if ($frontendPid) {
        Set-Content -Path $FrontendPidFile -Value $frontendPid
        Write-Success "Frontend starting → logs: $FrontendLogFile"
    }
    else {
        Write-Warn "Frontend didn't bind port $FrontendPort in time — check: $FrontendLogFile"
    }
}

function Stop-Frontend {
    if (Test-Path $FrontendPidFile) {
        $recorded = (Get-Content $FrontendPidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
        if ($recorded -match '^\d+$') {
            $proc = Get-Process -Id ([int]$recorded) -ErrorAction SilentlyContinue
            if ($proc -and $proc.ProcessName -eq 'node') { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
        }
        Remove-Item $FrontendPidFile -Force -ErrorAction SilentlyContinue
        Write-Success "Frontend stopped"
    }

    # Fallback: anything still holding Vite's port.
    $stray = Get-ListenerPid -Port $FrontendPort
    if ($stray) {
        Stop-Process -Id $stray -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-Up {
    Assert-Docker
    Assert-Node
    Initialize-EnvFile
    Initialize-FrontendEnvFile
    Select-ComposeFiles

    Write-Log ("Starting docker services: " + ($AllServices -join ' '))
    Invoke-Compose up -d --build @AllServices
    if ($LASTEXITCODE -ne 0) {
        Write-Err "docker compose up failed — see the output above."
    }

    Wait-Backend

    Write-Log "Running database migrations..."
    Invoke-Compose exec -T backend alembic upgrade head
    if ($LASTEXITCODE -eq 0) {
        Write-Success "Migrations applied"
    }
    else {
        Write-Warn "Migrations failed — check: docker compose logs backend"
    }

    Start-Frontend

    Write-Host ''
    Write-Host '  ──────────────────────────────────────'
    Write-Success "Liffy is up"
    Write-Host '  ──────────────────────────────────────'
    Write-Host '  Frontend  →  http://localhost:5173'
    Write-Host '  API       →  http://localhost:8000'
    Write-Host '  Swagger   →  http://localhost:8000/docs'
    Write-Host ''
    Write-Warn "Real reviews will call your configured LLM and (if POST_REVIEWS_TO_GITHUB=true) post to GitHub — check backend\.env before connecting a real repo."
    # After the stack is up, so the settings page's choice is readable — see
    # the note on the function.
    Test-ProviderCredentials
    Show-SubscriptionProviders
    Write-Host '  Stop:            .\liffy.ps1 down'
    Write-Host '  Check data:      .\liffy.ps1 check'
    Write-Host ''
}

function Invoke-Down {
    Stop-Frontend
    Select-ComposeFiles *> $null
    Invoke-Compose stop @AllServices *> $null
    if ($LASTEXITCODE -ne 0) {
        Write-Warn "docker compose stop failed — is Docker Desktop running?"
        return
    }
    Write-Success "All services stopped (data volumes kept — nothing was deleted)"
}

function Invoke-Logs {
    Select-ComposeFiles *> $null
    Invoke-Compose logs -f @AllServices
}

function Invoke-Check {
    Assert-Docker
    Select-ComposeFiles *> $null
    Write-Log "Checking whether repo data survived (Postgres + ChromaDB)..."

    $status = Invoke-Compose ps postgres 2>$null
    if (-not ($status -match 'Up|running')) {
        Write-Err "Postgres isn't running. Run .\liffy.ps1 first."
    }

    function Get-RowCount {
        param([string]$Table)
        $result = Invoke-Compose exec -T postgres psql -U liffy -d liffy -tAc "SELECT count(*) FROM $Table;" 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $result) { return '?' }
        return (@($result)[0] -replace '[\s\r]', '')
    }

    $repos      = Get-RowCount 'repositories'
    $prs        = Get-RowCount 'pull_requests'
    $reviews    = Get-RowCount 'reviews'
    $embeddings = Get-RowCount 'repo_embeddings'

    Write-Host ''
    Write-Host '  Postgres (survives docker compose down / rebuild via the pgdata volume):'
    Write-Host "    repositories   : $repos"
    Write-Host "    pull_requests  : $prs"
    Write-Host "    reviews        : $reviews"
    Write-Host "    repo_embeddings: $embeddings"

    $collections = '?'
    try {
        $response = Invoke-RestMethod -Uri 'http://localhost:8001/api/v2/tenants/default_tenant/databases/default_database/collections' -TimeoutSec 5
        # @() around it because a one-collection response deserialises to a bare
        # object, and .Count on a bare object is 1 only by accident on 5.1.
        $collections = @($response).Count
    }
    catch {
        # Chroma not up, or the API moved. '?' is the honest answer.
    }
    Write-Host ''
    Write-Host "  ChromaDB collections: $collections"
    Write-Host ''

    if ($repos -match '^\d+$' -and [int]$repos -gt 0) {
        Write-Success "Repo data exists — persistence looks good."
    }
    else {
        Write-Warn "No repositories found yet. Connect a repo through the app first, then rerun .\liffy.ps1 check (ideally after a docker compose down + up to prove it survives a rebuild)."
    }
}

switch ($Command) {
    'up'    { Invoke-Up }
    'down'  { Invoke-Down }
    'logs'  { Invoke-Logs }
    'check' { Invoke-Check }
    default { Write-Err "Unknown command '$Command'. Usage: .\liffy.ps1 [up|down|logs|check]" }
}
