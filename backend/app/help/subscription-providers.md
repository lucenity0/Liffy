---
title: Using a Claude or ChatGPT subscription
aliases: subscription! / claude code / codex / setup token / no api key / cli provider
related: providers, review-failed, connect-a-credential
---

`claude_code` and `codex` run reviews through a locally installed CLI signed in
to a subscription you already pay for, instead of an API key billed per token.

They are for local, personal use. Automating a subscription for a hosted,
multi-user deployment is a different thing under different terms, and neither
is available in CI.

**In Docker**, the worker needs the CLI inside its image and a credential it can
reach. `./liffy.sh` selects the right compose overlay automatically — a bare
`docker compose up` builds a worker without the CLIs, and every review then
fails with `'claude' is not on PATH`.

For Claude Code, run `claude setup-token` on the host and connect the result on
the settings page. For Codex there is no token login, so the container needs
your `~/.codex` directory mounted; the compose overlay documents exactly what
that grants before you uncomment it.

Expect these to be slow. A large pull request can take several minutes, which
is normal for this path.
