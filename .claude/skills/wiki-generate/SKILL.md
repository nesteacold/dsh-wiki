---
name: "wiki-generate"
description: "Generate or refresh this repository's local Repo Wiki (.dsh-wiki/): a paged, evidence-cited map of the codebase (pages + knowledge cards + a self-contained site). Use when the user says generate a wiki, build the repo wiki, document this codebase for agents, refresh/update the wiki, or the wiki is stale and needs re-pinning. Fully local: no network, nothing uploaded."
argument-hint: "Optional: a repository path (default: the current repo), or a scope such as 'only the plugin layer'"
compatibility: "Requires Python 3.7+ (standard library only) and git. No DSH install needed. The builder ships as scripts/build_wiki_site.py in this repository."
metadata:
  author: "dsh-wiki"
  source: "skills/wiki-protocol.md"
user-invocable: true
disable-model-invocation: false
---

## User Input

```text
$ARGUMENTS
```

Consider the input before proceeding. If it is empty, the repository in scope is the current one.

# Generate the Repo Wiki

You are a documentation engineering executor. Contract: **fully local, nothing uploaded, zero
network, evidence first, self-contained output**. This skill is the Claude Code route — there is no
DSH, no `/wiki` command and no native tool here. You read and write files, and you run one Python
script.

## The one thing that will trip you up

`assemble` **collects** the `pages/*.md` and `cards/*.md` you already wrote into `wiki.json`. It does
**not** author them. `build` renders the site from `wiki.json`. `selfcheck` verifies.

So the work order is: **you write the pages, then the script assembles and checks them.** A run that
starts with `assemble` produces an empty or unchanged wiki. Authoring is the agent's job, and no
subcommand does it for you.

## Hard rules (breaking one fails the task)

1. **No network at all.** No URL-fetching or web-search calls, no `curl`/`wget`, no cloud generation.
   Analysis reads local files only.
2. **No uploads.** No `git push`, no publishing, never send repository content anywhere.
3. **Do not read `.git` object contents.** No pack/object files, no full-history export. If version
   context is needed, `git log --oneline -15` is the only exception, and only when necessary.
4. **Output stays local:** `<repo>/.dsh-wiki/`. Never write outside the repository.
5. **Evidence first.** Back every claim with a `repo-relative/path:line`. Write "to be confirmed"
   when unsure. Never invent APIs, files or behaviour.

## Locating the builder

The builder is `scripts/build_wiki_site.py` in **this** repository (the `dsh-wiki` package). It is
not installed into the repositories you document, so always call it by its absolute path, and never
copy it into a target repository.

Confirm it runs before anything else:

```bash
cd <abs repo path to document>
python <abs path to this checkout>/scripts/build_wiki_site.py --help
```

Use `python`. On Windows `python3` is the Store stub, which is why this skill says `python` where the
DSH protocol says `python3`; use `python3` on Linux/macOS. It is pure Python 3 standard library
(>= 3.7), no third-party dependencies. Data (JSON reports, config) goes to stdout; warnings and status
go to stderr.

Run every builder command from the repository you are documenting: `--wiki` is resolved against the
current directory, so `--wiki .dsh-wiki` only names the right directory from the repository root.

## The loop

### Phase 0 — inventory (read-only)

- List top-level folders and key manifests (`README`, `package.json`, `pyproject.toml`, `go.mod`,
  `Cargo.toml`, …).
- Skip `.git`, `node_modules`, `dist`, `build`, `out`, `target`, `.venv`, `vendor`, `Pods`, lock
  files, binaries and large assets.
- Gauge size with a file count per extension. Do not read large files whole.

### Phase 0.5 — resolve the config

```bash
python <abs path to this checkout>/scripts/build_wiki_site.py resolve-config --repo <abs repo path>
```

`--repo` is required and must be the repository path. This prints the effective config and writes
`<repo>/.dsh-wiki/generation-meta.json`. **Every later tunable comes from that output** — do not
decide page count or language yourself.

Merge order: built-in defaults → `~/.dsh/dsh-wiki/config.json` (global) → `<repo>/.dsh-wiki/config.json`
(repo) → `--set k=v` flags. Turn a verbal preference ("in Vietnamese", "split finer") into `--set`
flags first:

```bash
# preview only: prints the config, writes nothing, not even generation-meta.json
python <abs path to this checkout>/scripts/build_wiki_site.py resolve-config --repo <abs repo path> --set language=vi --set pages.max=24 --dry-run
```

Dotted paths reach object fields (`pages.max`, `tree.maxDepth`, `skeleton.knownIssues`). List fields
take no index and must be assigned whole: `--set 'wordsPerPage=[300,600]'` (quoting matters in bash).
Unknown keys are rejected, not silently ignored. `--set profile=compact|standard|deep|legacy` expands
a preset; explicit fields still override it.

Defaults you can expect (from the script's own `DEFAULT_CONFIG`): `language=auto`,
`granularity=theme`, `pages={min 6, max 40}`, `tree={maxChildren 8, maxDepth 4}`,
`wordsPerPage=[400,900]`, `diagrams=minimal`, `citations=strict`, `skeleton.knownIssues=true`.

### Phase 1 — language

- `language != auto` → use it.
- `language == auto` → follow the repository's documentation language: README/comments mostly Chinese
  → `zh-CN`, otherwise `en`.
- Page content language comes from this field only. The site chrome is a separate decision: it follows
  `wiki.json` `language` by prefix (`vi*` → Vietnamese, `zh*` → Chinese, anything else → English).

### Phase 2 — plan the page tree (page count from `pages`, depth from `tree`)

Suggested skeleton: Overview → Architecture → Core modules ×N → Data flow / protocols →
Build & run → Known issues.

With `skeleton.knownIssues=true` the **Known issues / risks** page is mandatory.

`granularity` decides how much becomes a page: `theme` merges neighbouring modules by topic (the
default), `file` gives one page per core file or cluster, `hybrid` goes per file on the core path and
by topic elsewhere. Honour `pages.min` and `pages.max` (1–100, `min <= max`; `{6, 40}` by default) —
below `min` the wiki is too coarse to map the code, above `max` it is a second copy of the tree. Prefer
the low end of the range and say what you left out.

Fix each page's metadata before writing: `id` (kebab-case), `parentId` (`null` for roots), `order`,
`title`, `description`, `filePaths` (3–8 key files, repo-relative). Keep children per level
≤ `tree.maxChildren` and depth ≤ `tree.maxDepth`.

### Phase 3 — write each page

Write `pages/<id>.md` with front-matter followed by the page body. The accepted keys are exactly
`id`, `parentId`, `order`, `title`, `description`, `filePaths`; any other key is ignored with a WARN.
The parser is deliberately simple — a first line `---`, `key: value` lines, a closing `---` — and each
value is parsed as JSON first, then kept as a plain string. So quote it like JSON and it works:

```markdown
---
id: "wiki-builder"
parentId: "overview"
order: 3
title: "The wiki builder"
description: "How pages and cards become wiki.json and a site."
filePaths: ["scripts/build_wiki_site.py", "skills/wiki-protocol.md"]
---
<body>
```

`parentId: null` is a root. `order` must be sortable (a number). Keep the body within `wordsPerPage`
(default `[400,900]` words) and open with 2–3 sentences on what the page covers and what the reader can
do after it.

Write for the person taking over: explain invariants, pitfalls and **why** things are designed this
way, rather than restating folder names. The material a wiki is worth reading for is what is not
visible from the file names: the contract a module enforces, the ordering constraint, the failure that
already happened once.

**Citations (the part that decides whether this works).** With `citations=strict` (the default),
back key code points with a single backticked `` `repo-relative/path.ext:line` `` (or `:start-end`).

> `assemble` and `selfcheck` machine-check ONE shape only: a single backtick span whose entire content
> is `path.ext:line` or `path.ext:start-end`, with an allow-listed extension and ASCII path characters
> (letters, digits and `. _ - /`; see `_REF_EXTS` in the builder). A bare path without backticks, a span
> without `:line`, a path with spaces, a non-ASCII path, an extension-less file or an extension off
> that list, or several refs inside one span are **all unchecked**. A cited file that does not exist,
> a path that escapes the repository, an out-of-range line, or a bare filename that matches more than
> one file is a FAIL; a line in range that points at a blank line is a WARN. The check is a narrow
> backstop, not a guarantee — **verify every citation you emit yourself.**

Diagrams per `diagrams` (`none` | `minimal` | `rich`): with `minimal`/`rich`, architecture /
data-flow / module-boundary pages **must** have one; with `rich` aim at one per core page. Prefer
mermaid code blocks (they render offline). Inline SVG works but `<style>` elements, `style` attributes
and SMIL `<animate>` are always stripped by the sanitizer, so use presentation attributes such as
`fill="#0a7"`.

### Phase 3b — knowledge cards (recommended)

One atomic card per key module / concept / API; aim for 10–40 (the builder only warns above 200, which
is a size limit, not a target). Write `cards/<id>.md` with the fields in the front-matter and the
summary as the body — the body is collapsed to a single-line summary:

```markdown
---
id: "loopback-default"
title: "Bind to 127.0.0.1 by default"
kind: "concept"
keyFiles: ["lib/index.js:120"]
related: ["wiki-builder"]
tags: ["security", "network"]
pageIds: ["wiki-builder"]
---
The server binds loopback unless the owner opts in.
```

Accepted keys are exactly `id`, `title`, `kind`, `keyFiles`, `related`, `tags`, `pageIds`. `kind` is
`module` | `concept` | `api` (an unknown kind silently becomes `concept`). `keyFiles` needs at least
one repo-relative `path[:line]` — a card with no valid `keyFiles` is dropped — and is truncated at 8.
`summary` is capped at 400 characters. `related` must name other card ids and `pageIds` real page ids;
dangling ones are removed with a WARN. An id of `grid` is reserved.

Link to a card from page text with `[text](#card-<id>)`.

### Phase 4 — assemble, build, check

```bash
cd <abs repo path>
python <abs path to this checkout>/scripts/build_wiki_site.py assemble   --wiki .dsh-wiki --repo <abs repo path> --language <lang>
python <abs path to this checkout>/scripts/build_wiki_site.py build      --wiki .dsh-wiki
python <abs path to this checkout>/scripts/build_wiki_site.py selfcheck  --wiki .dsh-wiki
```

`assemble` collects, it does not author. It reads `pages/*.md` (and `cards/*.md` when a `cards/`
folder exists) and writes `wiki.json`. `--repo` is how `wiki.json` gets its `repoId`, and the citation
check resolves every path against that value, so pass it the absolute repository path. `--language`
sets the wiki language. It keeps other top-level keys of `wiki.json`; with no `cards/` folder the
existing cards are kept, so a partial refresh will not silently delete work.

`build` renders the single-file self-contained `site/index.html` from `wiki.json`.

**Both `build` and `selfcheck` must pass.** `selfcheck` exits 0/1 and checks: page-tree integrity
(a missing parent is promoted to a root with a warning; a real cycle is a FAIL; duplicate ids are
de-duplicated with a warning), `site/index.html` exists and is self-contained with zero external
URLs, and citation resolvability for both pages and cards. Read every WARN; a WARN about a citation
pointing at a blank line usually means shifted line numbers and must be re-checked.

`resolve-config` records the repository's `git rev-parse HEAD` as `sourceCommit` in
`generation-meta.json`; it is omitted for a non-git repository. **`sourceCommit` must be a real
commit.** An all-zeros or placeholder SHA is not a valid revision: git rejects it with
`fatal: Invalid revision range` when something later diffs from it, which makes every change look
unmapped. That was a real bug in this product, not a hypothetical. So: generate from a repository that
has at least one commit, and if `sourceCommit` is missing or not a 40/64 hex digit sha, say so instead
of proceeding.

### Phase 5 — report

Report: the absolute path of `site/index.html`, the page count, the card count, the page-tree
summary, the `selfcheck` verdict (0 FAIL, and what each WARN was), and an explicit "not covered / to be
confirmed" list. Do not describe the wiki as complete or fresh beyond what `selfcheck` and the
freshness check proved.

## Refreshing an existing wiki

Do not regenerate from scratch. Map what changed to what it affects:

```bash
python <abs path to this checkout>/scripts/build_wiki_site.py diff-impact --wiki .dsh-wiki --repo <abs repo path> [--from <commit>] [--to <commit>]
```

It is strictly read-only — no build, no config write, git only reads refs — and prints JSON on
stdout: `from`, `to`, `changedFiles`, `affectedPages`, `affectedCards`, `unmappedFiles`.
`--repo` defaults to `wiki.json` `repoId`; `--from` defaults to `sourceCommit` from
`generation-meta.json` (then `wiki.json`); `--to` defaults to `HEAD`. Exit 0 is success, exit 2 is any
failure on the git/diff path with one line on stderr. A file hits a page or card on exact equality or
on a **directory prefix at a path boundary** (`lib` covers `lib/a.py`, not `library/a.py`; backslashes,
a leading `./` and a trailing `:line` or `:start-end` are normalized away).

A revision that starts with `-`, contains `..`, or contains whitespace is rejected — quote or resolve
a sha yourself rather than passing a range to `--from` or `--to`.

Then: read the affected pages and cards, update the ones your change invalidated, re-run
`resolve-config` → `assemble` → `build` → `selfcheck`. The `resolve-config` re-run is what re-pins
`sourceCommit` to the current `HEAD`; `assemble` and `build` do not touch it. Files in
`unmappedFiles` are either new modules worth a page or genuinely peripheral — say which.

## Freshness — never claim what you did not check

The wiki is a **map, not the source of truth**. Prose goes stale and citations drift; the code wins.

Before telling anyone a wiki is current, compare the recorded `sourceCommit` against the real commit:

```bash
grep -o '"sourceCommit"[^,]*' .dsh-wiki/generation-meta.json .dsh-wiki/wiki.json
git rev-parse HEAD
```

- equal → the wiki describes the current commit (say "generated from `<sha>`", not "fresh");
- different → the wiki is behind; every citation is suspect, and `diff-impact` tells you how far;
- no recorded commit, or git unavailable → freshness is **unknown**, which is **not** the same as fresh.

Never write a wiki's freshness from memory or from the fact that you just ran `build`. Only the
comparison above is evidence.

## When NOT to use this

- A repository with a handful of files does not need a wiki; a good README is better. Below about six
  real modules there is nothing for `pages.min` to describe, and the page tree will be padding.
- Do not wiki generated or vendored trees (`dist/`, `build/`, `vendor/`, `node_modules/`, `Pods/`),
  lock files, binaries or large assets. Point `filePaths` at source.
- A wiki is a **map, not a tutorial**. It must let a reader jump to the code and understand the why —
  invariants, pitfalls, boundaries. Long prose that restates folder names is worse than a short page
  that cites well.
- Do not generate a wiki to avoid reading the code. The pages are only as good as the citations you
  verify yourself.
