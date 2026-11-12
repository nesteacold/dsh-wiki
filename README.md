<div align="center">

  <img src="docs/assets/logo.svg" alt="dsh-wiki logo" width="104">

  <h1>dsh-wiki</h1>

  <p><strong>DeepWiki-style local repo wiki for DeepSeek Harness (DSH): zero upload, zero network by default, evidence first.</strong><br />
  The agent reads your repository locally → produces a paged wiki with <code>path:line</code> citations (nav tree + diagrams) → builds a single self-contained HTML site served by your local DSH host.</p>

  <p>
    <a href="#-install">Install</a> ·
    <a href="#-usage">Usage</a> ·
    <a href="#-vs-community-alternatives">Comparison</a> ·
    <a href="#-security--privacy">Privacy</a> ·
    <a href="#-tests">Tests</a> ·
    <a href="README.zh.md">简体中文</a>
  </p>

  <p>
    <img src="docs/assets/badges/license.svg" alt="MIT License">
    <img src="docs/assets/badges/dsh.svg" alt="DSH 0.2.x compatible">
    <img src="docs/assets/badges/python.svg" alt="Python ≥3.7">
    <img src="docs/assets/badges/tests.svg" alt="tests: all suites pass — Python builder and translation regressions, Node host routes and trust fence, MCP adapter, job module and worker pipeline, journal/publish/containment/guard, client and update-panel React rendering, wiki freshness, README parity">
    <img src="docs/assets/badges/network.svg" alt="network: opt-in">
  </p>

</div>

> [!NOTE]
> **Codebase knowledge shouldn't live only in the original author's head — and shouldn't cost "upload the whole repo".**
>
> Among 9,100+ community plugins on awesome-dsh-plugin, none delivers a true DeepWiki-shaped artifact: dsh-openwiki wraps an external CLI and is unmaintained; codemap has citations but no prose; archify has diagrams but no wiki text. dsh-wiki combines **narrative pages + machine-checked evidence citations + offline diagrams + a self-contained site** in one DSH bundle — everything local, nothing leaves the machine.
>
> ```sh
> # this repository IS the plugin package — clone it and point DSH at the checkout
> REPO="<path to this repo checkout>"
> CLI="<path to DSH>/runtime/cli/bin/dsh"        # e.g. "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
>                                               # or  "C:\Users\<you>\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh"
> "$CLI" plugin --profile desktop add "$REPO"
> ```

## ✨ What it is

A DSH plugin, maintained here as **`@dsh-ext/dsh-wiki`** — a **fork** of
[`Acfufu/dsh-wiki`](https://github.com/Acfufu/dsh-wiki), with the reliability, pipeline and translation
work recorded in this repository's [`CHANGELOG.md`](CHANGELOG.md) and commit history (the development
specs and architecture notes live in the private development tree, not here). The
runtime id is `dsh-wiki`, which is why the package name keeps that suffix. Once installed into any
web/desktop profile it gives you four entries:

| Entry | Shape | Notes |
| --- | --- | --- |
| **`dsh-wiki` skill** | runtime skill | Say "generate a wiki for this repo" and the 5-phase protocol takes over: inventory → config resolution → language detection → page-tree planning → per-page writing → build + selfcheck |
| **`/wiki` command** | slash command | `/wiki generate [path]` (runs in a fork subagent), `/wiki view` (prints the local site URL), `/wiki list` |
| **📚 Sidebar Wiki panel** | left sidebar global panel | A new 📖 row in the sidebar: click to list every built wiki, pick one and the site is read right inside the app (refresh / back to list / pop-out) |
| **📖 Wiki button** | session-header slot | Opens the local index page in a standalone window (when you don't want to leave the conversation) |

Artifacts land in `<repo>/.dsh-wiki/`:

- `wiki.json` — single source of truth (schema `repo-wiki-local/1`, paged, inline markdown)
- `pages/<id>.md` — per-page export for diffing
- `generation-meta.json` — resolved config with per-field provenance
- `site/index.html` — **single-file self-contained site**: nav tree, full-text search (keyboard operable), light/dark themes, offline mermaid rendering, sanitized inline SVG, mobile responsive

The site passes a **zero-external-link machine check** (entity encoding, protocol-relative URLs, CSS `url()`/`@import` forms covered). Citations are machine-checked too, but only in one narrow shape: a single backticked `` `path:line` `` (or `path:start-end`) whose extension is allow-listed and whose path is ASCII. For that shape a missing file, a path leaving the repo or an out-of-range line fails `selfcheck`; a resolved-but-blank line is a warning, and an unavailable repository root degrades the whole check to a warning. Bare paths, spaces, non-ASCII paths, extension-less or unlisted extensions, several refs in one span, and non-backticked references are **not** checked — verify every citation you emit.

## 🚀 Install

Prereqs: a DSH Desktop / web profile (`dsh-base` + `dsh-web-app`), `python3 ≥ 3.7` (pure-stdlib builder, no third-party deps).

**Route A · GUI plugin page**: sidebar "Plugins" → Add → paste this repo's checkout path (the directory containing `package.json`) → Install → Enable.

**Route B · CLI**:

```sh
CLI="<path to DSH>/runtime/cli/bin/dsh"
REPO="<path to this repo checkout>"
"$CLI" plugin --profile desktop add "$REPO"
"$CLI" plugin --profile desktop list
```

The desktop profile runs `patchReload: live` — refresh and it's live. Peer ranges `^0.1.1-rc.1 || ^0.2.0-rc.1` pass the 0.2.2-rc.1 version gate (same style as @jieai/dsh-plugin-vet), no exemptions needed.

## 🧭 Usage

```sh
/wiki generate            # full wiki for the current workspace (fork subagent)
/wiki generate /path/repo # explicit repo
/wiki view                # print the local site URL
/wiki list                # list known wikis
```

Local routes (loopback on the desktop host):

- `/dsh-wiki/` — wiki index (auto-aggregates discovered repos)
- `/dsh-wiki/site?path=<repo>/.dsh-wiki` — open one site directly
- `/dsh-wiki/api/status` — JSON status

**Discovery**: session workspaces are remembered automatically (persisted to `<profile home>/dsh-wiki/registry.json`), and **sibling directories** of known roots are scanned too — any dir containing `<wikiDirName>/site/index.html` is picked up, so wikis imported via `import-legacy` show up in the index with zero config; `config.wikiRoots` adds extra roots.

### Agent tools — the wiki as a knowledge base

The plugin registers **five native DSH tools** (globally, so every agent in every session sees them)
plus a second skill, `wiki-knowledge`, that documents the consult loop. They are plain-object
definitions passed to `ctx.tools.register` — this plugin still imports **no** `@deepseek-ai/*` package,
so it never needs `defineTool`. When a Host exposes no `tools` service, the plugin logs **one** warning
and every other surface (skill, `/wiki`, routes) keeps working.

`tools` is therefore **not** in the plugin's cordis `inject` list; it is resolved lazily inside `apply()`
with `ctx.get("tools")`. Measured against the installed Host (2026-11-11): cordis `inject` is
all-or-nothing — `Fiber._refresh()` deactivates the whole plugin when any injected service has no
implementation, so `apply()` would never run and the skill, `/wiki` and the routes would all disappear
on a Host without `tools`; cordis has no `{ required, optional }` form. `ctx.get(name)` works without
`inject` (the same profile's `dsh-tool-subagent` resolves `llm` that way). A Host that also lacks
`ctx.get` degrades identically: one warning, no throw.

| Tool | Answers | Hard bound |
| --- | --- | --- |
| `wiki_search` | Ranked pages/cards for a text query and/or repository paths, with `path:line` citations | **20 hits** (default 5) and a **24 KiB** collection budget |
| `wiki_page` | One page's markdown + its file list + parent/children/sibling ids | **16 KiB** markdown (`truncated: true` when cut) |
| `wiki_cards` | Atomic cards filtered by `tags` (all-of), `file`, or `kind`; no filter returns the compact index | **50 rows** and a **24 KiB** budget |
| `wiki_impact` | Changed files → the pages/cards that cover them, using `diff-impact`'s exact normalization | **50 input paths** and a **24 KiB** budget |
| `wiki_status` | Repo id, title, language, page/card counts, `sourceCommit` vs git `HEAD`, staleness | one small object |

**The wiki is a map, not the source of truth.** Every hit carries the citations the item already
makes, and the skill tells an agent to re-verify each cited `path:line` in code before acting on it.

**Freshness semantics** (the gate the owner asked for):

- `stale: false` — the recorded `sourceCommit` equals git `HEAD`.
- `stale: true` — it does not; the result also carries `behind` (commit count) and `changedFiles`.
- `stale: "unknown"` — git or the recorded commit is unavailable. This is **never** reported as
  `false`: unmeasurable is not fresh.
- `GET /dsh-wiki/api/project?root=` exposes the same `stale`/`behind`/`changedFiles` fields, computed by
  the **same** function as `wiki_status`, so the panel and the tools cannot disagree.

Repository resolution is closed by default: an explicit `repo` is accepted only when it is already a
discovered root (or really contains `<wikiDirName>/wiki.json`) **and** proves canonical with no symlink
escape. An ambiguous or unknown request is a typed error listing candidate names — never a guess.
Omitting `repo` prefers the session's **creation directory** (`session.header.cwd`, immutable — the
same fact `lib/worker-guard.js:22,348` records), then the single discovered wiki that has one; several
candidates produce `repo-ambiguous` rather than a guess.
Error messages reach the model, so they name only the wiki-**relative** `<wikiDirName>/wiki.json`; an
absolute host path is never embedded in one.
Wiki content is read only from `<repo>/<wikiDirName>/wiki.json` and `generation-meta.json`, through the
plugin's existing contained reader (no link, no hard link, regular file, handle-identity bound).

Bounds also apply to *fields*: ids/titles/summaries and reference lists are clipped, and each
collection has a byte budget, so a pathological generated wiki cannot flood a context window.
`wiki_search` is deterministic — same input, byte-identical output, ties broken by `(kind, id)`.

Tool **parameters** are our own contract, not the Host's: `register()` validates `output.schema` but
never `parameters` (the Host's schema check also accepts annotation-only schemas as unconstrained JSON).
The harness therefore asserts, for every definition, an object-rooted parameter schema whose `required`
(when present) sits on the object only — a per-property `required` key is rejected.

### MCP adapter — the same wiki for agents outside DSH (Claude Code)

DSH sessions get the five tools natively. An agent **outside** DSH — Claude Code, VS Code, any MCP
client — gets the same five tools over MCP from one small process that **reuses** `lib/wiki-tools.js`:
the definitions, the bounds and the freshness arithmetic are the same code, so the two surfaces cannot
drift apart.

**stdio is the default transport** — the normal shape in a user terminal: the client spawns the server
and both sides speak newline-delimited JSON-RPC over stdin/stdout. No port, no listening socket, no
network surface, nothing to choose or keep free.

```sh
node mcp/server.mjs                                # stdio (default): JSON-RPC on stdin/stdout, no socket
node mcp/server.mjs --transport http --port 7919   # opt-in Streamable HTTP on 127.0.0.1
```

| Flag | Meaning |
| --- | --- |
| `--transport stdio\|http` | Transport (default `stdio`) |
| `--port N` | Loopback port for `--transport http` only (default `7919`); refused below 1024 and in the reserved `2190-2289` instead of being silently moved, and refused with the stdio default instead of being ignored |
| `--repo PATH` | Default root when a tool call omits `repo` (absolute; still passes the normal resolution proof) |
| `--dsh-home DIR` | Profile home holding `dsh-wiki/registry.json` (default `$DSH_HOME` or `~/.dsh`) |
| `--wiki-dir NAME` | Wiki directory inside a repository (default `.dsh-wiki`) |

Register it with the bundled installer — it computes the absolute paths, emits or applies the
registration for **Claude Code and Claude Desktop**, and refuses to guess. The tools then appear as
`mcp__dsh-wiki__wiki_search`, `mcp__dsh-wiki__wiki_page`, `mcp__dsh-wiki__wiki_cards`,
`mcp__dsh-wiki__wiki_impact`, `mcp__dsh-wiki__wiki_status`:

```sh
node tools/register-mcp.mjs            # dry run: prints the exact registration, changes nothing
node tools/register-mcp.mjs --apply    # register in Claude Code (user scope) + Claude Desktop
node tools/register-mcp.mjs --apply --target code --scope project   # project-scoped .mcp.json
node tools/register-mcp.mjs --uninstall --apply
```

**`--repo` is load-bearing, measured on this machine.** The adapter resolves an omitted `repo` from
the DSH registry (`~/.dsh/dsh-wiki/registry.json`); that registry held 8 roots and **two** carried a
wiki, so an unqualified call answers `repo-ambiguous` rather than guessing. The installer therefore always pins `--repo <abs>` when it can prove exactly one wiki,
and exits 2 with the candidate list when it cannot. Pass `--repo` yourself when running from outside
a wiki-bearing directory.

What was actually verified here, and what was not:

| Step | Evidence |
| --- | --- |
| Claude Code accepts and stores the registration | **measured** — `claude mcp add -s project` wrote `.mcp.json`; `-s user` wrote `~/.claude.json` (`Added stdio MCP server dsh-wiki ... to user config`), which keeps 62 top-level keys and 13 projects intact |
| Claude Code ↔ our server handshake, live | **measured** — `claude mcp get dsh-wiki` reports `Scope: User config (available in all your projects)` and `Status: √ Connected`, and `claude mcp list` lists `dsh-wiki ... √ Connected` next to the other servers |
| Claude Desktop config merge | **measured on the real file** — `mcpServers.dsh-wiki` inserted, `coworkUserFilesPath` and the whole `preferences` object preserved, timestamped backup written beside it. Claude Desktop reads this file at launch, so **restart the app** to pick the server up |
| `tools/list` / `tools/call` over stdio | **measured** as a real process — the exact argv stored in `.mcp.json`, stdin/stdout redirected to files: `initialize` returns `serverInfo {name: dsh-wiki, title: Local Repo Wiki}`, `tools/list` returns all five tools, a notification produces no response, and stdout carries protocol bytes only |
| `tools/list` / `tools/call` under the test suite | **measured** by `node tools/mcp-test.mjs` (110 passed, 0 skipped, 0 failed with full file access; in a restricted shell the pipe-dependent CLI/stdio tiers SKIP instead) |

Scope matters for approval: a **user-scope** entry is trusted and connects immediately, while a
project `.mcp.json` entry stays `⏸ Pending approval` until you approve it — so a cloned repository
cannot silently start a server.

The raw equivalents, if you prefer typing them. This repository **is** the package, so the server is at `mcp/server.mjs` (there is no `plugins/dsh-wiki/` level here); `<path-to-dsh-wiki>` is where you cloned it, and `<path-to-your-repo>` is the repository whose wiki you want to serve. User scope:

```sh
claude mcp add dsh-wiki -s user -- node "<path-to-dsh-wiki>\mcp\server.mjs" --repo "<path-to-your-repo>"
```

Project scope (`.mcp.json`). **Do not commit this file:** `--repo` must be an absolute path
(`mcp/server.mjs:120` rejects anything else) and `command` names this machine's node, so a committed
`.mcp.json` is wrong on every other machine and rots when node moves. (`${CLAUDE_PROJECT_DIR}` is
**not** expanded in `.mcp.json`, measured, so it cannot make the file portable either.) User scope
already covers every project, which is why a project file is normally unnecessary — generate it per
machine with `--scope project` if you want it, and add `.mcp.json` to `.gitignore`. Note the second
`--repo` form below: passing **no** `--repo` lets the server use the directory Claude Code starts it
in (it has to contain `<wikiDir>/wiki.json` to be accepted, so it can never bind the wrong repo):

```json
{ "mcpServers": { "dsh-wiki": { "type": "stdio", "command": "node", "args": ["<path-to-dsh-wiki>\\mcp\\server.mjs", "--repo", "<path-to-your-repo>"] } } }
```

**Claude Desktop** keeps its own list at `%APPDATA%\Claude\claude_desktop_config.json` (`~/Library/
Application Support/Claude/claude_desktop_config.json` on macOS); `--apply --target desktop` merges
the entry there with a backup. Restart the app after registering.

**Fallback / automation: Streamable HTTP.** Some clients and scripts only accept a URL. Start the same
server explicitly, then register the URL — the port you write down is the port it listens on:

```sh
node mcp/server.mjs --transport http --port 7919
claude mcp add --transport http dsh-wiki http://127.0.0.1:7919/mcp
```

or in `.mcp.json`:

```json
{ "mcpServers": { "dsh-wiki": { "type": "http", "url": "http://127.0.0.1:7919/mcp" } } }
```

Pick a port at or above 1024 (below that is privileged) and outside `2190-2289` (reserved on this
machine — that range can never bind). The server refuses both with exit code 2 instead of moving, so a
registered URL cannot silently point at nothing. The endpoint is a single `POST /mcp` (plus the
`GET /mcp` SSE channel the measured client opens), and the listener binds `127.0.0.1` only.

**Transport, as measured — not assumed.** Claude Code 2.1.286 sends `POST /mcp` with
`Accept: application/json, text/event-stream` and performs `server/discover` → `initialize` →
`notifications/initialized` → `GET /mcp` (SSE) → `tools/list`. All five are implemented; `tools/call`
returns the rendered text blocks, and a typed refusal (`ok:false`) is a normal result with
`isError:true`, never a JSON-RPC error. Measured over HTTP; the stdio path speaks the same protocol
core and is exercised in-process by the test suite.

**Why stdio is the default — and what this environment could not verify.** The user runs Claude Code
in a normal terminal, where the command above spawns the server with pipes; that is the transport the
client is built around, and it needs no port. A DSH-sandboxed process is the exception, not the rule:
it cannot spawn piped children (`spawn` → `EPERM`), so a **sandboxed agent** cannot exercise stdio at
all. Its CLI/OS-pipe tier is therefore skipped there (an explicit `SKIP`, never a fake pass) and must
be run once in a normal terminal; the default itself, the `--port` fence and the usage text are still
asserted inside the sandbox through file-captured (non-pipe) child output. End-to-end stdio against
Claude Code itself was **not** observed from this environment.

**Security:** the default stdio transport opens no socket; the opt-in HTTP transport binds `127.0.0.1`
only (no host option). Every HTTP request must pass four fences: a loopback `Host` **and** a loopback
`Origin` (or neither header, which is what a CLI client sends — a browser always sends both, so a
DNS-rebinding page is refused twice over), the single path `/mcp`, and a 1 MiB body cap. `GET /mcp`
opens at most 16 concurrent SSE channels (the next one is `429`, not another file descriptor), and every
request is bounded twice: a finite `requestTimeout` for receiving it (a connection that never finishes its
body is closed) and a bounded dispatch deadline (30 s) instead of holding its transport forever — on stdio
a wedged call would otherwise block the serialized queue behind it. Neither bound closes an open SSE
response. The adapter is read-only — it opens `<repo>/<wikiDirName>/wiki.json` and
`generation-meta.json` and nothing else — never fetches and never writes.

What the adapter **does not** claim:

- **No handle-identity containment.** The Host reads through `lib/fs-contain.js` (no link at any level,
  single hard link, identity bound to the handle). The adapter opens the resolved file **once** and takes
  its size from that same handle before reading it (so a swap between check and read cannot bypass the
  16 MiB cap), but it cannot detect a hard link whose name is inside the repository while its bytes live
  elsewhere on the same volume — `realpath` has no path to compare. That one gap is recorded in
  `specs/015-wiki-mcp-adapter/plan.md`; closing it needs `nlink`/inode comparison, which the Host does.
- **Not an authentication boundary.** In HTTP mode any process on this machine can reach the loopback
  port; the fences stop a *browser page*, not a local program. Remote exposure is out of scope
  (constitution A7: TLS + per-device credentials).

When the client omits `repo`, resolution follows the DSH registry
(`<profile home>/dsh-wiki/registry.json`): an explicit root must be absolute, canonical and either
already registered or really contain `<wikiDirName>/wiki.json`; otherwise **exactly one** wiki-bearing
root is used, and several produce `repo-ambiguous` listing basenames — never a guess.



### In-panel Generate / Update — **disabled by the release gate**

The panel ships the job controls and a model selector, but **background generation is deliberately off**
in this release: the write path must pass a real filesystem-isolation + trusted-recovery review before it
is exposed. The job manager **is** constructed and holds the trusted journal store, but `jobs.enabled`
defaults to `false`, so every job route answers 503 before it reads the body, resolves a root or touches
a path. Server contract today:

| Route | Method | Status | Behaviour |
| --- | --- | --- | --- |
| `/dsh-wiki/api/models` | GET | **available** (read-only) | `{ default, models: [{provider, model, label, providerLabel}], groups, failures }` straight from `sessionController.modelCatalog()`; 503 when the service is absent. It only reads the catalog. |
| `/dsh-wiki/api/jobs` | POST | **503 disabled** | `{ error: "<gate message>", disabled: true }`, returned **before** reading the body, resolving Host services or touching any path. |
| `/dsh-wiki/api/jobs?root=` | GET | **disabled payload** | `{ ok: true, root, disabled: true, disabledReason, active: null, last: null }`; the manager exists but the gate keeps it idle. The shape stays compatible with the panel's poller. An unknown root is still 403. |
| `/dsh-wiki/api/jobs/cancel` | POST | **503 disabled** | Same gate answer as POST `/api/jobs`. |
| `/dsh-wiki/api/jobs/recovery-plan?root=` | GET | **503 while disabled** | Read-only recovery plan for a root's journal record; it never renames or deletes anything. Measured 2026-11-10: the `jobs.enabled` gate answers 503 for this route too, and an unauthorised root is 403 before the gate. |
| `/dsh-wiki/api/jobs/recovery-execute` | POST | **403/503 while disabled; requires `confirm`** | The only route that may execute a recovery plan. Requires the literal body field `confirm: "execute-recovery"`, same-origin, JSON, the authorised root and an open journal store. **It cannot currently complete a post-restart restore** — see the limitation below. |

So the model catalog is available, but there is **no live generation** from the panel in this release.
The Generate/Update control stays **visible but disabled**, with the Host's exact gate reason shown as
text in the notice beside it: a capability that vanished would be indistinguishable from a capability
that was removed, and the user could not tell "not now" from "never again". The reason is deliberately
**visible text rather than a hover tooltip**, because a disabled form control's tooltip is not reliable
across browsers (not measured on this machine — treated as a reason to use visible text, not as a fact
about any particular engine). The model dropdown is **not** rendered while the gate is closed (the
selected model is shown as one muted line in the notice instead), because a lone read-only selector
reads as left-over debris. A selection could not start anything anyway: Generate/Update is disabled, the
POST route answers 503, and no job can ever become active. Use the in-session, foreground
`/wiki generate` instead — the panel offers a "Copy command" button for exactly that.

### The three actions, and why there is no "Regenerate"

| Control | Sends | Meaning |
| --- | --- | --- |
| **Update wiki (incremental)** | `action:"update"` + `incremental:true` | Rewrite only the pages/cards that `diff-impact` maps to the changed files (spec 013). |
| **Rebuild whole wiki** (More actions) | `action:"update"`, no `incremental` | Full rebuild. The only correct choice when there is no usable baseline, when `diff-impact` is unavailable, or when the published wiki's ids and file names disagree. |
| **Generate wiki** | `action:"generate"` | First build; there is no baseline yet. |

There is **no separate "Regenerate" action**, and that is a server fact rather than a UI omission:
`lib/jobs.js` defines `JOB_ACTIONS = ["generate", "update", "translate"]`, and the `btn.regen`
dictionary key has never been rendered as a button in any revision. Incremental work is requested through
the separate `incremental` field, not through `action`; `buildWorkerPrompt` still accepts only
`{jobId, root, stageDir, config}` and rejects unknown keys, carrying the affected set in its own optional
`incremental` option.

### Incremental update is fail-closed, never a silent full rebuild

`incremental:true` is accepted only with `action:"update"`. Every downgrade is an explicit refusal, and
every refusal starts no job: a non-boolean `incremental` is 400 `invalid-incremental`; `incremental:true`
with the wrong action is 400 `incremental-not-for-generate` / `incremental-not-for-translate`; and the
409 family is `incremental-no-baseline`, `incremental-unavailable`, `incremental-baseline-diverged`,
`incremental-up-to-date`, `incremental-id-mismatch`, `incremental-unexpected-write`. Two of these exist
because a caller who asked for incremental and silently received a full rebuild has been lied to.

Two safety properties are worth stating plainly:

- **The staging tree is seeded from the live wiki, and a failed seed is a hard failure.** Publication
  replaces the live tree, so a missing seed would make the wiki *shrink*.
- **Every entry the plan did not authorise is re-hashed after the worker stops**, from raw bytes, and any
  change, addition or deletion outside the affected set fails the job before publication. That covers
  **every top-level key of `wiki.json`**, every file under `pages/`+`cards/`, every other top-level entry,
  newly added empty directories, and files the worker drops under `site/` (only `site/index.html` is
  regenerated by the host, so the rest of that subtree is compared). The only exclusions are
  `generation-meta.json`, `config.json` and `locales/`, which cannot reach publication: the first is host-
  written after the worker stops, the last two are host-owned and re-copied from live. Without this
  comparison the "byte-identical except the listed ids" promise would be unverified — the worker guard
  permits `write`/`edit` anywhere under staging, so only this check turns the instruction into an enforced
  boundary. `sourceCommit` advances only when at least one page was actually rewritten **or deliberately
  removed**; a zero-change job keeps the old baseline rather than claiming freshness it does not have. An
  incremental plan is refused outright when the published wiki's front-matter ids and file names disagree
  (`incremental-id-mismatch`), because the affected set is keyed by id while the files are keyed by name —
  and because affected files are excluded from the comparison above, their declared ids are re-checked after
  the worker stops: an affected page may not declare *another* page's id, or it could shadow that page
  through `assemble`'s duplicate-id resolution (`selfcheck` does not reject duplicate ids, so nothing else
  would catch it).
- **Removing an affected page is allowed and recorded, never silent.** A page whose subject was deleted from
  the repository has to be able to go away, and refusing it would put the job in a permanent dead-end (the
  page stays affected on every later run, the worker deletes it again, the job fails forever). So the
  removal publishes and the job state carries `pagesRemoved` plus a bounded `removedSample`, which the panel
  shows as ", N pages removed" in the done line. A removal is never counted as a rewrite. Removing an
  affected **card** is refused instead, because there is no public field to record it and a silent
  disappearance is worse than asking for a full update.

Known residual gaps, stated rather than hidden: `site/index.html` itself is not compared (the host
overwrites it), `config.json`/`locales/` bytes are not compared (they cannot be published from staging),
a stray file left in staging by the worker's own tooling fails the job closed (recoverable with a full
update), and a directory replaced by a *different* directory with identical contents is not detected by this
comparison.

Measured limit, stated so nobody over-reads the feature: on the only real corpus available
(a private workspace, `dd02d64..67a1131`) 116 changed files mapped to **23 of 31 pages and 9 of 25 cards**,
with 102 files mapped to no page at all. For a wiki that has drifted far, incremental is barely cheaper
than a full rebuild, and `.dsh-wiki/` is itself committed, so a wiki update also shows up in the diff.

Why the gate: a background job would run an ordinary model session with **no filesystem isolation**
("do not touch the live `.dsh-wiki`" is a prompt-level rule, not a sandbox), and the former read routes
called `recover()` on `GET /api/projects|project|wiki|site`, so a plain read could rename an arbitrary
leftover `.dsh-wiki.bak-*` directory. Until the write path has actual isolation and recovery is trusted
(write path only, under a reviewed per-repo lock), the gate stays closed. Read-only routes no longer
call `recover()`; a leftover backup is left byte-for-byte untouched.

**Recovery route: two defects found by measurement on 2026-11-10, fixed, awaiting independent review.**
Both were on the execute path only. Neither is visible to a reader of either file alone — they were
disagreements between two modules that were each internally coherent.

1. **Vocabulary mismatch.** The production liveness provider returned `proof: "epoch-host-dead"`
   (`lib/index.js`), but the planner accepts only `["process-exit","host-registry","worker-session-id"]`
   (`lib/journal.js`). After a restart `planRecovery` therefore *threw* on malformed input, `reconcile`
   reported `status:"error"`, and the executor was never reached — so the one case the route exists for
   (a Host that died mid-publish leaving a `.dsh-wiki.bak-*` plus a record) could not run at all.
   The provider now returns `"process-exit"`, which is what was actually established: the recorded host
   process is gone, and a worker is an in-process subagent. `WORKER_PROOFS` is exported so a test can
   assert the provider's value is in the planner's vocabulary.
2. **Host pin.** The journal store is pinned to a host id minted **per apply** (`makeHostInstanceId`), so
   `lib/publish-executor.js` refused `restore-backup` with `host-pin-mismatch` for any record left by a
   previous process. Fixing (1) alone would have made this the next hard stop. The execute route now
   opens a **second, explicitly unpinned** store over the same `storeDir` and the same allowlist, and
   unpinned **`restore-backup` execution requires an explicit `recovery: true`** — the old silent
   "unpinned means skip the check" behaviour is gone, so accidental wiring fails closed with
   `recovery-not-declared` instead of accidentally working. Cleanup decisions (`remove-backup`,
   `remove-staging`) are **not** gated by that flag; they never advance a record, which is a boundary
   rather than a proof.

Safety does not rest on the pin: `lib/journal.js` returns **zero actions** for `alive`, `unknown`,
missing proof, or — across a restart — any proof other than independent process exit. An unpinned store
cannot rename anything unless the planner already decided to. Note that unpinned means the option key is
**omitted**; passing `hostInstanceId: null` explicitly is rejected as `invalid-options`, because presence
is decided with `Object.getOwnPropertyDescriptor`.

Residual limits on this path, stated rather than glossed: the body read is bounded in bytes and in time.
The deadline is enforced twice — a **synchronous elapsed-time check on every iteration** stops iterables
whose `next()` resolves immediately, including zero-byte streams (zero-length chunks are never
accumulated), and a **`setTimeout` race** stops a `next()` that never settles. On overflow, timeout or
abort the reader stops **without destroying the socket**: the route writes the 413/408 response and then
closes the connection on `finish`, so a chunked client receives the response body rather than a reset.
Measured: infinite zero-byte iterator → 408 in ~21 ms at ~20 MB heap (it used to exhaust the heap);
chunked overflow → peer receives `413` with the error body. `remove-backup` / `remove-staging` cleanup
decisions are not gated by `recovery: true` (they never advance a record, but that is a boundary, not a
proof); Windows durability is still `"file-flushed"`, not dir-synced; and this route has never been
exercised end to end over HTTP at any revision. **Treat post-restart recovery as unreviewed until an
independent verdict is written down.**






The implementation is still in the tree (`lib/jobs.js`): staging publication, canonical-`en` language
gate, protected host-owned `config.json`/`locales/`, single-flight fence, cancel/quarantine, bounded
timeouts, backup recovery, plus the write fences (same-origin, JSON content type, 32 KB cap, project
allowlist, exact catalog model). A **module-level** harness (`tools/jobs-harness-test.mjs`) exercises it
as a future/internal contract — those are **not** live-route claims. The live route contract
(503/disabled, no `recover()` on reads) is covered in `tools/harness-test.mjs` §19. Reopening means
landing the isolation + recovery work first, then re-wiring the manager (see the comment in
`lib/index.js`).

When re-enabled, a job works like this: the Host creates a normal DSH session at the repo root, pins the
model with `agent.model.select(...)` (session-scoped — the deployment default is **not** changed), sends
one follow-up prompt, and writes the candidate into `<repo>/.dsh-wiki.staging-<jobId>/` (a **sibling** of
`.dsh-wiki`). After a `completed` turn the Host requires `wiki.json` whose `repoId` names the repository
root, runs `build` + `selfcheck` (no shell, bounded timeouts), and publishes only a green candidate by
rename with a backup. Publication was never atomic (bounded millisecond window); that design note is for
the future work, not current behaviour.

Known limits for that future work: `translate` jobs and `locales/<lang>/` are not implemented; job state
is in memory only (a Host restart forgets the last job view; the wiki on disk is unaffected); the panel
sees stage granularity only around the agent turn; and the agent still runs with normal permissions.

**Migrating from ZCode**: say "import the legacy wiki" — `import-legacy` converts [zcode-repo-wiki](https://github.com/Acfufu/zcode-repo-wiki) data (`~/.zcode/v2/repo-wiki/<hash>`) in one step; the `wiki.json` schema is fully compatible.

**Knowledge cards (0.2.0)**: besides pages, a wiki may carry short atomic cards (module / concept / API) with machine-checked `path:line` evidence, shown as a filterable card grid, per-card views and in search; pages link to them with `[text](#card-<id>)`. Write `pages/*.md` + `cards/*.md` with front-matter and run `build_wiki_site.py assemble` to produce `wiki.json`.

**Incremental impact (`diff-impact`, read-only)**: maps a git range onto the wiki without regenerating it.

```sh
python3 scripts/build_wiki_site.py diff-impact --wiki <repo>/.dsh-wiki [--repo <abs repo path>] [--from <commit>] [--to <commit>]
```

`--from` defaults to the recorded `sourceCommit` (`generation-meta.json`, else `wiki.json`), `--to` to `HEAD`; `--repo` defaults to `wiki.json` `repoId`. The JSON report on stdout has `from`, `to`, `changedFiles`, `affectedPages`, `affectedCards` and `unmappedFiles`: changed files are matched against each page's `filePaths` and each card's `keyFiles` by exact path or directory prefix (`lib` covers `lib/a.py`, not `library/a.py`), with `:line`/`:start-end` suffixes normalized away. It never builds, never writes (not even inside `.dsh-wiki`), never touches the network, and failures on the diff path exit `2`.

## 🔄 Updating

The panel has a **Version** card: the installed version, a **Check** button and an **Install update**
button. It is **opt-in** and off by default (`update.enabled`, see Configuration): with it off the plugin makes
no outbound request at all and the card only says that checks are disabled.

**Check.** With `update.enabled: true`, and only for an install that passes requirements 1-5 below, pressing **Check** makes one HTTPS request to
`raw.githubusercontent.com/nesteacold/dsh-wiki/main/package.json` (5 s timeout, 64 KiB response cap, redirects
not followed, no credentials sent) and reads its `version`. Nothing polls: the panel reads the status once when it opens and again each time you press **Check**; with `update.enabled: true` each such read can make that one request. The same data is on `GET /dsh-wiki/api/update/status`.

**Install update.** The button works only when **every** requirement holds, evaluated in this order (the first
failure wins, and its reason is shown as text next to the button):

1. `update.enabled` is `true`, and no other update is running.
2. The installed plugin package is a **real directory**, not a symlink.
3. It is a git worktree **and** the install directory is that worktree's top level (not a subfolder of a
   bigger repository).
4. `origin` is an `https://` URL for `nesteacold/dsh-wiki` (`ssh://`, `git://`, `http://`, scp-style and local
   paths are refused).
5. The working tree is clean (`git status --porcelain` prints nothing), so uncommitted work is never touched.
6. The published version is a strict `X.Y.Z` and **strictly newer** than the installed one — an equal or older
   published version never installs (no downgrade).

Then it runs `git fetch --tags --prune origin` and `git checkout --detach` to the tag `v<version>` (or
`<version>`) if one exists, else to `origin/main`, and re-reads the local `package.json`: it must equal the
published version, otherwise the previous revision is restored and `postcondition-failed` is reported. Every git
call runs hardened: no credential helper, hooks directory pointed at an empty temporary folder, no submodule
recursion, HTTPS only, no user or system git config, no interactive prompt. The request is
`POST /dsh-wiki/api/update` with the body `{"confirm":"install-update"}`; without that exact token the update
service is never called.

**Reload to finish.** An applied update does **not** restart anything. The card says to reload the plugin, and
`reloadRequired` stays `true` until the plugin is re-created.

**Why a development install refuses.** An install that is a symlink — a plugin linked into the DSH profile from
a development checkout — is refused with `install-is-development-link`, before any git command runs. Checking out
a published version into the directory behind the link would overwrite that development tree, so neither the published-version check nor **Install update** runs there; the published version is fetched only for installs that pass every check before it (requirements 1-5).

**Refusal reasons** are a closed set of 15 codes, each with one fixed sentence (no paths, git output or upstream
text ever reach the client): `update-disabled`, `update-in-progress`, `install-not-found`,
`install-is-development-link`, `install-not-git`, `install-not-worktree-root`, `install-origin-mismatch`,
`install-dirty`, `latest-not-newer`, `version-invalid`, `network-unavailable`, `fetch-failed`,
`checkout-failed`, `postcondition-failed`, `internal-error`. All are HTTP 409 except `internal-error` (500).

**Manual equivalent** (what the button does, in a clean real checkout of the plugin):

```sh
git fetch --tags --prune origin
git checkout --detach v<version>   # or the tag <version>, or origin/main when no tag exists
```

then reload the plugin. An install of 0.3.1 cannot update itself through the panel: 0.3.1 has an annotated-tag defect (the postcondition compared HEAD with the unpeeled tag-object id, so every update was refused with `postcondition-failed` and restored), fixed in 0.3.2. To go from 0.3.1 to 0.3.2, use this manual equivalent with `v0.3.2`. Configuration key: `update.enabled` (boolean, default `false`; it is the only `update`
key and any other key is a configuration error). Known limit: the checkout/restore path has so far been verified
against injected fakes, not against a real repository.

## ⚔️ vs Community Alternatives

| | dsh-wiki | dsh-openwiki | dsh-plugin-codemap | archify |
| --- | --- | --- | --- | --- |
| Narrative wiki prose | ✅ paged + nav tree | ✅ (external CLI) | ❌ | ❌ |
| `path:line` citations + machine check | ✅ enforced | ❌ | ✅ | ❌ |
| Diagrams (offline mermaid/SVG) | ✅ | ❌ | dep graph only | ✅ diagrams only |
| Single-file self-contained site (search/themes) | ✅ zero-external-link checked | ❌ | ❌ | ❌ |
| Second toolchain / second API key | ❌ none | ✅ required | ❌ | ❌ |
| Uploads repo content | never | backend-dependent | never | cloud |
| Maintenance | active | stale (2026-09) | active | upstream active |

## 🎛️ Configuration

Plugin row `config` (editable per-line in the GUI plugin page):

```yaml
- id: dsh-wiki
  config:
    wikiDirName: .dsh-wiki   # wiki dir name inside each repo
    wikiRoots: []            # extra absolute scan roots
    # in-panel jobs (spec 007) — optional overrides
    pythonPath: ~            # interpreter for build/selfcheck (default: probe python3, python, py -3)
    jobTimeoutMs: 2700000    # whole agent turn budget (45 min)
    buildTimeoutMs: 600000   # build subprocess timeout (10 min)
    selfcheckTimeoutMs: 600000
    pollMs: 500              # job supervisor poll interval
    update:
      enabled: false         # in-panel version check / self-update (see Updating); false = zero network
```

The job-only settings (`pythonPath`, `jobTimeoutMs`, `buildTimeoutMs`, `selfcheckTimeoutMs`, `pollMs`)
take effect only when the job gate reopens; the read-only model catalog and the read routes ignore them.

Generation config merges four layers: builtin defaults → `~/.dsh/dsh-wiki/config.json` → `<repo>/.dsh-wiki/config.json` → `--set k=v`. Presets `compact`/`standard`/`deep`/`legacy`; tunables cover language, page count, granularity (theme/file/hybrid), words per page, diagram density (none/minimal/rich), citation mode (relaxed/strict).

Two separate language decisions: the **site chrome** (search placeholder, card labels, theme toggle, footer, empty-state strings) follows `wiki.json` `language` by prefix — `vi*` → Vietnamese, `zh*` → Chinese, anything else (default) → English — while the **page content** language comes from the resolve-config `language` field (default `auto`: follow the repository's documentation language). Content stays canonical `en` for this slice; the background job path is disabled by default and, when enabled, only produces or updates the canonical `en` wiki.

## 🔒 Security & Privacy

| Behavior | dsh-wiki |
| --- | --- |
| Uploads repo content / Git history | **never** |
| Network requests (generation, diagrams, fonts, scripts) | **never** (zero-dep builder, zero-external-link site). The one opt-in exception is the version check/self-update (`update.enabled`, default `false`; see Updating and `SECURITY.md`) |
| Reads `.git` object contents | **never** (sole exception: optional `git log --oneline -15` summary) |
| Artifact location | local disk only |

Host-side route fence: loopback Host check + directory basename must equal `wikiDirName` + read-only single-file serving, no traversal surface. The read routes never call `recover()`, so browsing a wiki cannot rename a leftover `.dsh-wiki.bak-*` directory. The three POST job routes (`/api/jobs`, `/api/jobs/cancel`, `/api/jobs/recovery-execute`) are **currently disabled at the route layer** (`jobs.enabled` defaults to `false`, so each answers 503 before the request body is read); `recovery-execute` additionally requires the literal body field `confirm: "execute-recovery"` and is the only route that can execute a journal recovery plan; the same-origin check (strict loopback `Origin` == parsed `Host`), JSON content-type requirement, 32 KB body cap, project-root allowlist and exact-model check in `lib/jobs.js` remain implemented for when the gate reopens, and are covered by the module harness — not by a live write path. General reminder: the plugin host half runs inside the host process — pair with `@jieai/dsh-plugin-vet` if you audit plugins.

## 🧪 Tests

```sh
# Counts measured 2026-11-11 on Windows with full file access; each suite prints its own tally.
python3 tests/test_build_wiki_site.py   # 217 builder regression checks (injection PoCs, SVG sanitizing, config merge, node --check on site scripts, citation resolution incl. unique-basename fallback)
python3 tests/test_wiki_translations.py # 113 translation-policy checks (structural SHA-256 per typed unit)
node tools/harness-test.mjs             # host-half checks (skill / commands / routes / trust fence / subagent paths, plus job-gate, language API and body-read response wiring, plus the five agent tools). Measured 2026-11-11 with full file access: 479 PASS / 0 FAIL / 0 SKIP. Where git is unavailable the two git-dependent blocks SKIP by design (measured: 472 PASS / 0 FAIL / 2 SKIP with git removed from PATH).
node tools/mcp-test.mjs                 # MCP adapter checks (HTTP over a real socket, in-process stdio, resolution semantics, CLI default transport + flag fences via file-captured stdio). Measured 2026-11-11 with full file access: 110 passed / 0 skipped / 0 failed; the CLI-spawned and OS-pipe tiers report SKIP where the environment denies piped child processes.
node tools/jobs-harness-test.mjs        # 202 module-level job checks (drives lib/jobs.js directly, incl. starved-deadline, chunked-overflow and hostile-input regressions)
node tools/frontmatter-differential-test.mjs # 64 differential checks (58 front-matter shapes: the extracted JS reader vs the real python assemble reader; 0 leaks; exits 2 rather than passing when python is absent)
node tools/jobs-worker-test.mjs         # 99 worker-pipeline checks (prompt/guard/journal/publish-executor/translate seeding)
node tools/worker-protocol-test.mjs     # 64 protocol checks passed (65 cases; 1 POSIX-only case skips on Windows)
node tools/client-smoke.mjs <react> <react-dom> # 155 client checks (grid/detail/cards, markdown safety, zoom + focus trap, model selector, language selector, job controls)
node tools/journal-test.mjs             # 75 journal validator/planner checks (incl. the exported proof vocabulary)
node tools/journal-store-test.mjs       # 86 journal-store checks (exclusive create, flush, rename, tamper refusal)
node tools/publish-executor-test.mjs    # 27 publish/recovery-executor checks (incl. restart restore + explicit recovery flag)
node tools/fs-contain-test.mjs          # 27 containment checks (canonical dir, identity, guarded rename)
node tools/worker-guard-test.mjs        # 61 worker tool-guard checks
node tools/host-liveness-test.mjs       # 26 host-liveness checks
node tools/readme-parity-test.mjs       # 127 README parity checks (heading skeleton, byte-identical code blocks, fact tokens, links and anchors, line ratio, no machine paths — across every README translation)
node tools/update-test.mjs              # 150 update checks (version check + safe self-update: enabled gate, symlink/dirty-tree/origin refusals, downgrade guard, no path or upstream text in payloads, never restarts, single-flight, hardened git config)
node tools/update-ui-test.mjs <react> <react-dom> # 72 update UI checks (the Version card in every state rendered with real React; requests only on user action; install success only reports a reload)
node tools/wiki-freshness-test.mjs      # 39 wiki-freshness checks (changedFiles excludes the wiki dir via git pathspec, stale/behind/unknown semantics, injected fake execFile — no git, no network)
node tools/recovery-code-projection-test.mjs # 18 recovery-code projection checks (route PLAN_CODES / releaseReason allowlists re-derived from the producers, drift in either direction fails, fail-closed fallback kept)
```

Each line above states the count its own suite prints, in that suite's own format: the two Python suites print `N/M passed`; a `node:test` suite reports `ℹ tests N / ℹ pass N / ℹ skipped N` (so `worker-protocol-test.mjs` declares 65 cases and skips 1 on Windows); the remaining harnesses print one `PASS` line per check and end with `ALL PASS`. There is deliberately **no single grand total**: a `PASS` line and a `node:test` case are different units, so adding them would yield a number with no defined meaning — and any fixed total goes stale the next time a suite grows. That is why the badge reads `all suites pass`. Re-run the block above to check any figure.

## ❓ FAQ

**How is this different from DeepWiki (Cognition)?** DeepWiki is a hosted service — the repo leaves your machine. dsh-wiki uses the model in your local session; nothing leaves the machine and the artifact is an HTML file you can double-click.

**Which DSH versions?** Peers declare `^0.1.1-rc.1 || ^0.2.0-rc.1`; verified on 0.2.2-rc.1 (2026-11-04 latest). No 0.2.2-breaking APIs used (tools.resolve / tools.mode / Session Projection all avoided).

**headless / tui profiles?** The skill and `/wiki view|list` work; `/wiki generate` and the local site routes need the web/desktop host (webServer).

**Does the builder need dependencies?** No. Pure Python 3.7+ stdlib, zero pip installs.

## 📄 License

MIT — see [LICENSE](LICENSE). Builder and viewer ported from [zcode-repo-wiki](https://github.com/Acfufu/zcode-repo-wiki) (MIT). The inlined mermaid runtime bundles third-party components — see `assets/THIRD-PARTY-NOTICES`.

## 🙏 Upstream

This package is a fork of [`Acfufu/dsh-wiki`](https://github.com/Acfufu/dsh-wiki) and keeps its MIT
licence, skill/command names and `repo-wiki-local/1` artifact schema so an existing wiki stays readable.
Fork-specific work lives in this repository:

- a journaled, two-rename publication path with a trusted recovery journal (`lib/journal*.js`,
  `lib/publish-executor.js`, `lib/fs-contain.js`)
- a tool-guard that confines a worker's `write`/`edit` to `staging/pages|cards/*.md`
  (`lib/worker-guard.js`)
- canonical-English wikis with per-locale unit translation and structural SHA-256 verification
  (`locales/<lang>/`, `scripts/wiki_translations.py`)
- the tracked work, decisions and open risks: this repository's [`CHANGELOG.md`](CHANGELOG.md) and its
  commit history (the numbered specs and `docs/arch-notes/` stay in the private development tree)

The package name here is `@dsh-ext/dsh-wiki`; `dsh-wiki` is only the runtime id. If you want the
unmodified original, install it from the upstream repository instead.
