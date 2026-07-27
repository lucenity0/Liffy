# `under-construction` — the GitHub Pages branch

This branch is **not source**. It is what `liffy.lucenity.dev` literally
serves, and it has no history in common with `main` on purpose: nothing here
should ever be merged either way.

```
/                     the public WIP page      → https://liffy.lucenity.dev/
/preview-<hex>/       full app builds          → handed out by link only
```

Everything on it is written by `deploy-preview.sh` on `main`:

| command                        | what it touches                          |
| ------------------------------ | ---------------------------------------- |
| `./deploy-preview.sh --wip`    | `index.html`, `favicon.svg`, `fonts/`    |
| `./deploy-preview.sh`          | `preview-<hex>/` (reuses the saved slug) |
| `./deploy-preview.sh --new`    | a fresh `preview-<hex>/`                 |
| `./deploy-preview.sh --kill`   | deletes that slug → 404                  |

Edit the WIP page at `frontend/public/under-construction.html` on `main` and
re-run `--wip`; the copy here is a build output. Preview subpaths are built
with `--base=/<slug>/` and carry `noindex, nofollow`, so an unguessable link
stays unindexed — but it is still public to anyone holding it.

`CNAME` and `.nojekyll` are read by Pages off this branch only. Removing
`CNAME` drops the custom domain; removing `.nojekyll` makes Jekyll eat any
path starting with an underscore.
