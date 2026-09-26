# 05 — Conventions & working agreement

## Golden rules
1. `upstream/` is **read-only**. Never edit, never commit changes inside the submodule. If a change
   there seems necessary, stop and write an ADR first.
2. Smallest possible diff. Prefer a new plugin over a change to an existing file.
3. Every unit of work: (a) do it, (b) update `03-BACKLOG.md` checkbox, (c) append to
   `04-PROGRESS.md`, (d) one commit.
4. Documentation is part of the deliverable, not an afterthought. Docs in English.
5. No vendor names outside `providers/` and adapter files (law 2 in `00-OVERVIEW.md`).

## Commits
- Conventional-commit prefixes: `feat:`, `fix:`, `docs:`, `chore:`, `test:`, `refactor:`.
- Reference the task ID: `docs: plan foundation (T-003)`.
- **Authorship is the repository owner only.** Do not add co-author or tool-attribution trailers.
- Never commit secrets; `.env` is gitignored. Never commit `.refs/`.

## Branches and versions
- `main` holds released versions only. Nothing is committed to it directly.
- `epic` is the integration branch. Every feature or fix branch starts from `epic` and merges back
  into it with `git merge --no-ff`, so each branch stays visible as one unit in the history.
- A release is `epic` merged into `main` (`--no-ff`), with `package.json` `version` bumped in the
  same merge and a tag on the merge commit: `git tag -a vX.Y.Z -m "VerNess vX.Y.Z"`, then
  `git push origin main epic --follow-tags`.
- Versions follow semver while pre-1.0: a release with new commands or config fields bumps the
  minor (`0.1.0` -> `0.2.0`); a release of fixes only bumps the patch.
- Before merging `epic` into `main`, run the clean-clone check below on `epic`.

## Code
- TypeScript ESM, explicit `.ts` import specifiers (upstream convention).
- Package name `@verness/<name>`, directory `packages/<name>/`, `type: module`,
  `main: lib/index.js`, `types: lib/types/index.d.ts`.
- `@deepseek-ai/cordis` in both `peerDependencies` and `devDependencies` with the same range.
- Every registration must be an effect that disposes (`ctx.effect`, `ctx.on`, registry `.register`).
- One service per package; augment `Context` with `declare module '@deepseek-ai/cordis'`.

## Tests
- Unit tests per provider/loader; plus, for anything product-visible, one REAL-composition boot
  test (upstream `docs/testing.md:38-40` — hand-built `ctx.plugin()` suites alone are insufficient).
- Every registry ships an HMR-safety test: dispose the contributing fiber, assert cleanup.

## Verify from a clean clone, not from your working directory

A feature is not shipped because it runs here. On 2026-09-26 a bare `lib/` in `.gitignore` also
matched `scripts/lib/`, so **none** of the launcher's eight modules was ever tracked: `git add`
skips ignored paths silently, eight commits reported success while adding nothing, and a clone of
the repo could not start at all. Everything passed locally the whole time.

Before claiming a feature ships:

```sh
git clone . "$(mktemp -d)/fresh" && cd "$_" && node scripts/verness.mjs help
```

If a new directory of source ever appears, check `git ls-files` covers it rather than trusting a
clean `git status` — an ignored file is invisible to both.

## How to resume work (read this first after a break)
1. `git log --oneline -5` and `docs/04-PROGRESS.md` — where we stopped.
2. `docs/02-ROADMAP.md` — the current milestone and its exit criteria.
3. `docs/03-BACKLOG.md` — first unchecked task of that milestone.
4. `docs/research/*.md` — seam names, file anchors, upstream formats (avoid re-reading upstream).
5. Only then touch code.

## Reference material
- `.refs/` holds full clones of the three reference repos (gitignored, re-clonable via
  `docs/04-PROGRESS.md` commands). `docs/research/` holds the distilled, committed knowledge.
- Prefer `docs/research/` over re-reading upstream: it is cheaper and it is the versioned truth.
