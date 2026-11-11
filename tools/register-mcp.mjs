#!/usr/bin/env node
// dsh-wiki — register the MCP adapter with Claude Code and/or Claude Desktop.
//
// WHY THIS EXISTS
//   The adapter (`mcp/server.mjs`) speaks MCP over stdio. Claude Code and Claude Desktop each keep
//   their own server list, in two different files, and both need ABSOLUTE paths. Typing that by hand
//   is where people get it wrong, so this script computes the paths and emits (or applies) the exact
//   registration for both surfaces.
//
// WHY --repo IS LOAD-BEARING (measured 2026-11-11 on this machine)
//   The adapter resolves an omitted `repo` from the DSH registry (`~/.dsh/dsh-wiki/registry.json`).
//   That registry held 8 roots and TWO of them carried a wiki,
//   so an unqualified call answers `repo-ambiguous` instead of guessing. This script therefore always
//   passes `--repo <abs>` when it can prove a single wiki, and refuses (exit 2) when it cannot.
//
// SAFETY
//   * Default mode is DRY RUN: it prints what it would do and changes nothing.
//   * `--apply` is required to write. The Claude Desktop config is backed up before a write.
//   * No secrets are read or printed: only key names and file paths.
//
// USAGE
//   node tools/register-mcp.mjs                        # dry run, both surfaces, this repo
//   node tools/register-mcp.mjs --apply                # register in Claude Code + Claude Desktop
//   node tools/register-mcp.mjs --apply --target code  # Claude Code only
//   node tools/register-mcp.mjs --apply --target desktop
//   node tools/register-mcp.mjs --uninstall --apply    # remove from both
//   node tools/register-mcp.mjs --repo "D:\repo" --scope project --apply
//   node tools/register-mcp.mjs --help

import { readFile, writeFile, rename, access } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const SERVER_NAME = "dsh-wiki";
const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // tools/ -> plugin root
const SERVER_PATH = path.join(PLUGIN_ROOT, "mcp", "server.mjs");
const NODE_EXE = process.execPath;
const WIKI_DIR_NAME = ".dsh-wiki";

const EXIT_USAGE = 2;

function fail(message, detail) {
  process.stderr.write(`register-mcp: ${message}\n`);
  if (detail) process.stderr.write(`${detail}\n`);
  process.exit(EXIT_USAGE);
}

function usage() {
  process.stdout.write(
    [
      "dsh-wiki MCP registration",
      "",
      "  node tools/register-mcp.mjs [options]",
      "",
      "Options:",
      "  --apply                 actually register/remove (default: dry run)",
      "  --uninstall             remove the server instead of adding it",
      "  --target <both|code|desktop>   which surface (default: both)",
      "  --scope <user|project|local>   Claude Code scope (default: user)",
      "  --repo <abs path>       repository root that owns .dsh-wiki (default: discovered)",
      "  --desktop-config <path> override the Claude Desktop config path",
      "  --help                  this text",
      "",
      `Server script: ${SERVER_PATH}`,
      `Node executable: ${NODE_EXE}`,
      "",
    ].join("\n"),
  );
}

/** Minimal argv parser: `--key value` and `--key=value`; unknown flags are an error, never ignored. */
function parseArgs(argv) {
  const known = new Set(["apply", "uninstall", "target", "scope", "repo", "desktop-config", "help"]);
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) fail(`unexpected argument "${token}"`);
    const eq = token.indexOf("=");
    const key = (eq >= 0 ? token.slice(2, eq) : token.slice(2)).toLowerCase();
    if (!known.has(key)) fail(`unknown option "${token}"`, "run with --help");
    if (key === "apply" || key === "uninstall" || key === "help") {
      out[key] = true;
      continue;
    }
    const value = eq >= 0 ? token.slice(eq + 1) : argv[++i];
    if (value === undefined || value === "") fail(`option "--${key}" needs a value`);
    out[key] = value;
  }
  return out;
}

/** Claude Desktop keeps its server list here on Windows. */
function defaultDesktopConfig() {
  if (process.env.DSH_WIKI_DESKTOP_CONFIG) return process.env.DSH_WIKI_DESKTOP_CONFIG;
  if (process.platform === "win32") return path.join(process.env.APPDATA ?? os.homedir(), "Claude", "claude_desktop_config.json");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  return path.join(os.homedir(), ".config", "Claude", "claude_desktop_config.json");
}

/** Roots the DSH plugin has remembered, and which of them actually carry a wiki. */
async function registryRoots() {
  const registryPath = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh"), "dsh-wiki", "registry.json");
  try {
    const parsed = JSON.parse(await readFile(registryPath, "utf8"));
    const roots = Array.isArray(parsed?.roots) ? parsed.roots : [];
    return roots.map((row) => row?.path).filter((p) => typeof p === "string" && p.length > 0);
  } catch {
    return [];
  }
}

const hasWiki = (root) => existsSync(path.join(root, WIKI_DIR_NAME, "wiki.json"));

/** Walk up from a directory looking for the wiki that belongs to it. */
function discoverUpwards(from) {
  let dir = path.resolve(from);
  for (;;) {
    if (hasWiki(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Decide the repository root the server should be pinned to.
 * An explicit --repo must actually contain a wiki; discovery prefers cwd, then the registry,
 * and refuses to guess between several candidates (that refusal is the point).
 */
async function resolveRepo(explicit) {
  if (explicit !== undefined) {
    const abs = path.resolve(explicit);
    if (!path.isAbsolute(explicit) && explicit !== abs) fail(`--repo must be an absolute path, got "${explicit}"`);
    if (!hasWiki(abs)) fail(`--repo "${abs}" has no ${WIKI_DIR_NAME}/wiki.json`, "point it at the repository that owns the wiki");
    return { root: abs, source: "--repo" };
  }
  const fromCwd = discoverUpwards(process.cwd());
  if (fromCwd) return { root: fromCwd, source: "current directory (walked up)" };

  const candidates = (await registryRoots()).filter(hasWiki);
  if (candidates.length === 1) return { root: candidates[0], source: "DSH registry (only wiki root)" };
  if (candidates.length === 0) {
    fail("no wiki found", `looked in the current directory and in the DSH registry; run from a repository that has ${WIKI_DIR_NAME}\\wiki.json, or pass --repo`);
  }
  fail(
    `${candidates.length} repositories have a wiki, so the server cannot choose one`,
    ["pass --repo <abs path>; candidates:", ...candidates.map((p) => `  ${p}`)].join("\n"),
  );
  return null; // unreachable
}

/** `claude mcp add ...` argv. Scope is explicit; `--` keeps our server flags out of Claude's parser. */
function claudeAddArgs({ scope, repo }) {
  return ["mcp", "add", SERVER_NAME, "-s", scope, "--", NODE_EXE, SERVER_PATH, "--repo", repo];
}

function claudeRemoveArgs({ scope }) {
  return ["mcp", "remove", SERVER_NAME, "-s", scope];
}

function desktopEntry({ repo }) {
  return { command: NODE_EXE, args: [SERVER_PATH, "--repo", repo] };
}

function run(command, args, { capture = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      windowsHide: true,
      shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(command),
    });
    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout?.on("data", (chunk) => { stdout += chunk; });
      child.stderr?.on("data", (chunk) => { stderr += chunk; });
    }
    child.on("error", (error) => resolve({ code: null, stdout, stderr: String(error?.message ?? error) }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** Merge one server into the Claude Desktop config, preserving every other key, with a backup. */
async function mergeDesktopConfig(configPath, entry, { remove }) {
  let current = {};
  let existed = false;
  if (existsSync(configPath)) {
    existed = true;
    const raw = await readFile(configPath, "utf8");
    try {
      current = JSON.parse(raw);
    } catch (error) {
      fail(`Claude Desktop config is not valid JSON: ${configPath}`, String(error?.message ?? error));
    }
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      fail(`Claude Desktop config is not a JSON object: ${configPath}`);
    }
  }
  const servers = current.mcpServers && typeof current.mcpServers === "object" && !Array.isArray(current.mcpServers)
    ? { ...current.mcpServers }
    : {};
  const before = JSON.stringify(servers[SERVER_NAME] ?? null);
  if (remove) delete servers[SERVER_NAME];
  else servers[SERVER_NAME] = entry;
  const after = JSON.stringify(servers[SERVER_NAME] ?? null);
  if (before === after) return { changed: false, existed };

  const next = { ...current, mcpServers: servers };
  if (existed) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = `${configPath}.bak-${stamp}`;
    await rename(configPath, backup);
    process.stdout.write(`  backup: ${backup}\n`);
  }
  await writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return { changed: true, existed };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { usage(); return; }

  const apply = options.apply === true;
  const uninstall = options.uninstall === true;
  const target = (options.target ?? "both").toLowerCase();
  if (!["both", "code", "desktop"].includes(target)) fail(`--target must be both, code or desktop, got "${target}"`);
  const scope = (options.scope ?? "user").toLowerCase();
  if (!["user", "project", "local"].includes(scope)) fail(`--scope must be user, project or local, got "${scope}"`);

  const { root: repo, source } = await resolveRepo(options.repo);
  const desktopConfig = options["desktop-config"] ? path.resolve(options["desktop-config"]) : defaultDesktopConfig();

  process.stdout.write(`dsh-wiki MCP registration${apply ? "" : " (dry run — nothing will change)"}\n`);
  process.stdout.write(`  repository: ${repo}\n  resolved by: ${source}\n  node: ${NODE_EXE}\n  server: ${SERVER_PATH}\n\n`);

  if (target === "both" || target === "code") {
    const args = uninstall ? claudeRemoveArgs({ scope }) : claudeAddArgs({ scope, repo });
    process.stdout.write(`Claude Code (scope: ${scope})\n  claude ${args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}\n`);
    if (apply) {
      const result = await run("claude", args);
      if (result.code !== 0) {
        process.stderr.write(`\n  FAILED (exit ${result.code ?? "spawn-error"}). Is the Claude Code CLI on PATH?\n`);
        process.exitCode = 1;
      } else {
        process.stdout.write("  done\n");
      }
    }
  }

  if (target === "both" || target === "desktop") {
    const entry = desktopEntry({ repo });
    process.stdout.write(`\nClaude Desktop\n  config: ${desktopConfig}\n`);
    process.stdout.write(`  ${uninstall ? "remove" : "merge"} mcpServers.${SERVER_NAME} = ${JSON.stringify(entry)}\n`);
    if (apply) {
      const result = await mergeDesktopConfig(desktopConfig, entry, { remove: uninstall });
      process.stdout.write(result.changed ? "  done\n" : "  already up to date\n");
    }
  }

  if (!apply) {
    process.stdout.write("\nNothing was changed. Re-run with --apply to register.\n");
    process.stdout.write("After registering, restart Claude Code / Claude Desktop so they pick up the server.\n");
  }
}

main().catch((error) => {
  process.stderr.write(`register-mcp: ${String(error?.message ?? error)}\n`);
  process.exit(1);
});
