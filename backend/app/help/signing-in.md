---
title: Signing in
aliases: sign in! / login / log in / oauth / session / signed out / logout / cant get in
related: getting-started, settings-and-env
---

Liffy signs you in with GitHub OAuth and keeps a session as a short-lived
access token plus a refresh token, rotated on every use.

If sign-in fails or bounces you straight back to the login page, it is almost
always configuration rather than your account:

- `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` must be set in `backend/.env`.
- The callback URL registered on the GitHub OAuth app must match the address
  you are actually using, exactly — `localhost` and `127.0.0.1` are different
  to OAuth even though they are the same machine.
- `JWT_SECRET_KEY` must be a real value. If it still reads `changeme`, sessions
  are forgeable; the setup scripts generate one.

Being signed out unexpectedly usually means the refresh token was already used.
Rotation is deliberate — a reused refresh token is treated as stolen rather
than as a retry.
