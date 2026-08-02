---
title: Connecting a repository
aliases: add a repository! / connect a repo / new repo / repositories / remove a repo
related: getting-started, indexing, webhooks
---

Add a repository by its `owner/name` from the dashboard. Liffy checks that your
GitHub token can actually see it before saving, so a typo or a private
repository you lack access to fails immediately rather than at review time.

Index it once after connecting. Until it has been indexed there is nothing for
reviews to retrieve, so they will still run but with no codebase context — the
thing that makes Liffy worth having.

Removing a repository deletes Liffy's record of it and its index. It does not
touch anything on GitHub, including the webhook — remove that in the
repository's settings if you no longer want deliveries.
