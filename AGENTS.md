# AGENTS.md — dsh-wiki

This repository **is** the `dsh-wiki` product: a local Repo Wiki plugin for DeepSeek Harness (DSH),
package `@dsh-ext/dsh-wiki`, runtime id `dsh-wiki`. It is the canonical source (owner decision
2026-11-11). The former monorepo copy at `dsh-ext/plugins/dsh-wiki` is retired: new wiki work happens
**here only**.

Files live at the **repository root** — there is no `plugins/dsh-wiki/` level. Anything written for
the old monorepo that says `plugins/dsh-wiki/...` means the same path from this root.

## Layout

| Path | What lives there |
|---|---|
| `lib/` | Host half (`index.js`, `jobs.js`, `update.js`, …) and the client module (`client.js`) |
| `mcp/` | MCP adapter (`server.mjs`) — the same wiki for agents outside DSH |
| `builder/`, `skills/`, `presets/` | wiki builder, runtime skills, worker preset |
| `.claude/skills/` | skills for Claude Code users (`wiki-generate`, …) |
| `tools/` | every test suite and helper (`*-test.mjs`, `register-mcp.mjs`) |
| `specs/`, `docs/arch-notes/` | **local only, git-ignored** (owner 2026-11-12): feature specs and design notes live on the maintainer's machine and are never published, because they carry private names and paths. They may be absent in a fresh clone. |
| `README.md`, `README.zh.md`, `README.vi.md` | user docs; **all three carry the same content** |

## Read first

- `CLAUDE.md` — standing rules, roles, gates.
- The spec for the area you touch (`specs/`), then the code it cites.

## Hard boundaries

- Never patch or fork DSH core; extend through the plugin API. `engines.dsh` is pinned in `package.json`.
- Zero network by default. The only outbound request is the opt-in version check (`update.enabled`,
  default `false`). Any new network use needs a spec and a reviewer.
- Never commit, push, tag or publish without explicit owner approval.
- Never read, print or commit credentials, tokens or keys.
- `.dsh-wiki/` (a generated wiki) never enters git — it is in `.gitignore`; keep it there.
- Preserve working-tree changes; no reset/clean/stash unless the owner asks.
- Do not change model policy or permission mode to work around a failure; report it.
