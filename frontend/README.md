# Liffy frontend

The web UI for Liffy: connect repositories, watch them index, and read the
reviews the pipeline writes.

Vite 8 · React 19 · TypeScript 6 · Tailwind CSS v4 · TanStack Query v5 ·
React Router v7 · MSW 2 · Vitest 4.

## Running it

```bash
npm ci
npm run dev          # expects the API at VITE_API_BASE_URL
npm run dev:mock     # no backend at all — MSW serves src/mocks/fixtures.ts
```

`dev:mock` is the one worth knowing about. It runs the whole UI against
fixtures with no Postgres, Redis, Chroma or LLM key anywhere, and every state
each screen can be in — loading, empty, error, and all four review lifecycle
states — is reachable by editing `src/mocks/fixtures.ts`. It is DEV-gated in
`main.tsx`, so the worker can never ship in a production build.

| Script | |
|---|---|
| `npm run dev` | dev server against the real API |
| `npm run dev:mock` | dev server against MSW fixtures |
| `npm run build` | typecheck, then production build |
| `npm run test` | Vitest, once |
| `npm run test:watch` | Vitest, watching |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc -b` |

`VITE_API_BASE_URL` points at the API (`http://localhost:8000` with the
compose stack). `VITE_USE_MSW=true` is what `dev:mock` sets.

## Layout

```
src/
  routes.tsx          exported as an array, so tests can mount any route
  index.css           the entire design system: tokens, texture, decorations
  types/api.ts        mirrors the backend's Pydantic schemas
  lib/                utils, validators, errors, pagination, reviewUtils, diff
  api/                axios client + one module per resource
  hooks/              keys.ts + queries + mutations
  mocks/              fixtures, handlers, node server, browser worker
  components/
    layout/           AppShell, TopBar, Breadcrumb, TabNav, PaperBackdrop
    ui/               Sheet, Badge, Button, Modal, Field, EmptyState, …
    repo/             RepoCard, RepoList, IndexStatus, ConnectRepoModal
    review/           ReviewRow, ReviewSummary, CommentGroup, diff/…
  pages/              Dashboard, Reviews, ReviewDetail, RepoDetail, StyleGuide
```

Tests sit next to what they test, as `Foo.test.tsx`.

## Design

A notebook: matte paper tones, hairline rules, and a faint CSS-only grain —
no `#fff`, no `#000`, no blurred shadows. Type is GitHub's Monaspace,
self-hosted, in two faces: **Argon** (the humanist cut) for the wordmark, page
headings, Liffy's review prose *and* code, diffs and file paths; **Neon** for
UI, chrome and tables. The conceptual move is that the LLM's verdict is the
handwriting in the margin.

`src/index.css` is the whole system, organised deliberately:

1. The raw palette — hand-written so it is always emitted, one block per
   theme. A theme overrides these values and nothing else; the `color-mix()`
   tints and diff washes reference them through `var()` and re-resolve on
   their own.
2. `@theme` — namespace resets (`--color-*: initial`) plus theme-invariant
   scales. It must come *first* of the two theme blocks: Tailwind applies them
   in source order, so a reset placed last would wipe every alias below.
3. `@theme inline` — semantic aliases. `inline` is load-bearing: plain
   `@theme` substitutes at `:root`, so a theme block would never propagate.

There is a DEV-only `/_styleguide` route with every swatch, the type ramp, all
four badge maps and every component state on one page — and it resolves hexes
and WCAG ratios live out of the browser, so the contrast audit is a standing
readout rather than a comment nobody re-measures.

## Things that will bite

- **Tailwind v4**: `border`/`divide`/`ring` default to `currentColor`, so
  every one must pair with `border-rule`. Constructed class names
  (`` bg-`${tone}`-tint ``) generate nothing.
- **`GET /reviews` returns no total count**, so pagination can only infer
  "there may be more" from a full page. No page numbers, by necessity.
- **`POST /reviews/trigger` returns no review id**, and
  `POST /reviews/{id}/trigger` creates a *new* review row rather than
  restarting the one on screen. Neither can deep-link; both land on the list.
- **Polling is the only completion signal.** No webhook or socket tells the
  frontend a worker finished, so `useReview` polls at 3s while in flight and
  `useRepoStatus` at 5s while un-indexed, each stopping the moment it is done.
- **Timestamps** can serialize without a `Z`, and `new Date("…T00:00:00")`
  parses as *local*. Everything goes through `ensureUtc`.
- **`lib/diff.ts` mirrors `backend/app/services/diff_parser.py`** and has to
  keep doing so — the backend anchors comments to new-file line numbers with
  its parser, and this one maps those numbers back onto rendered rows.
- **Monaco** must stay behind `React.lazy` or ~2.6MB lands in the main chunk,
  and its loader is pointed at the local package — the default is a CDN, which
  is not an option for a self-hosted tool.
