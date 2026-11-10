// dsh-wiki — dormant, injectable TRUSTED JOURNAL STORE for the publication transaction
// (spec 007, T018 follow-up).
//
// READ THIS FIRST — what this module is and is not
// -----------------------------------------------
// This module persists the version-1 transaction record that `lib/journal.js` validates and plans
// for, and it persists it OUTSIDE the repository (outside every allowlisted root, therefore outside
// worker-writable staging). It is deliberately:
//
//   * DORMANT. It is not imported by `lib/index.js`, `lib/jobs.js` or any Cordis composition row, it
//     writes no DSH profile/config, and it enables, reloads or schedules nothing. Nothing in the
//     running plugin can reach it until a later task wires it in behind the still-uncleared T018-T020
//     gates.
//   * PERSISTENCE ONLY. It never renames, deletes or publishes a wiki directory, never restores a
//     backup, never runs a recovery plan and never decides that a transaction finished. The only
//     filesystem mutations it performs are (a) one `mkdir`/`rmdir` pair for its own per-root lock
//     directory, (b) one temporary record file, and (c) one `rename` of that temporary file onto its
//     own journal path. `replaceTerminal` is not a cleanup: see CLEANUP IS NOT PROVEN below.
//   * NOT AN AUTHENTICITY LAYER. A record is trusted only because a trusted caller supplied the
//     existing canonical store directory, supplied the allowlist of repository roots, and because the
//     store files live outside them. There is no signature, no MAC, no key, no per-user isolation and
//     no protection against another process running as the same user. Filesystem identity
//     (dev/ino/kind) is an anti-swap check against a cooperating-but-sloppy or accidental adversary,
//     not a cryptographic guarantee.
//
// Public API (the only exports that matter operationally)
// -----------------------------------------------------
//
//   openJournalStore({ storeDir, allowedRoots, hostInstanceId?, io?, limits? })
//       -> Promise<frozen Store>
//
//     storeDir       REQUIRED. An EXISTING directory. It is canonicalized with
//                    `fs-contain.assertCanonicalDir` (canonical absolute path, on-disk casing from
//                    `realpath`, and no symlink/junction in ANY existing ancestor including itself)
//                    and its identity is bound. Every later operation re-verifies that identity.
//     allowedRoots   REQUIRED, non-empty, at most 64 entries. Each must be an existing canonical
//                    directory with no linked ancestor. These are the SAME canonical roots the
//                    trusted caller would pass to `validateJournal`, and every record read or written
//                    is validated against exactly this external allowlist.
//     hostInstanceId Optional host-instance token. When supplied, every record this store writes must
//                    be pinned to it (see HOST PIN).
//     io, limits     Optional injection and bounds (see INJECTION and LIMITS).
//
//   store.load(root)                            -> Promise<snapshot | null>
//   store.create(record)                        -> Promise<{ snapshot, lock }>
//   store.advance(previousSnapshot, nextRecord) -> Promise<{ snapshot, lock }>
//   store.replaceTerminal(previousSnapshot, newRecord)
//                                               -> Promise<{ snapshot, lock, replacement }>
//
// `root` and every record's `rootReal` must be one of `allowedRoots`. A store refuses to open at all
// when the store directory and an allowlisted root overlap in either direction (see OVERLAP).
//
// Snapshot
// --------
// A snapshot is a FROZEN object
//
//     { record, sha256, fileIdentity: { dev, ino }, durability }
//
// where `record` is the object `validateJournal` returned (so it is branded for `planRecovery`),
// `sha256` is the SHA-256 of the exact bytes on disk, `fileIdentity` is the dev/ino of the file those
// bytes were read from (base-10 strings), and `durability` is `"directory-synced"`, `"file-flushed"`
// or `"unverified"` (the last one only for a record loaded from disk, whose original write the store
// did not observe).
//
// Every snapshot is branded in a module-private, PER-STORE WeakSet. `advance` and `replaceTerminal`
// accept ONLY a snapshot this store instance produced; a structurally identical clone, a spread copy,
// a JSON round trip, a snapshot from another store (or from a store opened on the same directory
// later) and any object a hostile caller built are refused with `snapshot-not-owned`. This is
// compare-and-swap provenance: the brand proves "this store read or wrote exactly these bytes", which
// is what makes a lost-update check meaningful. Re-acquire authority by calling `load(root)` again.
//
// File layout — fixed name, NO enumeration
// ----------------------------------------
// One record file per allowlisted root:
//
//     <storeDir>/<sha256(root canonical, lowercased on Windows)>.journal.json
//     <storeDir>/<same hash>.lock                 (transient, per-root mutex directory)
//     <storeDir>/<same hash>.tmp-<16 random hex> (transient, one per write attempt)
//
// The name is derived ONLY from the root, so the store never lists a directory, never scans for
// files, never matches a prefix or an mtime and never picks "the newest" anything. A name-adjacent
// file that this derivation did not produce is invisible to the store: it is never read, adopted or
// deleted, and its presence changes no decision. Because the root is part of the name, a record
// cannot be silently served for a different repository even when both are allowlisted: `load` also
// re-checks the record's own `rootReal` binding (`root-not-requested`).
//
// READ PROTOCOL (every load and every CAS read)
// --------------------------------------------
//   1. `identityOf(journalPath)` — canonical realpath agreement plus a symlink/junction check on
//      every ancestor and on the file itself. Missing file => `null`, which is NOT an empty record
//      and confers NO authority: a missing journal can never be advanced.
//   2. Bounded read on an OPEN HANDLE, never `readFile`: the handle is `stat`ed (must be a regular
//      file with `nlink === 1`, and its dev/ino must equal the path identity from step 1), then at
//      most `maxRecordBytes + 1` bytes are read into a pre-sized buffer. The extra byte is the growth
//      detector: if the file grew after the size was taken, exactly the extra byte is readable and the
//      record is refused as unstable. Nothing is ever read that the bound did not already allow.
//   3. The path is re-`identityOf`ed and must still have the same dev/ino, kind and `nlink === 1`, so
//      a swap between the open and the read is refused instead of silently accepted.
//   4. Bytes must be strict UTF-8 that round-trips byte for byte (a leading BOM is refused), and the
//      text must be EXACTLY `JSON.stringify(validateJournal(JSON.parse(text), { allowedRoots }))`.
//      That single comparison rejects whitespace, key reordering, duplicate keys, unknown keys,
//      missing keys, trailing newlines, `\u` escapes and a BOM, while the validator applies the
//      caller's external allowlist.
//   5. The record must bind the requested root (`rootReal`), and its `rootIdentity` dev/ino/kind must
//      match the directory that is at that path right now.
//
// WRITE PROTOCOL (create, advance, replaceTerminal)
// ------------------------------------------------
// All writes for one root are serialized in-process by a per-root promise queue and, across processes,
// by an exclusive `mkdir` lock directory — the only atomic create-if-absent primitive portable Node
// exposes. The store NEVER breaks a lock: no mtime heuristic, no PID probe, no discovery, no automatic
// removal. A lock directory that exists (from a crashed writer, or planted by anyone with write access
// to the store) makes every later write for that root fail with `store-locked` until an operator has
// confirmed no writer is active and removed it by hand.
//
// Inside the lock:
//   1. `create` re-checks that the journal file is absent; `advance`/`replaceTerminal` compare the
//      on-disk SHA-256 AND dev/ino against the supplied snapshot (CAS) and refuse with
//      `stale-snapshot` when they differ. A stale snapshot never writes anything.
//   2. The next record is validated with the external allowlist, then the immutable fields, the host
//      pin, the phase step and the carryover rules are checked (see PHASE STEPS / CARRYOVER).
//   3. A temporary file `<hash>.tmp-<16 hex>` is created with the exclusive `wx` flag (so an existing
//      file is never truncated), written, `fsync`ed and closed.
//   4. Exactly ONE `rename(temp, journalPath)` — no retry, no loop, no fallback copy.
//   5. The store directory is `fsync`ed BEST EFFORT. Codes that mean "this platform/filesystem cannot
//      sync a directory handle" (`EPERM`, `EACCES`, `EISDIR`, `EINVAL`, `ENOSYS`, `ENOTSUP`,
//      `EOPNOTSUPP`, `EBADF` — Windows returns `EPERM`) are recognized and reported as
//      `durability: "file-flushed"` instead of `"directory-synced"`. Any other failure is a real
//      post-rename fault.
//   6. The record is read back with the full read protocol and must have exactly the SHA-256 that was
//      written and exactly the dev/ino of the temporary file that was renamed. A mismatch is a
//      post-rename fault (someone replaced the file, or the filesystem did something unexpected).
//
// Post-rename faults (steps 5-6, and a lock that cannot be released after the commit) are reported as
// `commit-uncertain` / `lock-release-unverified` with `committed: true` and a message that says the
// state is UNCERTAIN. This module NEVER claims the previous record is unchanged once the rename has
// happened: it does not know, and pretending otherwise is exactly the bug that makes a crash-time
// recovery rename the wrong directory.
//
// Phase steps (a closed table; terminals have no successor)
// --------------------------------------------------------
//     created        -> worker-running | aborted
//     worker-running -> worker-stopped | aborted
//     worker-stopped -> validated      | aborted
//     validated      -> live-moved     | aborted
//     live-moved     -> published      | rolled-back
//     published      -> (terminal)
//     rolled-back    -> (terminal)
//     aborted        -> (terminal)
//
// `create` writes the FIRST record and requires phase `created`; every later phase goes through
// `advance`. `replaceTerminal` is the only way to start a new transaction afterwards: it requires a
// TERMINAL previous snapshot and a new record in phase `created` with a DIFFERENT `jobId`.
//
// CARRYOVER (what a phase step may and may not claim)
// --------------------------------------------------
// A record describes the two renames of the publication (live -> backup, staging -> live), so a phase
// step that invents, drops or reshuffles a bound identity would make the stored description a lie and
// would let `planRecovery` rename the wrong directory. `advance` therefore enforces:
//
//     worker-running   live and backup unchanged; a staging identity appears
//     worker-stopped   staging, live and backup unchanged
//     validated        staging, live and backup unchanged
//     aborted          live and backup unchanged; staging is retained or dropped, never substituted
//     live-moved       staging unchanged, live recorded ABSENT, backup becomes the previously live id
//     published        staging recorded ABSENT, live becomes the staged candidate, backup unchanged
//     rolled-back      staging unchanged, live becomes the previous backup id, backup becomes ABSENT
//     replaceTerminal  the new `created` record binds the live identity the terminal record left
//                      behind (or `null`), and the same root identity
//
// Identity comparison uses dev/ino/kind only: a directory's `nlink` changes whenever a subdirectory is
// created or removed — including inside the root and inside the staging directory — so treating
// `nlink` as part of the identity would refuse honest phase steps. `journal.js` makes the same choice.
//
// The store cannot verify that a claimed carryover matches reality (it never inspects the staging,
// live or backup directories). It only refuses a step that contradicts the record's own history.
// Whether the claimed snapshot is TRUE on disk is the executor's re-verification job.
//
// HOST PIN
// --------
// When `openJournalStore` was given a `hostInstanceId`, every record it writes must be pinned to that
// instance, and `advance` additionally requires the next record to keep the previous record's host
// pin (an immutable field). A restarted Host therefore cannot adopt and advance an older instance's
// transaction through this store; that path belongs to the still-unproven trusted executor. This is
// fail closed on purpose: nothing here can prove a worker of an older instance is stopped.
//
// CLEANUP IS NOT PROVEN
// ---------------------
// `replaceTerminal` rewrites one record file. It does NOT remove, and cannot verify anything about,
// the replaced transaction's bound artifacts: its staging directory, its `.bak-` directory or its
// backup. The returned `replacement` says so explicitly (`cleanupProven: false` plus the retained
// paths), and the caller must plan the old transaction's cleanup from the retained branded record
// (`planRecovery`) — it is irreversible that the replaced record is no longer readable from the store.
//
// LOCK AND TEMPORARY FILE CLEANUP
// -------------------------------
// The store removes a lock directory or temporary file ONLY when it can prove ownership by identity:
// the entry it `lstat`s must have exactly the dev/ino it observed when it created the entry. Anything
// else — a replaced lock, a substituted temp file, an unreadable entry, a vanished one — is RETAINED
// and reported (`retained-ambiguous`, `lock-release-unverified`), never deleted by name and never
// "repaired" by looking at timestamps or process ids.
//
// LIMITS
// ------
//   maxRecordBytes   Refuse a record file (and a record about to be written) larger than this.
//   maxPathLength    Forwarded to `fs-contain` for its own path checks.
//
// LIMITATIONS — do not oversell this module
// -----------------------------------------
//   * Process-crash visibility only. The ONE thing this store buys is the ordinary rename guarantee:
//     a concurrent or later reader sees either the complete previous record or the complete next one,
//     never a mixture — PROVIDED the filesystem is stable and every writer cooperates by using this
//     store (or at least by not fighting it). It does NOT promise power-loss durability: with
//     `durability: "file-flushed"` (always the case on Windows today) the rename itself may not have
//     reached the volume, and a power cut can lose the new record, the rename, or both. Directory
//     `fsync` is attempted best effort and its unsupported result is reported, not hidden.
//   * NOT atomic no-replace. `rename(2)`/`MoveFileEx` replaces an existing destination. `create`
//     checks absence and then renames; a writer that ignores the lock can slip in between, and the
//     last rename wins. There is no `RENAME_NOREPLACE` in portable Node, so an "only if absent" commit
//     cannot be expressed. The mkdir lock is the practical guard and it is advisory, not a capability.
//   * NO OS isolation and no confinement. This is a userspace, cooperative layer. It has no mount
//     namespace, no file-descriptor pinning, no ACL and no defence against a privileged writer or one
//     running as the same user. Two processes that both ignore the lock can corrupt each other's CAS.
//   * NOT liveness. This module never observes a worker, never decides a worker is dead, never breaks
//     a stale lock, and never resolves an interrupted transaction. Every automatic-decision gate stays
//     where it already was: `planRecovery` (and the still-unimplemented executor behind it).
//   * Point-in-time checks. Every identity check is a snapshot separated from the operation it
//     guards; a component can be swapped in between. Ancestor identity is re-walked before each
//     operation, which narrows but cannot remove the race.
//   * Not a sandbox against the store directory's owner. Whoever can write the store can replace its
//     files. The read protocol detects a swap that happens during a read, and the write protocol
//     detects one that happens during a write; a swap that lands between two operations is only
//     caught by the SHA-256 + dev/ino CAS, and only if the caller still holds an older snapshot.
//   * `allowedRoots` is trust the caller supplies. This module proves the roots exist, are canonical,
//     are link-free and do not overlap the store; it cannot prove the caller chose the right roots.
//   * No recovery, no executor, no journal-driven rename. T018 remains open, and the independent
//     review, the trusted executor and the worker-liveness proof are all still missing.
//
// INJECTION
// ---------
// `options.io` may override any of: `lstat` (bigint stats), `realpath`, `open` (returns a handle with
// `stat({ bigint: true })`, `read`, `write`, `sync`, `close`), `mkdir` (non-recursive, so an existing
// entry throws `EEXIST`), `rmdir`, `unlink`, `rename`. There is deliberately no listing seam: the
// store never enumerates, so `readdir`/`opendir` are rejected as unknown keys. Unknown options, io
// keys and limit keys are refused rather than ignored.
//
// Error surface
// -------------
// Everything throws `JournalStoreError` with one of the stable `ERROR_CODES` values. Errors that are
// raised AFTER the record rename carry `committed: true` and explain that the committed state is
// uncertain; a lock-release failure after a commit also carries the committed `snapshot`. Errors
// raised while a lock was held carry `lockRelease`.

import { createHash, randomBytes } from "node:crypto";
import { realpath as realpathCallback } from "node:fs";
import { lstat, mkdir, open, rename, rmdir, unlink } from "node:fs/promises";
import path from "node:path";

import { ERROR_CODES as FS_ERROR_CODES, FsContainError, assertCanonicalDir, identityOf } from "./fs-contain.js";
import { JournalError, validateJournal } from "./journal.js";

const isWin = process.platform === "win32";

/** Stable public error codes. Do not rename; consumers branch on these values. */
export const ERROR_CODES = Object.freeze({
  INVALID_OPTIONS: "invalid-options",
  INVALID_IO: "invalid-io",
  INVALID_LIMIT: "invalid-limit",
  INVALID_SNAPSHOT: "invalid-snapshot",
  SNAPSHOT_NOT_OWNED: "snapshot-not-owned",
  SNAPSHOT_INCONSISTENT: "snapshot-inconsistent",
  STORE_UNTRUSTED: "store-untrusted",
  STORE_OVERLAP_ROOT: "store-overlap-root",
  STORE_IDENTITY_CHANGED: "store-identity-changed",
  STORE_LOCKED: "store-locked",
  LOCK_RELEASE_UNVERIFIED: "lock-release-unverified",
  ROOT_NOT_ALLOWED: "root-not-allowed",
  ROOT_UNREADABLE: "root-unreadable",
  ROOT_IDENTITY_MISMATCH: "root-identity-mismatch",
  ROOT_NOT_REQUESTED: "root-not-requested",
  RECORD_MISSING: "record-missing",
  RECORD_EXISTS: "record-exists",
  RECORD_INVALID: "record-invalid",
  RECORD_TOO_LARGE: "record-too-large",
  RECORD_UNREADABLE: "record-unreadable",
  RECORD_UNSTABLE: "record-unstable",
  RECORD_NOT_UTF8: "record-not-utf8",
  RECORD_NOT_CANONICAL: "record-not-canonical",
  STALE_SNAPSHOT: "stale-snapshot",
  INVALID_TRANSITION: "invalid-transition",
  INVALID_CARRYOVER: "invalid-carryover",
  HOST_PIN_MISMATCH: "host-pin-mismatch",
  IMMUTABLE_FIELD_CHANGED: "immutable-field-changed",
  WRITE_FAILED: "write-failed",
  COMMIT_UNCERTAIN: "commit-uncertain",
});

/** The phase steps a stored record may take. Terminals have no successor. */
export const PHASE_STEPS = Object.freeze({
  created: Object.freeze(["worker-running", "aborted"]),
  "worker-running": Object.freeze(["worker-stopped", "aborted"]),
  "worker-stopped": Object.freeze(["validated", "aborted"]),
  validated: Object.freeze(["live-moved", "aborted"]),
  "live-moved": Object.freeze(["published", "rolled-back"]),
  published: Object.freeze([]),
  "rolled-back": Object.freeze([]),
  aborted: Object.freeze([]),
});

/** Phases no record may advance out of. */
export const TERMINAL_PHASES = Object.freeze(["published", "rolled-back", "aborted"]);

/**
 * Hard bounds applied before any record is decoded or written. Override per store via
 * `options.limits`; unknown keys are refused.
 */
export const DEFAULT_LIMITS = Object.freeze({
  maxRecordBytes: 64 * 1024,
  maxPathLength: 4096,
});

/** Typed error for every refusal. `code` is one of ERROR_CODES. */
const genuineErrors = new WeakSet();

export class JournalStoreError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    genuineErrors.add(this);
    this.name = "JournalStoreError";
    this.code = code;
    // Tri-state: true => the journal rename already happened and a LATER step failed, so the
    // committed state is uncertain; false => nothing was committed and a previously existing record
    // (if any) is untouched; undefined => not applicable (e.g. a pure validation refusal).
    if (options.committed !== undefined) this.committed = options.committed;
    if (options.snapshot !== undefined) this.snapshot = options.snapshot;
    // `cause` is kept whenever the caller supplied the key, so a falsy or undefined rejection reason is preserved.
    if (Object.hasOwn(options, "cause")) this.cause = options.cause;
    if (options.detail !== undefined) this.detail = Object.freeze({ ...options.detail });
  }
}

// ---------- constants ----------

const JOURNAL_SUFFIX = ".journal.json";
const LOCK_SUFFIX = ".lock";
const TEMP_MARKER = ".tmp-";
const MAX_ALLOWED_ROOTS = 64;
const MAX_TOKEN_LENGTH = 256;
const MIN_TOKEN_LENGTH = 8;
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_DISPLAY = 160;
const SHORT_FIELD = 64;

/**
 * Codes that mean "this platform or filesystem cannot sync a directory handle". Windows returns
 * `EPERM` for `fsync` on a directory handle that it happily opened, so a directory sync that fails
 * this way is reported as `file-flushed` rather than as a post-rename fault.
 */
const UNSUPPORTED_DIRECTORY_SYNC = Object.freeze([
  "EPERM",
  "EACCES",
  "EISDIR",
  "EINVAL",
  "ENOSYS",
  "ENOTSUP",
  "EOPNOTSUPP",
  "EBADF",
]);

/** Fields bound at `create` that no phase step may change (compared as text). */
const IMMUTABLE_TEXT_FIELDS = Object.freeze(["jobId", "hostInstanceId", "workerSessionId", "protocolSha256", "promptSha256"]);

/** Fields bound at `create` that no phase step may change (compared as platform paths). */
const IMMUTABLE_PATH_FIELDS = Object.freeze(["rootReal", "stagePath", "livePath", "backupPath"]);

const IO_FUNCTIONS = Object.freeze(["lstat", "realpath", "open", "mkdir", "rmdir", "unlink", "rename"]);

const nativeRealpath = typeof realpathCallback.native === "function" ? realpathCallback.native : realpathCallback;

/** Native realpath supplies the on-disk casing on Windows; promisified by hand to avoid node:util. */
function realpath(target) {
  return new Promise((resolve, reject) => {
    nativeRealpath(target, (error, resolved) => {
      if (error) reject(error);
      else resolve(resolved);
    });
  });
}

const DEFAULT_IO = Object.freeze({
  lstat: (target) => lstat(target, { bigint: true }),
  realpath: (target) => realpath(target),
  open: (target, flags, mode) => open(target, flags, mode),
  mkdir: (target) => mkdir(target),
  rmdir: (target) => rmdir(target),
  unlink: (target) => unlink(target),
  rename: (src, dest) => rename(src, dest),
});

/** Marker for "no cause" (a real cause may legitimately be undefined). */
const NO_CAUSE = Symbol("no-cause");

const MISSING_RECORD = Object.freeze({ status: "missing" });

// ---------- small helpers ----------

function fail(code, message, options) {
  throw new JournalStoreError(code, message, options);
}

/** Read `.code` from an arbitrary value without running caller code. */
function codeOf(value) {
  try {
    const code = value?.code;
    // Only a short identifier-shaped code is ever echoed; anything else (free text, secrets) is dropped.
    return typeof code === "string" && /^[A-Za-z0-9_]{1,32}$/.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

/** A validator code is a short kebab-case identifier; anything else is dropped. */
function journalCodeOf(error) {
  const code = safeRead(error, "code");
  return typeof code === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(code) ? code : undefined;
}

/** True only for a genuine JournalStoreError; never runs caller code that throws. */
function isStoreError(value) {
  // Provenance brand, not `instanceof`: a Proxy can lie about its prototype and must never be mutated.
  try {
    return value !== null && typeof value === "object" && genuineErrors.has(value);
  } catch {
    return false;
  }
}

/** Best-effort attach of a field to a store error; a frozen/sealed/hostile error is reported as false. */
function tryAttach(target, name, value) {
  try {
    target[name] = value;
    return target[name] === value;
  } catch {
    return false;
  }
}

function safeRead(target, name) {
  try {
    return target[name];
  } catch {
    return undefined;
  }
}

function isCode(value, code) {
  return codeOf(value) === code;
}

function display(value) {
  const text = String(value);
  return text.length > MAX_DISPLAY ? `${text.slice(0, MAX_DISPLAY - 3)}...` : text;
}

function short(value) {
  if (typeof value !== "string") return display(value);
  return value.length > SHORT_FIELD ? `${value.slice(0, SHORT_FIELD)}...` : value;
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Case/format-insensitive path equality for the host platform. A local copy: `fs-contain` does not
 * export it, and importing a helper it never published would be a hidden API dependency.
 */
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

/** True when `child` is `parent` or lives below it, path-segment aware. Local copy as above. */
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

function isStatsLike(stats) {
  // A hostile io result may be a Proxy or carry throwing getters: that is "not stats", never an escape.
  try {
    return (
      stats !== null &&
      typeof stats === "object" &&
      typeof stats.isSymbolicLink === "function" &&
      typeof stats.isDirectory === "function" &&
      typeof stats.isFile === "function"
    );
  } catch {
    return false;
  }
}

/** `instanceof` that cannot throw (a Proxy getPrototypeOf trap or revoked proxy is simply "no"). */
function isInstance(value, constructor) {
  try {
    return value instanceof constructor;
  } catch {
    return false;
  }
}

/**
 * Split a canonical identity JSON string into its comparable parts. `journal.js` already validated
 * the exact shape, and `nlink` is deliberately dropped: a directory's link count changes whenever a
 * subdirectory appears, so it can never be part of an identity comparison.
 */
function identityParts(raw) {
  if (typeof raw !== "string") fail(ERROR_CODES.RECORD_INVALID, "an identity binding must be a canonical JSON string");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(ERROR_CODES.RECORD_INVALID, "an identity binding is not valid JSON", { cause: error });
  }
  if (parsed === null || typeof parsed !== "object") {
    fail(ERROR_CODES.RECORD_INVALID, "an identity binding is not a JSON object");
  }
  return { dev: String(parsed.dev), ino: String(parsed.ino), kind: String(parsed.kind) };
}

/** Identity comparison that ignores `nlink` and treats `null` as a positive "absent". */
function sameBoundIdentity(a, b) {
  if (a === null || b === null) return a === b;
  const left = identityParts(a);
  const right = identityParts(b);
  return left.dev === right.dev && left.ino === right.ino && left.kind === right.kind;
}

/** The one name derivation this module ever uses. Nothing is discovered, nothing is listed. */
function journalKeyFrom(canonicalRoot) {
  return sha256Hex(Buffer.from(isWin ? canonicalRoot.toLowerCase() : canonicalRoot, "utf8"));
}

/**
 * The journal file name for a canonical root path. Exported for callers that must reason about the
 * layout; it performs NO filesystem work and grants NO authority (a file with this name is still
 * validated, bound and CAS-checked before it is believed).
 */
export function journalFileName(canonicalRoot) {
  if (typeof canonicalRoot !== "string" || canonicalRoot.length === 0) {
    fail(ERROR_CODES.INVALID_OPTIONS, "journalFileName requires a canonical root path string");
  }
  return `${journalKeyFrom(canonicalRoot)}${JOURNAL_SUFFIX}`;
}

const containOptionsCache = new WeakMap();

/** The `fs-contain` option shape for one io/limits pair: identity checks only, no enumeration. */
function containOptions(io, limits) {
  let cached = containOptionsCache.get(io);
  if (cached === undefined || cached.maxPathLength !== limits.maxPathLength) {
    cached = Object.freeze({
      io: Object.freeze({ lstat: io.lstat, realpath: io.realpath }),
      limits: Object.freeze({ maxPathLength: limits.maxPathLength }),
      maxPathLength: limits.maxPathLength,
    });
    containOptionsCache.set(io, cached);
  }
  return { io: cached.io, limits: cached.limits };
}

/** Normalize a `fs-contain` refusal into this module's error surface. */
function containFailure(error, code, label, target) {
  const fsCode = isInstance(error, FsContainError) ? safeRead(error, "code") : codeOf(error);
  return new JournalStoreError(
    code,
    `${label} ${JSON.stringify(display(target))} cannot be trusted (${fsCode ?? "error"}): every path this store touches is checked for symlink/junction ancestors, canonical realpath agreement and hard links before it is used`,
    { cause: error, detail: { fsCode } },
  );
}

/** A failure that happened AFTER the record rename: the committed state is unknown, and we say so. */
function commitUncertain(message, ...rest) {
  // `cause` is attached only when the caller passed one, so an `undefined` rejection reason is still
  // preserved (key present) while "no cause" stays absent.
  const [cause, detail] = rest;
  return new JournalStoreError(
    ERROR_CODES.COMMIT_UNCERTAIN,
    `the new journal record was already renamed onto the journal path, and then ${message}. ` +
      "The committed state is UNCERTAIN: the new record may or may not be visible to a later reader, and this store does NOT claim the previous record is still in place. " +
      "Re-read the record with load(root), treat it as ambiguous, and do not repeat the phase step until the record on disk has been inspected.",
    { committed: true, ...(rest.length > 0 && cause !== NO_CAUSE ? { cause } : {}), detail },
  );
}

function isUnsupportedDirectorySync(error) {
  const code = codeOf(error);
  return code !== undefined && UNSUPPORTED_DIRECTORY_SYNC.includes(code);
}

// ---------- option resolution ----------

/**
 * Capture ONE own property as plain data, without running caller code. Only an own DATA property is
 * accepted: an accessor (getter) is refused as invalid rather than invoked, and a reflective trap that
 * throws (Proxy `ownKeys`/`getOwnPropertyDescriptor`/`getPrototypeOf`, revoked proxy, even
 * `throw undefined`) is turned into a typed refusal. NOTE: a malicious Proxy can still run its own trap
 * code during these reflective calls; this module cannot prevent that, it only guarantees the failure
 * is typed and that no accessor is invoked.
 */
function ownDataProperty(object, key, code, label) {
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(object, key);
  } catch (error) {
    fail(code, `${label} cannot be inspected`, { cause: error });
  }
  if (descriptor === undefined) return { present: false, value: undefined };
  if (!Object.hasOwn(descriptor, "value")) fail(code, `${label} must be a plain data property, not an accessor`);
  return { present: true, value: descriptor.value };
}

/** Own enumerable string keys of an options-like object, with reflective failures typed. */
function ownKeysOf(object, code, label) {
  try {
    return Object.keys(object);
  } catch (error) {
    fail(code, `${label} cannot be inspected`, { cause: error });
  }
}

function isPlainObjectLike(value, code, label) {
  if (value === null || typeof value !== "object") return false;
  try {
    return !Array.isArray(value);
  } catch (error) {
    fail(code, `${label} cannot be inspected`, { cause: error });
  }
}

function resolveLimits(overrides) {
  if (overrides === undefined) return DEFAULT_LIMITS;
  if (!isPlainObjectLike(overrides, ERROR_CODES.INVALID_LIMIT, "limits")) fail(ERROR_CODES.INVALID_LIMIT, "limits must be an object");
  const limits = { ...DEFAULT_LIMITS };
  for (const key of ownKeysOf(overrides, ERROR_CODES.INVALID_LIMIT, "limits")) {
    if (!Object.hasOwn(DEFAULT_LIMITS, key)) fail(ERROR_CODES.INVALID_LIMIT, `unknown limit "${key}"`);
    limits[key] = ownDataProperty(overrides, key, ERROR_CODES.INVALID_LIMIT, `limit "${key}"`).value;
  }
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1) {
      fail(ERROR_CODES.INVALID_LIMIT, `limit "${key}" must be a positive safe integer`);
    }
  }
  return Object.freeze(limits);
}

function resolveIo(override) {
  if (override === undefined) return DEFAULT_IO;
  if (!isPlainObjectLike(override, ERROR_CODES.INVALID_IO, "options.io")) fail(ERROR_CODES.INVALID_IO, "options.io must be an object");
  const io = { ...DEFAULT_IO };
  for (const key of ownKeysOf(override, ERROR_CODES.INVALID_IO, "options.io")) {
    if (!IO_FUNCTIONS.includes(key)) {
      fail(
        ERROR_CODES.INVALID_IO,
        `unknown options.io function "${key}": this store never enumerates a directory, so there is deliberately no listing seam`,
      );
    }
    io[key] = ownDataProperty(override, key, ERROR_CODES.INVALID_IO, `options.io.${key}`).value;
  }
  for (const key of IO_FUNCTIONS) {
    if (typeof io[key] !== "function") fail(ERROR_CODES.INVALID_IO, `options.io.${key} must be a function`);
  }
  return Object.freeze(io);
}

function readToken(raw, label) {
  if (typeof raw !== "string") fail(ERROR_CODES.INVALID_OPTIONS, `${label} must be a string`);
  if (raw.length < MIN_TOKEN_LENGTH || raw.length > MAX_TOKEN_LENGTH) {
    fail(ERROR_CODES.INVALID_OPTIONS, `${label} must be ${MIN_TOKEN_LENGTH}-${MAX_TOKEN_LENGTH} characters`);
  }
  if (!TOKEN_RE.test(raw) || raw.includes("..") || raw.endsWith(".")) {
    fail(ERROR_CODES.INVALID_OPTIONS, `${label} must be ASCII letters, digits, ".", "_" or "-" (no "..", no trailing ".")`);
  }
  return raw;
}

function readOptions(options) {
  if (!isPlainObjectLike(options, ERROR_CODES.INVALID_OPTIONS, "openJournalStore options")) {
    fail(ERROR_CODES.INVALID_OPTIONS, "openJournalStore options must be an object");
  }
  const keys = ownKeysOf(options, ERROR_CODES.INVALID_OPTIONS, "openJournalStore options");
  const allowedKeys = ["storeDir", "allowedRoots", "hostInstanceId", "io", "limits"];
  for (const key of keys) {
    if (!allowedKeys.includes(key)) fail(ERROR_CODES.INVALID_OPTIONS, `unknown option "${key}"`);
  }
  // Each option is read ONCE, as an own data property; a getter is never invoked.
  const capture = (key) => ownDataProperty(options, key, ERROR_CODES.INVALID_OPTIONS, `option "${key}"`);

  const storeDirOption = capture("storeDir");
  if (!storeDirOption.present) {
    fail(
      ERROR_CODES.INVALID_OPTIONS,
      "storeDir is required: the trusted caller must supply the existing canonical directory that holds journal records, and it must live outside every allowlisted repository root",
    );
  }
  const storeDir = storeDirOption.value;
  if (typeof storeDir !== "string" || storeDir.length === 0) {
    fail(ERROR_CODES.INVALID_OPTIONS, "storeDir must be a non-empty absolute path string");
  }

  const rootsOption = capture("allowedRoots");
  if (!rootsOption.present) {
    fail(
      ERROR_CODES.INVALID_OPTIONS,
      "allowedRoots is required: the trusted caller must supply the canonical repository roots a record may bind (no discovery, no defaults)",
    );
  }
  const rawRoots = rootsOption.value;
  let rootsIsArray;
  try {
    rootsIsArray = Array.isArray(rawRoots);
  } catch (error) {
    fail(ERROR_CODES.INVALID_OPTIONS, "allowedRoots cannot be inspected", { cause: error });
  }
  if (!rootsIsArray) fail(ERROR_CODES.INVALID_OPTIONS, "allowedRoots must be an array of canonical directory paths");
  const lengthOption = ownDataProperty(rawRoots, "length", ERROR_CODES.INVALID_OPTIONS, "allowedRoots.length");
  const rootCount = lengthOption.value;
  if (!Number.isSafeInteger(rootCount) || rootCount < 0) fail(ERROR_CODES.INVALID_OPTIONS, "allowedRoots has an invalid length");
  if (rootCount === 0) fail(ERROR_CODES.INVALID_OPTIONS, "allowedRoots must not be empty");
  if (rootCount > MAX_ALLOWED_ROOTS) {
    fail(ERROR_CODES.INVALID_OPTIONS, `allowedRoots must not have more than ${MAX_ALLOWED_ROOTS} entries`);
  }
  const allowedRoots = [];
  for (let index = 0; index < rootCount; index += 1) {
    const entry = ownDataProperty(rawRoots, String(index), ERROR_CODES.INVALID_OPTIONS, `allowedRoots[${index}]`);
    const value = entry.value;
    if (!entry.present || typeof value !== "string" || value.length === 0) {
      fail(ERROR_CODES.INVALID_OPTIONS, `allowedRoots[${index}] must be a non-empty absolute path string`);
    }
    allowedRoots.push(value);
  }

  const hostOption = capture("hostInstanceId");
  const hostInstanceId = hostOption.present ? readToken(hostOption.value, "hostInstanceId") : null;
  const ioOption = capture("io");
  const limitsOption = capture("limits");

  return {
    storeDir,
    allowedRoots,
    hostInstanceId,
    io: resolveIo(ioOption.value),
    limits: resolveLimits(limitsOption.value),
  };
}
// ---------- read protocol ----------

/**
 * Read at most `maxRecordBytes + 1` bytes from an open handle. The extra byte is the growth detector:
 * a file that grew after its size was taken makes exactly one more byte readable, and the record is
 * refused as unstable. No `readFile`, so no unbounded allocation after a size race.
 */
async function readBoundedBytes(handle, limits, sizeBig) {
  if (typeof sizeBig !== "bigint") {
    fail(ERROR_CODES.RECORD_UNREADABLE, "the journal handle did not report a bigint size");
  }
  if (sizeBig < 0n) fail(ERROR_CODES.RECORD_UNREADABLE, "the journal file reports a negative size");
  if (sizeBig > BigInt(limits.maxRecordBytes)) {
    fail(
      ERROR_CODES.RECORD_TOO_LARGE,
      `the journal file is ${sizeBig} bytes, above the ${limits.maxRecordBytes}-byte limit; it is refused without being read, so an oversized or attacker-grown file can never be decoded`,
    );
  }
  const size = Number(sizeBig);
  const buffer = Buffer.allocUnsafe(size + 1);
  let filled = 0;
  while (filled < buffer.length) {
    let bytesRead;
    try {
      bytesRead = safeRead(await handle.read(buffer, filled, buffer.length - filled, filled), "bytesRead");
    } catch (error) {
      fail(ERROR_CODES.RECORD_UNREADABLE, `the journal file cannot be read (${codeOf(error) ?? "error"})`, { cause: error });
    }
    if (!Number.isSafeInteger(bytesRead) || bytesRead < 0) {
      fail(ERROR_CODES.RECORD_UNREADABLE, "the journal read returned an invalid byte count");
    }
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  if (filled > size) {
    fail(
      ERROR_CODES.RECORD_UNSTABLE,
      `the journal file grew from ${size} bytes while it was being read; the store never decodes a record whose extent it cannot bound`,
    );
  }
  if (filled !== size) {
    fail(ERROR_CODES.RECORD_UNSTABLE, `the journal file shrank from ${size} to ${filled} bytes while it was being read`);
  }
  return buffer.subarray(0, filled);
}

/** Strict UTF-8 that must round-trip byte for byte; a leading BOM is refused as non-canonical. */
function decodeRecordBytes(bytes) {
  let text;
  try {
    // `ignoreBOM: true` keeps a leading BOM as U+FEFF so the canonicality check below reports it
    // instead of the decoder silently stripping it.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    fail(ERROR_CODES.RECORD_NOT_UTF8, "the journal file is not valid UTF-8", { cause: error });
  }
  const reencoded = Buffer.from(text, "utf8");
  if (reencoded.length !== bytes.length || !reencoded.equals(bytes)) {
    fail(ERROR_CODES.RECORD_NOT_UTF8, "the journal file is not round-trip UTF-8");
  }
  if (text.charCodeAt(0) === 0xfeff) {
    fail(ERROR_CODES.RECORD_NOT_CANONICAL, "the journal file starts with a byte-order mark");
  }
  return text;
}

/**
 * Read and structurally verify one record file.
 *
 * @returns {Promise<{status: "missing"} | {status: "present", text: string, sha256: string, identity: {dev: string, ino: string}}>}
 *   `missing` is a positive observation of absence. It is NOT an empty record and confers NO
 *   authority: nothing may be advanced from it.
 */
async function readRecordFile(io, limits, filePath) {
  let before;
  try {
    before = await identityOf(filePath, containOptions(io, limits));
  } catch (error) {
    if (isInstance(error, FsContainError) && safeRead(error, "code") === FS_ERROR_CODES.PATH_NOT_FOUND) return MISSING_RECORD;
    throw containFailure(error, ERROR_CODES.RECORD_UNREADABLE, "the journal file", filePath);
  }
  if (before.kind !== "file") {
    fail(
      ERROR_CODES.RECORD_UNREADABLE,
      `the journal path is a "${before.kind}", not a regular file; the store never reads or replaces a non-regular journal path`,
    );
  }
  if (before.nlink !== "1") {
    fail(
      ERROR_CODES.RECORD_UNREADABLE,
      `the journal file has ${before.nlink} hard links; a multiply-linked journal can be rewritten through another name, so it is refused`,
    );
  }

  let handle;
  try {
    handle = await io.open(filePath, "r");
  } catch (error) {
    if (isCode(error, "ENOENT")) {
      fail(ERROR_CODES.RECORD_UNSTABLE, "the journal file disappeared between the identity check and the open");
    }
    fail(ERROR_CODES.RECORD_UNREADABLE, `the journal file cannot be opened (${codeOf(error) ?? "error"})`, { cause: error });
  }

  let failed = false;
  let failure;
  let outcome;
  try {
    const stats = await handle.stat({ bigint: true });
    if (!isStatsLike(stats)) fail(ERROR_CODES.RECORD_UNREADABLE, "the open journal handle did not return filesystem stats");
    if (!stats.isFile()) fail(ERROR_CODES.RECORD_UNREADABLE, "the open journal handle is not a regular file");
    if (stats.nlink !== 1n) {
      fail(ERROR_CODES.RECORD_UNREADABLE, `the open journal handle has ${String(stats.nlink)} hard links`);
    }
    const dev = String(stats.dev);
    const ino = String(stats.ino);
    if (dev !== before.dev || ino !== before.ino) {
      fail(ERROR_CODES.RECORD_UNSTABLE, "the journal path was re-pointed between the identity check and the open");
    }
    const bytes = await readBoundedBytes(handle, limits, stats.size);
    // Re-check the path AFTER the read: a swap during the read must be refused, not silently used.
    let after;
    try {
      after = await identityOf(filePath, containOptions(io, limits));
    } catch (error) {
      throw containFailure(error, ERROR_CODES.RECORD_UNSTABLE, "the journal file", filePath);
    }
    if (after.dev !== dev || after.ino !== ino || after.kind !== "file" || after.nlink !== "1") {
      fail(ERROR_CODES.RECORD_UNSTABLE, "the journal path no longer refers to the file that was read");
    }
    outcome = { status: "present", text: decodeRecordBytes(bytes), sha256: sha256Hex(bytes), identity: Object.freeze({ dev, ino }) };
  } catch (error) {
    failed = true;
    failure = error;
  }
  // Separate booleans: a thrown `undefined`/`null`/`false`/`0` is a failure like any other.
  let closeFailed = false;
  let closeReason;
  try {
    await handle.close();
  } catch (error) {
    closeFailed = true;
    closeReason = error;
  }
  if (failed) {
    if (isStoreError(failure)) throw failure;
    throw new JournalStoreError(ERROR_CODES.RECORD_UNREADABLE, `the journal file cannot be read (${codeOf(failure) ?? "error"})`, { cause: failure });
  }
  if (closeFailed) {
    throw new JournalStoreError(ERROR_CODES.RECORD_UNREADABLE, `the journal handle cannot be closed (${codeOf(closeReason) ?? "error"})`, {
      cause: closeReason,
    });
  }
  return outcome;
}

/** Parse, validate with the caller's external allowlist, and require canonical serialization. */
function parseRecordText(text, allowedRoots) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    fail(ERROR_CODES.RECORD_INVALID, "the journal file is not valid JSON", { cause: error });
  }
  let record;
  try {
    record = validateJournal(parsed, { allowedRoots });
  } catch (error) {
    if (isInstance(error, JournalError)) {
      const journalCode = journalCodeOf(error);
      fail(ERROR_CODES.RECORD_INVALID, `the journal file was refused by the schema validator (${journalCode ?? "error"})`, {
        cause: error,
        detail: { journalCode },
      });
    }
    fail(ERROR_CODES.RECORD_INVALID, `the journal file could not be validated (${codeOf(error) ?? "error"})`, { cause: error });
  }
  if (JSON.stringify(record) !== text) {
    fail(
      ERROR_CODES.RECORD_NOT_CANONICAL,
      "the journal file is not canonically serialized: the bytes must be exactly JSON.stringify(validateJournal(record)), so whitespace, key reordering, duplicate keys, extra keys, escapes and trailing bytes are all refused",
    );
  }
  return record;
}

/** Serialize a validated record and enforce the size bound BEFORE anything reaches the filesystem. */
function serializeRecord(record, limits) {
  const text = JSON.stringify(record);
  if (typeof text !== "string" || text.length === 0) {
    fail(ERROR_CODES.RECORD_INVALID, "the validated record could not be serialized");
  }
  const size = Buffer.byteLength(text, "utf8");
  if (size > limits.maxRecordBytes) {
    fail(
      ERROR_CODES.RECORD_TOO_LARGE,
      `the record serializes to ${size} bytes, above the ${limits.maxRecordBytes}-byte limit; nothing was written`,
    );
  }
  return text;
}

// ---------- phase, pin and carryover rules ----------

function validateRecord(rawRecord, allowedRoots) {
  let record;
  try {
    record = validateJournal(rawRecord, { allowedRoots });
  } catch (error) {
    if (isInstance(error, JournalError)) {
      const journalCode = journalCodeOf(error);
      fail(
        ERROR_CODES.RECORD_INVALID,
        `the record was refused by the schema validator (${journalCode ?? "error"}); this store only ever persists records that validate against the caller's external allowlist`,
        { cause: error, detail: { journalCode } },
      );
    }
    // Any other throw (hostile getter/Proxy trap, even `throw undefined`) is typed, and kept as the cause.
    fail(ERROR_CODES.RECORD_INVALID, `the record could not be validated (${codeOf(error) ?? "error"}); nothing was written`, { cause: error });
  }
  return record;
}

function assertHostPin(hostInstanceId, record) {
  if (hostInstanceId === null) return;
  if (record.hostInstanceId !== hostInstanceId) {
    fail(
      ERROR_CODES.HOST_PIN_MISMATCH,
      `this store is pinned to host instance ${JSON.stringify(hostInstanceId)} but the record is pinned to ${JSON.stringify(record.hostInstanceId)}; ` +
        "an instance never adopts and advances another instance's transaction through this store (that path belongs to the unproven trusted executor)",
    );
  }
}

function assertTransition(from, to) {
  const allowed = PHASE_STEPS[from];
  if (allowed === undefined) fail(ERROR_CODES.INVALID_TRANSITION, `the stored record declares an unknown phase ${JSON.stringify(from)}`);
  if (!allowed.includes(to)) {
    fail(
      ERROR_CODES.INVALID_TRANSITION,
      `phase step "${from}" -> "${to}" is not allowed: "${from}" may only become ${allowed.length === 0 ? "nothing, it is terminal" : allowed.map((phase) => `"${phase}"`).join(" or ")}`,
    );
  }
}

function assertImmutable(previous, next) {
  for (const field of IMMUTABLE_TEXT_FIELDS) {
    if (previous[field] !== next[field]) {
      fail(
        ERROR_CODES.IMMUTABLE_FIELD_CHANGED,
        `"${field}" is bound when the record is created and must not change during a transaction (was ${JSON.stringify(short(previous[field]))}, now ${JSON.stringify(short(next[field]))})`,
      );
    }
  }
  for (const field of IMMUTABLE_PATH_FIELDS) {
    if (!samePath(previous[field], next[field])) {
      fail(
        ERROR_CODES.IMMUTABLE_FIELD_CHANGED,
        `"${field}" is bound when the record is created and must not change during a transaction (was ${JSON.stringify(short(previous[field]))}, now ${JSON.stringify(short(next[field]))})`,
      );
    }
  }
  // `rootIdentity` may differ only in `nlink`, which changes whenever a subdirectory of the root is
  // created or removed: dev/ino/kind are the identity.
  if (!sameBoundIdentity(previous.rootIdentity, next.rootIdentity)) {
    fail(
      ERROR_CODES.IMMUTABLE_FIELD_CHANGED,
      'the root identity (dev/ino/kind) is bound when the record is created and must not change during a transaction',
    );
  }
}

function assertCarryover(previous, next) {
  const before = previous.snapshots;
  const after = next.snapshots;
  const require = (condition, message) => {
    if (!condition) fail(ERROR_CODES.INVALID_CARRYOVER, message);
  };
  const stageKept = () => sameBoundIdentity(before.stage, after.stage);
  const liveKept = () => sameBoundIdentity(before.live, after.live);
  const backupKept = () => sameBoundIdentity(before.backup, after.backup);

  switch (next.phase) {
    case "worker-running":
      require(liveKept(), 'the first phase step must not change the bound live identity: nothing was renamed yet');
      require(backupKept(), 'the first phase step must not bind a backup identity: nothing was renamed yet');
      break;
    case "worker-stopped":
    case "validated":
      require(stageKept(), `the staging identity bound at "worker-running" must survive into "${next.phase}" unchanged`);
      require(liveKept(), `"${next.phase}" must not change the bound live identity`);
      require(backupKept(), `"${next.phase}" must not bind a backup identity`);
      break;
    case "aborted":
      require(liveKept(), 'an abort must not change the bound live identity: the live wiki was never renamed');
      require(backupKept(), 'an abort must not bind a backup identity: the live wiki was never renamed');
      require(
        after.stage === null || stageKept(),
        "an abort may record the staging identity as absent (when the staging directory is gone) but must never substitute a different staging identity",
      );
      break;
    case "live-moved":
      require(stageKept(), 'the staging identity must not change when the live directory is moved aside');
      require(after.live === null, 'the live path must be recorded ABSENT at "live-moved": it was renamed away');
      require(
        sameBoundIdentity(before.live, after.backup),
        'the identity that was live before the move must reappear as the backup identity at "live-moved"',
      );
      break;
    case "published":
      require(after.stage === null, 'the staging path must be recorded ABSENT at "published": the candidate is the live directory now');
      require(
        sameBoundIdentity(before.stage, after.live),
        'the published live identity must be exactly the candidate identity that was bound as the staging directory',
      );
      require(backupKept(), 'publication must not change the backup identity');
      break;
    case "rolled-back":
      require(stageKept(), 'a rollback keeps the candidate in staging, so its identity must not change');
      require(
        sameBoundIdentity(before.backup, after.live),
        'a rollback must restore exactly the identity that was live before the move; it is bound as the backup identity',
      );
      require(after.backup === null, 'a rollback leaves no backup identity: the backup became the live directory again');
      break;
    default:
      // `created` never arrives through advance(); assertTransition refuses it first.
      break;
  }
}

// ---------- owned-artifact cleanup ----------

/**
 * Remove one entry only when its identity still equals the identity that was observed when this store
 * created it. Anything else is retained: the store never deletes by name, never trusts an mtime and
 * never guesses.
 */
async function removeOwnedArtifact(io, target, expected, kind) {
  let stats;
  try {
    stats = await io.lstat(target);
  } catch (error) {
    return isCode(error, "ENOENT") ? "absent" : "retained-ambiguous";
  }
  if (!isStatsLike(stats)) return "retained-ambiguous";
  let dev;
  let ino;
  let isDir;
  try {
    dev = String(stats.dev);
    ino = String(stats.ino);
    isDir = stats.isDirectory();
    if (stats.isSymbolicLink()) return "retained-ambiguous";
  } catch {
    return "retained-ambiguous";
  }
  if (dev !== expected.dev || ino !== expected.ino) return "retained-ambiguous";
  if (kind === "dir" && !isDir) return "retained-ambiguous";
  try {
    if (kind === "dir") await io.rmdir(target);
    else await io.unlink(target);
    return "removed";
  } catch (error) {
    return isCode(error, "ENOENT") ? "absent" : "retained-ambiguous";
  }
}

// ---------- lock ----------

async function acquireLock(io, storeDir, key) {
  const lockPath = path.join(storeDir, `${key}${LOCK_SUFFIX}`);
  try {
    await io.mkdir(lockPath);
  } catch (error) {
    if (isCode(error, "EEXIST")) {
      fail(
        ERROR_CODES.STORE_LOCKED,
        `the store lock ${JSON.stringify(display(lockPath))} already exists. This store never breaks a lock automatically: it does not read an mtime, does not probe a process id, does not scan for stale locks and does not remove one it cannot prove it owns. ` +
          "An operator must confirm that no writer is active for this root and remove the directory by hand.",
        { detail: { lockPath } },
      );
    }
    fail(ERROR_CODES.WRITE_FAILED, `the store lock ${JSON.stringify(display(lockPath))} cannot be created (${codeOf(error) ?? "error"}); nothing was written`, {
      committed: false,
      cause: error,
    });
  }
  let stats;
  try {
    stats = await io.lstat(lockPath);
  } catch (error) {
    fail(
      ERROR_CODES.WRITE_FAILED,
      `the store lock was created but its identity cannot be read (${codeOf(error) ?? "error"}); it is retained and nothing was written`,
      { committed: false, cause: error, detail: { lockPath, lockRelease: "retained-ambiguous" } },
    );
  }
  let plainDirectory = false;
  let lockIdentity;
  try {
    plainDirectory = isStatsLike(stats) && !stats.isSymbolicLink() && stats.isDirectory();
    if (plainDirectory) lockIdentity = Object.freeze({ dev: String(stats.dev), ino: String(stats.ino) });
  } catch {
    plainDirectory = false;
  }
  if (!plainDirectory) {
    fail(
      ERROR_CODES.WRITE_FAILED,
      "the store lock was created but the entry at the lock path is not a plain directory; it is retained and nothing was written",
      { committed: false, detail: { lockPath, lockRelease: "retained-ambiguous" } },
    );
  }
  return Object.freeze({ path: lockPath, identity: lockIdentity });
}

/**
 * Run `task` under the per-root lock and release the lock afterwards, whatever happens. A release
 * that cannot be proven to remove OUR lock is reported: on a successful task it becomes
 * `lock-release-unverified` (committed, with the snapshot attached), on a failed task it is attached
 * to the original error as `lockRelease`.
 */
async function runLocked(io, storeDir, key, task) {
  const lock = await acquireLock(io, storeDir, key);
  let failed = false;
  let primary;
  let result;
  try {
    result = await task(lock);
  } catch (error) {
    failed = true;
    primary = error;
  }
  const release = await removeOwnedArtifact(io, lock.path, lock.identity, "dir");
  const released = release === "removed" || release === "absent";
  if (failed) {
    // The primary failure is never lost and an arbitrary thrown value is never mutated.
    // Only a genuinely constructed JournalStoreError (provenance brand) is ever mutated; null,
    // primitives, frozen objects and Proxies are wrapped instead.
    if (isStoreError(primary) && tryAttach(primary, "lockRelease", release)) throw primary;
    if (isStoreError(primary)) {
      const committed = safeRead(primary, "committed");
      const code = safeRead(primary, "code");
      throw new JournalStoreError(typeof code === "string" && Object.values(ERROR_CODES).includes(code) ? code : ERROR_CODES.WRITE_FAILED, "the locked task failed with an error that could not carry the lock release outcome", {
        ...(typeof committed === "boolean" ? { committed } : {}),
        cause: primary,
        detail: { lockRelease: release },
      });
    }
    const wrapped = new JournalStoreError(ERROR_CODES.WRITE_FAILED, `the locked task failed with a non-store error (${codeOf(primary) ?? "error"})`, {
      cause: primary,
      detail: { lockRelease: release },
    });
    wrapped.lockRelease = release;
    throw wrapped;
  }
  if (!released) {
    throw new JournalStoreError(
      ERROR_CODES.LOCK_RELEASE_UNVERIFIED,
      `the record was committed, but the store lock ${JSON.stringify(display(lock.path))} could not be proven to be the directory this store created (${release}), so it was RETAINED. ` +
        "Every later write for this root now fails with store-locked until an operator confirms no writer is active and removes it by hand.",
      { committed: true, snapshot: result?.snapshot, detail: { lockPath: lock.path, lockRelease: release } },
    );
  }
  return Object.freeze({ ...result, lock: "released" });
}

// ---------- per-root in-process serialization ----------

/**
 * Serialize every operation that touches one root inside this process. The queue is keyed by the
 * derived journal key, so two roots never block each other. Cross-process exclusion is the mkdir
 * lock; this queue only removes intra-process interleaving, which a CAS alone would report as a
 * confusing stale-snapshot error instead of a deterministic order.
 */
function enqueue(queues, key, task) {
  const prior = queues.get(key) ?? Promise.resolve();
  const run = prior.then(task, task);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, tail);
  tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
}

// ---------- the store ----------

/**
 * Open a journal store over an existing, trusted, canonical directory.
 *
 * @param {{
 *   storeDir: string,
 *   allowedRoots: string[],
 *   hostInstanceId?: string,
 *   io?: object,
 *   limits?: {maxRecordBytes?: number, maxPathLength?: number}
 * }} options
 * @returns {Promise<Readonly<{
 *   storeDir: string,
 *   allowedRoots: ReadonlyArray<string>,
 *   hostInstanceId: string|null,
 *   load: (root: string) => Promise<Readonly<object>|null>,
 *   create: (record: object) => Promise<Readonly<object>>,
 *   advance: (previousSnapshot: object, nextRecord: object) => Promise<Readonly<object>>,
 *   replaceTerminal: (previousSnapshot: object, newRecord: object) => Promise<Readonly<object>>
 * }>>}
 * @throws {JournalStoreError}
 */
export async function openJournalStore(options) {
  const resolved = readOptions(options);
  const { io, limits } = resolved;

  let storeEntry;
  try {
    storeEntry = await assertCanonicalDir(resolved.storeDir, containOptions(io, limits));
  } catch (error) {
    throw containFailure(error, ERROR_CODES.STORE_UNTRUSTED, "the store directory", resolved.storeDir);
  }

  const allowedRoots = [];
  for (const raw of resolved.allowedRoots) {
    let entry;
    try {
      entry = await assertCanonicalDir(raw, containOptions(io, limits));
    } catch (error) {
      throw containFailure(error, ERROR_CODES.ROOT_UNREADABLE, "allowlisted root", raw);
    }
    if (!allowedRoots.some((existing) => samePath(existing, entry.path))) allowedRoots.push(entry.path);
  }

  for (const root of allowedRoots) {
    if (samePath(root, storeEntry.path)) {
      fail(
        ERROR_CODES.STORE_OVERLAP_ROOT,
        `the store directory IS an allowlisted repository root (${JSON.stringify(display(root))}); a journal inside a worker-writable repository is exactly what T018 forbids`,
      );
    }
    if (isWithin(root, storeEntry.path)) {
      fail(
        ERROR_CODES.STORE_OVERLAP_ROOT,
        `the store directory ${JSON.stringify(display(storeEntry.path))} is INSIDE the allowlisted repository root ${JSON.stringify(display(root))}; a worker that can write the repository could rewrite its own journal`,
      );
    }
    if (isWithin(storeEntry.path, root)) {
      fail(
        ERROR_CODES.STORE_OVERLAP_ROOT,
        `the allowlisted repository root ${JSON.stringify(display(root))} is INSIDE the store directory ${JSON.stringify(display(storeEntry.path))}; the store must not be able to contain repository content`,
      );
    }
  }

  const storeDir = storeEntry.path;
  const storeIdentity = storeEntry.identity;
  const hostInstanceId = resolved.hostInstanceId;
  const frozenRoots = Object.freeze([...allowedRoots]);

  // Per-store, module-private provenance brand. A snapshot is authority only for THIS store: another
  // store over the same directory has its own brand, so a snapshot cannot be replayed across stores.
  const brand = new WeakSet();
  const queues = new Map();

  function brandSnapshot(fields) {
    const snapshot = Object.freeze({
      record: fields.record,
      sha256: fields.sha256,
      fileIdentity: Object.freeze({ dev: fields.fileIdentity.dev, ino: fields.fileIdentity.ino }),
      durability: fields.durability,
    });
    brand.add(snapshot);
    return snapshot;
  }

  function requireOwnSnapshot(snapshot) {
    if (snapshot === null || typeof snapshot !== "object" || !brand.has(snapshot)) {
      fail(
        ERROR_CODES.SNAPSHOT_NOT_OWNED,
        "advance() and replaceTerminal() accept ONLY a snapshot object that THIS store returned from create/load/advance/replaceTerminal. " +
          "A structurally identical clone, a spread copy, a JSON round trip, a snapshot from another store instance and any object built by the caller are refused: a compare-and-swap is only meaningful for the bytes this store actually observed. Call load(root) again to re-acquire authority.",
      );
    }
    const recomputed = sha256Hex(Buffer.from(JSON.stringify(snapshot.record), "utf8"));
    if (recomputed !== snapshot.sha256) {
      fail(ERROR_CODES.SNAPSHOT_INCONSISTENT, "the snapshot's sha256 does not match the record it carries; the snapshot is refused");
    }
    const fileIdentity = snapshot.fileIdentity;
    if (fileIdentity === null || typeof fileIdentity !== "object" || typeof fileIdentity.dev !== "string" || typeof fileIdentity.ino !== "string") {
      fail(ERROR_CODES.SNAPSHOT_INCONSISTENT, "the snapshot does not carry a dev/ino file identity; it is refused");
    }
    return snapshot;
  }

  /** Re-verify that the store directory is still the same canonical, link-free directory. */
  async function reverifyStore() {
    let entry;
    try {
      entry = await assertCanonicalDir(storeDir, containOptions(io, limits));
    } catch (error) {
      throw containFailure(error, ERROR_CODES.STORE_IDENTITY_CHANGED, "the store directory", storeDir);
    }
    if (entry.identity.dev !== storeIdentity.dev || entry.identity.ino !== storeIdentity.ino) {
      fail(
        ERROR_CODES.STORE_IDENTITY_CHANGED,
        `the directory at ${JSON.stringify(display(storeDir))} is no longer the directory this store was opened on (bound dev/ino ${storeIdentity.dev}/${storeIdentity.ino}, found ${entry.identity.dev}/${entry.identity.ino}); every operation is refused until a new store is opened on a verified directory`,
      );
    }
    return entry;
  }

  /** Resolve an allowlisted root and bind it to the requested canonical path. */
  async function resolveRoot(rawRoot, label) {
    if (typeof rawRoot !== "string" || rawRoot.length === 0) {
      fail(ERROR_CODES.INVALID_OPTIONS, `${label} must be a non-empty absolute path string`);
    }
    let entry;
    try {
      entry = await assertCanonicalDir(rawRoot, containOptions(io, limits));
    } catch (error) {
      throw containFailure(error, ERROR_CODES.ROOT_UNREADABLE, `the ${label} root`, rawRoot);
    }
    if (!frozenRoots.some((allowed) => samePath(allowed, entry.path))) {
      fail(
        ERROR_CODES.ROOT_NOT_ALLOWED,
        `the root ${JSON.stringify(display(entry.path))} is not one of the ${frozenRoots.length} allowlisted canonical root(s) supplied when this store was opened`,
      );
    }
    return entry;
  }

  /** The record must bind the requested root, and that root must still be the same directory. */
  function assertBoundToRoot(record, rootEntry, requestedPath) {
    if (!samePath(record.rootReal, requestedPath)) {
      fail(
        ERROR_CODES.ROOT_NOT_REQUESTED,
        `the journal file for this root binds rootReal ${JSON.stringify(display(record.rootReal))}, not the requested ${JSON.stringify(display(requestedPath))}; the store never serves one repository's record for another`,
      );
    }
    const declared = identityParts(record.rootIdentity);
    if (declared.dev !== rootEntry.identity.dev || declared.ino !== rootEntry.identity.ino || declared.kind !== "dir") {
      fail(
        ERROR_CODES.ROOT_IDENTITY_MISMATCH,
        `the record binds the root identity dev/ino ${declared.dev}/${declared.ino} but the directory at that path is dev/ino ${rootEntry.identity.dev}/${rootEntry.identity.ino}; the root may have been replaced, so the record is refused`,
      );
    }
  }

  function journalPathFor(key) {
    return path.join(storeDir, `${key}${JOURNAL_SUFFIX}`);
  }

  async function storeRootAndKey(record, label) {
    const entry = await resolveRoot(record.rootReal, label);
    return { entry, key: journalKeyFrom(entry.path) };
  }

  // ---- read ----

  async function load(rawRoot) {
    const requested = await resolveRoot(rawRoot, "load");
    const key = journalKeyFrom(requested.path);
    return enqueue(queues, key, async () => {
      await reverifyStore();
      const current = await resolveRoot(requested.path, "load");
      const file = await readRecordFile(io, limits, journalPathFor(key));
      if (file.status === "missing") return null;
      const record = parseRecordText(file.text, frozenRoots);
      assertBoundToRoot(record, current, requested.path);
      return brandSnapshot({ record, sha256: file.sha256, fileIdentity: file.identity, durability: "unverified" });
    });
  }

  // ---- write helper ----

  /**
   * Write `text` to the journal path via exactly one rename. Every step before the rename reports
   * `committed: false`; every step after it reports `commit-uncertain` with `committed: true`.
   */
  async function writeRecordFile(key, text) {
    const filePath = journalPathFor(key);
    const expectedSha = sha256Hex(Buffer.from(text, "utf8"));
    const bytes = Buffer.from(text, "utf8");
    const tempPath = path.join(storeDir, `${key}${TEMP_MARKER}${randomBytes(8).toString("hex")}`);

    let handle = null;
    let tempIdentity = null;
    let failed = false;
    let failure;

    try {
      handle = await io.open(tempPath, "wx", 0o600);
      const stats = await handle.stat({ bigint: true });
      if (!isStatsLike(stats) || !stats.isFile() || stats.nlink !== 1n) {
        fail(ERROR_CODES.WRITE_FAILED, "the temporary journal file is not a single-link regular file", { committed: false });
      }
      tempIdentity = Object.freeze({ dev: String(stats.dev), ino: String(stats.ino) });
      let written = 0;
      while (written < bytes.length) {
        const writeResult = await handle.write(bytes, written, bytes.length - written, written);
        const bytesWritten = safeRead(writeResult, "bytesWritten");
        if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0) {
          fail(ERROR_CODES.WRITE_FAILED, "the temporary journal file accepted no bytes", { committed: false });
        }
        written += bytesWritten;
      }
      await handle.sync();
    } catch (error) {
      failed = true;
      failure = error;
    }

    let closeFailed = false;
    let closeError;
    if (handle !== null) {
      try {
        await handle.close();
      } catch (error) {
        closeFailed = true;
        closeError = error;
      }
    }
    if (!failed && closeFailed) {
      failed = true;
      failure = closeError;
    }

    if (failed) {
      // Nothing was renamed, so the previous record (if any) is genuinely untouched. The temporary
      // file is removed only when its identity proves it is the file this store created.
      const cleanup = tempIdentity === null ? "retained-ambiguous" : await removeOwnedArtifact(io, tempPath, tempIdentity, "file");
      // Only a store error that already says "nothing committed" is passed through, and only if it
      // can carry the cleanup outcome; everything else is wrapped without being touched.
      if (isStoreError(failure) && safeRead(failure, "committed") === false && tryAttach(failure, "tempCleanup", cleanup)) {
        throw failure;
      }
      throw new JournalStoreError(
        ERROR_CODES.WRITE_FAILED,
        `writing the temporary journal file failed (${codeOf(failure) ?? "error"}); nothing was committed, so the previous record is unchanged`,
        { committed: false, cause: failure, detail: { tempCleanup: cleanup } },
      );
    }

    try {
      // Exactly one rename, never retried: a retry could replace a record that appeared meanwhile.
      await io.rename(tempPath, filePath);
    } catch (error) {
      const cleanup = await removeOwnedArtifact(io, tempPath, tempIdentity, "file");
      throw new JournalStoreError(
        ERROR_CODES.WRITE_FAILED,
        `renaming the temporary journal file onto the journal path failed (${codeOf(error) ?? "error"}); nothing was committed, so the previous record is unchanged`,
        { committed: false, cause: error, detail: { tempCleanup: cleanup } },
      );
    }

    // ---- from here on the record is renamed into place: no failure may claim the old state ----
    const durability = await syncStoreDirectory();
    let readback;
    try {
      readback = await readRecordFile(io, limits, filePath);
    } catch (error) {
      throw commitUncertain(`the record could not be read back (${codeOf(error) ?? "an unrecognized error"})`, error, {
        readbackFailure: codeOf(error),
      });
    }
    if (readback.status !== "present") {
      throw commitUncertain("the record was no longer present at the journal path", NO_CAUSE, { durability });
    }
    if (readback.sha256 !== expectedSha) {
      throw commitUncertain("the journal file does not contain the bytes that were renamed into place (another writer may have replaced it)", NO_CAUSE, {
        durability,
        expectedSha256: expectedSha,
        foundSha256: readback.sha256,
      });
    }
    if (readback.identity.dev !== tempIdentity.dev || readback.identity.ino !== tempIdentity.ino) {
      throw commitUncertain("the file at the journal path is not the file that was renamed there (identity swap)", NO_CAUSE, {
        durability,
        expectedIdentity: tempIdentity,
        foundIdentity: readback.identity,
      });
    }
    return { sha256: expectedSha, fileIdentity: readback.identity, durability };
  }

  /**
   * Best-effort directory sync of the store directory. An unsupported-directory-sync code is reported
   * as `file-flushed` (the record content is flushed, the rename itself is not proven durable); any
   * other failure is a post-rename fault.
   */
  async function syncStoreDirectory() {
    let handle;
    let openFailed = false;
    let openError;
    try {
      handle = await io.open(storeDir, "r");
    } catch (error) {
      openFailed = true;
      openError = error;
    }
    if (openFailed) {
      if (isUnsupportedDirectorySync(openError)) return "file-flushed";
      throw commitUncertain(`the store directory could not be opened for a directory sync (${codeOf(openError) ?? "error"})`, openError);
    }
    // Separate booleans: a thrown `undefined` is a real sync failure, never "directory-synced".
    let syncFailed = false;
    let syncError;
    try {
      await handle.sync();
    } catch (error) {
      syncFailed = true;
      syncError = error;
    }
    let closeFailed = false;
    let closeError;
    try {
      await handle.close();
    } catch (error) {
      closeFailed = true;
      closeError = error;
    }
    if (syncFailed) {
      if (isUnsupportedDirectorySync(syncError)) return "file-flushed";
      throw commitUncertain(`the directory sync of the store failed (${codeOf(syncError) ?? "error"})`, syncError);
    }
    // A close failure after a successful directory sync does not undo the sync (best effort, as before).
    void closeFailed;
    void closeError;
    return "directory-synced";
  }

  // ---- create ----

  async function create(rawRecord) {
    const record = validateRecord(rawRecord, frozenRoots);
    if (record.phase !== "created") {
      fail(
        ERROR_CODES.INVALID_TRANSITION,
        `create() writes the FIRST record of a transaction and requires phase "created"; phase ${JSON.stringify(record.phase)} must go through advance()`,
      );
    }
    assertHostPin(hostInstanceId, record);
    const { key } = await storeRootAndKey(record, "create");
    const text = serializeRecord(record, limits);

    return enqueue(queues, key, async () => {
      await reverifyStore();
      const current = await resolveRoot(record.rootReal, "create");
      assertBoundToRoot(record, current, current.path);
      const filePath = journalPathFor(key);
      const existing = await readRecordFile(io, limits, filePath);
      if (existing.status !== "missing") {
        fail(
          ERROR_CODES.RECORD_EXISTS,
          `this root already has a journal record; create() never overwrites one. Read it with load(root) and advance it, or use replaceTerminal() when it is terminal`,
          { detail: { journalPath: filePath } },
        );
      }
      return runLocked(io, storeDir, key, async () => {
        // Re-check under the lock: another process may have created the record after the read above.
        // `rename` cannot express "only if absent"; see LIMITATIONS.
        const again = await readRecordFile(io, limits, filePath);
        if (again.status !== "missing") {
          fail(
            ERROR_CODES.RECORD_EXISTS,
            "this root already has a journal record (it appeared while this store was acquiring the lock); create() never overwrites one",
            { detail: { journalPath: filePath } },
          );
        }
        const written = await writeRecordFile(key, text);
        const snapshot = brandSnapshot({ record, sha256: written.sha256, fileIdentity: written.fileIdentity, durability: written.durability });
        return { snapshot };
      });
    });
  }

  // ---- advance ----

  async function advance(previousSnapshot, rawRecord) {
    const previous = requireOwnSnapshot(previousSnapshot);
    const record = validateRecord(rawRecord, frozenRoots);
    assertImmutable(previous.record, record);
    assertHostPin(hostInstanceId, record);
    assertTransition(previous.record.phase, record.phase);
    assertCarryover(previous.record, record);
    const { key } = await storeRootAndKey(record, "advance");
    const text = serializeRecord(record, limits);

    return enqueue(queues, key, async () => {
      await reverifyStore();
      const current = await resolveRoot(record.rootReal, "advance");
      assertBoundToRoot(record, current, current.path);
      const filePath = journalPathFor(key);
      return runLocked(io, storeDir, key, async () => {
        const file = await readRecordFile(io, limits, filePath);
        if (file.status === "missing") {
          fail(
            ERROR_CODES.RECORD_MISSING,
            "a previous snapshot was supplied but the journal file is absent; the store never advances from an assumed record, because a missing record confers no authority",
            { detail: { journalPath: filePath } },
          );
        }
        assertCas(previous, file, "advance");
        const written = await writeRecordFile(key, text);
        const snapshot = brandSnapshot({ record, sha256: written.sha256, fileIdentity: written.fileIdentity, durability: written.durability });
        return { snapshot };
      });
    });
  }

  /** Compare-and-swap: the on-disk bytes and file must be exactly what the snapshot observed. */
  function assertCas(previous, file, label) {
    if (file.sha256 !== previous.sha256) {
      fail(
        ERROR_CODES.STALE_SNAPSHOT,
        `${label} refused: the journal for this root no longer holds the bytes the snapshot observed (snapshot sha ${previous.sha256}, on-disk sha ${file.sha256}). ` +
          "Another writer advanced or replaced the record; nothing was written, so the on-disk record is unchanged. Re-read with load(root) and rebuild the step from the current record.",
      );
    }
    if (file.identity.dev !== previous.fileIdentity.dev || file.identity.ino !== previous.fileIdentity.ino) {
      fail(
        ERROR_CODES.STALE_SNAPSHOT,
        `${label} refused: the journal path now refers to a different file than the snapshot bound (snapshot dev/ino ${previous.fileIdentity.dev}/${previous.fileIdentity.ino}, on-disk ${file.identity.dev}/${file.identity.ino}). Nothing was written.`,
      );
    }
  }

  // ---- replaceTerminal ----

  async function replaceTerminal(previousSnapshot, rawRecord) {
    const previous = requireOwnSnapshot(previousSnapshot);
    if (!TERMINAL_PHASES.includes(previous.record.phase)) {
      fail(
        ERROR_CODES.INVALID_TRANSITION,
        `replaceTerminal() only replaces a TERMINAL record (${TERMINAL_PHASES.map((phase) => `"${phase}"`).join(", ")}); the stored record is in phase ${JSON.stringify(previous.record.phase)} and must be advanced or recoverable instead`,
      );
    }
    const record = validateRecord(rawRecord, frozenRoots);
    if (record.phase !== "created") {
      fail(ERROR_CODES.INVALID_TRANSITION, `a replacement record must start a new transaction in phase "created", not ${JSON.stringify(record.phase)}`);
    }
    if (record.jobId === previous.record.jobId) {
      fail(
        ERROR_CODES.INVALID_TRANSITION,
        `a replacement must start a DIFFERENT transaction: the new record still binds jobId ${JSON.stringify(record.jobId)}, which is the job being replaced`,
      );
    }
    assertHostPin(hostInstanceId, record);
    if (!samePath(record.rootReal, previous.record.rootReal)) {
      fail(ERROR_CODES.IMMUTABLE_FIELD_CHANGED, "a replacement record must bind the same repository root as the record it replaces");
    }
    if (!sameBoundIdentity(previous.record.rootIdentity, record.rootIdentity)) {
      fail(ERROR_CODES.IMMUTABLE_FIELD_CHANGED, "a replacement record must bind the same root identity (dev/ino/kind) as the record it replaces");
    }
    if (!sameBoundIdentity(previous.record.snapshots.live, record.snapshots.live)) {
      fail(
        ERROR_CODES.INVALID_CARRYOVER,
        "a replacement transaction must bind the live identity the replaced record left behind (or null when no wiki is published); it may not invent one",
      );
    }

    const { key } = await storeRootAndKey(record, "replaceTerminal");
    const text = serializeRecord(record, limits);
    const retained = [];
    if (previous.record.snapshots.backup !== null) retained.push(Object.freeze({ kind: "backup", path: previous.record.backupPath }));
    if (previous.record.snapshots.stage !== null) retained.push(Object.freeze({ kind: "staging", path: previous.record.stagePath }));
    const replacement = Object.freeze({
      priorJobId: previous.record.jobId,
      priorPhase: previous.record.phase,
      cleanupProven: false,
      retained: Object.freeze(retained),
      note:
        "Replacing the record does not remove, and proves nothing about, the previous transaction's bound artifacts. The replaced record is no longer readable from this store, so plan its cleanup from the branded record the caller still holds (planRecovery) before any further step.",
    });

    return enqueue(queues, key, async () => {
      await reverifyStore();
      const current = await resolveRoot(record.rootReal, "replaceTerminal");
      assertBoundToRoot(record, current, current.path);
      const filePath = journalPathFor(key);
      return runLocked(io, storeDir, key, async () => {
        const file = await readRecordFile(io, limits, filePath);
        if (file.status === "missing") {
          fail(
            ERROR_CODES.RECORD_MISSING,
            "a previous snapshot was supplied but the journal file is absent; a missing record confers no authority, so nothing is replaced",
            { detail: { journalPath: filePath } },
          );
        }
        assertCas(previous, file, "replaceTerminal");
        const written = await writeRecordFile(key, text);
        const snapshot = brandSnapshot({ record, sha256: written.sha256, fileIdentity: written.fileIdentity, durability: written.durability });
        return { snapshot, replacement };
      });
    });
  }

  return Object.freeze({
    storeDir,
    storeIdentity,
    allowedRoots: frozenRoots,
    hostInstanceId,
    load,
    create,
    advance,
    replaceTerminal,
  });
}
