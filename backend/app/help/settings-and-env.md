---
title: Settings page or .env?
aliases: settings! / configure / dotenv / env file / where is this configured
related: connect-a-credential, providers
---

Both work, and the page tells you which one is in force for every setting.

`backend/.env` is the file. The settings page stores overrides in the database.
An override wins over the file, so the page is the last word — and every row
says where its current value came from:

- **Connected / override** — set here, on this page.
- **From .env** — coming from the file. The page can replace it, and doing so
  leaves the file untouched.
- **Default** — nobody has set it.

That distinction is why Disconnect only appears on values the page itself
stored. A value from `.env` has nothing here to remove; you replace it instead.

Changes take effect on the next review. Nothing already running picks them up.
