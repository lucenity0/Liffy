# Indexing coverage

What Liffy actually indexes, measured against its own repository. Numbers from
the LANG-2 verification run (2026-07-29), on the commit that added TypeScript
and JavaScript chunking (#161).

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

**200 indexable files → 1,044 chunks.**

| Extension | Chunks | | Kind | Chunks |
|---|---:|---|---|---:|
| `.py` | 546 | | `function` | 548 |
| `.tsx` | 247 | | `module` | 303 |
| `.ts` | 164 | | `class` | 73 |
| `.md` | 16 | | `block` | 72 |
| `.js` | 15 | | `interface` | 48 |
| everything else | 56 | | | |

**426 of 1,044 chunks (41%) come from the frontend** — before #161 that was
zero, because everything but Python fell back to line windows. 669 chunks
(64%) carry a symbol name.

### Incremental sync

Re-running against an unchanged tree:

```
chunks_added=0  chunks_skipped=1044  chunks_deleted=0
chunk identity stable: True (1044 pairs)
```

`chunks_skipped` equalling the total is the check that matters. If Tree-sitter
emitted definitions in a different order between runs, every
`(file_path, chunk_index)` pair would point at different content, every hash
would mismatch, and an unchanged repository would re-embed in full — expensive,
and wrong in a way nothing would report.

### Retrieval spot-check

Real embeddings (`BAAI/bge-small-en-v1.5`, local), top-5 by cosine distance:

| Query | Nearest neighbours |
|---|---|
| *React component rendering a review comment with severity badges* | `ReviewComment.tsx:19-72` (0.218), `ReviewComment.tsx:1-17` (0.228), `ReviewDetail.tsx:26-89` (0.234) |
| *split source code into function-level chunks using tree-sitter* | `chunker.py:1-54` (0.207), `chunker.py:229-269` (0.237), `chunker.py:60-69` (0.282) |
| *paginate the reviews list with limit and offset* | `test_api_reviews.py:128-132` (0.170), `Reviews.test.tsx:24-35` (0.188), `useReviews.ts:15-31` (0.198), `api/reviews.ts:9-17` (0.211) |

Judgement: **related, not merely five results.** The third query is the
interesting one — a single concept pulls the backend endpoint test, the
frontend page test, the hook and the API wrapper. That cross-language
retrieval is the thing multi-language indexing was for, and it only works
because both halves are now chunked semantically.

## What is deliberately excluded

Beyond the obvious (`node_modules`, `dist`, `.git`, binaries, lockfiles):

- **`.env` and its variants.** A dotenv holds database passwords and API keys;
  indexing one embeds them into the vector store, where they come back as
  review context — and under a hosted embedding provider they are sent to a
  third party on the way in. Found by this run, which had indexed
  `backend/.env`. `.env.example` and friends are still indexed: no values, and
  genuinely useful context for configuration questions.
- **Datastores** — `.sqlite3`, `.db`, `.onnx` and similar. Chroma's own persist
  directory holds an 11 MB `chroma.sqlite3`; without this the index ingests its
  own storage. This run produced 60 chunks of SQLite page data before the fix.
- **`.d.ts`** — ambient declarations with no implementation behind them. They
  chunk cleanly now that TypeScript is indexed, which is the problem: they
  would crowd retrieval with declarations of the very functions someone wanted
  the body of.

## Known limits

- **`MAX_CHUNK_CHARS = 2000` was tuned for Python.** Across the frontend, 60 of
  411 chunks sit at the cap, so the largest components (`MonacoDiff`,
  `ConnectRepoModal`, `RepoList`) are split mid-component. Splitting is on line
  boundaries, so nothing is lost, but a retrieval hit can land on half a
  component. Worth revisiting with real usage data.
- **`backend/tests/fixtures/ReviewComment.tsx` is a copy** of the real
  component, kept so the chunker tests run against genuine code. It is indexed
  too, so it occupies a duplicate slot in results for frontend-component
  queries — visible in the first spot-check above, where it takes two of the
  top four.
