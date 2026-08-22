# ADR 007 — Liffy is single-tenant, and says so

**Status:** accepted · **Date:** 2026-08-23 · **Issues:** #298

## Context

A full-repo adversarial review before any real deployment turned up six
findings. Five were a guard that already existed failing to cover one case. The
sixth was the one this ADR is really about: Liffy had no answer to *whose
instance is this?*, and every other finding got worse because of it.

`api/settings.py` recorded the gap honestly — "authenticated, but not
authorized beyond that … a real limitation rather than an oversight". What the
note did not say is that account creation was open too. `upsert_user` created a
row for whoever completed the OAuth handshake, so "any signed-in user" meant
anyone with a GitHub account, and an instance running webhooks has to be
reachable from the internet for webhooks to arrive at all.

That mattered because of what the settings page decides. `openai_base_url`
chooses which company receives the code being reviewed; the review request
carries the diff, every retrieved context chunk, and `OPENAI_API_KEY` in the
`Authorization` header. `post_reviews_to_github` and `github_review_event_mode`
decide whether Liffy writes to real pull requests and whether it can block a
human's merge. One `PATCH` from a stranger was enough for any of it.

## Decision

**One instance, one owner, claimed by first login.**

`users.is_owner` is set by the first account to complete the handshake, and a
partial unique index makes "exactly one" true rather than merely intended — two
simultaneous first logins resolve on the constraint instead of producing two
owners. Every later login is refused unless it is the owner (matched on
`github_id`, which is stable across renames) or appears in
`ALLOWED_GITHUB_LOGINS`.

`require_owner` gates the routes that are about the *install* rather than about
your repositories: all four settings routes, and `help/report`.

## Why not roles

Because the honest shape of the product is one person. Liffy connects *your*
repositories with *your* GitHub token and reviews them with *your* API key or
*your* subscription. A role system would be a larger change than the feature it
protects, and every role beyond "owner" would be a permission nobody has asked
for — which is how a role system becomes the thing you have to reason about
instead of the thing you were protecting.

The allowlist is the escape hatch for the one real case: a second person who
genuinely needs to look. They get a session and their own repositories. They do
not get the install.

Reconsider this the moment two people need *different* settings, which is the
point at which settings stop being instance-global and the argument above stops
holding.

## What the model assumes

- **The instance is reachable from the internet.** Not a worst case, a
  requirement — GitHub has to be able to POST to `/webhook/github`.
- **The owner's GitHub token is the most privileged credential in the system.**
  It reaches private repositories and can write to pull requests. Nothing may
  silently escalate to it, which is why `get_github_token` now refuses rather
  than falling back.
- **Anything the model emits is attacker-influenced.** A pull request's diff
  goes into the prompt, so a contributor can attempt to steer the output. Every
  model-authored string that reaches a published GitHub comment is defanged,
  and code spans use a delimiter that cannot be closed from inside.
- **The database is trusted, the `settings` table is not.** A row is not
  authority: `load_overrides` re-parses every stored value through
  `SettingSpec.parse` on boot, so a hand-written `INSERT` faces the same
  validation as a `PATCH`.

## Consequences

- **Everyone signs in again once, on upgrade.** The lockdown lands at the OAuth
  callback, and refresh tokens rotate for 30 days without ever returning to it —
  so "refused at the next login" was not a guarantee when there might never be a
  next login. Migration `a91e5c2b7d04` revokes every live session, and
  `session_permitted` re-asks the question on each rotation so the answer cannot
  go stale mid-session.
- A fresh clone still runs with no configuration. Whoever sets it up becomes
  the owner by using it, which is the property the old open behaviour was
  really protecting.
- The Settings entry is hidden from a non-owner's nav. Appearance lives under
  Settings and is purely local (`useAppearance` writes to `localStorage`), so
  an allowlisted user loses the theme editor along with the settings they could
  not use. A rare inconvenience, traded for one nav rule instead of a split
  page.
- Migration `a91e5c2b7d04` backfills the oldest account as owner. On a
  single-user install that is the person who set it up; on any other it is the
  closest thing to a defensible answer without asking a question a migration
  cannot ask.
- Ownership cannot currently be transferred from the UI. `UPDATE users SET
  is_owner` in psql is the answer, and the partial unique index means you have
  to clear the old one first. Worth a real control if anyone ever needs it.
