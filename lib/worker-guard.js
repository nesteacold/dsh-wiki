// dsh-wiki — reusable filesystem guard for background job workers (spec 007 follow-up).
//
// Purpose: a background wiki job starts an ordinary model session (see jobs.js). That session
// inherits the Host's full tool set, so it can do anything the Host process can do. This module
// confines *that agent only* to the file operations a wiki worker needs, with a fail-closed
// allowlist. It is a policy layer, not an OS sandbox: see LIMITATIONS at the bottom.
//
// Verified Host contract (read from the installed @deepseek-ai/dsh-tools declarations, 2026-11-09):
//   ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined
//   ToolsService.guard(guard: ToolGuard): () => void
//   ToolExecution extends ToolExecutionInput { callId; rootCallId; name; arguments; agent?; signal; ... }
//   Agent.id is a SessionId (the worker session id jobs.js creates).
// The guard is monotonic and *synchronous*, runs after the extensible `tools/pre-execute`
// waterfall, and a returned reason string denies the call; no later listener can allow it again.
//
// Because ToolGuard cannot await, the decision engine here is synchronous and pure (read-only fs
// probes, no mutation of the registry or filesystem). `authorize(exec)` is the async public
// contract and delegates to that same engine, so the tested API and the installed guard cannot
// drift apart. See the verified integration status at the bottom of this file.
//
// Effective working directory (verified against the installed Host, 2026-11-09):
//   Session.header.cwd is the immutable creation directory, not the directory a relative tool
//   path resolves against. `working_directory(cd)` changes a session's effective directory at
//   runtime, and WorkingDirectoryService owns it: `workingDirectory.get(session): string` reads
//   the committed effective directory synchronously, without filesystem I/O. The guard therefore
//   requires an injected synchronous resolver `getEffectiveCwd(agent)` and never consults
//   session.header.cwd. Reference adapter (not wired here):
//     getEffectiveCwd: (agent) => ctx.workingDirectory.get(agent.session)
//
// Only node builtins are imported: plugins resolve Host services through ctx, never by importing
// DSH packages.
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";

// ---------- public contract ----------

/**
 * The only tools an active worker may call. Exact names; anything else is denied.
 *
 * `skill` is deliberately absent. A worker's instructions must arrive already preseeded by the
 * Host: a project skill can shadow a same-named skill, and the context loaders a skill pulls in
 * are not part of this guard. Preseeding instructions and deciding how context loaders are
 * confined are separate release prerequisites (see LIMITATIONS).
 */
export const ALLOWED_TOOLS = Object.freeze(["read", "glob", "grep", "write", "edit"]);

/** Provenance note for the integration adapter (verified, not guessed). */
export const TOOL_GUARD_CONTRACT = Object.freeze({
  source: "@deepseek-ai/dsh-tools (installed Host declarations)",
  signature: "(execution: Readonly<ToolExecution>) => string | undefined",
  semantics:
    "monotonic synchronous guard after tools/pre-execute; a returned reason denies the call and a later listener cannot turn it back into permission",
  therefore:
    "the installer registers a synchronous deny-only guard; async authorize() wraps the identical synchronous decision engine",
});

/** Tools whose first argument names a filesystem target we must resolve. */
const READ_TOOLS = new Set(["read"]);
const SEARCH_TOOLS = new Set(["glob", "grep"]);
const WRITE_TOOLS = new Set(["write", "edit"]);

const isWin = process.platform === "win32";
const REASON_PREFIX = "dsh-wiki worker guard: ";

// Host-owned entries a worker must never write: the Host assembles wiki.json/config/locales and
// owns the journal. The type of refusal matters to the model, so name them explicitly.
const HOST_OWNED_DIRS = new Set(["locales", "journal", "site"]);
const HOST_OWNED_FILES = new Set(["wiki.json", "config.json", "generation-meta.json"]);

// Credential-ish path components. Denying a public key (id_*_.pub) is harmless; denying a private
// key by name is the point. Matching is per path segment, never on file contents (we never read).
const SENSITIVE_NAME_PATTERNS = Object.freeze([
  /^\.git$/i,
  /^\.env$/i,
  /^\.env\..+$/i,
  /^\.envrc$/i,
  /^\.ssh$/i,
  /^\.aws$/i,
  /^\.gnupg$/i,
  /^\.azure$/i,
  /^\.kube$/i,
  /^\.docker$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^_netrc$/i,
  /^\.pgpass$/i,
  /^\.htpasswd$/i,
  /^\.git-credentials$/i,
  /^\.credentials(\.(json|ya?ml|txt))?$/i,
  /^credentials(\.(json|ya?ml|txt|ini|cfg))?$/i,
  /^secrets?(\.(json|ya?ml|txt|ini|env))?$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|gpg|asc|ppk)$/i,
]);

// Recursive grep reads file contents, so the entire reachable search root is scanned for
// credential-like names before it is allowed. There are no assumed skips: a positive include
// filter (`**`) can reach node_modules, generated .dsh-wiki* trees and VCS directories, so the
// scan must reach them too (and deny anything it cannot prove clean). See LIMITATIONS.
//
// Strict per-tool argument contract, mirroring the installed tool schemas minus the sandbox
// escalation keys: a worker may never request wider sandbox permissions or a justification for
// them. Any own key that is not listed here is denied, so a future tool option cannot widen the
// policy silently.
const ARGUMENT_KINDS = Object.freeze({
  read: Object.freeze({ file_path: "string", offset: "positive-integer", limit: "positive-integer" }),
  glob: Object.freeze({ pattern: "string", path: "string" }),
  grep: Object.freeze({ pattern: "string", path: "string", include: "string" }),
  write: Object.freeze({ file_path: "string", content: "string" }),
  edit: Object.freeze({ file_path: "string", old_string: "string", new_string: "string", replace_all: "boolean" }),
});

const REQUIRED_ARGUMENTS = Object.freeze({
  read: Object.freeze(["file_path"]),
  glob: Object.freeze(["pattern"]),
  grep: Object.freeze(["pattern"]),
  write: Object.freeze(["file_path", "content"]),
  edit: Object.freeze(["file_path", "old_string", "new_string"]),
});

const DEFAULT_LIMITS = Object.freeze({
  maxPathLength: 4096,
  maxSearchEntries: 20000,
  maxSearchDepth: 24,
});

const DEFAULT_IO = Object.freeze({
  lstat: (target) => lstatSync(target),
  realpath: (target) => (typeof realpathSync.native === "function" ? realpathSync.native(target) : realpathSync(target)),
  readdir: (target) => readdirSync(target, { withFileTypes: true }),
});

export class WorkerGuardError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WorkerGuardError";
    this.code = code;
  }
}

// ---------- small helpers ----------

const freezeDecision = (decision) => Object.freeze(decision);

const allow = (code, tool) => freezeDecision({ allow: true, code, ...(tool ? { tool } : {}) });

const deny = (code, reason, tool) =>
  freezeDecision({
    allow: false,
    code,
    ...(tool ? { tool } : {}),
    reason: reason.startsWith(REASON_PREFIX) ? reason : REASON_PREFIX + reason,
  });

/** Case/format-insensitive path equality for the host platform. */
function samePath(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const trim = (value) => (value.length > 1 ? value.replace(/[\\/]+$/, "") : value);
  const left = trim(a);
  const right = trim(b);
  return isWin ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** True when `child` is `parent` or lives below it (lexical, canonical paths expected). */
function isWithin(parent, child) {
  if (typeof parent !== "string" || typeof child !== "string") return false;
  if (!path.isAbsolute(parent) || !path.isAbsolute(child)) return false;
  if (isWin && parent.slice(0, 2).toLowerCase() !== child.slice(0, 2).toLowerCase()) return false;
  const rel = path.relative(parent, child);
  if (rel === "") return true;
  return rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
}

function splitSegments(value) {
  return value.split(/[\\/]+/).filter((segment) => segment.length > 0);
}

/**
 * A glob segment is checked with its wildcards removed, so `*.pem` / `credentials.*` cannot be
 * used to enumerate key material even though `isSensitivePathName()` only sees the literal.
 */
function globSegmentIsSensitive(segment) {
  const literal = segment.replace(/[*?[\]{}!]/g, "").replace(/\.+$/, "");
  if (literal.length === 0) return false;
  return isSensitivePathName(literal);
}

const RESERVED_WIN_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Credential-like name check, applied to one path segment. */
export function isSensitivePathName(name) {
  if (typeof name !== "string" || name.length === 0) return false;
  for (const pattern of SENSITIVE_NAME_PATTERNS) if (pattern.test(name)) return true;
  return false;
}

/**
 * Reject syntactically hostile paths before touching the filesystem: traversal, NUL, UNC and
 * device paths, drive-relative paths, Windows stream separators, reserved device names.
 * Returns a human reason or null when the shape is acceptable.
 */
function invalidPathShape(raw, { maxLength = DEFAULT_LIMITS.maxPathLength } = {}) {
  if (typeof raw !== "string") return "the path must be a string";
  if (raw.length === 0) return "the path is empty";
  if (raw.length > maxLength) return `the path is longer than ${maxLength} characters`;
  if (raw.includes("\u0000")) return "the path contains a NUL byte";
  if (isWin) {
    if (/^[\\/]{2}/.test(raw)) return "UNC and device paths are not allowed";
    if (/^[a-zA-Z]:(?![\\/])/.test(raw)) return "drive-relative paths are not allowed";
    if (/[<>"|?*]/.test(raw)) return "the path contains characters that are not allowed";
    if (/[\u0000-\u001f]/.test(raw)) return "the path contains control characters";
  }
  const segments = splitSegments(raw);
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    if (segment === "..") return 'the path contains a ".." segment';
    if (!isWin) continue;
    const isDrive = index === 0 && /^[a-zA-Z]:$/.test(segment);
    if (!isDrive && segment.includes(":")) return "the path contains a Windows stream separator";
    if (/[. ]$/.test(segment)) return "a path segment ends with a dot or space";
    if (RESERVED_WIN_NAMES.test(segment)) return "the path uses a reserved Windows device name";
  }
  return null;
}

/** Own-property read: prototype-inherited arguments must never satisfy a filesystem check. */
function readStringArgument(args, key) {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return { error: "the tool arguments must be an object" };
  if (!Object.hasOwn(args, key)) return { error: `the "${key}" argument is missing` };
  let value;
  try {
    value = args[key];
  } catch {
    return { error: `the "${key}" argument cannot be read` };
  }
  if (typeof value !== "string") return { error: `the "${key}" argument must be a string` };
  return { value };
}

const KIND_DESCRIPTION = Object.freeze({
  string: "a string",
  boolean: "a boolean",
  "positive-integer": "a positive integer",
});

function argumentMatchesKind(kind, value) {
  switch (kind) {
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "positive-integer":
      return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
    default:
      return false;
  }
}

/**
 * Own-key + type validation for one tool call, before any filesystem work. `Reflect.ownKeys()`
 * catches inherited/unknown/escalation keys (`sandbox_permissions`, `justification`, a future
 * traversal option) instead of letting the tool body interpret something the policy never saw.
 * Returns a human reason or null when the shape is acceptable.
 */
function validateToolArguments(tool, args) {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return "the tool arguments must be an object";
  const kinds = ARGUMENT_KINDS[tool];
  if (!kinds) return `tool "${tool}" has no argument contract`;
  const required = REQUIRED_ARGUMENTS[tool];
  let names;
  try {
    names = Reflect.ownKeys(args);
  } catch {
    return "the tool arguments cannot be inspected";
  }
  for (const name of names) {
    if (typeof name !== "string" || !Object.hasOwn(kinds, name)) {
      return `the "${String(name)}" argument is not permitted for the ${tool} tool`;
    }
  }
  for (const name of required) {
    if (!Object.hasOwn(args, name)) return `the "${name}" argument is missing`;
  }
  for (const name of Object.keys(kinds)) {
    if (!Object.hasOwn(args, name)) continue;
    let value;
    try {
      value = args[name];
    } catch {
      return `the "${name}" argument cannot be read`;
    }
    if (!argumentMatchesKind(kinds[name], value)) {
      return `the "${name}" argument must be ${KIND_DESCRIPTION[kinds[name]] ?? kinds[name]}`;
    }
  }
  return null;
}

/** A thenable is not a synchronous value; reject it rather than await it (the guard cannot await). */
function isThenable(value) {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
  try {
    return typeof value.then === "function";
  } catch {
    return true;
  }
}

function readAgentId(exec) {
  try {
    const id = exec?.agent?.id;
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

function readToolName(exec) {
  try {
    const name = exec?.name;
    return typeof name === "string" && name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

function readArguments(exec) {
  try {
    return { value: exec?.arguments };
  } catch {
    return { error: "the tool arguments cannot be read" };
  }
}

// ---------- factory ----------

/**
 * Create a guard registry. One instance is intended to live for the plugin's lifetime and serve
 * several jobs; each job activates its own worker agent id and releases it when the job ends.
 *
 * @param {object} options
 * @param {(agent: object) => string} options.getEffectiveCwd REQUIRED, synchronous, authoritative
 *   resolver of the calling session's effective working directory. The guard passes `exec.agent`
 *   (the ToolExecution's Agent) and expects the absolute directory the tool body will resolve
 *   relative paths against. The reference adapter for the installed Host is
 *   `(agent) => ctx.workingDirectory.get(agent.session)`: `workingDirectory.get(session)` reads the
 *   committed effective directory without filesystem I/O, and `working_directory` can change it
 *   after creation. `session.header.cwd` is the immutable creation directory, so it is never read
 *   here and never used as a fallback. The resolver must not return a Promise; a missing value, a
 *   non-string, a thenable, a throw, an unresolvable path or a directory that differs from the
 *   activated job directory denies the call.
 * @param {object} [options.io] overrides for { lstat, realpath, readdir } (tests)
 * @param {object} [options.limits] overrides for { maxPathLength, maxSearchEntries, maxSearchDepth }
 */
export function createWorkerGuard(options = {}) {
  const io = { ...DEFAULT_IO, ...(options.io ?? {}) };
  const limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
  const getEffectiveCwd = options.getEffectiveCwd;
  if (typeof getEffectiveCwd !== "function") {
    throw new WorkerGuardError(
      "invalid-effective-cwd-resolver",
      "createWorkerGuard requires getEffectiveCwd(agent): string, a synchronous resolver of the Host's working-directory projection (workingDirectory.get(session)); session.header.cwd is the immutable creation directory and is never authoritative",
    );
  }
  const activations = new Map();
  let installed = null;

  // ---------- activation ----------

  const canonicalDir = (value, label) => {
    if (typeof value !== "string" || value.length === 0) {
      throw new WorkerGuardError(`invalid-${label}`, `${label} must be a non-empty absolute path`);
    }
    if (!path.isAbsolute(value)) throw new WorkerGuardError(`invalid-${label}`, `${label} must be absolute, got "${value}"`);
    if (value.includes("\u0000")) throw new WorkerGuardError(`invalid-${label}`, `${label} must not contain a NUL byte`);
    let info;
    try {
      info = io.lstat(value);
    } catch (error) {
      throw new WorkerGuardError(`invalid-${label}`, `${label} does not exist (${error?.code ?? "error"})`);
    }
    if (info.isSymbolicLink()) throw new WorkerGuardError(`invalid-${label}`, `${label} must not be a symlink or junction`);
    if (!info.isDirectory()) throw new WorkerGuardError(`invalid-${label}`, `${label} must be a directory`);
    let real;
    try {
      real = io.realpath(value);
    } catch (error) {
      throw new WorkerGuardError(`invalid-${label}`, `${label} cannot be resolved (${error?.code ?? "error"})`);
    }
    return { root: path.resolve(value), real: path.resolve(real) };
  };

  /**
   * Activate confinement for one worker agent id.
   *
   * @param {string} agentId exact Agent.id / SessionId of the job session
   * @param {object} activation
   * @param {string} activation.repoRoot source repository root (read scope)
   * @param {string} activation.stagingRoot candidate wiki directory (read scope, only write scope)
   * @param {string} [activation.cwd] relative-path base; defaults to repoRoot (matches the session cwd)
   * @returns {() => boolean} idempotent release function
   */
  const activate = (agentId, activation = {}) => {
    if (typeof agentId !== "string" || agentId.length === 0 || agentId.length > 512) {
      throw new WorkerGuardError("invalid-agent-id", "agentId must be a non-empty string of at most 512 characters");
    }
    if (activations.has(agentId)) {
      throw new WorkerGuardError("agent-already-active", `worker agent ${agentId} already has an active guard; release it first`);
    }
    const repo = canonicalDir(activation.repoRoot, "repoRoot");
    const staging = canonicalDir(activation.stagingRoot, "stagingRoot");
    if (samePath(repo.real, staging.real)) {
      throw new WorkerGuardError("invalid-staging", "stagingRoot must be a separate directory from repoRoot");
    }
    if (isWithin(staging.real, repo.real)) {
      throw new WorkerGuardError("invalid-staging", "stagingRoot must not contain repoRoot");
    }
    const cwdValue = activation.cwd ?? repo.root;
    const cwd = canonicalDir(cwdValue, "cwd");
    if (!isWithin(repo.real, cwd.real)) {
      throw new WorkerGuardError("invalid-cwd", "cwd must live inside repoRoot");
    }

    const worker = Object.freeze({
      agentId,
      cwd: cwd.real,
      repoRoot: repo.root,
      repoReal: repo.real,
      stagingRoot: staging.root,
      stagingReal: staging.real,
    });
    activations.set(agentId, worker);

    let released = false;
    return () => {
      if (released) return false;
      released = true;
      if (activations.get(agentId) !== worker) return false;
      activations.delete(agentId);
      return true;
    };
  };

  const release = (agentId) => {
    if (typeof agentId !== "string") return false;
    return activations.delete(agentId);
  };

  const releaseAll = () => {
    const count = activations.size;
    activations.clear();
    return count;
  };

  const isActive = (agentId) => typeof agentId === "string" && activations.has(agentId);

  const activeAgentIds = () => [...activations.keys()];

  // ---------- per-call root verification ----------

  /** Roots are re-verified on every call: a replaced/re-pointed staging dir must fail closed. */
  const rootsUnchanged = (worker) => {
    const verify = (root, expectedReal, label) => {
      let info;
      try {
        info = io.lstat(root);
      } catch (error) {
        return `${label} is not accessible (${error?.code ?? "error"})`;
      }
      if (info.isSymbolicLink()) return `${label} became a symlink or junction`;
      if (!info.isDirectory()) return `${label} is no longer a directory`;
      let real;
      try {
        real = io.realpath(root);
      } catch (error) {
        return `${label} cannot be resolved (${error?.code ?? "error"})`;
      }
      if (!samePath(real, expectedReal)) return `${label} now resolves to a different directory`;
      return null;
    };
    return verify(worker.repoRoot, worker.repoReal, "the repository root") ?? verify(worker.stagingRoot, worker.stagingReal, "the staging root");
  };

  /**
   * Authoritative effective working directory check. The guard passes `exec.agent` (the
   * ToolExecution's Agent) to a synchronous resolver; if the resolver throws, returns a thenable,
   * returns missing/invalid/mismatched value, or realpath fails, every call denies. Never reads
   * session.header.cwd.
   */
  const checkEffectiveCwd = (tool, exec, worker) => {
    let agent;
    try {
      agent = exec?.agent;
    } catch {
      return deny("cwd-unavailable", "the worker agent cannot be read; refusing", tool);
    }
    if (!agent) return deny("cwd-unavailable", "the worker agent is not present; refusing", tool);
    let value;
    try {
      value = getEffectiveCwd(agent);
    } catch {
      return deny("cwd-unavailable", "the authoritative effective working directory could not be resolved; refusing", tool);
    }
    if (isThenable(value)) return deny("cwd-not-synchronous", "the effective working directory resolver returned a Promise; it must be synchronous; refusing", tool);
    if (value === undefined || value === null || value === "") return deny("cwd-missing", "the authoritative effective working directory is missing; refusing (session.header.cwd is never consulted)", tool);
    if (typeof value !== "string") return deny("cwd-invalid", "the authoritative effective working directory is not a string; refusing", tool);
    if (!path.isAbsolute(value)) return deny("cwd-invalid", "the authoritative effective working directory is not absolute; refusing", tool);
    if (value.includes("\u0000")) return deny("cwd-invalid", "the authoritative effective working directory contains a NUL byte; refusing", tool);
    let real;
    try {
      real = io.realpath(value);
    } catch {
      return deny("cwd-unavailable", "the authoritative effective working directory cannot be resolved; refusing", tool);
    }
    if (!samePath(real, worker.cwd)) {
      return deny("cwd-mismatch", `the worker's effective working directory ${JSON.stringify(value)} does not match the activated job directory; refusing`, tool);
    }
    return null;
  };

  // ---------- path resolution ----------

  const pickAnchor = (worker, absolute) => {
    if (isWithin(worker.stagingRoot, absolute)) {
      return { kind: "staging", root: worker.stagingRoot, real: worker.stagingReal };
    }
    if (isWithin(worker.repoRoot, absolute)) {
      return { kind: "repo", root: worker.repoRoot, real: worker.repoReal };
    }
    return null;
  };

  /**
   * Resolve a model-supplied path for one worker.
   *
   * Rules, in order: syntactic shape -> lexical containment in repo/staging -> walk every existing
   * component from the canonical root and reject symlinks/junctions -> verify the final real path
   * is still inside a root. A missing tail (write to a new file) is allowed because its deepest
   * existing parent is canonical and every existing component was checked.
   */
  const resolveTarget = (worker, raw, tool) => {
    const shape = invalidPathShape(raw, { maxLength: limits.maxPathLength });
    if (shape) return { deny: deny("path-traversal", `${shape} (${tool})`, tool) };

    const absolute = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(worker.cwd, raw);
    const anchor = pickAnchor(worker, absolute);
    if (!anchor) {
      return { deny: deny("path-outside-roots", `"${raw}" is outside the job roots: reads are limited to the repository and the staging wiki, writes to the staging wiki`, tool) };
    }

    const relative = path.relative(anchor.root, absolute);
    const segments = relative === "" ? [] : relative.split(path.sep).filter((segment) => segment.length > 0);
    for (const segment of segments) {
      if (isSensitivePathName(segment)) {
        return { deny: deny("path-sensitive", `"${raw}" looks like credential material (.git, .env, keys, secrets); it is blocked by policy`, tool) };
      }
    }

    let current = anchor.real;
    let missingAt = -1;
    for (let index = 0; index < segments.length; index++) {
      const next = path.join(current, segments[index]);
      let info;
      try {
        info = io.lstat(next);
      } catch (error) {
        if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
          missingAt = index;
          break;
        }
        return { deny: deny("path-unreadable", `"${raw}" cannot be inspected (${error?.code ?? "error"})`, tool) };
      }
      if (info.isSymbolicLink()) {
        return { deny: deny("path-symlink", `"${raw}" passes through a symlink or junction ("${segments[index]}"); links are not followed`, tool) };
      }
      if (index < segments.length - 1 && !info.isDirectory()) {
        return { deny: deny("path-not-directory", `"${raw}" crosses a non-directory component ("${segments[index]}")`, tool) };
      }
      current = next;
    }

    let realTarget;
    if (missingAt === -1) {
      let canonical;
      try {
        canonical = io.realpath(current);
      } catch (error) {
        return { deny: deny("path-unreadable", `"${raw}" cannot be resolved (${error?.code ?? "error"})`, tool) };
      }
      if (!samePath(canonical, current)) {
        return { deny: deny("path-symlink", `"${raw}" resolves outside its canonical path; links are not followed`, tool) };
      }
      realTarget = current;
    } else {
      // current is the deepest existing parent (still canonical: every component above was checked).
      realTarget = path.join(current, ...segments.slice(missingAt));
    }

    if (!isWithin(worker.repoReal, realTarget) && !isWithin(worker.stagingReal, realTarget)) {
      return { deny: deny("path-outside-roots", `"${raw}" resolves outside the job roots`, tool) };
    }
    if (segments.some((segment) => isSensitivePathName(segment))) {
      return { deny: deny("path-sensitive", `"${raw}" targets credential material`, tool) };
    }

    return { real: realTarget, anchor: anchor.kind, segments, raw };
  };

  // ---------- write policy ----------

  const checkWriteShape = (worker, resolved, tool, raw) => {
    if (resolved.anchor !== "staging") {
      return deny("write-not-staging", `"${raw}" is not inside the staging wiki; the worker may only write ${worker.stagingReal}/pages/*.md and ${worker.stagingReal}/cards/*.md`, tool);
    }
    const relative = path.relative(worker.stagingReal, resolved.real);
    const segments = relative === "" ? [] : relative.split(path.sep).filter((segment) => segment.length > 0);

    const hostOwned = segments.find((segment) => HOST_OWNED_DIRS.has(segment.toLowerCase()) || HOST_OWNED_FILES.has(segment.toLowerCase()));
    if (hostOwned) {
      return deny("write-host-owned", `"${raw}" is host-owned (${hostOwned}); the Host assembles wiki.json, config.json, locales and the journal — the worker writes pages/*.md and cards/*.md only`, tool);
    }
    if (segments.length !== 2) {
      return deny("write-not-allowed", `"${raw}" must be exactly ${worker.stagingReal}/pages/<name>.md or ${worker.stagingReal}/cards/<name>.md (one level, flat)`, tool);
    }
    const [directory, name] = segments;
    if (directory !== "pages" && directory !== "cards") {
      return deny("write-not-allowed", `"${raw}" must live under pages/ or cards/, not "${directory}/"`, tool);
    }
    if (!name.endsWith(".md") || name.length <= 3) {
      return deny("write-not-allowed", `"${raw}" must be a .md file`, tool);
    }
    if (name.startsWith(".") || /[\u0000-\u001f<>:"/\\|?*]/.test(name) || RESERVED_WIN_NAMES.test(name)) {
      return deny("write-not-allowed", `"${raw}" has a name the worker may not write`, tool);
    }

    // A pre-existing hardlink would let the write mutate a file outside the staging tree.
    try {
      const info = io.lstat(resolved.real);
      if (info.isSymbolicLink()) return deny("path-symlink", `"${raw}" is a symlink or junction`, tool);
      if (info.isDirectory()) return deny("write-not-allowed", `"${raw}" is a directory`, tool);
      if (info.isFile() && Number(info.nlink) > 1) {
        return deny("write-hardlink", `"${raw}" has multiple hard links; writing it could modify a file outside the staging wiki`, tool);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") return deny("path-unreadable", `"${raw}" cannot be inspected (${error?.code ?? "error"})`, tool);
    }
    return null;
  };

  // ---------- search policy ----------

  const checkGlobPattern = (pattern) => {
    if (typeof pattern !== "string" || pattern.trim().length === 0) return "the glob pattern must be a non-empty string";
    if (pattern.length > 1024) return "the glob pattern is too long";
    if (pattern.includes("\u0000")) return "the glob pattern contains a NUL byte";
    if (path.isAbsolute(pattern) || /^[a-zA-Z]:/.test(pattern) || /^[\\/]{2}/.test(pattern)) {
      return "absolute glob patterns are not allowed; pass a relative pattern";
    }
    if (pattern.includes("..")) return 'the glob pattern may not contain ".."';
    for (const segment of splitSegments(pattern)) {
      if (globSegmentIsSensitive(segment)) return `the glob pattern targets credential material ("${segment}")`;
    }
    return null;
  };

  /**
   * grep reads file *contents*, so the whole reachable search tree is proven to contain no
   * credential-like or unproven entry before it is allowed. No subtree is exempt: ignore-file
   * exemptions (node_modules, .dsh-wiki*, .git, .svn, .hg) are not assumed, because a positive
   * include filter can still reach them. A symlink, an unexpected dirent, any inspection failure
   * and every exceeded bound deny the call (fail closed).
   */
  const scanSearchRoot = (target) => {
    let info;
    try {
      info = io.lstat(target);
    } catch (error) {
      return { unverified: `the search root cannot be inspected (${error?.code ?? "error"})` };
    }
    if (info.isSymbolicLink()) return { unverified: "the search root is a symbolic link or junction; links are not followed" };
    if (info.isFile()) return { ok: true };
    if (!info.isDirectory()) return { unverified: "the search root is not a regular file or directory" };

    const stack = [{ dir: target, depth: 0 }];
    let seen = 1;
    while (stack.length > 0) {
      const { dir, depth } = stack.pop();
      if (depth >= limits.maxSearchDepth) return { unverified: `the search root is deeper than ${limits.maxSearchDepth} levels` };
      let entries;
      try {
        entries = io.readdir(dir);
      } catch (error) {
        // Every failure denies: a directory we cannot list could hide a credential.
        return { unverified: `the search root cannot be listed (${error?.code ?? "error"})` };
      }
      if (!Array.isArray(entries)) return { unverified: "the search root listing was not an array" };
      for (const entry of entries) {
        if (++seen > limits.maxSearchEntries) {
          return { unverified: `the search root has more than ${limits.maxSearchEntries} entries` };
        }
        let name;
        let directory = false;
        let file = false;
        let link = false;
        try {
          name = entry.name;
          directory = entry.isDirectory();
          file = entry.isFile();
          link = entry.isSymbolicLink();
        } catch {
          return { unverified: "an entry of the search root could not be inspected" };
        }
        if (typeof name !== "string" || name.length === 0) {
          return { unverified: "an entry of the search root has no readable name" };
        }
        // Credential-like names are checked before the type, so a secret is reported as such.
        if (isSensitivePathName(name)) return { sensitive: path.join(dir, name) };
        // A link could point anywhere; rg may or may not follow it, so it is never provable.
        if (link) return { unverified: `the search root contains a symbolic link or junction ("${name}"); links are not followed` };
        if (!directory && !file) {
          return { unverified: `the search root contains an entry that is not a regular file or directory ("${name}")` };
        }
        if (directory) stack.push({ dir: path.join(dir, name), depth: depth + 1 });
      }
    }
    return { ok: true };
  };

  // ---------- decision engine ----------

  const evaluate = (exec) => {
    const agentId = readAgentId(exec);
    const worker = agentId ? activations.get(agentId) : undefined;
    if (!worker) return allow("not-worker", readToolName(exec) ?? undefined);

    const tool = readToolName(exec);
    if (!tool) return deny("tool-not-allowed", "the tool call has no name", null);
    if (!ALLOWED_TOOLS.includes(tool)) {
      return deny("tool-not-allowed", `tool "${tool}" is not permitted for a wiki worker (allowed: ${ALLOWED_TOOLS.join(", ")})`, tool);
    }

    const rootProblem = rootsUnchanged(worker);
    if (rootProblem) return deny("root-changed", `${rootProblem}; the job roots are immutable, refusing every call`, tool);

    // Authoritative effective working directory: never fallback to session.header.cwd.
    const cwdProblem = checkEffectiveCwd(tool, exec, worker);
    if (cwdProblem) return cwdProblem;

    const argsResult = readArguments(exec);
    if (argsResult.error) return deny("args-invalid", `the ${tool} tool cannot be authorized: ${argsResult.error}`, tool);
    const args = argsResult.value;

    // Strict per-tool own-key + type validation before any filesystem work.
    const argsProblem = validateToolArguments(tool, args);
    if (argsProblem) return deny("args-invalid", `the ${tool} tool cannot be authorized: ${argsProblem}`, tool);

    if (READ_TOOLS.has(tool)) {
      const filePath = readStringArgument(args, "file_path");
      if (filePath.error) return deny("args-invalid", `the read tool cannot be authorized: ${filePath.error}`, tool);
      const resolved = resolveTarget(worker, filePath.value, tool);
      if (resolved.deny) return resolved.deny;
      return allow("allowed", tool);
    }

    if (WRITE_TOOLS.has(tool)) {
      const filePath = readStringArgument(args, "file_path");
      if (filePath.error) return deny("args-invalid", `the ${tool} tool cannot be authorized: ${filePath.error}`, tool);
      // An empty old_string is malformed for `edit`: it would match everywhere.
      if (tool === "edit") {
        const oldString = readStringArgument(args, "old_string");
        if (oldString.error) return deny("args-invalid", `the edit tool cannot be authorized: ${oldString.error}`, tool);
        if (oldString.value.length === 0) return deny("args-invalid", "the edit tool cannot be authorized: the old_string argument must be non-empty", tool);
      }
      const resolved = resolveTarget(worker, filePath.value, tool);
      if (resolved.deny) return resolved.deny;
      const shapeProblem = checkWriteShape(worker, resolved, tool, filePath.value);
      if (shapeProblem) return shapeProblem;
      return allow("allowed", tool);
    }

    if (tool === "glob") {
      const pattern = readStringArgument(args, "pattern");
      if (pattern.error) return deny("args-invalid", `the glob tool cannot be authorized: ${pattern.error}`, tool);
      const patternProblem = checkGlobPattern(pattern.value);
      if (patternProblem) return deny("path-traversal", patternProblem, tool);
      let searchRoot = worker.cwd;
      if (Object.hasOwn(args, "path")) {
        const searchPath = readStringArgument(args, "path");
        if (searchPath.error) return deny("args-invalid", `the glob search path is invalid: ${searchPath.error}`, tool);
        const resolved = resolveTarget(worker, searchPath.value, tool);
        if (resolved.deny) return resolved.deny;
        searchRoot = resolved.real;
      }
      if (!isWithin(worker.repoReal, searchRoot) && !isWithin(worker.stagingReal, searchRoot)) {
        return deny("path-outside-roots", "the glob search root is outside the job roots", tool);
      }
      return allow("allowed", tool);
    }

    // grep: recursive content search. The search root must be inside the roots and provably free
    // of credential-like names before any file content can be surfaced through the tool.
    const pattern = readStringArgument(args, "pattern");
    if (pattern.error) return deny("args-invalid", `the grep tool cannot be authorized: ${pattern.error}`, tool);
    if (pattern.value.trim().length === 0) return deny("args-invalid", "the grep pattern is empty", tool);
    let searchRoot = worker.cwd;
    if (Object.hasOwn(args, "path")) {
      const searchPath = readStringArgument(args, "path");
      if (searchPath.error) return deny("args-invalid", `the grep search path is invalid: ${searchPath.error}`, tool);
      const resolved = resolveTarget(worker, searchPath.value, tool);
      if (resolved.deny) return resolved.deny;
      searchRoot = resolved.real;
    }
    if (!isWithin(worker.repoReal, searchRoot) && !isWithin(worker.stagingReal, searchRoot)) {
      return deny("path-outside-roots", "the grep search root is outside the job roots", tool);
    }
    // The include filter is a positive glob; validate it so it cannot name an absolute path,
    // ascend, or target credential material. It never narrows what the scan below must prove.
    if (Object.hasOwn(args, "include")) {
      const includeArg = readStringArgument(args, "include");
      if (includeArg.error) return deny("args-invalid", `the grep include filter is not allowed: ${includeArg.error}`, tool);
      const includeProblem = checkGlobPattern(includeArg.value);
      if (includeProblem) return deny("path-traversal", `the grep include filter is not allowed: ${includeProblem}`, tool);
    }
    const scan = scanSearchRoot(searchRoot);
    if (scan.sensitive) {
      return deny("search-root-sensitive", `the grep search root contains a credential-like path (${path.basename(scan.sensitive)}); narrow the search path to a directory without secrets`, tool);
    }
    if (scan.unverified) {
      return deny("search-root-unverified", `the grep search root could not be proven free of credential-like paths (${scan.unverified}); narrow the search path`, tool);
    }
    return allow("allowed", tool);
  };

  const safeEvaluate = (exec) => {
    try {
      return evaluate(exec);
    } catch (error) {
      // Fail closed for an active worker; never throw out of a guard.
      return deny("internal-error", `internal error while authorizing (${error?.code ?? "unexpected"}); failing closed`, readToolName(exec) ?? null);
    }
  };

  // ---------- public surface ----------

  /** Async public contract. Identical decision as the synchronous engine the guard must use. */
  const authorize = async (exec) => safeEvaluate(exec);

  /** Synchronous engine; exposed so tests can prove guard/authorize parity. */
  const authorizeSync = (exec) => safeEvaluate(exec);

  /**
   * Install the deny-only guard on a Host context. Verified against ToolsService.guard():
   * `guard(fn)` returns the effect disposer and fn must return `string | undefined`.
   *
   * Lifetime: the Host keeps the registration until this handle's `dispose()` runs, so the plugin
   * must hold the handle and dispose it before the owning context unloads. Disposal clears the
   * cached state (installState() then reports not installed) and a later install() registers a new
   * guard. A registration that does not return a disposer FUNCTION (undefined, an object, a
   * Promise) is reported pending instead of success, because such a guard could be active but
   * unremovable.
   *
   * @returns {{installed: boolean, integration: string, reason?: string, dispose?: () => boolean}}
   */
  const install = (ctx) => {
    if (installed) return installed;
    const pending = (reason) =>
      Object.freeze({ installed: false, integration: "pending", contract: TOOL_GUARD_CONTRACT, reason });
    const tools = ctx?.tools;
    if (!tools || typeof tools.guard !== "function") {
      // Report, don't cache: a later ctx with the real service must still be installable.
      return pending("this Host exposes no ctx.tools.guard(); the pure guard is complete and tested but runtime installation is pending");
    }

    const guard = (exec) => {
      let active = false;
      try {
        active = isActive(readAgentId(exec));
      } catch {
        active = false;
      }
      if (!active) return undefined; // other sessions keep their own policy
      const decision = safeEvaluate(exec);
      return decision.allow ? undefined : decision.reason;
    };

    let registered;
    try {
      registered = tools.guard(guard);
    } catch (error) {
      return pending(`ctx.tools.guard() refused registration (${error?.message ?? error}); runtime installation is pending`);
    }

    // The Host contract is "the exact disposer". Anything else cannot be reasoned about: an
    // undefined/object/Promise result may still leave the guard registered, so report pending.
    if (typeof registered !== "function") {
      return pending("ctx.tools.guard() did not return a disposer function (undefined, object or Promise); runtime installation is pending");
    }
    let registeredThenable = false;
    try {
      registeredThenable = isThenable(registered);
    } catch {
      registeredThenable = true;
    }
    if (registeredThenable) {
      return pending("ctx.tools.guard() returned a thenable instead of a disposer function; runtime installation is pending");
    }

    let disposed = false;
    const dispose = () => {
      if (disposed) return false;
      disposed = true;
      let clean = true;
      try {
        registered();
      } catch {
        // The registration may outlive this handle; the caller cannot do more than report it.
        clean = false;
      }
      // Clear the cached active state so installState() is truthful and a later install()
      // registers a new guard instead of returning this disposed one.
      if (installed && installed.dispose === dispose) installed = null;
      return clean;
    };
    installed = Object.freeze({
      installed: true,
      integration: "tools.guard",
      contract: TOOL_GUARD_CONTRACT,
      semantics: "synchronous, monotonic, deny-only; reason string denies the call",
      dispose,
    });
    return installed;
  };

  /** Truthful live installation state; cleared when the returned disposer runs. */
  const installState = () =>
    Object.freeze(
      installed ? { installed: true, integration: installed.integration } : { installed: false, integration: "none" },
    );

  const dispose = () => {
    if (installed?.dispose) installed.dispose();
    installed = null;
    activations.clear();
  };

  return Object.freeze({
    activate,
    release,
    releaseAll,
    isActive,
    activeAgentIds,
    authorize,
    authorizeSync,
    install,
    installState,
    dispose,
  });
}

// ---------- verified integration status ----------
//
// What was verified against the installed Host (2026-11-09):
//   * ctx.tools.guard exists and returns a disposer (ToolsService declaration above).
//   * ToolGuard is synchronous: it returns string | undefined, not a Promise. DSH docs are explicit
//     that guards are monotonic and run after `tools/pre-execute`; a guard cannot await.
//   * exec.agent.id is the calling Agent's SessionId, and exec.name/exec.arguments are the
//     canonical call identity, so an exact agent-id registry is enforceable.
//   * WorkingDirectoryService owns each session's effective directory:
//     `get(session: Session): string` is synchronous ("read the committed directory without
//     filesystem I/O"); `set(agent, path)` is what the model-visible `working_directory` tool
//     changes. Session.header.cwd is only the creation directory, so it is not authoritative and
//     is never consulted here.
// Consequence: async authorize() is the public contract, but the runtime guard path must be
// synchronous; both call the same `evaluate()`, so there is one policy and no drift.
//
// What is NOT done here: lib/index.js is outside this change's scope, so installWorkerGuard is not
// called by the plugin yet, and getEffectiveCwd is not wired to ctx.workingDirectory. The release
// gate in index.js still disables background jobs; wiring this guard is a prerequisite for
// reopening it, not a substitute for it.
//
// LIMITATIONS (do not oversell this module):
//   * TOCTOU: checks run before the tool body. A process with write access to a checked directory
//     (not this worker: it cannot run shell, and its write scope is pages/cards/*.md) could swap a
//     component between the check and the open. This is policy, not an OS sandbox; no kernel
//     boundary is claimed.
//   * Path spelling: absolute paths must use the job root as given; 8.3 short names and alias
//     junctions pointing at the same root are denied (fail-closed) rather than canonicalized.
//   * Recursive grep now proves the WHOLE reachable search tree: no node_modules/.dsh-wiki*/.git/
//     .svn/.hg exemption is assumed, because a positive include glob can still reach those trees.
//     Any symlink, unexpected dirent, inspection failure (including EACCES/EPERM/ENOTDIR/ENOENT) or
//     exceeded bound denies the call. Consequence: a large dependency tree needs an explicit
//     narrower `path`, and a repository with any symlink cannot be grepped as a whole.
//   * glob returns path names, not contents. It is pattern/root constrained and credential names
//     are refused in the pattern, but the names of unrelated credential-ish files elsewhere in the
//     tree are not filtered; only file *contents* are protected by the grep/read checks.
//   * read checks the name of the opened path; a hardlink with an innocuous name pointing at a
//     secret is not distinguishable by name (same class of gap as any name-based policy). This
//     remains unsolved and is not claimed as an OS sandbox.
//   * Only the exact activated agent id is confined. A child agent of a worker would have its own
//     id and would not be guarded; the worker cannot create one because delegation tools
//     (subagent/workflow) are denied, but a Host that spawns children by another route would need
//     its own activation.
//   * Effective cwd is authoritative only through the injected resolver. The guard never reads
//     session.header.cwd; a missing resolver is a construction error, and a resolver that is
//     missing, throws, returns a Promise/non-string/unresolvable path, or disagrees with the
//     activated job directory denies every call. The job creator must activate with the directory
//     the session's working-directory projection actually holds.
//   * `skill` is not allowed for a worker. Its instructions must be host-preseeded before a job
//     starts, project skills can shadow same-named skills, and the context loaders a skill pulls
//     in are not covered by this guard; preseeded instructions plus a context-loader confinement
//     decision are separate release prerequisites.
//   * Search-root scanning is bounded; exceeding a bound denies the call (fail-closed) rather than
//     allowing it, so very large roots need an explicit narrower path.
//   * Hardlinks are rejected only for an already-existing write target; a link created between
//     check and write is the same TOCTOU window as above.
//   * Install lifetime: the tools.guard registration lives until the returned disposer runs. Keep
//     that handle and call dispose() on context unload; a later install() registers a new guard.
//     If tools.guard() does not return a disposer FUNCTION the guard may be registered but
//     unremovable, so installation is reported pending rather than success.
//   * Windows: junctions are detected via lstat().isSymbolicLink(), verified on this machine.

