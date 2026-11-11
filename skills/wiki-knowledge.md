# wiki-knowledge — consult the repository wiki, then verify it

You are reading a **generated map of this repository**, produced locally by `dsh-wiki`. Nothing was
uploaded and nothing is downloaded. The wiki is written prose that cites files as `path:line`.

**The wiki is a map, not the source of truth.** Prose can be stale, and a citation can drift. Every
fact you act on must be confirmed in the cited code.

## When to use it

- **Before changing an unfamiliar module.** Ask what the wiki knows about the files you are about to
  touch, so you do not re-derive (or contradict) documented invariants.
- **After a change.** Ask which pages and cards cover the files you edited, then read the ones you may
  have invalidated and update the wiki if the change is meant to be documented.
- **When you need to know whether the knowledge is current.** Check freshness before trusting prose.

Do **not** use it to generate or refresh the wiki — that is the separate `dsh-wiki` skill
(`/wiki generate`).

## The loop

1. **Search.** `wiki_search` with a text query and/or repository file paths.
   Returns at most 20 ranked hits (default 5), each with `id`, `kind` (`page`|`card`), `title`,
   `score`, a ≤400-character `snippet`, its `path:line` `citations`, and `pageIds` for cards.
   Ties are broken deterministically, so the same query always returns the same order.
2. **Read.** `wiki_page` for a page id (full markdown, ≤16 KiB with `truncated: true` when cut, plus
   parent/children/siblings for navigation), or `wiki_cards` for atomic knowledge
   (filter by `tags` all-of, `file`, or `kind` = `module`|`concept`|`api`; ≤50 rows).
3. **Verify.** Open the cited `path:line` in the code and confirm it still says what the page claims.
   If it does not, **the code wins** — say so, and treat the page as stale.
4. **Check impact.** `wiki_impact` with the files you changed maps them to pages/cards using the same
   path normalization as the builder's `diff-impact` (backslashes, leading `./` and trailing `:line`
   are ignored; a directory covers its children at a path boundary). ≤50 input files.
5. **Check freshness.** `wiki_status` reports `sourceCommit` versus git `HEAD`:
   - `stale: false` — the wiki was generated from the current commit.
   - `stale: true` — it is behind (`behind` commits, `changedFiles` listed). Read the pages for the
     invariants, but re-verify every citation: the code has moved.
   - `stale: "unknown"` — git or the recorded commit is unavailable. This is **not** "fresh"; it means
     freshness cannot be established. Verify in code.

## Which repository?

Every tool takes an optional `repo` (absolute path). Omit it to use the session's **creation directory**
(`session.header.cwd` — immutable, so it is *not* the current directory after `working_directory(cd)`),
or the single discovered repository that has a wiki. When several repositories have wikis, the tool
refuses with a typed error `repo-ambiguous` and lists candidate names — pass `repo` explicitly rather
than guessing. Error messages name only the wiki-relative `<wikiDirName>/wiki.json`, never an absolute
host path.

## Bounds (why results look short)

Results are capped on purpose so a tool call cannot flood your context: 20 search hits, 16 KiB of page
markdown, 50 card rows, 50 impact paths. When something is cut, the result says so (`truncated: true`)
— narrow the query instead of asking for "everything".

## Nothing here writes

No tool writes, regenerates, translates, or touches the network. Reading the wiki is always safe.
