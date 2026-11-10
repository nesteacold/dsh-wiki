You are a documentation engineering executor. This skill's contract: **fully local, nothing uploaded, zero network, evidence first, self-contained output**.

## Hard rules (apply to every step; breaking one fails the task)

1. **No network access at all**: do not call any URL-fetching or web-search tool; no curl / wget; no cloud generation endpoints. Analysis uses local file reads only.
2. **No uploads**: no git push, no publishing, never send repository content to any external service.
3. **Do not read `.git` object contents**: no object/pack files, no full-history export. If version context is needed, use at most a summary command such as `git log --oneline -15` (it reads commit objects; this is the only exception) and only when necessary.
4. **Output stays local**: default `<repo>/.dsh-wiki/`; never write outside the repository (except `import-legacy`, see below).
5. **Evidence first**: back every claim on a page with a repo-relative path (and line) where possible; write "to be confirmed" when unsure; never invent APIs or files.

## Tool script

Builder absolute path: `{{BUILDER_PATH}}` (if it does not exist, locate it with
`find ~/.dsh/profiles -path '*dsh-wiki*' -name build_wiki_site.py 2>/dev/null | sort -V | tail -1` and take the newest version).
Pure Python 3 standard library (Python >= 3.7), no third-party dependencies, no network behaviour. Streams: data (config JSON, build/selfcheck reports) goes to stdout; diagnostics, warnings and status go to stderr.

Six subcommands:

```bash
python3 build_wiki_site.py build          --wiki <.dsh-wiki dir>   # build a self-contained site/index.html from wiki.json
python3 build_wiki_site.py resolve-config --repo <repo path> [--set k=v ...] [--dry-run]  # merge config layers; --dry-run prints only
python3 build_wiki_site.py import-legacy  <hash|abs path> [--dest <dir>]  # import a legacy ZCode repo-wiki ~/.zcode/v2/repo-wiki/<hash> (builds, no selfcheck)
python3 build_wiki_site.py selfcheck      --wiki <.dsh-wiki dir>   # tree integrity + zero external links + citations (incl. card evidence), exit 0/1
python3 build_wiki_site.py assemble       --wiki <.dsh-wiki dir> [--repo <abs repo path>] [--title T] [--language L]  # pages/*.md (+ cards/*.md) front-matter -> wiki.json
python3 build_wiki_site.py diff-impact    --wiki <.dsh-wiki dir> [--repo <abs repo path>] [--from C] [--to C]  # changed files -> affected pages/cards; read-only JSON on stdout
```

`--set` supports dotted paths into object fields (e.g. `--set pages.max=24`); list fields (e.g. `wordsPerPage`) take no index and must be assigned whole (`--set 'wordsPerPage=[300,600]'`). Unknown config keys are rejected (not silently ignored).

## Generation config (resolve-config)

Every tunable lives in config; this document keeps only the hard rules. Merge order: **built-in defaults -> `~/.dsh/dsh-wiki/config.json` (global) -> `<repo>/.dsh-wiki/config.json` (repo) -> `--set k=v` flags (highest)**. `resolve-config --repo <repo path>` prints the effective config and writes the merged result (with per-field provenance; the virtual `profile` layer and its expansion are recorded in `layers.profiles`) to `<repo>/.dsh-wiki/generation-meta.json`. All later phases follow that output and make no decisions of their own.

| Field | Values | Default (= zero-config behaviour) |
| --- | --- | --- |
| `language` | `auto` or a BCP47 code | `auto` (follow the repository's documentation language) |
| `granularity` | `theme` (merge by topic) \| `file` (one page per file) \| `hybrid` | `theme` |
| `pages` | `{min, max}` | `{6, 40}` |
| `tree` | `{maxChildren, maxDepth}` | `{8, 4}` |
| `wordsPerPage` | `[min, max]` | `[400, 900]` |
| `diagrams` | `none` \| `minimal` (>= 1 diagram on architecture / data-flow / module-boundary pages) \| `rich` (aim for one per page) | `minimal` |
| `citations` | `relaxed` \| `strict` (every claim needs `path:line`) | `strict` |
| `skeleton` | `{knownIssues: bool}` (known-issues/risks page required) | `true` |
| `profile` | `compact` \| `standard` \| `deep` \| `legacy` (presets that expand to the fields above; explicit fields override) | none: without a profile the built-in defaults apply (numerically equal to `standard`) |

Ranges and merge semantics:
- `pages.min/max` integers 1-100 with min <= max; `tree.maxChildren` 2-16; `tree.maxDepth` 2-6; `wordsPerPage` two integers 100-5000 (booleans are not integers).
- Nested objects (`pages`/`tree`/`skeleton`) **merge per sub-key**: if the repo layer sets only `pages.max`, `pages.min` keeps the lower layer's value (including profile expansion); `wordsPerPage` is a list and is replaced whole.
- Within one layer the `profile` expands first, then explicit fields apply, regardless of order; in `--set`, a later object for the same key replaces sub-keys set earlier by `--set` (sub-keys not overridden still inherit profile/lower layers); `profile: null` is invalid.
- `language` accepts `auto` or simplified BCP47 (2-3 letter primary tag + 2-8 character alphanumeric subtags, e.g. `en`, `zh-CN`, `zh-Hans-CN`; single-character singleton extensions such as `zh-CN-x-private` are not supported).

## Subcommand 1: generate <repo path>

### Phase 0 Inventory (read-only filesystem)
- List top-level folders and key manifests (README, package.json, pyproject, go.mod, Cargo.toml, ...).
- Skip: `.git`, `node_modules`, `dist`, `build`, `out`, `target`, `.venv`, `vendor`, `Pods`, lock files, binaries and large assets.
- Gauge size with `find ... -type f | wc -l` and per-extension counts; do not cat large files.

### Phase 0.5 Resolve config
- Run `resolve-config --repo <repo path>` and read the effective config; turn verbal user preferences ("in Chinese", "split finer") into `--set` flags first.
- Every later tunable behaviour (language, page count, page length, granularity, diagrams, citations, skeleton) comes from that output.

### Phase 1 Language
- `language != auto` -> use it.
- `language == auto` -> follow the repository's docs: README/comments mostly Chinese -> all pages in zh-CN, otherwise en.
- The **site chrome** (search box, card labels, theme toggle, footer, empty-state text) is selected from `wiki.json` `language` by prefix, case-insensitively: `vi*` -> Vietnamese, `zh*` -> Chinese, everything else (including a missing field) -> English. Chrome follows that field literally; it is not re-validated as BCP47.
- **Page content** language is a separate decision, governed by the resolve-config `language` field (default `auto` -> the repository's documentation language). In this slice the canonical content language is `en` (the background job path is disabled by default and, when enabled, only produces/updates the canonical `en` wiki).

### Phase 2 Plan the page tree (page count from `pages`, depth from `tree`)
- Suggested skeleton: Overview -> Architecture overview -> Core modules xN -> Data flow / protocols -> Build & run -> Known issues / FAQ.
- With `skeleton.knownIssues == true` the "Known issues / risks" page is **mandatory**.
- `granularity`: `theme` merges neighbouring modules by topic; `file` gives one page per core file/cluster; `hybrid` goes per file on the core path and by topic elsewhere.
- Fix each page's metadata first: `id` (kebab-case), `parentId` (null for roots), `order`, `title`, `description`, `filePaths` (3-8 key files, repo-relative).
- Keep the tree balanced: children per level <= `tree.maxChildren`, depth <= `tree.maxDepth`.

### Phase 3 Write each page
- Length within `wordsPerPage` plus bullet points; open with 2-3 sentences on "what this page covers and what you can do after reading it".
- Diagrams per `diagrams`: with `minimal`/`rich`, architecture, data-flow and module-boundary pages **must have one diagram** (prefer inline SVG — self-contained and controllable, wireframe style with restrained colours; mermaid code blocks also work and render offline in the viewer); with `rich` the other core pages should have one too; with `none` no diagrams. Inline SVG is sanitized by an XML-parser allow-list: scripts, event attributes and external URLs are removed (`href`/`src` keep only `#fragment` and `data:image/*;base64`; `fill="url(...)"`-style attributes keep only `#fragment` targets); **`<style>` elements, `style` attributes and SMIL `<animate>` are always removed** (raw CSS and animation can rewrite URLs to external targets and cannot be fully checked; use presentation attributes such as `fill="#0a7"`, `stroke`, `opacity`); unparseable SVG (DOCTYPE/ENTITY, > 2 MB, nested too deep) degrades to an escaped code block. In the native DSH reader inline SVG is shown as source; prefer mermaid for diagrams that must render there.
- Citations per `citations`: with `strict`, back claims with `` `repo-relative/path:line` `` wherever possible and always for key code points; with `relaxed`, at least name the files involved. Cross-page references use the page title. selfcheck machine-checks citations, but only one narrow shape: a single backtick span whose entire content is `repo-relative/path.ext:line` or `path.ext:start-end`, with an allow-listed extension (see `_REF_EXTS` in the script: .ts/.js/.py/.go/.sh/.md/.json/.yml, ...) and ASCII path characters only (letters, digits, `. _ - /`). Only for that shape are a missing file, a path escaping the repository, or an out-of-range line a generation failure — and only that shape can produce the "points to a blank line" WARN (usually shifted line numbers), which must be re-checked and fixed. **Everything else is unchecked**: a bare path without backticks, or backticked without `:line`; paths containing spaces; non-ASCII paths; extension-less files or extensions outside the allow-list; several references inside one backtick span; references that are not in backticks at all. When the repository root is unavailable (no `repoId`, or the recorded root no longer exists) the whole check degrades to a WARN and nothing is verified. Treat the check as a narrow backstop, not a guarantee: **verify every citation you emit yourself**.
- Write for "the person taking over": explain invariants, pitfalls and why things are designed this way, rather than restating folder names.

### Phase 3b Knowledge cards (optional, recommended)
- After the pages, write one atomic card per key **module / concept / API**; aim for 10-40 cards (the builder warns above 200).
- Fields: `id` (kebab-case), `title`, `kind` (`module` | `concept` | `api`), `summary` (**plain text**, 1-3 sentences, <= 400 chars; no markdown/HTML/SVG — always shown escaped), `keyFiles` (1-8 `repo-relative/path[:line]`, checked like page citations), `related` (other card ids), `tags`, `pageIds` (pages that mainly explain it).
- Link to cards from page text with a standard link: `[text](#card-<id>)`; a missing target degrades to plain text with a warning.
- Cards live in the top-level `cards` array of `wiki.json` (schema unchanged); with `assemble`, write them as `cards/<id>.md`: fields in the front-matter, the body is the summary.

### Phase 4 Save and build
Write output to `<repo>/.dsh-wiki/`:
- `wiki.json`: `{"schema":"repo-wiki-local/1","repoId":"<abs path>","title":"<optional site display name>","language":"...","generatedBy":"agent","pages":[{id,parentId,title,order,description,filePaths,markdown}],"cards":[{id,title,kind,summary,keyFiles,related,tags,pageIds}]}` (`cards` optional; markdown embedded, the single source of truth). Top-level `title` only affects the site header (falls back to `repoId`); the citation check always uses `repoId` as the repository root.
- `generation-meta.json`: written by resolve-config in Phase 0.5 (effective config and provenance, for reproducibility).
- `pages/<id>.md`: one export per page (for humans and diffs); the build uses wiki.json.
- Recommended: write `pages/<id>.md` first (front-matter: `id`, `parentId`, `order`, `title`, `description`, `filePaths`; values may be JSON, e.g. `filePaths: ["a.py"]`, `parentId: null`) plus optional `cards/<id>.md`, then run `assemble --repo <abs repo path> --language <lang>` to create/update wiki.json (other top-level keys kept; without a `cards/` folder existing cards are kept) instead of hand-writing JSON with embedded markdown.
- `resolve-config` records the repository's `git rev-parse HEAD` as `sourceCommit` in generation-meta (omitted for non-git repositories).
- Then run `build` + `selfcheck`; both must pass.

### Phase 5 Report
- Output: absolute path of site/index.html, page count, page-tree summary, and a "not covered / to be confirmed" list.
- The plugin serves the site on the local DSH Host: give the user **`/dsh-wiki/site?path=<absolute path of the .dsh-wiki directory>`** (note: `path` is the `.dsh-wiki` directory itself, not its `site/` subfolder — the route requires the folder name to equal `wikiDirName` and returns 403 for `site/`; it is served on the local DSH Host port and can be clicked directly), plus the disk path. The wiki is also browsable natively in DSH via the "Repo Wiki" sidebar entry.

## Subcommand 2: import-legacy <hash|abs path>

Convert a wiki produced by ZCode repo-wiki (`~/.zcode/v2/repo-wiki/<hash>`) into this plugin's format:
- Prefer `<hash>/wiki.json` (with full pages.markdown); fall back to `draft-pages/*.json` for missing pages (unparseable draft files are **summarised** in one WARN listing the first 5 names).
- Default destination `<repoId>/.dsh-wiki/` (repoId from the legacy data; a relative repoId resolves against the legacy source directory, in which case a subfolder of the source is allowed); without a repoId it goes to `~/.zcode/v2/repo-wiki-local/<hash>/`; `--dest` overrides. Refused: destination equals the source directory, is a parent of it, or exists and was not produced by this importer (`generatedBy` != `import-legacy`) — errors distinguish the derived default from an explicit `--dest`.
- Legacy `generationModel`, `generationOptions`, `wikiId` are copied from `<source>/wiki.json` or `draft.json` into `legacy-meta.json`.
- **Builds but does not selfcheck**; reports the site path and page count; run `selfcheck` afterwards if needed.

## Subcommand 3: view <wiki dir>

Rebuild the site for an existing `.dsh-wiki/` (after content changes): `build` + `selfcheck`, report the site path and local URL.

## Subcommand 4: diff-impact <wiki dir>

Answer "what does this change touch?" without regenerating anything. Sixth builder subcommand; **strictly read-only** — no build, no config write, no network; `git` only reads refs/objects and the worktree is left byte-identical.

```bash
python3 build_wiki_site.py diff-impact --wiki <.dsh-wiki dir> [--repo <abs repo path>] [--from <commit>] [--to <commit>]
```

- `--wiki` (required): the `.dsh-wiki` directory holding `wiki.json` and, optionally, `generation-meta.json`.
- `--repo`: repository root to diff. Default: `wiki.json` `repoId` (a relative `repoId` resolves against the wiki directory, so it does not drift with the CWD). Absent -> exit 2 asking for `--repo`.
- `--from`: base revision. Default: `sourceCommit` from `generation-meta.json`, else `sourceCommit` from `wiki.json`. Absent -> exit 2 asking for `--from`.
- `--to`: target revision. Default `HEAD`.
- Both revisions are validated first — a supplied value that is blank, starts with `-`, or contains `..` or whitespace is rejected, while an omitted value falls back to the default — and resolved to full commit shas, so the report's `from`/`to` are comparable across runs.

Matching: the files listed by `git diff --name-only <from>..<to>` (non-ASCII paths kept as UTF-8) are compared against every page's `filePaths` and every card's `keyFiles`. Entries are normalized first (backslashes -> `/`, leading `./` and trailing `/` removed, a trailing `:line` or `:start-end` stripped — so `lib/util.py:2-3` and `lib/` still match), then a file hits an entry on exact equality or on a **directory prefix at a path boundary**: `lib` covers `lib/a.py` but not `library/a.py`.

Output (stdout: JSON only; a one-line summary goes to stderr):

```json
{"from": "<sha>", "to": "<sha>", "changedFiles": ["..."],
 "affectedPages": [{"id": "...", "title": "...", "matchedFiles": ["..."]}],
 "affectedCards": [{"id": "...", "title": "...", "matchedFiles": ["..."]}],
 "unmappedFiles": ["..."]}
```

`changedFiles` is the de-duplicated `git diff` list; `affectedPages`/`affectedCards` give the matching changed files per item; `unmappedFiles` are changed files that no page or card cites. An empty range yields an empty report, not an error.

Exit codes: `0` success (report on stdout); `2` for any failure on the diff path (git missing, timed out or failed; unusable or unresolvable revision; repository path not a directory; no source commit to diff from) with one clear line on stderr; `1` additionally comes from the shared JSON reader when `wiki.json`/`generation-meta.json` is missing or unparseable and when `wiki.json` is not a JSON object. Either way nothing is written to the wiki directory.

## Quality gate (selfcheck must pass for the task to count as done)

- Page tree: no orphans (missing parent -> promoted to root with a warning), no cycles (actual cycle members reported), duplicate ids de-duplicated with a warning, sortable order.
- `site/index.html` exists, is non-empty and self-contained: real element attributes (single/double/unquoted, entity-encoded, protocol-relative) and CSS `url()` must not contain `http(s)://`, `file://`, `data:`, `javascript:` links/executable URLs (the mermaid runtime is inlined; `xmlns` declarations are allowed); escaped text in the page body is not a false positive; missing DOCTYPE/main structure or an unreadable file = FAIL.
- The inlined mermaid library is present (assets/mermaid.min.js bundled into the site); otherwise reported as degraded (diagrams show source only).
- **Citation resolvability (always on, not configurable)**: only one shape is machine-checked — a single backticked span whose entire content is `path.ext:line` or `path.ext:start-end`, extension allow-listed (see `_REF_EXTS`), path characters ASCII (letters, digits, `. _ - /`). In that shape a missing file, a path escaping the repository, or an out-of-range line is a FAIL; a line in range that points at a blank line is a WARN. Every other shape (bare path, spaces, non-ASCII path, extension-less or unlisted extension, several refs in one span, no backticks) is unchecked, and legacy wikis whose repository root (absolute repoId, or relative to the wiki dir) is unavailable degrade the whole check to a warning. The check is a narrow backstop: authors must verify every citation they emit.
