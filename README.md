<div align="center">

  <img src="docs/assets/logo.svg" alt="dsh-wiki logo" width="104">

  <h1>dsh-wiki</h1>

  <p><strong>DeepWiki-style local repo wiki for DeepSeek Harness (DSH): zero upload, zero network, evidence first.</strong><br />
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
    <img src="docs/assets/badges/tests.svg" alt="tests: 217 builder, 113 translation, 398 host, 104 module job, 99 worker pipeline, 64 protocol, 127 client, 302 trusted-journal/containment/guard/liveness checks">
    <img src="docs/assets/badges/network.svg" alt="zero network">
  </p>

</div>

> [!NOTE]
> **Codebase knowledge shouldn't live only in the original author's head — and shouldn't cost "upload the whole repo".**
>
> Among 9,100+ community plugins on awesome-dsh-plugin, none delivers a true DeepWiki-shaped artifact: dsh-openwiki wraps an external CLI and is unmaintained; codemap has citations but no prose; archify has diagrams but no wiki text. dsh-wiki combines **narrative pages + machine-checked evidence citations + offline diagrams + a self-contained site** in one DSH bundle — everything local, nothing leaves the machine.
>
> ```sh
> # this repo is the maintained fork; install the plugin from it
> REPO="<path to your dsh-ext checkout>"
> CLI="<path to DSH>/runtime/cli/bin/dsh"        # e.g. "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
>                                               # or  "C:\Users\<you>\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh"
> "$CLI" plugin --profile desktop add "$REPO/plugins/dsh-wiki"
> ```

## ✨ What it is

A DSH plugin, maintained here as **`@dsh-ext/dsh-wiki`** — a **fork** of
[`Acfufu/dsh-wiki`](https://github.com/Acfufu/dsh-wiki), with the reliability, pipeline and translation
work tracked in [`specs/007-wiki-pipeline-i18n-models`](../../specs/007-wiki-pipeline-i18n-models). The
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

**Route A · GUI plugin page**: sidebar "Plugins" → Add → paste this repo's plugin path (`<repo>/plugins/dsh-wiki`) → Install → Enable.

**Route B · CLI**:

```sh
CLI="<path to DSH>/runtime/cli/bin/dsh"
REPO="<path to your dsh-ext checkout>"
"$CLI" plugin --profile desktop add "$REPO/plugins/dsh-wiki"
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

There is **no separate "Regenerate" action**, and this is a server fact rather than a UI omission:
`lib/jobs.js` defines `JOB_ACTIONS = ["generate", "update", "translate"]`, and `buildWorkerPrompt`
(`lib/worker-protocol.js`) takes only `{jobId, root, stageDir, config}` — it rejects unknown keys and
never sees `action`. So "Generate" and "Update" build an **identical** worker task and differ only in
the button label (which depends on whether a wiki already exists). In particular "Update wiki" is not an
incremental update: `lib/jobs.js` reports `incremental-unsupported` ("incremental wiki generation is not
supported in this slice"). A distinct Regenerate control would advertise a distinction that does not
exist; if incremental update is ever implemented, it needs a server-side action first.

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
```

The job-only settings (`pythonPath`, `jobTimeoutMs`, `buildTimeoutMs`, `selfcheckTimeoutMs`, `pollMs`)
take effect only when the job gate reopens; the read-only model catalog and the read routes ignore them.

Generation config merges four layers: builtin defaults → `~/.dsh/dsh-wiki/config.json` → `<repo>/.dsh-wiki/config.json` → `--set k=v`. Presets `compact`/`standard`/`deep`/`legacy`; tunables cover language, page count, granularity (theme/file/hybrid), words per page, diagram density (none/minimal/rich), citation mode (relaxed/strict).

Two separate language decisions: the **site chrome** (search placeholder, card labels, theme toggle, footer, empty-state strings) follows `wiki.json` `language` by prefix — `vi*` → Vietnamese, `zh*` → Chinese, anything else (default) → English — while the **page content** language comes from the resolve-config `language` field (default `auto`: follow the repository's documentation language). Content stays canonical `en` for this slice; the background job path is disabled by default and, when enabled, only produces or updates the canonical `en` wiki.

## 🔒 Security & Privacy

| Behavior | dsh-wiki |
| --- | --- |
| Uploads repo content / Git history | **never** |
| Network requests (generation, diagrams, fonts, scripts) | **never** (zero-dep builder, zero-external-link site) |
| Reads `.git` object contents | **never** (sole exception: optional `git log --oneline -15` summary) |
| Artifact location | local disk only |

Host-side route fence: loopback Host check + directory basename must equal `wikiDirName` + read-only single-file serving, no traversal surface. The read routes never call `recover()`, so browsing a wiki cannot rename a leftover `.dsh-wiki.bak-*` directory. The three POST job routes (`/api/jobs`, `/api/jobs/cancel`, `/api/jobs/recovery-execute`) are **currently disabled at the route layer** (`jobs.enabled` defaults to `false`, so each answers 503 before the request body is read); `recovery-execute` additionally requires the literal body field `confirm: "execute-recovery"` and is the only route that can execute a journal recovery plan; the same-origin check (strict loopback `Origin` == parsed `Host`), JSON content-type requirement, 32 KB body cap, project-root allowlist and exact-model check in `lib/jobs.js` remain implemented for when the gate reopens, and are covered by the module harness — not by a live write path. General reminder: the plugin host half runs inside the host process — pair with `@jieai/dsh-plugin-vet` if you audit plugins.

## 🧪 Tests

```sh
python3 tests/test_build_wiki_site.py   # 217 builder regression checks (injection PoCs, SVG sanitizing, config merge, node --check on site scripts, citation resolution incl. unique-basename fallback)
python3 tests/test_wiki_translations.py # 113 translation-policy checks (structural SHA-256 per typed unit)
node tools/harness-test.mjs             # 398 host-half checks (skill / commands / routes / trust fence / subagent paths, plus job-gate, language API and body-read response wiring)
node tools/jobs-harness-test.mjs        # 104 module-level job checks (drives lib/jobs.js directly, incl. starved-deadline, chunked-overflow and hostile-input regressions)
node tools/jobs-worker-test.mjs         # 99 worker-pipeline checks (prompt/guard/journal/publish-executor/translate seeding)
node tools/worker-protocol-test.mjs     # 64 protocol checks (1 POSIX-only case skipped on Windows)
node tools/client-smoke.mjs <react> <react-dom>  # 127 client checks (grid/detail/cards, markdown safety, zoom + focus trap, model selector, language selector, job controls)
node tools/journal-test.mjs             # 75 journal validator/planner checks (incl. the exported proof vocabulary)
node tools/journal-store-test.mjs       # 86 journal-store checks (exclusive create, flush, rename, tamper refusal)
node tools/publish-executor-test.mjs    # 27 publish/recovery-executor checks (incl. restart restore + explicit recovery flag)
node tools/fs-contain-test.mjs          # 27 containment checks (canonical dir, identity, guarded rename)
node tools/worker-guard-test.mjs        # 61 worker tool-guard checks
node tools/host-liveness-test.mjs       # 26 host-liveness checks
```

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
- the tracked work, decisions and open risks: [`specs/007-wiki-pipeline-i18n-models`](../../specs/007-wiki-pipeline-i18n-models)
  and [`docs/arch-notes/`](../../docs/arch-notes)

The package name here is `@dsh-ext/dsh-wiki`; `dsh-wiki` is only the runtime id. If you want the
unmodified original, install it from the upstream repository instead.
