// dsh-wiki — Host side of the in-panel version check and safe self-update (spec 016).
//
// WHAT THIS IS
//   createUpdateService({ pluginRoot, installPath, fetchImpl, gitRunner, now, enabled }) answers two questions and
//   owns exactly one write action:
//     status()  the public §3.2 payload; never writes, and makes one HTTPS GET only when enabled
//     apply()   preflight §3.4 steps 1..8 and, only if every step passes, `git fetch` + `git checkout --detach`
//   Every safety invariant in spec §4 is a property of this module, so it is built out of injected
//   seams (`fetchImpl`, `gitRunner`, `now`) and touches no real network or repository in tests. The HTTP
//   surface (loopback/same-origin/content-type guards, bounded body parse, `confirm` token) stays in
//   lib/index.js next to the existing helpers — this module only ever sees an already-validated request.
//
// WHAT IT MUST NEVER DO
//   * put a filesystem path, git stderr, an upstream error string or a token in a returned value;
//   * follow a redirect to another origin, or trust `content-length` for the response cap, or buffer
//     an unbounded body before enforcing it (the 64 KiB cap is enforced while streaming);
//   * run git through a shell, prompt for credentials, or act on an unverified `origin`;
//   * let git read user, system or repository configuration: every invocation carries a `-c` prefix
//     that disables credential helpers, hooks and non-HTTPS protocols, plus an empty global/system
//     config file and an empty hooks directory (so no hook shipped by the repository being updated
//     can ever execute here);
//   * treat the module root as a fallback write target: the module root is the development tree, so a
//     missing installed package means "refuse", not "use the module root";
//   * act on an enclosing repository: the install must BE its worktree's top level;
//   * move the install to a version that is not strictly newer (§3.4.8, the downgrade guard);
//   * reload, restart or otherwise touch the Host lifecycle — it reports `reloadRequired` and stops.
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// ---------- fixed surface (spec §3.1: not configurable, on purpose) ----------
// One URL, one origin, one branch. Each of these, if configurable, would widen the network or the
// write surface of a plugin that otherwise makes no outbound request at all.
export const VERSION_URL = "https://raw.githubusercontent.com/nesteacold/dsh-wiki/main/package.json";
export const VERSION_HOST = "raw.githubusercontent.com";
export const EXPECTED_ORIGIN = "nesteacold/dsh-wiki";
export const FETCH_TIMEOUT_MS = 5000;
export const MAX_VERSION_BODY_BYTES = 64 * 1024;
export const GIT_TIMEOUT_MS = 60_000;
// The explicit install token (§3.3), the same shape as recovery-execute's `confirm`.
export const CONFIRM_TOKEN = "install-update";
export const REPO_VERSION_FILE = "package.json";

/** The closed §3.5 vocabulary. Nothing outside this list may ever reach a public payload. */
export const REASON_CODES = Object.freeze([
  "update-disabled",
  "update-in-progress",
  "install-not-found",
  "install-is-development-link",
  "install-not-git",
  "install-not-worktree-root",
  "install-origin-mismatch",
  "install-dirty",
  "latest-not-newer",
  "version-invalid",
  "network-unavailable",
  "fetch-failed",
  "checkout-failed",
  "postcondition-failed",
  "internal-error",
]);

// Fixed sentences for the closed vocabulary. They are the ONLY user-visible descriptions: a caller
// that needed an exception message here would be leaking a path or a git stderr line by construction.
// None of them contains "/" or "\\", so a path can never hide in one (tools/update-test.mjs asserts it).
export const REASON_MESSAGES = Object.freeze({
  "update-disabled": "Update checks are disabled; set update.enabled to true in the plugin configuration.",
  "update-in-progress": "Another update is already running; wait for it to finish before starting another.",
  "install-not-found": "This plugin's installed package could not be located, so it cannot update itself.",
  "install-is-development-link": "This plugin is installed as a development link, so it cannot update itself.",
  "install-not-git": "This install is not a git worktree, so it cannot update itself.",
  "install-not-worktree-root": "This install is not the top level of its git worktree, so it cannot update itself.",
  "install-origin-mismatch": "This install does not come from the expected repository, so it cannot update itself.",
  "install-dirty": "This install has uncommitted changes; commit or discard them before updating.",
  "latest-not-newer": "The published version is not newer than the installed version.",
  "version-invalid": "The published version is not a valid version number.",
  "network-unavailable": "The published version could not be retrieved.",
  "fetch-failed": "The update could not be fetched from the repository.",
  "checkout-failed": "The update could not be checked out.",
  "postcondition-failed": "The update did not produce the expected version.",
  "internal-error": "The update failed for an internal reason.",
});

// Refusals are conflicts with the current state of the install, not malformed requests; the route has
// already answered malformed ones (415/400) before the service is consulted. internal-error is a 500.
export const REASON_HTTP = Object.freeze({
  "update-disabled": 409,
  "update-in-progress": 409,
  "install-not-found": 409,
  "install-is-development-link": 409,
  "install-not-git": 409,
  "install-not-worktree-root": 409,
  "install-origin-mismatch": 409,
  "install-dirty": 409,
  "latest-not-newer": 409,
  "version-invalid": 409,
  "network-unavailable": 409,
  "fetch-failed": 409,
  "checkout-failed": 409,
  "postcondition-failed": 409,
  "internal-error": 500,
});

export const INSTALL_KINDS = Object.freeze(["install", "development-link", "unknown"]);

// ---------- pure semver ----------
// Strict X.Y.Z and nothing else: the published version is the whole trigger of a write, so a
// prerelease/build suffix must be refused as `version-invalid` rather than compared approximately.
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * Parse a strict `X.Y.Z` version.
 * @returns {{major: number, minor: number, patch: number}|null} null for anything that is not exactly X.Y.Z
 */
export function parseSemver(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return null;
  const match = SEMVER_RE.exec(value);
  if (!match) return null;
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (!parts.every((part) => Number.isSafeInteger(part))) return null;
  return { major: parts[0], minor: parts[1], patch: parts[2] };
}

/** Compare two versions (strings or parsed objects). Unparsable input yields null, never 0. */
export function compareSemver(left, right) {
  const a = typeof left === "string" ? parseSemver(left) : left;
  const b = typeof right === "string" ? parseSemver(right) : right;
  if (!a || !b) return null;
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  return 0;
}

/** Strictly newer: the downgrade guard of §3.4.8. Unknown versions are never "newer". */
export function isNewerVersion(latest, installed) {
  const compared = compareSemver(latest, installed);
  return compared === 1;
}

// ---------- pure origin normalisation ----------
// `git remote get-url origin` legitimately returns several spellings of the same repository (with or
// without `.git`, with or without a trailing slash). Everything that is not exactly owner/repo on
// github.com over HTTPS is a mismatch — near misses such as `nesteacold/dsh-wiki-evil`,
// `evil/nesteacold/dsh-wiki` or another host must not normalise onto the expected repository.
//
// H4: HTTPS is the only accepted transport. git://, ssh://, the scp-like `git@host:owner/repo` form and
// file/local paths are all refused: the update path trusts HTTPS-to-the-pinned-host plus git's own
// object integrity, and no other transport gives that. A development install whose origin is an SSH
// URL is therefore refused rather than updated over a channel this feature cannot reason about.
const GITHUB_HOST = "github.com";
const ORIGIN_MAX = 512;
const OWNER_REPO_RE = /^[a-z0-9](?:[a-z0-9._-]{0,99})$/;

/**
 * Normalise a git remote URL to `owner/repo` (lowercase, no `.git`), or null when it is not a plain
 * `https://` two-segment path on github.com.
 * @returns {string|null}
 */
export function normalizeOrigin(raw) {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value.length === 0 || value.length > ORIGIN_MAX) return null;
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  // Anything that is not an absolute https URL — including ssh://, git://, the scp-like form, file://
  // and relative paths — is not a spelling variant of the one accepted origin.
  if (!/^https:\/\//i.test(value)) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  // Only HTTPS: plain http would downgrade the object-integrity claim.
  if (url.protocol !== "https:") return null;
  // A userinfo (even the conventional `git` ssh user) is not a spelling variant of an HTTPS remote.
  if (url.username || url.password) return null;
  if (url.port) return null;
  const host = url.hostname.toLowerCase();
  if (host !== GITHUB_HOST) return null;
  const repoPath = url.pathname;

  const segments = repoPath.split("/").filter((segment) => segment.length > 0);
  if (segments.length !== 2) return null;
  const [owner, repoRaw] = segments;
  const repo = repoRaw.replace(/\.git$/i, "");
  if (!OWNER_REPO_RE.test(owner.toLowerCase()) || !OWNER_REPO_RE.test(repo.toLowerCase())) return null;
  if (repo.length === 0) return null;
  return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

/** True only for the one repository this feature is allowed to update from. */
export function isExpectedOrigin(raw) {
  return normalizeOrigin(raw) === EXPECTED_ORIGIN;
}

// ---------- git seams ----------
// Minimal environment: git needs a PATH and a temp directory, nothing else. Nothing from the ambient
// environment is forwarded wholesale, so no token, credential helper or proxy variable can ride along.
const GIT_ENV_ALLOWLIST = Object.freeze([
  "PATH", "PATHEXT", "SystemRoot", "SystemDrive", "ComSpec", "WINDIR", "TEMP", "TMP",
  "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "LANG", "LC_ALL", "OS",
]);

/**
 * The `-c` prefix EVERY git invocation carries, before the subcommand.
 *
 * Why (H1): git reads configuration from the system, the user's `~/.gitconfig` and the repository's own
 * `.git/config`, and honours `core.hooksPath`. A repository being updated controls its `.git/config`
 * and the hooks it points at, so without this prefix a self-update could run code shipped by that
 * repository — and "no credentials" could not be true by construction. Command-line configuration
 * beats repository configuration (verified on git 2.55: a repo-level `core.hooksPath` and
 * `credential.helper` are both overridden), so these settings hold even for a hostile `.git/config`:
 *   credential.helper=          no credential helper (repo or global) can be consulted;
 *   credential.interactive=never  never fall back to an interactive prompt;
 *   core.hooksPath=<empty dir>  no repository hook (post-checkout, etc.) can execute;
 *   core.fsmonitor=false        no configured fsmonitor program can run;
 *   submodule.recurse=false     no submodule traversal;
 *   protocol.allow=never + protocol.https.allow=always
 *                               only HTTPS can be contacted, whatever `.git/config` says.
 * @param {string} hooksPath an empty directory created for this call
 * @returns {string[]} argv elements to place before the subcommand
 */
export function gitHardeningArguments(hooksPath) {
  return [
    "-c", "credential.helper=",
    "-c", "credential.interactive=never",
    "-c", `core.hooksPath=${hooksPath}`,
    "-c", "core.fsmonitor=false",
    "-c", "submodule.recurse=false",
    "-c", "protocol.allow=never",
    "-c", "protocol.https.allow=always",
  ];
}

/**
 * The environment every git invocation receives: an allowlisted base plus non-interactive settings.
 * `GIT_TERMINAL_PROMPT=0` makes git fail instead of waiting on a terminal prompt (spec §3.4).
 *
 * H1: `GIT_CONFIG_NOSYSTEM=1` drops the system configuration, and `GIT_CONFIG_GLOBAL`/
 * `GIT_CONFIG_SYSTEM` point at an EMPTY file created for this call, so `~/.gitconfig`,
 * `%PROGRAMDATA%\Git\config` and the XDG equivalents cannot supply a credential helper, a
 * `url.*.insteadOf` rewrite or `core.sshCommand`. `GIT_CONFIG_SYSTEM` exists since git 2.32; on an
 * older git it is simply an unknown variable and `GIT_CONFIG_NOSYSTEM` already covers that case.
 * @param {{configPath?: string}} [overrides] configPath: the empty config file created for this call
 * @returns {Record<string, string>}
 */
export function gitEnvironment(overrides = {}) {
  const env = {};
  for (const key of GIT_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_ASKPASS = "";
  env.SSH_ASKPASS = "";
  env.ESCAPE_PROMPT = "0";
  env.GCM_INTERACTIVE = "never";
  env.GIT_CONFIG_NOSYSTEM = "1";
  const configPath = typeof overrides?.configPath === "string" ? overrides.configPath : "";
  if (configPath.length > 0) {
    env.GIT_CONFIG_GLOBAL = configPath;
    env.GIT_CONFIG_SYSTEM = configPath;
  }
  return env;
}

/**
 * One private, empty git sandbox for a single call: an empty hooks directory and an empty config file
 * under `os.tmpdir()` — never inside the repository and never inside the install directory — plus the
 * `dispose` the caller runs in a `finally`. Nothing in it is ever written by git: it only exists so the
 * `-c core.hooksPath` and `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` targets are real but empty.
 * @returns {Promise<{hooksPath: string, configPath: string, dispose: () => Promise<void>}>}
 */
const createGitSandbox = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dsh-wiki-update-git-"));
  const hooksPath = path.join(dir, "hooks");
  const configPath = path.join(dir, "gitconfig");
  await mkdir(hooksPath);
  await writeFile(configPath, "", { flag: "wx" });
  return {
    hooksPath,
    configPath,
    dispose: async () => { await rm(dir, { recursive: true, force: true }); },
  };
};

/**
 * Default git runner: one child process per call, argument vector only, no shell, bounded time.
 * Never throws and never returns stderr to a caller-visible field — the service maps `ok` to a code.
 * @param {string[]} argv arguments after `git`
 * @param {{cwd: string, timeoutMs: number, env: Record<string, string>}} options
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string}>}
 */
export function createDefaultGitRunner() {
  return async function runGitProcess(argv, options) {
    if (!Array.isArray(argv) || argv.some((argument) => typeof argument !== "string")) {
      return { ok: false, stdout: "", stderr: "" };
    }
    return await new Promise((resolve) => {
      try {
        execFile("git", argv, {
          cwd: options?.cwd,
          env: options?.env,
          timeout: options?.timeoutMs ?? GIT_TIMEOUT_MS,
          maxBuffer: 256 * 1024,
          windowsHide: true,
          encoding: "utf8",
        }, (error, stdout, stderr) => {
          resolve({
            ok: error === null || error === undefined,
            stdout: typeof stdout === "string" ? stdout : "",
            stderr: typeof stderr === "string" ? stderr : "",
          });
        });
      } catch {
        resolve({ ok: false, stdout: "", stderr: "" });
      }
    });
  };
}

// ---------- install observation ----------
// `lstat`, never `stat`: a symlinked install must be *seen* as a link. The installed plugin on this
// machine is exactly such a link, and the whole point of §3.4.3 is to refuse it instead of writing
// into the development tree behind it.
const inspectInstallKind = async (installRoot) => {
  try {
    const stats = await lstat(installRoot);
    if (stats.isSymbolicLink()) return "development-link";
    return stats.isDirectory() ? "install" : "unknown";
  } catch {
    return "unknown";
  }
};

/** Read the local version from the install's own package.json; unreadable/invalid => null. */
const readInstalledVersion = async (installRoot) => {
  if (typeof installRoot !== "string" || installRoot.length === 0) return null;
  try {
    const raw = await readFile(path.join(installRoot, REPO_VERSION_FILE), "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed?.version === "string" && parseSemver(parsed.version) ? parsed.version : null;
  } catch {
    return null;
  }
};

/**
 * The form two paths are compared in. Windows is case-insensitive and git may print either separator,
 * so both differences are normalised away there; elsewhere only a trailing separator is dropped.
 * @param {string} value an absolute path
 */
const comparablePath = (value) => {
  const normalized = path.normalize(value).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
};

/**
 * True when both paths resolve to the same directory on disk (symlinks and 8.3 aliases included).
 * Any failure to resolve — a path that no longer exists, an empty `git` answer — is a mismatch, never
 * an assumption of equality: this decides whether the updater may write at all.
 * @param {string} left
 * @param {string} right
 * @returns {Promise<boolean>}
 */
const isSameDirectory = async (left, right) => {
  if (typeof left !== "string" || typeof right !== "string" || left.length === 0 || right.length === 0) {
    return false;
  }
  try {
    const [leftReal, rightReal] = await Promise.all([realpath(left), realpath(right)]);
    return comparablePath(leftReal) === comparablePath(rightReal);
  } catch {
    return false;
  }
};

/**
 * The in-panel version check and safe self-update service (spec 016).
 *
 * @param {object} options
 * @param {string} [options.pluginRoot]  module root; READ-ONLY source of the display-only `installed.version`
 *   when no installed package path was resolved. Never inspected as a write target and never a git cwd.
 * @param {string|null} [options.installPath]  installed package path: the only directory inspected by
 *   §3.2/§3.4.3 and the git cwd. `null`/absent means "not located" and refuses `install-not-found`.
 * @param {Function} [options.fetchImpl]  defaults to the global fetch
 * @param {Function} [options.gitRunner]  `(argv, {cwd, timeoutMs, env}) => {ok, stdout, stderr}`
 * @param {Function} [options.now]        clock seam, defaults to `() => new Date()`
 * @param {boolean} [options.enabled]     `config.update.enabled`; anything but `true` means disabled
 */
export function createUpdateService({
  pluginRoot,
  installPath,
  fetchImpl,
  gitRunner,
  now,
  enabled,
} = {}) {
  const fetchFn = typeof fetchImpl === "function" ? fetchImpl : globalThis.fetch;
  const runGitProcess = typeof gitRunner === "function" ? gitRunner : createDefaultGitRunner();
  const clock = typeof now === "function" ? now : () => new Date();
  const isEnabled = enabled === true;
  // §3.2: the directory that is actually inspected is the installed package path the caller resolved —
  // the profile's node_modules entry, which this module cannot see from its own realpath. There is NO
  // fallback to the module root: the module root is the development tree, `lstat`s as a plain directory
  // and would silently bypass §4.2's link guard, turning the dev tree into a write target. So a missing
  // path stays `null` and refuses `install-not-found` before any lstat, git call or request.
  const installRoot = typeof installPath === "string" && installPath.length > 0 ? installPath : null;
  // The display-only version read (§3.2 `installed.version`). The module root is still allowed here so
  // the panel can show a version even when the installed package could not be located — read only.
  const versionRoot = installRoot
    ?? (typeof pluginRoot === "string" && pluginRoot.length > 0 ? pluginRoot : null);
  // Single-flight latch (§4.8). Set synchronously — before the first await — so two requests that
  // arrive in the same tick cannot both pass preflight step 2.
  let inFlight = false;
  // §3.2: `reloadRequired` is true from the moment an update is applied until the plugin is
  // re-created. It lives here, in the instance, on purpose — a plugin cycle (a new service) is
  // exactly what clears it, so it must never be persisted to disk, config or an environment variable.
  // Only a successful apply sets it; a refusal leaves the tree as it was, so there is nothing to reload.
  let reloadPending = false;

  const refusal = (code, extra) => ({
    ok: false,
    status: REASON_HTTP[code] ?? 500,
    code: REASON_CODES.includes(code) ? code : "internal-error",
    error: REASON_MESSAGES[REASON_CODES.includes(code) ? code : "internal-error"],
    ...(extra ?? {}),
  });

  /**
   * One git call: hardened argv prefix, an empty per-call config/hooks sandbox, and the minimal
   * environment. `stderr` is deliberately dropped here: it can quote a path.
   *
   * H1: the sandbox is created before the child starts and removed in `finally`, so the `-c
   * core.hooksPath` target and `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` file are real and empty for
   * exactly the lifetime of the call. A sandbox that cannot be created fails closed: no git runs.
   * H2: with no resolved install path there is nothing legitimate to run git in, so none is run.
   */
  const runGit = async (args) => {
    if (installRoot === null) return { ok: false, stdout: "" };
    let sandbox = null;
    try {
      sandbox = await createGitSandbox();
      const argv = [...gitHardeningArguments(sandbox.hooksPath), ...args];
      const result = await runGitProcess(argv, {
        cwd: installRoot,
        timeoutMs: GIT_TIMEOUT_MS,
        env: gitEnvironment({ configPath: sandbox.configPath }),
      });
      return {
        ok: result?.ok === true,
        stdout: typeof result?.stdout === "string" ? result.stdout : "",
      };
    } catch {
      return { ok: false, stdout: "" };
    } finally {
      if (sandbox) {
        try {
          await sandbox.dispose();
        } catch {
          // Best effort: a leftover empty temp directory is not a security or correctness finding.
        }
      }
    }
  };

  /**
   * Read a response body under `MAX_VERSION_BODY_BYTES` WHILE it streams (H5): the counter runs on the
   * chunks as they arrive and the reader is cancelled the moment the cap is exceeded, so an oversized
   * or endless body is never buffered into memory first. The `content-length` refusal stays as the
   * cheap early exit, but it is not what provides the bound.
   *
   * A Response-like object without a readable `body` falls back to `text()`, still capped afterwards —
   * that path exists for injected/plain fakes, not for a real fetch.
   * @returns {Promise<{ok: true, text: string}|{ok: false, code: string}>}
   */
  const readBoundedText = async (response) => {
    const stream = response?.body;
    if (stream && typeof stream.getReader === "function") {
      const reader = stream.getReader();
      const chunks = [];
      let total = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done === true) break;
          if (!ArrayBuffer.isView(value)) return { ok: false, code: "network-unavailable" };
          total += value.byteLength;
          if (total > MAX_VERSION_BODY_BYTES) {
            // Stop pulling bytes: the cap is enforced here, not after `text()` buffered everything.
            try {
              await reader.cancel();
            } catch {
              // The body is being discarded either way; a cancel failure changes nothing.
            }
            return { ok: false, code: "network-unavailable" };
          }
          chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
        }
      } catch {
        try {
          await reader.cancel();
        } catch {
          // Already failed; the refusal below is the outcome.
        }
        return { ok: false, code: "network-unavailable" };
      }
      return { ok: true, text: Buffer.concat(chunks).toString("utf8") };
    }
    let text;
    try {
      text = await response.text();
    } catch {
      return { ok: false, code: "network-unavailable" };
    }
    if (typeof text !== "string") return { ok: false, code: "network-unavailable" };
    if (Buffer.byteLength(text, "utf8") > MAX_VERSION_BODY_BYTES) {
      return { ok: false, code: "network-unavailable" };
    }
    return { ok: true, text };
  };

  /**
   * The single network read of this plugin (§3.1). Returns `{ok:true, version}` or `{ok:false, code}`
   * and never exposes an upstream message.
   */
  const fetchPublishedVersion = async () => {
    if (typeof fetchFn !== "function") return { ok: false, code: "network-unavailable" };
    let response;
    try {
      response = await fetchFn(VERSION_URL, {
        method: "GET",
        // No redirect is followed at all: a redirect to another origin can never be acted on, and a
        // same-origin redirect is not needed for this endpoint. The 3xx simply fails the 200 check.
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        // Nothing identifying is sent: no Authorization, no cookies, no referrer.
        credentials: "omit",
        cache: "no-store",
        headers: { accept: "application/json" },
      });
    } catch {
      return { ok: false, code: "network-unavailable" };
    }
    if (!response || response.status !== 200) return { ok: false, code: "network-unavailable" };
    // Defence in depth: even if an injected/managed fetch follows redirects, the resolved URL must
    // still be the pinned origin. Unknown `url` (a bare fake) is not treated as a mismatch.
    if (typeof response.url === "string" && response.url.length > 0) {
      let resolved = null;
      try {
        resolved = new URL(response.url);
      } catch {
        return { ok: false, code: "network-unavailable" };
      }
      if (resolved.hostname.toLowerCase() !== VERSION_HOST) return { ok: false, code: "network-unavailable" };
    }
    // `content-length` is not trusted; it only lets an obviously oversized body fail before reading.
    const declared = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(declared) && declared > MAX_VERSION_BODY_BYTES) {
      return { ok: false, code: "network-unavailable" };
    }
    const body = await readBoundedText(response);
    if (!body.ok) return { ok: false, code: body.code };
    const text = body.text;
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      // Not a JSON document => there is no version to parse, which §3.4.7 reports as version-invalid.
      return { ok: false, code: "version-invalid" };
    }
    const version = payload?.version;
    if (typeof version !== "string" || parseSemver(version) === null) {
      return { ok: false, code: "version-invalid" };
    }
    return { ok: true, version };
  };

  /**
   * Preflight §3.4, in exactly the spec's order, first failure wins.
   * Steps 1 and 2 are re-checked here with `selfInFlight` so that `apply()` can hold the latch while
   * still running the same ordered sequence the status route runs.
   * @param {boolean} selfInFlight true when the caller already holds the single-flight latch
   */
  const runPreflight = async (selfInFlight) => {
    // 1. enabled
    if (!isEnabled) return { ok: false, code: "update-disabled", latest: null };
    // 2. nothing already in flight
    if (!selfInFlight && inFlight) return { ok: false, code: "update-in-progress", latest: null };
    // 3. an installed package path was resolved at all, and it is a real directory — never a symlink
    //    (checked before any git call, §4.2). There is no fallback to the module root: that is the
    //    development tree, and inspecting it here would defeat §4.2 (H2). `unknown` is the fail-closed
    //    answer and nothing is read, run or requested.
    if (installRoot === null) {
      return { ok: false, code: "install-not-found", latest: null, installKind: "unknown" };
    }
    const installKind = await inspectInstallKind(installRoot);
    if (installKind !== "install") return { ok: false, code: "install-is-development-link", latest: null, installKind };
    // 4. a git worktree, and the install is that worktree's TOP LEVEL — not a subdirectory of an
    //    enclosing repository (`--is-inside-work-tree` is true for any depth, H3). Both sides are
    //    compared by realpath so a symlinked or differently-cased path cannot slip past, and an
    //    unanswerable question fails closed: if git cannot name a top level, this is not a worktree
    //    an updater may write into.
    const workTree = await runGit(["rev-parse", "--is-inside-work-tree"]);
    if (!workTree.ok || workTree.stdout.trim() !== "true") {
      return { ok: false, code: "install-not-git", latest: null, installKind };
    }
    const topLevel = await runGit(["rev-parse", "--show-toplevel"]);
    if (!topLevel.ok || !(await isSameDirectory(topLevel.stdout.trim(), installRoot))) {
      return { ok: false, code: "install-not-worktree-root", latest: null, installKind };
    }
    // 5. origin normalises to the expected repository
    const origin = await runGit(["remote", "get-url", "origin"]);
    if (!origin.ok || !isExpectedOrigin(origin.stdout)) {
      return { ok: false, code: "install-origin-mismatch", latest: null, installKind };
    }
    // 6. clean worktree — this is what protects uncommitted work (§4.3)
    const status = await runGit(["status", "--porcelain"]);
    if (!status.ok || status.stdout.trim().length > 0) {
      return { ok: false, code: "install-dirty", latest: null, installKind };
    }
    // 7. the published version, parsed strictly
    const published = await fetchPublishedVersion();
    if (!published.ok) return { ok: false, code: published.code, latest: null, installKind };
    const latest = {
      version: published.version,
      checkedAt: clock().toISOString(),
      source: VERSION_HOST,
    };
    // 8. strictly newer — the downgrade guard (§3.4.8)
    const installedVersion = await readInstalledVersion(installRoot);
    if (!isNewerVersion(latest.version, installedVersion)) {
      return { ok: false, code: "latest-not-newer", latest, installKind, installed: installedVersion };
    }
    return { ok: true, code: null, latest, installKind, installed: installedVersion };
  };

  /**
   * Resolve the commit to check out: a published tag when one matches, else the tracked branch
   * `origin/main`.
   *
   * The branch fallback is deliberate (spec §7): the published repository has no tags, so `main` is the
   * release line, and a tag is preferred the moment one exists. It is safe only because the branch is
   * not itself evidence of a version — the postcondition in `apply()` re-reads the local `package.json`
   * after the checkout and requires exactly the published version, so a `main` tip that does not carry
   * it fails as `postcondition-failed` (and the previous revision is restored). Nothing here trusts the
   * ref's name for the version.
   *
   * Every candidate is peeled to a COMMIT (`<ref>^{commit}`). For an ANNOTATED tag a bare
   * `rev-parse <tag>` prints the tag OBJECT id, while `checkout --detach` peels it and leaves HEAD on the
   * commit — so the postcondition (`rev-parse HEAD` === target) would never match and every update to an
   * annotated release would end as `postcondition-failed`. For a lightweight tag or a branch the peel is
   * a no-op. The returned id is therefore always a commit id, comparable with `rev-parse HEAD`.
   */
  const resolveTarget = async (version) => {
    for (const ref of [`refs/tags/v${version}`, `refs/tags/${version}`, "origin/main"]) {
      const resolved = await runGit(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
      const sha = resolved.stdout.trim();
      if (resolved.ok && /^[0-9a-f]{7,64}$/i.test(sha)) return sha;
    }
    return null;
  };

  /**
   * The public §3.2 status projection. Never writes; the only side effect is the single network read
   * that only happens when `enabled === true`. `reloadRequired` reports the remembered
   * `reloadPending` — recomputing it from this check would lose the hint exactly when it matters
   * (a panel reload after an applied update).
   * @returns {Promise<object>}
   */
  const status = async () => {
    // No installed package path means no install to inspect: `unknown`, not the module root (H2).
    const installKind = installRoot === null ? "unknown" : await inspectInstallKind(installRoot);
    // The version is display-only, so it may still come from the module root when nothing was resolved.
    const installedVersion = await readInstalledVersion(versionRoot);
    const payload = {
      ok: true,
      enabled: isEnabled,
      installed: { version: installedVersion, installKind },
      latest: null,
      updateAvailable: false,
      canUpdate: false,
      reason: null,
      reloadRequired: reloadPending,
    };
    let preflight;
    try {
      preflight = await runPreflight(false);
    } catch {
      // A seam that throws is a bug, not a finding: report the closed internal-error code and stop.
      return { ...payload, reason: "internal-error" };
    }
    if (preflight.latest) payload.latest = { ...preflight.latest };
    payload.updateAvailable =
      payload.latest !== null && installedVersion !== null
      && compareSemver(payload.latest.version, installedVersion) === 1;
    payload.canUpdate = preflight.ok === true;
    payload.reason = preflight.ok ? null : preflight.code;
    return payload;
  };

  /**
   * Preflight then apply (§3.3/§3.4). Never throws; every failure is a closed code with a fixed
   * sentence. Never reloads the plugin: the caller gets `reloadRequired` and decides.
   * @returns {Promise<object>}
   */
  const apply = async () => {
    // Steps 1 and 2 without holding the latch, so a refusal is decided before anything is claimed.
    if (!isEnabled) return refusal("update-disabled");
    if (inFlight) return refusal("update-in-progress");
    inFlight = true;
    try {
      const preflight = await runPreflight(true);
      // §3.3 refusal shape is exactly { error, code } plus the optional restore outcome.
      if (!preflight.ok) return refusal(preflight.code);
      const latestVersion = preflight.latest.version;
      const installedVersion = preflight.installed;

      // 9. fetch, resolve, check out detach, then prove the postconditions.
      const previous = await runGit(["rev-parse", "HEAD"]);
      const previousHead = /^[0-9a-f]{7,64}$/i.test(previous.stdout.trim()) ? previous.stdout.trim() : null;
      const fetched = await runGit(["fetch", "--tags", "--prune", "origin"]);
      if (!fetched.ok) return refusal("fetch-failed");
      // Nothing to check out after a successful fetch (no matching tag, no origin/main) means the
      // revision could not be obtained from the repository, so it is reported as fetch-failed — no
      // checkout was attempted and nothing moved, hence no `restored` field.
      const target = await resolveTarget(latestVersion);
      if (!target) return refusal("fetch-failed");

      // Restoring the previous revision is reported, never silent: the caller must know the tree moved.
      const restore = async () => {
        if (!previousHead) return false;
        const restored = await runGit(["checkout", "--detach", previousHead]);
        return restored.ok;
      };

      const checkout = await runGit(["checkout", "--detach", target]);
      if (!checkout.ok) return refusal("checkout-failed", { restored: await restore() });

      // Postcondition 1: HEAD is the revision we resolved.
      const head = await runGit(["rev-parse", "HEAD"]);
      const atTarget = head.ok && head.stdout.trim().toLowerCase() === target.toLowerCase();
      // Postcondition 2: the tree on disk really carries the expected version.
      const onDisk = await readInstalledVersion(installRoot);
      if (!atTarget || onDisk !== latestVersion) {
        const restored = await restore();
        // H6: the checkout SUCCEEDED, so the tree has already moved to the target. If the restore then
        // failed, HEAD is not where the caller last saw it — remember that, or the next status() would
        // report the install as unchanged. A restore that succeeded put the tree back: nothing pending.
        if (!restored) reloadPending = true;
        return refusal("postcondition-failed", { restored });
      }
      // The tree moved: remember it for every later status() of this instance (§3.2). Only the success
      // path and the "checkout succeeded but the restore failed" path set the flag; a plain refusal, or
      // a postcondition failure whose restore succeeded, left the tree as it was.
      reloadPending = true;
      // The update never reloads or restarts anything: the owner decides when to cycle the plugin.
      return {
        ok: true,
        applied: true,
        from: installedVersion ?? null,
        to: latestVersion,
        reloadRequired: true,
      };
    } catch {
      return refusal("internal-error");
    } finally {
      inFlight = false;
    }
  };

  return {
    enabled: isEnabled,
    status,
    apply,
  };
}
