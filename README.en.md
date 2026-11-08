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
    <a href="README.md">简体中文</a>
  </p>

  <p>
    <img src="docs/assets/badges/license.svg" alt="MIT License">
    <img src="docs/assets/badges/dsh.svg" alt="DSH 0.2.x compatible">
    <img src="docs/assets/badges/python.svg" alt="Python ≥3.7">
    <img src="docs/assets/badges/tests.svg" alt="tests 64+25 passed">
    <img src="docs/assets/badges/network.svg" alt="zero network">
  </p>

</div>

> [!NOTE]
> **Codebase knowledge shouldn't live only in the original author's head — and shouldn't cost "upload the whole repo".**
>
> Among 9,100+ community plugins on awesome-dsh-plugin, none delivers a true DeepWiki-shaped artifact: dsh-openwiki wraps an external CLI and is unmaintained; codemap has citations but no prose; archify has diagrams but no wiki text. dsh-wiki combines **narrative pages + machine-checked evidence citations + offline diagrams + a self-contained site** in one DSH bundle — everything local, nothing leaves the machine.
>
> ```sh
> git clone https://github.com/Acfufu/dsh-wiki && cd dsh-wiki
> "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add "$PWD"
> ```

## ✨ What it is

A standard DSH community plugin (`@acfufu/dsh-wiki`). Once installed into any web/desktop profile it gives you four entries:

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

The site passes a **zero-external-link machine check** (entity encoding, protocol-relative URLs, CSS `url()`/`@import` forms covered); every `` `path:line` `` citation is machine-verified: the file must exist and the line number must be in range — out of range = generation failure.

## 🚀 Install

Prereqs: a DSH Desktop / web profile (`dsh-base` + `dsh-web-app`), `python3 ≥ 3.7` (pure-stdlib builder, no third-party deps).

**Route A · GUI plugin page**: sidebar "Plugins" → Add → paste this repo path (or `https://github.com/Acfufu/dsh-wiki`) → Install → Enable.

**Route B · CLI**:

```sh
CLI="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
"$CLI" plugin --profile desktop add github:Acfufu/dsh-wiki
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

**Migrating from ZCode**: say "import the legacy wiki" — `import-legacy` converts [zcode-repo-wiki](https://github.com/Acfufu/zcode-repo-wiki) data (`~/.zcode/v2/repo-wiki/<hash>`) in one step; the `wiki.json` schema is fully compatible.

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
```

Generation config merges four layers: builtin defaults → `~/.dsh/dsh-wiki/config.json` → `<repo>/.dsh-wiki/config.json` → `--set k=v`. Presets `compact`/`standard`/`deep`/`legacy`; tunables cover language, page count, granularity (theme/file/hybrid), words per page, diagram density (none/minimal/rich), citation mode (relaxed/strict).

## 🔒 Security & Privacy

| Behavior | dsh-wiki |
| --- | --- |
| Uploads repo content / Git history | **never** |
| Network requests (generation, diagrams, fonts, scripts) | **never** (zero-dep builder, zero-external-link site) |
| Reads `.git` object contents | **never** (sole exception: optional `git log --oneline -15` summary) |
| Artifact location | local disk only |

Host-side route fence: loopback Host check + directory basename must equal `wikiDirName` + read-only single-file serving, no traversal surface. General reminder: the plugin host half runs inside the host process — pair with `@jieai/dsh-plugin-vet` if you audit plugins.

## 🧪 Tests

```sh
python3 tests/test_build_wiki_site.py   # 64 builder regression checks (injection PoCs, SVG sanitizing, config merge, node --check on site scripts)
node tools/harness-test.mjs             # 25 host-half checks (skill registration / commands / routes / trust fence / subagent paths)
```

## ❓ FAQ

**How is this different from DeepWiki (Cognition)?** DeepWiki is a hosted service — the repo leaves your machine. dsh-wiki uses the model in your local session; nothing leaves the machine and the artifact is an HTML file you can double-click.

**Which DSH versions?** Peers declare `^0.1.1-rc.1 || ^0.2.0-rc.1`; verified on 0.2.2-rc.1 (2026-11-04 latest). No 0.2.2-breaking APIs used (tools.resolve / tools.mode / Session Projection all avoided).

**headless / tui profiles?** The skill and `/wiki view|list` work; `/wiki generate` and the local site routes need the web/desktop host (webServer).

**Does the builder need dependencies?** No. Pure Python 3.7+ stdlib, zero pip installs.

## 📄 License

MIT — see [LICENSE](LICENSE). Builder and viewer ported from [zcode-repo-wiki](https://github.com/Acfufu/zcode-repo-wiki) (MIT). The inlined mermaid runtime bundles third-party components — see `assets/THIRD-PARTY-NOTICES`.
