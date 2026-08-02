---
title: Connecting or replacing a credential
aliases: connect! / disconnect / replace token / oauth token / api key / credential
related: settings-and-env, subscription-providers
---

Credentials are set from the settings page so you do not have to edit a file.
Their values are never sent back to the browser — the page reports only whether
something is set, and where from.

**Connect** stores a credential for Liffy to use. For Claude Code the value
comes from running `claude setup-token` on your own machine; the dialog shows
the command because Liffy cannot run it for you (it is a browser login).

**Replace** appears when the credential currently comes from `backend/.env`. It
stores a new one here without touching the file.

**Disconnect** appears only when the page is the source. It removes Liffy's
copy — whatever `.env` holds takes over again, so a credential set in both
places will still show as configured afterwards. It does not revoke anything at
the provider; do that on their side.
