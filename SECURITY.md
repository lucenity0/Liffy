# Security policy

Liffy holds GitHub access tokens and reads private source code, so a bug here
can matter more than the project's size suggests. Reports are welcome and will
be taken seriously.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.** A public issue is
readable by everyone, including anyone who would use it, before there is a fix.

Report it privately through GitHub:

1. Go to <https://github.com/lucenity0/Liffy/security/advisories/new>
   (the **Security** tab → **Report a vulnerability**).
2. Describe the issue and how to reproduce it.
3. Submit. Only the maintainers can see the draft advisory.

This route keeps the report private, gives us a place to work on a fix with you,
and issues a CVE if one is warranted. If you cannot use it for any reason, open
a normal issue that says only *"security report, please make contact"* — with no
detail — and a maintainer will follow up.

### What to include

The more of this you have, the faster it gets fixed:

- What an attacker can do, and what they need in order to do it (network access?
  a repo connected? an account on the instance?)
- Steps to reproduce, or a proof of concept
- The commit or version you tested
- Your configuration, particularly `LLM_PROVIDER` and whether the instance is
  exposed to the internet
- Anything you think we would get wrong about the impact

### What to expect

Liffy is built by two students alongside coursework, so please read these as
honest intentions rather than a commercial SLA:

| | Target |
|---|---|
| First response | Within 5 days |
| Assessment and severity | Within 14 days |
| Fix for a critical issue | As fast as we can manage, prioritised over features |

We will keep you updated, credit you in the advisory unless you would rather we
did not, and tell you plainly if we decide not to fix something and why.

## Scope

Liffy is **self-hosted**. There is no Liffy-operated server, no hosted instance,
and no user data held by the maintainers — every deployment belongs to whoever
runs it. That shapes what is in scope here.

### In scope

- Authentication and session handling — the OAuth flow, JWT issuing and
  verification, refresh-token rotation
- Webhook signature verification (`backend/app/api/webhook.py`) — anything that
  lets an unsigned or forged payload be processed
- Access control — one user reaching another user's repositories, reviews or
  tokens
- Secret handling — GitHub tokens, model API keys, or the JWT signing key being
  logged, returned in an API response, or written somewhere unexpected
- Injection of any kind, including prompt injection that causes Liffy to
  exfiltrate code or credentials
- Dependency vulnerabilities that are actually reachable from Liffy's code

### Out of scope

- Vulnerabilities in the model providers themselves — report those to
  Anthropic, Google or Ollama
- The consequences of running with `.env.example` defaults in production. The
  placeholder `JWT_SECRET_KEY` is a placeholder; see below
- Anything that requires an attacker to already have shell access to the host
- Missing hardening on an instance the operator chose to expose to the internet
  without a reverse proxy, TLS, or authentication in front of it
- Reports from automated scanners with no demonstrated impact

## If you run Liffy

A few things are your responsibility rather than the project's, because they
depend on your deployment:

- **Set a real `JWT_SECRET_KEY`.** The setup scripts generate one. If yours
  still reads `changeme`, anyone can forge a session.
- **Set a real `GITHUB_WEBHOOK_SECRET`,** and keep it matched to the one
  configured in GitHub. The webhook endpoint is public by necessity; the
  signature is the only thing separating a real event from a forged one.
- **Keep `backend/.env` out of version control.** It is gitignored; keep it
  that way.
- **Do not expose the API directly.** Put it behind a reverse proxy with TLS.
- **Understand where your code goes.** With a local model nothing leaves your
  machine; with a hosted provider your diffs and retrieved source are sent to
  that provider. See [*where your code goes*](README.md#-where-your-code-goes)
  in the README.

## Known dependency advisories

Audited 2026-08-03 with `pip-audit` and `npm audit`. Both audits were clean of
everything reachable by an unauthenticated request; what remains is listed here
rather than left for you to rediscover.

The backend went from **36 advisories across 11 packages to 7 across 4**. Fixed
by upgrading: `starlette` (10, the HTTP layer every request reaches first),
`python-multipart` (7, request-body parsing), `pygments`, `python-dotenv`,
`langsmith`, and most of `langchain-core`. `pytest` was also removed from
`requirements.txt` entirely — it was pinned there as well as in
`requirements-dev.txt`, so a test runner was being installed into production
images for no reason.

### Accepted, with reasons

**`langchain` 0.3.30, `langchain-core` 0.3.86, `langchain-text-splitters`
0.3.11, `langchain-openai` 0.2.10 — 5 advisories.**

Every one is fixed only in the `1.x` line. That is not a version bump: `1.x`
moves import paths and the chain-composition APIs that `backend/app/llm/chain.py`
is built on, so taking it means porting the review pipeline. We have taken the
newest `0.3` releases instead, which carry the fixes that were backported.

These are reachable through prompt and document inputs — which, in Liffy, are
the diffs and source of repositories **you** connected, on an instance **you**
run. That is a materially narrower exposure than an unauthenticated HTTP path,
and it is why these are the ones left rather than the starlette advisories.

If you are pointing Liffy at repositories you do not control, weigh that
differently, and treat the `1.x` migration as work worth doing.

**`react-router` 7.18.2 — 1 advisory.** GHSA-qwww-vcr4-c8h2 is a CSRF bypass in
**RSC mode**. Liffy's frontend is a Vite SPA using `createBrowserRouter`
(`frontend/src/App.tsx`) and does not use React Server Components, so the
vulnerable path is not present. The fix is in `8.x`, a major upgrade.

**`dompurify`, via `monaco-editor` — 1 advisory, moderate.** A
`CUSTOM_ELEMENT_HANDLING` sanitiser bypass. Monaco renders the diff viewer, and
Liffy does not configure custom-element handling. No fixed `monaco-editor` was
available at the time of audit.

### Re-running the audit

```bash
pip-audit -r backend/requirements.txt      # or: uvx pip-audit -r ...
cd frontend && npm audit
```

If you find one of the accepted advisories is reachable in a way we have
misjudged, that is exactly the sort of report the process above is for.

## Supported versions

Liffy is pre-1.0 and moves fast. Only `main` is supported — fixes land there,
and there are no backports to older commits or tags.
