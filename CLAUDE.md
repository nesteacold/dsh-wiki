# CLAUDE.md — dsh-wiki

Repo: `nesteacold/dsh-wiki` — the canonical source of the `dsh-wiki` DSH plugin (owner decision
2026-11-11; the monorepo copy `dsh-ext/plugins/dsh-wiki` is retired). Layout and boundaries:
`AGENTS.md`.

## Roles

| Role | Does | Model (owner's word only) |
|---|---|---|
| lead (architect) | evaluates, designs, prioritises; owns `specs/`, `docs/`, `AGENTS.md`, `CLAUDE.md`; does not edit plugin code | session model |
| coder | every code change; smallest correct change; reports literal build/test output | `r9-fallback / ds41-cmc-ccsonnet` |
| beastcore | read-only R&D on DSH source; facts labelled (a) measured / (b) read from source / (c) inferred | `r9-commandcode / cc/claude-opus-5-5` |
| scout | fast read-only lookups | `r9-commandcode / cc/claude-haiku-5-5` |
| reviewer | independent review; mandatory for anything touching network, auth, update/install, or the job/publish path; alone declares PASS | `r9-fallback / sol61-opus55` |

Do not silently substitute a model when a route fails; report it.

## Working process

- Every feature gets `specs/<###-slug>/spec.md` before code. Continue the existing numbering (highest
  today: 022). `specs/` and `docs/arch-notes/` are git-ignored and stay on this machine (owner
  2026-11-12): never `git add -f` them, and never quote their private names or paths in a commit,
  README or code comment.
- Evidence over assertion: report the literal command and its output. A green suite is not a proof —
  `0.3.1` shipped a self-update defect with every suite green; prefer a mutation or a real drill.
- Commit only the paths you changed: `git commit -- <paths>`.

## Gates (run from the repo root before asking for a commit)

```
node tools/readme-parity-test.mjs
node tools/mcp-test.mjs
node tools/harness-test.mjs
node tools/update-test.mjs
node tools/update-ui-test.mjs <react-dir> <react-dom-dir>
node tools/jobs-worker-test.mjs
```

Known: `jobs-worker-test.mjs` flakes on a loaded machine in tests unrelated to any recent change
(8 s `finish()` budget, dispose ordering); the untouched baseline reproduces it. Re-run before
treating one failure as a regression, and never "fix" it by loosening an assertion.

## Rules worth repeating

- All READMEs carry the same content; `tools/readme-parity-test.mjs` enforces code blocks and counts.
- No private machine paths or private project names in anything published.
- `.dsh-wiki/` stays out of git.
- A version bump, tag or push needs the owner's explicit approval.
