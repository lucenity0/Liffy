---
title: Starting Liffy for the first time
aliases: getting started! / install / setup / first run / liffy.sh / how do i start
related: settings-and-env, webhooks, providers
---

`./liffy.sh` is the way in. It creates `backend/.env` if it is missing,
generates a real JWT secret, picks the right compose files for your configured
provider, starts everything, and waits until the backend is healthy.

Use it rather than `docker compose up` directly. The launcher knows things the
bare compose command does not — most importantly, that a subscription provider
needs a different worker image, which a plain `up` will silently replace.

Other commands: `./liffy.sh down` stops everything and keeps your data,
`./liffy.sh logs` follows the services, and `./liffy.sh check` reports what is
configured and what is missing.

After it starts, sign in with GitHub, connect a repository, let it index once,
and open a pull request.
