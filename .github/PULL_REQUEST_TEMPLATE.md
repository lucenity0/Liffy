### What

<!-- What this changes, in a sentence or two. -->

### Why

<!-- The reason. This is the part nobody can reconstruct from the diff later. -->

### How to test it

<!--
The commands or the clicks. If it is visual, put a screenshot in — both
themes if it touches styling, since paper and graphite are a structural
inversion rather than a lightness flip.
-->

---

- [ ] Branch is prefixed `feat/` · `fix/` · `chore/` · `docs/` · `test/` · `refactor/`
- [ ] One thing — a bug fix *and* a rename is two PRs
- [ ] `cd backend && pip install -r requirements-dev.txt && PYTHONPATH=. pytest`
- [ ] `cd frontend && npm run lint && npm run typecheck && npm run test && npm run build`
- [ ] Behaviour change comes with tests
- [ ] Checked in both themes, if it touches styling
- [ ] Labelled controls, real headings, keyboard reachable, decorative graphics `aria-hidden`

<sub>Full guide: [CONTRIBUTING.md](https://github.com/lucenity0/Liffy/blob/main/CONTRIBUTING.md) · Found a security problem? [SECURITY.md](https://github.com/lucenity0/Liffy/blob/main/SECURITY.md), not a PR description.</sub>
