# Indexing coverage

What Liffy actually indexes, measured against its own repository. Numbers from
the LANG-2 verification run (2026-07-29), on `main` after the auth milestone
and TypeScript chunking (#161) landed.

## Languages

Semantic, function-level chunking via Tree-sitter:

| Extension | Grammar |
|---|---|
| `.py` | `tree-sitter-python` |
| `.ts` | `tree-sitter-typescript` (typescript) |
| `.tsx` | `tree-sitter-typescript` (**tsx** — a separate grammar; the plain one reads `<Foo>` as a type assertion and mis-parses JSX) |
| `.js` `.jsx` `.mjs` `.cjs` | `tree-sitter-javascript` |

Every other text file falls back to fixed 80-line windows, which is why some
chunks below have `kind = "block"`.

## Measured on `lucenity0/Liffy`

**217 indexable files → 1,191 chunks. 754 of them (63%) carry a symbol name.**

That last number is the one that says the milestone worked. Across the
frontend alone it is **53% named, against 0% before #161** — every `.ts` and
`.tsx` file used to land as anonymous 80-line windows.

| Extension | Files | Chunks | | Kind | Chunks |
|---|---:|---:|---|---|---:|
| `.py` | 66 | 576 | | `function` | 624 |
| `.tsx` | 64 | 309 | | `module` | 360 |
| `.ts` | 42 | 214 | | `block` | 77 |
| `.md` | 9 | 20 | | `class` | 76 |
| `.js` | 2 | 15 | | `interface` | 54 |

**538 chunks (44%) come from the frontend.**

### Incremental sync

Re-running against an unchanged tree:

```
chunks_added=0  chunks_skipped=1191  chunks_deleted=0
chunk identity stable: True (1191 pairs)
```

`chunks_skipped` equalling the total is the check that matters. If Tree-sitter
emitted definitions in a different order between runs, every
`(file_path, chunk_index)` pair would point at different content, every hash
would mismatch, and an unchanged repository would re-embed in full —
expensive, and wrong in a way nothing would report.

### Retrieval spot-check

Real embeddings (`BAAI/bge-small-en-v1.5`, local), top-5 by cosine distance:

| Query | Nearest neighbours |
|---|---|
| *React component rendering a review comment with severity badges* | `ReviewComment.tsx:19-72` (0.218), `ReviewComment.tsx:1-17` (0.228), `ReviewDetail.tsx:26-89` (0.234) |
| *split source code into function-level chunks using tree-sitter* | `chunker.py:1-54` (0.207), `chunker.py:229-269` (0.237), `chunker.py:60-69` (0.282) |
| *store and clear the access and refresh token pair in localStorage* | `tokenStore.ts:1-30` (0.170), `tokenStore.ts:65-76` (0.221), `tokenStore.ts:78-81` (0.225) |
| *paginate the reviews list with limit and offset* | `test_api_reviews.py:131-135` (0.170), `Reviews.test.tsx:24-35` (0.188), `useReviews.ts:15-31` (0.198), `api/reviews.ts:9-17` (0.211) |

Judgement: **related, not merely five results.** The last query is the
interesting one — a single concept pulls the backend endpoint test, the
frontend page test, the hook and the API wrapper. That cross-language
retrieval is what multi-language indexing was for, and it only works because
both halves are chunked semantically now.

## What is excluded, and what that is worth

Beyond the obvious (`node_modules`, `dist`, `.git`, binaries, lockfiles):

- **Dotenvs** — `.env`, `.env.local`, `.envrc` (direnv), and the
  `staging.env` / `docker.env` convention `env_file:` encourages, in any
  case. A dotenv holds database passwords and API keys; indexing one embeds
  them into the vector store, where they return as review context and, under
  a hosted embedding provider, are sent to a third party on the way in.
  `.env.example` / `.sample` / `.template` / `.dist` stay indexed: no values,
  and genuinely useful context for configuration questions.
- **Datastores and serialised blobs** — `.sqlite3`, `.db`, `.onnx`,
  `.pickle`, `.parquet` and similar. Chroma's persist directory holds an
  11 MB `chroma.sqlite3`; a repository that commits one would have the index
  ingest the vector store itself.
- **`.d.ts`** — ambient declarations with no implementation behind them. They
  chunk cleanly now that TypeScript is indexed, which is the problem: they
  would crowd retrieval with declarations of the very functions someone
  wanted the body of.

### These are preventive, not a fix for a leak that happened

Liffy lists files through GitHub's **git-tree API**, which returns only
*tracked* files. A dotenv is gitignored in any repository that has its house
in order — including this one, where `backend/.env`, `frontend/.env` and
`chroma/` are all untracked and were never reachable through that path.

The case these defend against is a repository where somebody **committed**
one, which is common enough to be worth the ten lines: `_is_indexable` runs
against whatever repository a user connects, not against this one.

They surfaced during LANG-2 because that run substituted the local working
tree for the GitHub API and a filesystem walk does not respect `.gitignore`.
Worth knowing as a limitation of that method, and worth keeping the
exclusions regardless.

### If a dotenv *was* indexed

Re-indexing removes it. The file drops out of `list_repository_files`, its
keys never reach `seen_keys`, and the stale-cleanup in `indexer.py` purges
the vectors from Chroma and the rows from Postgres.
`test_reindexing_purges_already_embedded_secrets` pins that, because it is
otherwise an emergent property of two unrelated pieces of code.

**Local purging cannot undo an embedding request that already went out.**
Under `EMBEDDING_PROVIDER=openai` the values were transmitted at first index,
and deleting the vectors afterwards does not reach them — those credentials
have to be **rotated**. `local` is the default and never leaves the machine,
so most deployments are unaffected.

### Scope

This is **an exclusion list for dotenvs and datastores, not a general secret
scanner.** Deliberately still indexed, and worth knowing about if your
repository contains them: `.npmrc` and `.netrc` (auth tokens), `id_rsa`,
`*.pem`, `*.key`, `credentials.json`. Same class of content, outside the
"dotenv" shape, and not covered here.

## Known limits

- **`MAX_CHUNK_CHARS = 2000` was tuned for Python**, and a large React
  component exceeds it. Across the frontend's 538 chunks:

  | | Splits | Fragments |
  |---|---:|---:|
  | Named definitions | 19 | 30 (5.6%) |
  | Module regions | 31 | 61 (11.3%) |

  Median chunk is 428 chars, p90 is 1,975. Splitting is on line boundaries so
  nothing is lost, but a retrieval hit can land on half a component — the
  worst cases are `StyleGuide` (9 pieces) and `MonacoDiff` (4). The module
  figure is dominated by test files, where a whole `describe` block is one
  region; that is closer to expected than defective. **5.6% is the number
  worth acting on**, and it wants its own issue rather than a constant bumped
  on a hunch.

- **`backend/tests/fixtures/ReviewComment.tsx` is a copy** of the real
  component, kept so the chunker tests run against genuine code. It is
  indexed too, so it takes two of the top four slots for frontend-component
  queries — visible in the first spot-check above.
