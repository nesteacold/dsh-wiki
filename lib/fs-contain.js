// dsh-wiki — dormant, injectable filesystem-containment primitives for the trusted publication
// journal (spec 007, T018/T020 follow-up).
//
// This module is deliberately not wired into lib/index.js or lib/jobs.js, does not enable/reload
// jobs, does not discover or recover transactions, and never deletes or cleans up anything. It owns
// exactly these primitives:
//
//   assertCanonicalDir(target, options?)       existing directory, canonical absolute, no links in
//                                              any existing ancestor (including the target)
//   identityOf(target, options?)               serializable dev/ino identity of an existing entry
//   verifySame(target, expected, options?)     identity re-check against a previously bound identity
//   scanTree(root, options?)                   bounded, fail-closed inventory of a directory tree
//   guardedRename(src, dest, options?)         identity/parent/absence checks immediately before ONE
//                                              rename; no overwrite, no recovery, no cleanup
//
// Threat model and contract
// -------------------------
// A repository is attacker-controlled content. It can contain symlinks, Windows junctions/reparse
// points, hardlinks, special files, and an attacker with local write access can swap a path
// component concurrently. Every primitive below:
//
//   * accepts only an absolute, drive-qualified (Windows) / absolute (POSIX) path with no
//     `.`/`..` segments; it rejects UNC and device paths, Windows alternate data streams, NUL,
//     control characters, overlong input, and (on Windows) reserved device names and segments
//     ending in a dot or space, then checks the lexical normalization against realpath;
//   * lstats every existing component from the filesystem root down to the target, including the
//     filesystem root itself and the final component, and rejects any `lstat().isSymbolicLink()`
//     (Node reports Windows junctions as symbolic links);
//   * requires `realpath(target)` to agree with the canonical lexical path (case-insensitively on
//     Windows, where Node's native realpath also supplies the on-disk casing), so 8.3 short-name
//     aliases and any surviving reparse-point escape are rejected rather than followed;
//   * compares Windows paths case-insensitively and path-segment aware, never by raw `startsWith`
//     on arbitrary text;
//   * binds identity as `{ dev, ino, kind, nlink }` where `dev`, `ino` and `nlink` are normalized
//     non-negative base-10 strings from bigint `lstat` values. The result is JSON-serializable on
//     every platform and never contains a bigint. `kind` is `"dir"`, `"file"` or `"other"`.
//     `nlink` is an informational point-in-time snapshot. `verifySame` pins dev/ino and kind only
//     and never treats a differing `nlink` as drift, because any writer can add a hardlink between
//     two checks. Publication and scanning must re-check hardlinks in the operation that acts:
//     `scanTree` rejects `nlink !== 1`, and `guardedRename` re-checks the source's link count
//     immediately before its one rename.
//
// `scanTree` additionally fails closed on every symlink/junction, every non-regular file, every
// hardlinked regular file (`nlink !== 1`), every entry whose realpath disagrees with its lexical
// path (8.3 aliases and non-junction reparse redirects), any `opendir`/`lstat`/`realpath` error,
// any rejection from the listing iterator or from the listing handle's `close()` — an injected
// iterator is not required to reject with an `Error`, so a rejection value of `undefined`, `null`,
// `false`, `0` or `""` is still a failure — and any exceeded bound (entries, depth, path length).
// Directories are enumerated as a stream and the scan stops at the first exceeded bound, so it
// reads at most `maxScanEntries + 1` names. It never reads file contents and never mutates the
// tree. A scan is a point-in-time snapshot, not a lock: an entry can change after it has been
// inspected.
//
// `guardedRename` accepts only an already-existing source and a not-yet-existing destination. There
// is intentionally no overwrite/replace option: destination existence is always rejected. It
// requires the caller to bind `expect.src`, `expect.srcParent` and `expect.destParent` identities
// beforehand (normally via `identityOf`/`assertCanonicalDir`), revalidates source identity, both
// parent identities and destination absence in the same operation, and then performs exactly one
// `rename(2)`. It never rolls back, never recovers a backup and never deletes a path.
//
// LIMITATIONS — do not oversell this module
// -----------------------------------------
//   * NOT atomic check/open: the last check and the actual `rename(2)` are separate syscalls. A
//     process with write access to a checked directory can swap a component in that window. Node
//     exposes no portable `renameat2`/`RENAME_NOREPLACE`, `openat`/`O_NOFOLLOW` or fd-relative
//     rename API, so the gap cannot be closed here. In particular a destination that appears after
//     the absence check can, depending on platform, be replaced by `rename`.
//   * NOT kernel isolation: this is a userspace, point-in-time policy layer. It provides no mount
//     namespace, no file-descriptor pinning, no capability boundary and no protection against a
//     privileged or concurrently-writing process. Callers must serialize writers themselves.
//   * `verifySame`/`identityOf` re-walk ancestors on every call, which narrows but never removes the
//     race. `identityOf` does not prove the *absence* of a path; use `assertCanonicalDir` for a
//     directory that must exist.
//   * Windows dev/ino values are what Node reports (volume serial + file index). They are not a
//     cryptographic identity and can change after a volume reformat or file-system restore.
//   * A path whose final component is a legitimate case variant is returned by realpath with the
//     on-disk casing; comparisons use case-insensitive path equality on Windows. On POSIX, casing
//     is significant.
//   * Windows extended-length/device forms (`\\?\...`, `\\.\...`) and UNC paths are rejected
//     outright, so a legitimate path longer than the legacy limit fails closed instead of being
//     opened through a device namespace.
//   * `guardedRename` rejects an existing regular-file source with more than one hardlink. A
//     directory's link count is not inspected (directories normally have several links).
//   * `scanTree` streams every directory through `opendir` instead of calling `readdir`, so a
//     hostile or very large listing is never materialized: enumeration stops at the first exceeded
//     bound and the handle is closed on every path. It still performs one realpath check per
//     accepted entry, so on a very large tree it pays one extra syscall per entry and aborts at the
//     first unprovable entry.
//   * `scanTree` is still a point-in-time walk: a directory can be modified after it was listed and
//     before its entries are inspected, and the handle carries no identity of its own. Serially
//     mutating writers must be excluded by the caller.
//   * `scanTree` has no wall-clock bound and deliberately does not add one. It awaits the listing
//     iterator and then the handle's `close()` to completion, so an injected `next()`, `return()` or
//     `close()` that never settles leaves the scan pending forever; if `async iterator.return()`
//     hangs, the explicit `close()` is never reached and the handle can stay open. A pending scan is
//     NOT an acceptance and NOT a refusal: callers must treat an unsettled scan as fail closed, keep
//     the publication fence raised, and must not publish, adopt or journal on it. A timeout here
//     would let a stalled handle force a retry while it is still live, which is why no timer is used.
//   * No file contents are hashed or validated here. The journal must bind its own content hashes
//     and transaction record separately.
//
// Injection
// ---------
// Every primitive takes `options.io` with optional `lstat`, `realpath`, `opendir` and `rename`
// overrides. Defaults use `node:fs/promises` with `lstat(..., { bigint: true })`, Node's native
// realpath for on-disk casing, and `opendir` for streaming enumeration. An injected `lstat` must
// return an object with `isSymbolicLink()`, `isDirectory()`, `isFile()` and `dev`/`ino`/`nlink`
// values (bigint, safe number or base-10 string). An injected `opendir` must return an
// async-iterable handle with a `close()` function; `scanTree` pulls one entry at a time and stops
// at the first exceeded bound. An injected iterator is not trusted to reject with an `Error`:
// rejecting `next()` with `undefined`, `null`, `false`, `0` or `""` (or `close()` with any of those)
// is a scan failure, never an empty or partial inventory. There is deliberately no array-returning
// listing seam: a complete `readdir` array is unbounded work that has to be paid before any entry
// limit applies, so `options.io.readdir` is rejected. Unknown options, limits and io keys are
// rejected rather than ignored.
//
// Error surface
// -------------
// All failures throw `FsContainError` with one of the stable `ERROR_CODES` values. No primitive
// returns a partial result and no primitive mutates the filesystem except the single successful
// `rename` inside `guardedRename`.

import { realpath as realpathCallback } from "node:fs";
import { lstat, opendir, rename } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const isWin = process.platform === "win32";

/** Stable public error codes. Do not rename; consumers branch on these values. */
export const ERROR_CODES = Object.freeze({
  INVALID_INPUT: "invalid-input",
  INVALID_OPTION: "invalid-option",
  INVALID_LIMIT: "invalid-limit",
  MALFORMED_PATH: "malformed-path",
  PATH_NOT_ABSOLUTE: "path-not-absolute",
  PATH_NOT_FOUND: "path-not-found",
  PATH_UNREADABLE: "path-unreadable",
  PATH_LINK: "path-link",
  ANCESTOR_LINK: "ancestor-link",
  ANCESTOR_NOT_DIRECTORY: "ancestor-not-directory",
  PATH_NOT_DIRECTORY: "path-not-directory",
  PATH_NOT_CANONICAL: "path-not-canonical",
  IDENTITY_INVALID: "identity-invalid",
  IDENTITY_MISMATCH: "identity-mismatch",
  KIND_MISMATCH: "kind-mismatch",
  SCAN_LINK: "scan-link",
  SCAN_NOT_CANONICAL: "scan-not-canonical",
  SCAN_NONREGULAR: "scan-nonregular",
  SCAN_HARDLINK: "scan-hardlink",
  SCAN_UNREADABLE: "scan-unreadable",
  SCAN_LIMIT: "scan-limit",
  RENAME_SAME_PATH: "rename-same-path",
  RENAME_SOURCE_ROOT: "rename-source-root",
  RENAME_DESTINATION_ROOT: "rename-destination-root",
  RENAME_DESTINATION_INSIDE_SOURCE: "rename-destination-inside-source",
  RENAME_DESTINATION_EXISTS: "rename-destination-exists",
  RENAME_DESTINATION_UNREADABLE: "rename-destination-unreadable",
  RENAME_SOURCE_NOT_REGULAR: "rename-source-not-regular",
  RENAME_SOURCE_HARDLINK: "rename-source-hardlink",
  RENAME_FAILED: "rename-failed",
});

/**
 * Hard bounds applied before filesystem work or scanning. Override per call via `options.limits`.
 * `maxScanDepth` counts components below the scanned root (root itself is depth 0);
 * `maxScanEntries` counts every file and directory entry.
 */
export const DEFAULT_LIMITS = Object.freeze({
  maxPathLength: 4096,
  maxScanEntries: 20000,
  maxScanDepth: 64,
});

/** Typed error for every refusal. `code` is one of ERROR_CODES. */
export class FsContainError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = "FsContainError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

const RESERVED_WIN_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$|clock\$)(\..*)?$/i;
const IDENTITY_KINDS = Object.freeze(["dir", "file", "other"]);
const MAX_DISPLAY = 160;

// Native realpath supplies the on-disk casing on Windows; fs.promises.realpath does not expose a
// native variant on current Node, so promisify the callback form.
const nativeRealpath = typeof realpathCallback.native === "function" ? realpathCallback.native : realpathCallback;
const realpath = promisify(nativeRealpath);

const DEFAULT_IO = Object.freeze({
  lstat: (target) => lstat(target, { bigint: true }),
  realpath: (target) => realpath(target),
  // Directory enumeration is streaming on purpose: a readdir() array is unbounded work that has to
  // be materialized before any entry limit can be applied.
  opendir: (target) => opendir(target),
  rename: (src, dest) => rename(src, dest),
});

const IO_FUNCTIONS = Object.freeze(["lstat", "realpath", "opendir", "rename"]);

// ---------- small helpers ----------

function fail(code, message, cause) {
  throw new FsContainError(code, message, cause);
}

function displayPath(value) {
  const text = String(value);
  return text.length > MAX_DISPLAY ? `${text.slice(0, MAX_DISPLAY - 3)}...` : text;
}

/**
 * Read `.code` from an arbitrary value. Rejection values are attacker-adjacent input: they are not
 * required to be Errors (they can be `undefined`, `null`, `false`, `0` or `""`) and an exotic object
 * can throw on property access, so no code is reported in those cases.
 */
function errorCodeOf(value) {
  try {
    const code = value?.code;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

/** Case/format-insensitive path equality for the host platform. */
function samePath(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const normalize = (value) => {
    const resolved = path.normalize(value);
    const root = path.parse(resolved).root;
    const trimmed = resolved.length > root.length ? resolved.replace(/[\\/]+$/, "") : resolved;
    return isWin ? trimmed.toLowerCase() : trimmed;
  };
  return normalize(a) === normalize(b);
}

/** True when `child` is `parent` or lives below it, using platform-aware comparison. */
function isWithin(parent, child) {
  if (typeof parent !== "string" || typeof child !== "string") return false;
  const separator = isWin ? "\\" : "/";
  const normalize = (value) => {
    const resolved = path.normalize(value);
    const root = path.parse(resolved).root;
    const trimmed = resolved.length > root.length ? resolved.replace(/[\\/]+$/, "") : resolved;
    return isWin ? trimmed.toLowerCase() : trimmed;
  };
  const left = normalize(parent);
  const right = normalize(child);
  if (left === right) return true;
  const prefix = left.endsWith(separator) ? left : left + separator;
  return right.startsWith(prefix);
}

function normalizeId(value, label) {
  if (typeof value === "bigint") {
    if (value < 0n) fail(ERROR_CODES.IDENTITY_INVALID, `${label} must not be negative`);
    return value.toString(10);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      fail(ERROR_CODES.IDENTITY_INVALID, `${label} must be a non-negative safe integer or bigint`);
    }
    return String(value);
  }
  if (typeof value === "string") {
    if (!/^(0|[1-9][0-9]*)$/.test(value)) {
      fail(ERROR_CODES.IDENTITY_INVALID, `${label} must be a normalized non-negative base-10 string`);
    }
    return value;
  }
  fail(ERROR_CODES.IDENTITY_INVALID, `${label} must be a bigint, safe integer or base-10 string`);
}

function statsKind(stats) {
  if (stats.isSymbolicLink()) return "link";
  if (stats.isDirectory()) return "dir";
  if (stats.isFile()) return "file";
  return "other";
}

function isStatsLike(stats) {
  return (
    stats !== null &&
    typeof stats === "object" &&
    typeof stats.isSymbolicLink === "function" &&
    typeof stats.isDirectory === "function" &&
    typeof stats.isFile === "function"
  );
}

function makeIdentity(stats) {
  return Object.freeze({
    dev: normalizeId(stats.dev, "dev"),
    ino: normalizeId(stats.ino, "ino"),
    kind: statsKind(stats),
    nlink: normalizeId(stats.nlink, "nlink"),
  });
}

// `nlink` is optional and informational. It is normalized so the identity stays serializable, but
// no primitive compares it: a caller must not read a passing `verifySame` as a hardlink guarantee.
function normalizeExpectedIdentity(expected, label) {
  if (expected === null || typeof expected !== "object" || Array.isArray(expected)) {
    fail(ERROR_CODES.IDENTITY_INVALID, `${label} must be an identity object`);
  }
  for (const key of ["dev", "ino", "kind"]) {
    if (!Object.hasOwn(expected, key)) fail(ERROR_CODES.IDENTITY_INVALID, `${label}.${key} is required`);
  }
  const dev = normalizeId(expected.dev, `${label}.dev`);
  const ino = normalizeId(expected.ino, `${label}.ino`);
  const kind = expected.kind;
  if (!IDENTITY_KINDS.includes(kind)) {
    fail(ERROR_CODES.IDENTITY_INVALID, `${label}.kind must be one of ${IDENTITY_KINDS.join(", ")}`);
  }
  const nlink = Object.hasOwn(expected, "nlink") ? normalizeId(expected.nlink, `${label}.nlink`) : undefined;
  return Object.freeze({ dev, ino, kind, ...(nlink === undefined ? {} : { nlink }) });
}

function assertIdentityMatches(actual, expected, label) {
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
    fail(
      ERROR_CODES.IDENTITY_MISMATCH,
      `${label} identity changed (expected dev/ino ${expected.dev}/${expected.ino}, found ${actual.dev}/${actual.ino})`,
    );
  }
  if (actual.kind !== expected.kind) {
    fail(
      ERROR_CODES.KIND_MISMATCH,
      `${label} kind changed (expected ${expected.kind}, found ${actual.kind})`,
    );
  }
  return actual;
}

function validateWindowsSegment(segment, label) {
  if (/[<>"|?*]/.test(segment)) {
    fail(ERROR_CODES.MALFORMED_PATH, `${label} contains a character Windows does not allow`);
  }
  if (segment.includes(":")) {
    fail(ERROR_CODES.MALFORMED_PATH, `${label} contains a Windows alternate-data-stream separator`);
  }
  if (/[. ]$/.test(segment)) {
    fail(ERROR_CODES.MALFORMED_PATH, `${label} contains a segment ending in a dot or space`);
  }
  if (RESERVED_WIN_NAMES.test(segment)) {
    fail(ERROR_CODES.MALFORMED_PATH, `${label} uses a reserved Windows device name`);
  }
}

/**
 * Validate the syntactic shape of a caller-supplied absolute path and return its lexical
 * normalization. This is deliberately stricter than path.resolve(): the caller must already have a
 * canonical, absolute, non-UNC/device path with no `.`/`..` segments and no Windows stream syntax.
 */
function canonicalAbsolute(raw, label, limits) {
  if (typeof raw !== "string") fail(ERROR_CODES.INVALID_INPUT, `${label} must be a string`);
  if (raw.length === 0) fail(ERROR_CODES.MALFORMED_PATH, `${label} is empty`);
  if (raw.length > limits.maxPathLength) {
    fail(ERROR_CODES.MALFORMED_PATH, `${label} is longer than ${limits.maxPathLength} characters`);
  }
  if (raw.includes("\u0000")) fail(ERROR_CODES.MALFORMED_PATH, `${label} contains a NUL byte`);
  if (/[\u0000-\u001f]/.test(raw)) fail(ERROR_CODES.MALFORMED_PATH, `${label} contains control characters`);
  if (!path.isAbsolute(raw)) fail(ERROR_CODES.PATH_NOT_ABSOLUTE, `${label} must be an absolute path`);

  if (isWin) {
    if (/^[\\/]{2}/.test(raw)) {
      fail(ERROR_CODES.MALFORMED_PATH, `${label} is a UNC, device or extended-length path`);
    }
    if (!/^[a-zA-Z]:[\\/]/.test(raw)) {
      fail(ERROR_CODES.PATH_NOT_ABSOLUTE, `${label} must be a drive-qualified absolute path`);
    }
  } else if (raw.startsWith("//")) {
    fail(ERROR_CODES.MALFORMED_PATH, `${label} is a UNC-like path`);
  }

  const rawSegments = raw.split(isWin ? /[\\/]+/ : /\/+/);
  for (const [index, segment] of rawSegments.entries()) {
    if (segment.length === 0) continue;
    if (segment === "." || segment === "..") {
      fail(ERROR_CODES.MALFORMED_PATH, `${label} contains a "${segment}" segment`);
    }
    if (!isWin) continue;
    // The first segment of a drive-qualified path is the drive prefix, not a stream syntax.
    if (index === 0 && /^[a-zA-Z]:$/.test(segment)) continue;
    validateWindowsSegment(segment, label);
  }

  let abs;
  try {
    abs = path.resolve(raw);
  } catch (error) {
    fail(ERROR_CODES.MALFORMED_PATH, `${label} cannot be resolved`, error);
  }
  const root = path.parse(abs).root;
  if (root.length === 0 || !path.isAbsolute(root)) {
    fail(ERROR_CODES.PATH_NOT_ABSOLUTE, `${label} has no absolute filesystem root`);
  }
  const relative = path.relative(root, abs);
  const segments = relative === "" ? [] : relative.split(path.sep);
  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === "..") {
      fail(ERROR_CODES.MALFORMED_PATH, `${label} is not in canonical lexical form`);
    }
    if (isWin) validateWindowsSegment(segment, label);
  }
  return { abs, root, segments };
}

async function lstatRequired(io, target, label, isFinal) {
  let stats;
  try {
    stats = await io.lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") {
      fail(ERROR_CODES.PATH_NOT_FOUND, `${label} does not exist: ${displayPath(target)}`, error);
    }
    if (error?.code === "ENOTDIR") {
      fail(
        isFinal ? ERROR_CODES.PATH_NOT_DIRECTORY : ERROR_CODES.ANCESTOR_NOT_DIRECTORY,
        `${label} crosses a non-directory component: ${displayPath(target)}`,
        error,
      );
    }
    fail(
      ERROR_CODES.PATH_UNREADABLE,
      `${label} cannot be inspected (${error?.code ?? "error"}): ${displayPath(target)}`,
      error,
    );
  }
  if (!isStatsLike(stats)) {
    fail(ERROR_CODES.PATH_UNREADABLE, `${label} lstat did not return filesystem stats: ${displayPath(target)}`);
  }
  return stats;
}

/**
 * Resolve one existing path to its canonical absolute form and identity, walking every component
 * from the filesystem root. `allowKinds` is the set of final kinds the caller accepts; links are
 * rejected before the kind is considered.
 */
async function canonicalEntry(raw, { io, limits, label, allowKinds }) {
  const { abs, root, segments } = canonicalAbsolute(raw, label, limits);
  let stats = await lstatRequired(io, root, label, false);
  if (stats.isSymbolicLink()) {
    fail(ERROR_CODES.PATH_LINK, `${label} filesystem root is a symlink or junction: ${displayPath(root)}`);
  }
  if (statsKind(stats) !== "dir") {
    fail(ERROR_CODES.PATH_NOT_DIRECTORY, `${label} filesystem root is not a directory: ${displayPath(root)}`);
  }

  let current = root;
  for (let index = 0; index < segments.length; index++) {
    const isFinal = index === segments.length - 1;
    current = path.join(current, segments[index]);
    stats = await lstatRequired(io, current, label, isFinal);
    if (stats.isSymbolicLink()) {
      fail(
        isFinal ? ERROR_CODES.PATH_LINK : ERROR_CODES.ANCESTOR_LINK,
        `${label} ${isFinal ? "is" : "crosses"} a symlink or junction: ${displayPath(current)}`,
      );
    }
    const kind = statsKind(stats);
    if (!isFinal) {
      if (kind !== "dir") {
        fail(
          ERROR_CODES.ANCESTOR_NOT_DIRECTORY,
          `${label} crosses a non-directory ancestor: ${displayPath(current)}`,
        );
      }
    } else if (!allowKinds.includes(kind)) {
      fail(
        allowKinds.length === 1 && allowKinds[0] === "dir"
          ? ERROR_CODES.PATH_NOT_DIRECTORY
          : ERROR_CODES.KIND_MISMATCH,
        `${label} has kind "${kind}", expected ${allowKinds.join(" or ")}: ${displayPath(current)}`,
      );
    }
  }

  if (segments.length === 0 && !allowKinds.includes("dir")) {
    fail(ERROR_CODES.PATH_NOT_DIRECTORY, `${label} filesystem root is not an accepted entry kind`);
  }

  let canonical;
  try {
    canonical = await io.realpath(abs);
  } catch (error) {
    if (error?.code === "ENOENT") {
      fail(ERROR_CODES.PATH_NOT_FOUND, `${label} disappeared before it could be resolved: ${displayPath(abs)}`, error);
    }
    fail(
      ERROR_CODES.PATH_UNREADABLE,
      `${label} cannot be resolved (${error?.code ?? "error"}): ${displayPath(abs)}`,
      error,
    );
  }
  if (typeof canonical !== "string" || !path.isAbsolute(canonical)) {
    fail(ERROR_CODES.PATH_UNREADABLE, `${label} realpath did not return an absolute path: ${displayPath(abs)}`);
  }
  if (!samePath(abs, canonical)) {
    fail(
      ERROR_CODES.PATH_NOT_CANONICAL,
      `${label} is not in canonical form: ${displayPath(abs)} resolves to ${displayPath(canonical)}`,
    );
  }
  return { path: path.resolve(canonical), identity: makeIdentity(stats) };
}

function resolveLimits(overrides) {
  if (overrides === undefined) return DEFAULT_LIMITS;
  if (overrides === null || typeof overrides !== "object" || Array.isArray(overrides)) {
    fail(ERROR_CODES.INVALID_LIMIT, "limits must be an object");
  }
  for (const key of Object.keys(overrides)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, key)) {
      fail(ERROR_CODES.INVALID_LIMIT, `unknown limit "${key}"`);
    }
  }
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1) {
      fail(ERROR_CODES.INVALID_LIMIT, `limit "${key}" must be a positive safe integer`);
    }
  }
  return Object.freeze(limits);
}

function resolveDeps(options, allowedKeys) {
  const resolvedOptions = options === undefined ? {} : options;
  if (resolvedOptions === null || typeof resolvedOptions !== "object" || Array.isArray(resolvedOptions)) {
    fail(ERROR_CODES.INVALID_OPTION, "options must be an object");
  }
  for (const key of Object.keys(resolvedOptions)) {
    if (!allowedKeys.includes(key)) fail(ERROR_CODES.INVALID_OPTION, `unknown option "${key}"`);
  }
  const override = resolvedOptions.io;
  if (override !== undefined && (override === null || typeof override !== "object" || Array.isArray(override))) {
    fail(ERROR_CODES.INVALID_OPTION, "options.io must be an object");
  }
  for (const key of Object.keys(override ?? {})) {
    if (key === "readdir") {
      fail(
        ERROR_CODES.INVALID_OPTION,
        'options.io.readdir is not supported: provide "opendir" returning a streaming directory handle',
      );
    }
    if (!IO_FUNCTIONS.includes(key)) {
      fail(ERROR_CODES.INVALID_OPTION, `unknown options.io function "${key}"`);
    }
  }
  const io = Object.freeze({ ...DEFAULT_IO, ...(override ?? {}) });
  for (const key of IO_FUNCTIONS) {
    if (typeof io[key] !== "function") fail(ERROR_CODES.INVALID_OPTION, `options.io.${key} must be a function`);
  }
  return { io, limits: resolveLimits(resolvedOptions.limits) };
}

function resolveRenameExpectation(expect) {
  if (expect === null || typeof expect !== "object" || Array.isArray(expect)) {
    fail(ERROR_CODES.INVALID_OPTION, "guardedRename requires expect { src, srcParent, destParent }");
  }
  for (const key of Object.keys(expect)) {
    if (!["src", "srcParent", "destParent"].includes(key)) {
      fail(ERROR_CODES.INVALID_OPTION, `unknown expect key "${key}"`);
    }
  }
  for (const key of ["src", "srcParent", "destParent"]) {
    if (!Object.hasOwn(expect, key)) fail(ERROR_CODES.INVALID_OPTION, `expect.${key} is required`);
  }
  return Object.freeze({
    src: normalizeExpectedIdentity(expect.src, "expect.src"),
    srcParent: normalizeExpectedIdentity(expect.srcParent, "expect.srcParent"),
    destParent: normalizeExpectedIdentity(expect.destParent, "expect.destParent"),
  });
}

function isEntryName(name) {
  if (typeof name !== "string" || name.length === 0) return false;
  if (name === "." || name === "..") return false;
  if (/[\u0000-\u001f]/.test(name)) return false;
  return !(isWin ? /[\\/]/.test(name) : name.includes("/"));
}

/** A listing handle must be streamable and explicitly closeable; arrays are rejected upstream. */
function isDirectoryHandle(handle) {
  if (handle === null || typeof handle !== "object") return false;
  try {
    return typeof handle[Symbol.asyncIterator] === "function" && typeof handle.close === "function";
  } catch {
    // An exotic injection that throws on property access is not a usable streaming handle.
    return false;
  }
}

/**
 * Close a listing handle and ignore every failure. Used only on fail-closed paths, where the
 * refusal is the outcome that matters and a close error must not mask it.
 */
async function closeHandleQuietly(handle) {
  try {
    if (handle !== null && typeof handle === "object" && typeof handle.close === "function") {
      await handle.close();
    }
  } catch {
    // Already failing closed: the primary refusal is reported by the caller.
  }
}

function entryNameOf(entry) {
  let name = null;
  if (typeof entry === "string") name = entry;
  else if (entry !== null && typeof entry === "object" && typeof entry.name === "string") name = entry.name;
  return isEntryName(name) ? name : null;
}

/**
 * Stream one directory through `io.opendir` and hand each validated entry name to `onName` as it is
 * read. The caller bounds the work: `onName` throws as soon as a limit is exceeded, which stops the
 * enumeration immediately instead of materializing a full listing first. The handle is closed on
 * every path (exhaustion, refusal, iterator error, close error) and close errors are surfaced when
 * they are the only failure.
 *
 * Failure is tracked with an explicit flag, never with a sentinel value: an injected iterator or
 * handle may reject with ANY value, including `undefined`, `null`, `false`, `0` or `""`. Treating
 * `undefined` as "no error" would accept an empty inventory for an iterator whose `next()` (or
 * `close()`) rejected with `undefined`. The arbitrary rejection value is carried through and is
 * normalized to `SCAN_UNREADABLE` unless the primary failure is already an `FsContainError` (a
 * refusal such as `SCAN_LIMIT`), which is rethrown unchanged so a close failure cannot mask it.
 *
 * There is no wall-clock bound here: the iterator and the explicit `close()` are awaited to
 * completion. A `next()`/`return()`/`close()` that never settles leaves the scan pending (and a
 * hanging `async iterator.return()` means the explicit `close()` is never reached), which is fail
 * closed, not an acceptance — see LIMITATIONS in the module header. No timeout is applied.
 */
async function forEachEntryName(io, directoryPath, onName) {
  let handle;
  try {
    handle = await io.opendir(directoryPath);
  } catch (error) {
    fail(
      ERROR_CODES.SCAN_UNREADABLE,
      `scan cannot list ${displayPath(directoryPath)} (${errorCodeOf(error) ?? "error"})`,
      error,
    );
  }
  if (!isDirectoryHandle(handle)) {
    // A malformed handle is refused, but a close() it does expose is still called so a partial
    // handle cannot leak a descriptor.
    await closeHandleQuietly(handle);
    fail(
      ERROR_CODES.SCAN_UNREADABLE,
      `scan io.opendir did not return a streaming directory handle with close() for ${displayPath(directoryPath)}`,
    );
  }

  let failed = false;
  let reason;
  try {
    for await (const entry of handle) {
      const name = entryNameOf(entry);
      if (name === null) {
        fail(
          ERROR_CODES.SCAN_UNREADABLE,
          `scan listing has an invalid entry under ${displayPath(directoryPath)}`,
        );
      }
      await onName(name);
    }
  } catch (error) {
    // `error` may be any rejection value, including undefined; the flag is what records failure.
    failed = true;
    reason = error;
  }
  try {
    await handle.close();
  } catch (error) {
    // Node's Dir closes itself when its iterator is fully consumed and then rejects close() with
    // ERR_DIR_CLOSED; a fully consumed listing is not a leak. Any other close error is surfaced
    // only when nothing else already failed.
    if (!failed && errorCodeOf(error) !== "ERR_DIR_CLOSED") {
      failed = true;
      reason = error;
    }
  }
  if (!failed) return;
  if (reason instanceof FsContainError) throw reason;
  fail(
    ERROR_CODES.SCAN_UNREADABLE,
    `scan cannot list ${displayPath(directoryPath)} (${errorCodeOf(reason) ?? "error"})`,
    reason,
  );
}

function relativeEntryPath(root, absolute) {
  const relative = path.relative(root, absolute);
  if (
    relative === "" ||
    relative === "." ||
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  ) {
    fail(ERROR_CODES.SCAN_UNREADABLE, `scan entry escaped its root: ${displayPath(absolute)}`);
  }
  return relative.split(path.sep).join("/");
}

function freezeEntry(relative, kind, identity) {
  return Object.freeze({ path: relative, kind, identity });
}

// ---------- public primitives ----------

/**
 * Assert that `target` is an existing directory whose canonical absolute path can be trusted.
 *
 * Every existing component, including the filesystem root and the target itself, is lstatted and
 * must not be a symlink/junction. `realpath` must agree with the lexical path (case-insensitively
 * on Windows), so aliases and reparse-point escapes fail closed.
 *
 * @param {string} target absolute, canonical-looking directory path
 * @param {{io?: object, limits?: object}} [options]
 * @returns {Promise<{path: string, root: string, identity: {dev: string, ino: string, kind: string, nlink: string}}>}
 * @throws {FsContainError}
 */
export async function assertCanonicalDir(target, options = {}) {
  const { io, limits } = resolveDeps(options, ["io", "limits"]);
  const entry = await canonicalEntry(target, { io, limits, label: "directory", allowKinds: ["dir"] });
  return Object.freeze({
    path: entry.path,
    root: path.parse(entry.path).root,
    identity: entry.identity,
  });
}

/**
 * Return the serializable identity of one existing entry (directory, regular file or other
 * non-link). The path is canonicalized and every ancestor is checked for links/symlinks first.
 *
 * @param {string} target absolute path
 * @param {{io?: object, limits?: object}} [options]
 * @returns {Promise<{dev: string, ino: string, kind: "dir"|"file"|"other", nlink: string}>}
 * @throws {FsContainError}
 */
export async function identityOf(target, options = {}) {
  const { io, limits } = resolveDeps(options, ["io", "limits"]);
  const entry = await canonicalEntry(target, {
    io,
    limits,
    label: "target",
    allowKinds: ["dir", "file", "other"],
  });
  return entry.identity;
}

/**
 * Verify that `target` still has the expected dev/ino identity and kind. The path is canonicalized
 * and all ancestors are rechecked for links before the identity comparison.
 *
 * `expected.nlink` is accepted but informational: it is normalized into the returned identity and
 * never compared, because any writer can add a hardlink at any time. Callers that must exclude
 * hardlinks re-check `nlink` in the operation that acts, as `scanTree` and `guardedRename` do.
 *
 * @param {string} target absolute path
 * @param {{dev: string|number|bigint, ino: string|number|bigint, kind: string, nlink?: string|number|bigint}} expected
 * @param {{io?: object, limits?: object}} [options]
 * @returns {Promise<{dev: string, ino: string, kind: "dir"|"file"|"other", nlink: string}>}
 * @throws {FsContainError}
 */
export async function verifySame(target, expected, options = {}) {
  const { io, limits } = resolveDeps(options, ["io", "limits"]);
  const want = normalizeExpectedIdentity(expected, "expected identity");
  const entry = await canonicalEntry(target, {
    io,
    limits,
    label: "target",
    allowKinds: ["dir", "file", "other"],
  });
  assertIdentityMatches(entry.identity, want, "target");
  return entry.identity;
}

/**
 * Produce a bounded, deterministic, fail-closed inventory of `root`.
 *
 * Directory listings are streamed with `io.opendir` and each entry is vetted before the next name
 * is pulled, so an exceeded entry bound stops the enumeration (at most `maxScanEntries + 1` names
 * are read) instead of materializing the listing. Only the accepted entries are sorted by their
 * `/`-separated relative path, so the returned array is deterministic while memory and syscall work
 * stay bounded by the limits. Directories are included. Every symlink or junction, every
 * non-regular entry, every hardlinked regular file, every entry whose realpath disagrees with its
 * lexical path, every read/lstat/realpath error and every exceeded bound aborts the whole scan (no
 * partial result). `maxScanDepth` counts path components below the root (root itself is depth 0).
 * File contents are never read and the tree is never modified.
 *
 * @param {string} root absolute canonical directory path
 * @param {{io?: object, limits?: {maxPathLength?: number, maxScanEntries?: number, maxScanDepth?: number}}} [options]
 * @returns {Promise<{
 *   root: string,
 *   rootIdentity: {dev: string, ino: string, kind: string, nlink: string},
 *   entries: ReadonlyArray<{path: string, kind: "dir"|"file", identity: {dev: string, ino: string, kind: string, nlink: string}}>,
 *   fileCount: number,
 *   dirCount: number,
 *   entryCount: number
 * }>}
 * @throws {FsContainError}
 */
export async function scanTree(root, options = {}) {
  const { io, limits } = resolveDeps(options, ["io", "limits"]);
  const rootEntry = await canonicalEntry(root, {
    io,
    limits,
    label: "scan root",
    allowKinds: ["dir"],
  });

  const entries = [];
  let fileCount = 0;
  let dirCount = 0;
  let entryCount = 0;
  const stack = [{ absolute: rootEntry.path, depth: 0 }];

  while (stack.length > 0) {
    const directory = stack.pop();
    // Each yielded name is consumed and fully vetted before the next one is pulled, so an exceeded
    // bound aborts the enumeration instead of first collecting the whole listing.
    await forEachEntryName(io, directory.absolute, async (name) => {
      entryCount += 1;
      if (entryCount > limits.maxScanEntries) {
        fail(ERROR_CODES.SCAN_LIMIT, `scan exceeds ${limits.maxScanEntries} entries`);
      }
      const depth = directory.depth + 1;
      if (depth > limits.maxScanDepth) {
        fail(ERROR_CODES.SCAN_LIMIT, `scan exceeds depth ${limits.maxScanDepth}`);
      }
      const absolute = path.join(directory.absolute, name);
      if (absolute.length > limits.maxPathLength) {
        fail(ERROR_CODES.SCAN_LIMIT, `scan entry path exceeds ${limits.maxPathLength} characters`);
      }
      let stats;
      try {
        stats = await io.lstat(absolute);
      } catch (error) {
        fail(
          ERROR_CODES.SCAN_UNREADABLE,
          `scan cannot inspect ${displayPath(absolute)} (${error?.code ?? "error"})`,
          error,
        );
      }
      if (!isStatsLike(stats)) {
        fail(ERROR_CODES.SCAN_UNREADABLE, `scan lstat did not return filesystem stats: ${displayPath(absolute)}`);
      }
      if (stats.isSymbolicLink()) {
        fail(ERROR_CODES.SCAN_LINK, `scan found a symlink or junction: ${displayPath(absolute)}`);
      }
      let canonical;
      try {
        canonical = await io.realpath(absolute);
      } catch (error) {
        fail(
          ERROR_CODES.SCAN_UNREADABLE,
          `scan cannot resolve ${displayPath(absolute)} (${error?.code ?? "error"})`,
          error,
        );
      }
      if (typeof canonical !== "string" || !path.isAbsolute(canonical) || !samePath(absolute, canonical)) {
        fail(
          ERROR_CODES.SCAN_NOT_CANONICAL,
          `scan entry resolves through a link or alias: ${displayPath(absolute)} -> ${displayPath(canonical)}`,
        );
      }
      const kind = statsKind(stats);
      if (kind === "dir") {
        const identity = makeIdentity(stats);
        entries.push(freezeEntry(relativeEntryPath(rootEntry.path, absolute), "dir", identity));
        dirCount += 1;
        stack.push({ absolute, depth });
      } else if (kind === "file") {
        const identity = makeIdentity(stats);
        if (identity.nlink !== "1") {
          fail(
            ERROR_CODES.SCAN_HARDLINK,
            `scan found a regular file with ${identity.nlink} links: ${displayPath(absolute)}`,
          );
        }
        entries.push(freezeEntry(relativeEntryPath(rootEntry.path, absolute), "file", identity));
        fileCount += 1;
      } else {
        fail(ERROR_CODES.SCAN_NONREGULAR, `scan found a non-regular entry: ${displayPath(absolute)}`);
      }
    });
  }

  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return Object.freeze({
    root: rootEntry.path,
    rootIdentity: rootEntry.identity,
    entries: Object.freeze(entries),
    fileCount,
    dirCount,
    entryCount,
  });
}

/**
 * Verify the bound source identity, both parent identities and destination absence, then perform
 * exactly one `rename(2)`. The destination must not exist; there is no overwrite contract.
 *
 * Order immediately before the operation: source identity (with all ancestors rechecked), source
 * parent identity, destination parent identity, destination absence, one rename. This is not an
 * atomic check-and-rename; see LIMITATIONS in the module header.
 *
 * @param {string} src absolute, existing source path
 * @param {string} dest absolute, not-yet-existing destination path
 * @param {{
 *   expect: {
 *     src: {dev: string|number|bigint, ino: string|number|bigint, kind: string, nlink?: string|number|bigint},
 *     srcParent: {dev: string|number|bigint, ino: string|number|bigint, kind: string, nlink?: string|number|bigint},
 *     destParent: {dev: string|number|bigint, ino: string|number|bigint, kind: string, nlink?: string|number|bigint}
 *   },
 *   io?: object,
 *   limits?: object
 * }} options
 * @returns {Promise<{
 *   src: string,
 *   dest: string,
 *   srcIdentity: {dev: string, ino: string, kind: string, nlink: string},
 *   srcParentIdentity: {dev: string, ino: string, kind: string, nlink: string},
 *   destParentIdentity: {dev: string, ino: string, kind: string, nlink: string}
 * }>}
 * @throws {FsContainError}
 */
export async function guardedRename(src, dest, options = {}) {
  const { io, limits } = resolveDeps(options, ["io", "limits", "expect"]);
  const expect = resolveRenameExpectation(options.expect);
  if (expect.src.kind !== "dir" && expect.src.kind !== "file") {
    fail(ERROR_CODES.RENAME_SOURCE_NOT_REGULAR, "rename source must be a directory or regular file");
  }

  const source = canonicalAbsolute(src, "rename source", limits);
  const destination = canonicalAbsolute(dest, "rename destination", limits);
  const sourceRoot = path.parse(source.abs).root;
  const destinationRoot = path.parse(destination.abs).root;

  if (samePath(source.abs, sourceRoot)) {
    fail(ERROR_CODES.RENAME_SOURCE_ROOT, "rename source must not be a filesystem root");
  }
  if (samePath(destination.abs, destinationRoot)) {
    fail(ERROR_CODES.RENAME_DESTINATION_ROOT, "rename destination must not be a filesystem root");
  }
  if (samePath(source.abs, destination.abs)) {
    fail(ERROR_CODES.RENAME_SAME_PATH, "rename source and destination are the same path");
  }
  if (isWithin(source.abs, destination.abs)) {
    fail(ERROR_CODES.RENAME_DESTINATION_INSIDE_SOURCE, "rename destination is inside the source subtree");
  }

  const sourceName = path.basename(source.abs);
  const destinationName = path.basename(destination.abs);
  if (sourceName.length === 0 || destinationName.length === 0) {
    fail(ERROR_CODES.MALFORMED_PATH, "rename source and destination must have a final name");
  }

  // Initial canonicalization of both parents: rejects a link anywhere in either ancestry.
  const sourceParent = await canonicalEntry(path.dirname(source.abs), {
    io,
    limits,
    label: "source parent",
    allowKinds: ["dir"],
  });
  const destinationParent = await canonicalEntry(path.dirname(destination.abs), {
    io,
    limits,
    label: "destination parent",
    allowKinds: ["dir"],
  });

  const initialSource = path.join(sourceParent.path, sourceName);
  const initialDestination = path.join(destinationParent.path, destinationName);
  if (samePath(initialSource, initialDestination)) {
    fail(ERROR_CODES.RENAME_SAME_PATH, "rename source and destination are the same path");
  }
  if (isWithin(initialSource, initialDestination)) {
    fail(ERROR_CODES.RENAME_DESTINATION_INSIDE_SOURCE, "rename destination is inside the source subtree");
  }

  // Immediate revalidation, in order: source identity (all ancestors rechecked), source parent
  // identity, destination parent identity, destination absence.
  const sourceEntry = await canonicalEntry(initialSource, {
    io,
    limits,
    label: "rename source",
    allowKinds: ["dir", "file", "other"],
  });
  const actualSource = assertIdentityMatches(sourceEntry.identity, expect.src, "rename source");
  if (actualSource.kind === "file" && actualSource.nlink !== "1") {
    fail(
      ERROR_CODES.RENAME_SOURCE_HARDLINK,
      `rename source is a regular file with ${actualSource.nlink} links`,
    );
  }

  const finalSourceParent = await canonicalEntry(sourceParent.path, {
    io,
    limits,
    label: "source parent",
    allowKinds: ["dir"],
  });
  assertIdentityMatches(finalSourceParent.identity, expect.srcParent, "source parent");

  const finalDestinationParent = await canonicalEntry(destinationParent.path, {
    io,
    limits,
    label: "destination parent",
    allowKinds: ["dir"],
  });
  assertIdentityMatches(finalDestinationParent.identity, expect.destParent, "destination parent");

  const sourcePath = path.join(finalSourceParent.path, path.basename(sourceEntry.path));
  const destinationPath = path.join(finalDestinationParent.path, destinationName);
  if (samePath(sourcePath, destinationPath)) {
    fail(ERROR_CODES.RENAME_SAME_PATH, "rename source and destination are the same path");
  }
  if (isWithin(sourcePath, destinationPath)) {
    fail(ERROR_CODES.RENAME_DESTINATION_INSIDE_SOURCE, "rename destination is inside the source subtree");
  }

  let destinationExists = false;
  try {
    await io.lstat(destinationPath);
    destinationExists = true;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      fail(
        ERROR_CODES.RENAME_DESTINATION_UNREADABLE,
        `rename destination cannot be inspected (${error?.code ?? "error"}): ${displayPath(destinationPath)}`,
        error,
      );
    }
  }
  if (destinationExists) {
    fail(
      ERROR_CODES.RENAME_DESTINATION_EXISTS,
      `rename destination already exists: ${displayPath(destinationPath)}`,
    );
  }

  try {
    await io.rename(sourcePath, destinationPath);
  } catch (error) {
    fail(
      ERROR_CODES.RENAME_FAILED,
      `rename failed (${error?.code ?? "error"}): ${displayPath(sourcePath)} -> ${displayPath(destinationPath)}`,
      error,
    );
  }

  return Object.freeze({
    src: sourcePath,
    dest: destinationPath,
    srcIdentity: actualSource,
    srcParentIdentity: finalSourceParent.identity,
    destParentIdentity: finalDestinationParent.identity,
  });
}
