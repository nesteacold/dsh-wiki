// dsh-wiki — dormant, pure trusted transaction-journal schema validator and recovery planner
// (spec 007, T018 follow-up).
//
// READ THIS FIRST — what this module is and is not
// -----------------------------------------------
// This is a schema and decision layer only. It deliberately does NOT:
//   * touch the filesystem: no `node:fs` import, no realpath, no lstat, no mtime, no directory
//     listing or filename discovery of any kind;
//   * persist, create, update or repair a journal record;
//   * execute, schedule or authorize a rename/delete: every planned action is inert symbolic data
//     that a still-unimplemented trusted executor must re-verify and perform;
//   * authenticate anything. A record is trusted only because a trusted caller supplied the
//     allowlisted canonical root (now) and because a trusted store persists the record outside
//     worker-writable staging (later). There is no signature, no MAC, no per-user isolation and no
//     protection against another process running as the same user.
//
// Two exports matter operationally:
//
//   validateJournal(record, { allowedRoots })
//       Pure, synchronous, fail-closed schema validation. `allowedRoots` is REQUIRED and must be
//       supplied by the trusted caller (normally the canonical real paths returned by
//       `assertCanonicalDir` for allowlisted repositories). There is no discovery and no default:
//       a record whose `rootReal` is not exactly one of those roots is rejected. Returns a freshly
//       built, deeply frozen record. Callers must keep and use the RETURNED record as the authority;
//       the input object is never retained, so a hostile Proxy or a later mutation cannot change a
//       decision that was already taken against the returned copy. That exact returned object is
//       also the only thing this module will ever accept as authorization to plan actions.
//
//   planRecovery(validRecord, observations)
//       Pure, deterministic decision function. It takes the object returned by `validateJournal`
//       (re-validated structurally on every call) plus trusted *observations* of the actual
//       filesystem identities and worker liveness, and returns a frozen plan:
//       `{ version, jobId, phase, restart, worker, decision, code, reason, actions }`.
//       Ambiguity never produces actions. `decision` is one of `no-op`, `restore-backup`,
//       `cleanup`, `manual`, `quarantine`; only `restore-backup` and `cleanup` ever carry actions,
//       and those actions are symbolic descriptions, not effects.
//
// Provenance gate on `planRecovery`
// --------------------------------
// `planRecovery` accepts ONLY an object this module instance returned from `validateJournal`, proved
// by a module-private WeakSet brand that nothing outside this file can set. Structural validity is
// not authority: the allowlist test lives in `validateJournal`, so a well-formed copy of a record (a
// spread clone, a JSON round trip, a record deserialized from storage, a forged-root record from any
// hostile source) was never checked against a trusted caller's allowlist, and planning actions from
// it could clean up or restore directories under an unauthorized root. Every such input is refused
// with `record-not-validated` BEFORE any action is computed. A persisted record must be re-validated
// explicitly — `validateJournal(record, { allowedRoots })` with the caller's external allowlist —
// and only the object that call returns may be planned. The brand is per object and per module
// instance: clones are not branded, existing brands are never transferred, and no root supplied by a
// caller can re-authorize an unbranded record.
//
// Plan provenance, and how the trusted executor uses it
// ----------------------------------------------------
// Every frozen plan `planRecovery` returns is branded in a second module-private WeakSet, and
// `isRecoveryPlan(value)` is the only probe of that set. It exists because the trusted executor
// receives a plan it must not merely re-check structurally: a forged but internally consistent plan
// (the right jobId, phase, paths and identities) passes every shape test, so the executor asks this
// module whether the plan is one this planner produced and refuses anything else BEFORE any rename or
// removal. A check deferred until journal advancement is too late — that happens after the rename,
// and the cleanup path never advances a record at all. The probe grants nothing: it is a membership
// test, there is no exported brander, the set is per module instance, and a look-alike object with
// identical fields is not a member.
//
// Record schema, version 1 (closed own-key schema; exactly these keys, no extras, no symbols,
// no accessors, no non-enumerable own properties, prototype must be Object.prototype or null):
//
//   version           literal number 1
//   jobId             1-64 lowercase ASCII letters/digits (the same shape the staging binder uses)
//   hostInstanceId    opaque host-instance token, 8-256 chars of [A-Za-z0-9._-]
//   rootReal          canonical absolute allowlisted repository root (never a filesystem root)
//   rootIdentity      identity JSON string of the root directory
//   stagePath         exactly `<rootReal>/.dsh-wiki.staging-<jobId>`
//   livePath          exactly `<rootReal>/.dsh-wiki`
//   backupPath        exactly `<rootReal>/.dsh-wiki.bak-<jobId>`
//   workerSessionId   opaque worker session token, 8-256 chars of [A-Za-z0-9._-]
//   protocolSha256    lowercase SHA-256 hex (64 chars) of the worker protocol file
//   promptSha256      lowercase SHA-256 hex (64 chars) of the exact worker prompt
//   phase             one of PHASES
//   snapshots         { stage, live, backup }; each value is `null` (bound as ABSENT at this phase)
//                     or a directory identity JSON string
//
// Identity JSON strings are canonical: exactly `{"dev":"..","ino":"..","kind":"dir","nlink":".."}`
// in that key order, compact separators, non-negative normalized base-10 strings for dev/ino/nlink.
// Re-serializing the parsed value must reproduce the input string byte for byte, which rejects
// whitespace, key reordering, duplicate keys and unknown keys instead of accepting them.
//
// Phase/snapshot table (an inconsistent combination is rejected, because a plan built on it could
// rename the wrong directory):
//
//   phase                                   snapshots.stage  snapshots.live   snapshots.backup
//   created                                 null             prior live|null  null
//   worker-running / worker-stopped         identity         prior live|null  null
//   validated                               identity         prior live|null  null
//   live-moved                              identity         null (gap)       prior live|null
//   published                               null             candidate        prior live|null
//   rolled-back / aborted                   identity|null    prior live|null  null
//
// `prior live` is the published wiki as it was when the transaction started. At `published` the
// candidate (formerly the staging directory) IS the live directory, so `snapshots.live` holds the
// candidate identity and `snapshots.backup` holds the identity that was live before publication.
// A `null` snapshot is a positive statement that the path was absent, not "unknown".
//
// REQUIRED WRITE ORDER (a contract for the trusted store that does not exist yet)
// ------------------------------------------------------------------------------
// This module persists nothing, but the phase table above only describes reality if the store writes
// each phase in the right relation to the two renames (1: live -> `.dsh-wiki.bak-<jobId>`,
// 2: staging -> `.dsh-wiki`). A record written on the wrong side of a rename is a lie about what is
// on disk, and the planner will believe it. The order is therefore:
//
//   1. `validated` is made DURABLE before the first rename runs. At that moment the live wiki is
//      still the prior one (or absent, for a first generation), which is exactly what the record
//      binds. Written after the live directory had already moved, the same record would claim a live
//      directory that no longer exists, and a crash would be planned as "crash between the renames"
//      (restore-backup) for a move that was fully intended.
//   2. first rename: live -> `.dsh-wiki.bak-<jobId>` (skipped when no live wiki exists; the record
//      then binds `snapshots.live === null`).
//   3. `live-moved` is written strictly AFTER that first rename, never before. Recorded early it
//      declares the live path absent while the live directory is still there, so every plan built on
//      it misreads the on-disk state (`unexpected-live` at best, a wrong restore at worst).
//   4. promotion: staging -> `.dsh-wiki`.
//   5. `published` is written strictly AFTER the promotion, never before. The record binds the
//      candidate identity as `snapshots.live` and the prior identity as `snapshots.backup`, so
//      claiming it early would make a crashed publication plan a cleanup of that backup while the
//      candidate is still in staging.
//
// Recovery itself never writes: it observes, decides, and (in the still-unimplemented trusted
// executor) acts. A store that rewrites a record must re-validate the reloaded copy with the same
// external allowlist, because a reloaded object is unbranded and cannot plan.
//
// Identity matching compares dev, ino and kind only. `nlink` is validated but intentionally NOT
// compared: a directory's link count changes whenever a subdirectory is created or removed, so
// treating it as part of the identity would produce false mismatches during normal operation.
//
// Observations schema (closed own-key schema, supplied by a trusted observer; note that this module
// cannot verify how the observation was produced):
//
//   hostInstanceId   opaque token; differing from the record means "this is a restart from the
//                    perspective of the writer that created the record"
//   worker           { state: "alive"|"stopped"|"unknown", proof?, sessionId? }
//                    proof is optional when state is "stopped" and forbidden otherwise; missing
//                    proof, proof "worker-session-id", or a non-"process-exit" proof across a
//                    restart all quarantine. A matching `sessionId` is NEVER sufficient evidence:
//                    it is not consulted for liveness at all.
//   root, stage, live, backup
//                    each is `{ state: "present", identity }`, `{ state: "absent" }` or
//                    `{ state: "unknown" }`. "unknown" is ambiguity and never yields actions.
//
// Recovery policy (deliberately conservative):
//   * A worker reported alive or unknown quarantines every phase: nothing is touched, even when the
//     transaction looks terminal. An old-host worker needs independent proof (process exit); a
//     session id is not proof.
//   * Any identity drift of a bound artifact quarantines. An unexpected artifact with no bound
//     identity (forged `.bak-*`, stray staging, misleading mtime) is never deleted, only reported.
//   * The only automatic roll-forward/roll-back action is restoring a previously live directory
//     from its bound backup into the missing live path (`restore-backup`), and only when the live
//     gap is observed, the backup identity matches exactly, and the worker is proven stopped. Every
//     other bound artifact must still match in the same observation: if the staging directory is
//     missing or has drifted while the live gap exists, the state is inconsistent, so the decision
//     is `manual`/`quarantine` and the restore is left to an operator.
//   * `cleanup` is planned only for a validated backup after `published` (requires the bound backup
//     identity AND the bound candidate identity as the observed live directory) and for a bound
//     staging directory after `rolled-back`/`aborted`.
//   * Validated-but-unpublished candidates are not promoted and interrupted transactions
//     (`worker-running`/`worker-stopped`/`validated`) are not deleted automatically: those need an
//     operator, so the decision is `manual` with no actions.
//
// LIMITATIONS — do not oversell this module
// -----------------------------------------
//   * No persistence. Nothing here creates, updates or reloads a journal. Until a trusted store
//     writes the record before mutation (in the REQUIRED WRITE ORDER above), scans it at startup and
//     re-validates it with the same allowlist, recovery has no authority. A reloaded record is a
//     different object and is therefore unbranded: `planRecovery` refuses it until the trusted caller
//     re-validates it with `validateJournal(record, { allowedRoots })` and plans the returned object.
//   * No execution and no atomicity. A planned rename is checked here against observations that are
//     point-in-time; the executor must re-verify identity and destination absence immediately before
//     acting (see this package's filesystem-containment primitives), and even that is not an
//     atomic check-and-rename.
//   * Planned removals cannot be made identity-safe with portable Node primitives: there is no
//     fd-relative or no-follow unlink here. The action records the expected identity so the executor
//     can fail closed; it does not make a deletion safe.
//   * `allowedRoots` is trust the caller supplies. This module cannot prove a root is real or that
//     its ancestors contain no junction; that is `assertCanonicalDir`'s job and a separate gate. The
//     provenance brand proves only that SOME trusted caller ran `validateJournal` with SOME
//     allowlist in this module instance — it cannot prove that allowlist was the right one, so a
//     caller that passes a hostile allowlist defeats the root check on its own authority.
//   * Pure functions cannot observe the filesystem, so `planRecovery` trusts the observations'
//     *content*. Whether a "worker exited" proof is genuine is the observer's responsibility.
//   * No hostile-Proxy immunity beyond single-read descriptor capture: values are read once through
//     `Object.getOwnPropertyDescriptor`, so a Proxy cannot present different values to validation
//     and to the returned record, but it can still lie about what the record contains. A Proxy is
//     never itself branded, so a proxied record cannot reach `planRecovery`.
//   * Diagnostics never coerce an untrusted value. A refused input is described by type (and, for a
//     string, by a truncated quoted copy), so no `toJSON`, getter, `valueOf` or `toString` of the
//     caller's object ever runs for the sake of an error message, a BigInt or cyclic value cannot
//     turn a refusal into a raw TypeError, and every reflection step that can throw (including
//     `Array.isArray` and `length` on a revoked Proxy) is caught and normalized to a JournalError.

import path from "node:path";

/** Journal schema version. Bump only with a new validator; a record with any other version is invalid. */
export const version = 1;

/** Fixed active wiki directory name (spec 007). Duplicated on purpose: this module imports nothing. */
const WIKI_DIR_NAME = ".dsh-wiki";

/** The only phases a version-1 record may declare. */
export const PHASES = Object.freeze([
  "created",
  "worker-running",
  "worker-stopped",
  "validated",
  "live-moved",
  "published",
  "rolled-back",
  "aborted",
]);

/** The only decisions `planRecovery` may return. */
export const DECISIONS = Object.freeze(["no-op", "restore-backup", "cleanup", "manual", "quarantine"]);

/** Stable public error codes. Do not rename; consumers branch on these values. */
export const ERROR_CODES = Object.freeze({
  INVALID_OPTIONS: "invalid-options",
  INVALID_RECORD: "invalid-record",
  UNKNOWN_KEY: "unknown-key",
  INVALID_VERSION: "invalid-version",
  INVALID_JOB_ID: "invalid-job-id",
  INVALID_HOST_INSTANCE_ID: "invalid-host-instance-id",
  INVALID_SESSION_ID: "invalid-session-id",
  INVALID_ROOT: "invalid-root",
  ROOT_NOT_ALLOWED: "root-not-allowed",
  INVALID_PATH: "invalid-path",
  FORGED_PATH: "forged-path",
  INVALID_IDENTITY: "invalid-identity",
  INVALID_HASH: "invalid-hash",
  INVALID_PHASE: "invalid-phase",
  INCONSISTENT_PHASE: "inconsistent-phase",
  INVALID_OBSERVATIONS: "invalid-observations",
  RECORD_NOT_VALIDATED: "record-not-validated",
});

/** Typed error for every refusal. `code` is one of ERROR_CODES. */
export class JournalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "JournalError";
    this.code = code;
  }
}

const isWin = process.platform === "win32";

/**
 * Provenance brand: exactly the frozen objects `validateJournal` returned, and nothing else. This is
 * the only authority `planRecovery` accepts. Structural validity cannot substitute for it, because
 * the allowlist check happens in `validateJournal` against roots the trusted caller supplied, so an
 * unbranded but well-formed record (structural clone, JSON round trip, deserialized record, forged
 * root) has never been authorized by anyone. The WeakSet is module-private: no export, no key, no
 * symbol exposes it, so an outside caller cannot re-brand a clone or transfer an existing brand. It
 * is per module instance — a copy of this module validates with its own brand, which fails closed.
 */
const AUTHORIZED_RECORDS = new WeakSet();

/**
 * Plan brand: exactly the frozen result objects `makeResult` returned, and nothing else. Same rules as
 * `AUTHORIZED_RECORDS` — module-private, per object, never transferred — and the only way to read it
 * is the `isRecoveryPlan` predicate below, which cannot create authority.
 */
const AUTHORIZED_PLANS = new WeakSet();

// ---------- bounds and shapes ----------

const MAX_PATH_LENGTH = 4096;
const MAX_TOKEN_LENGTH = 256;
const MIN_TOKEN_LENGTH = 8;
const MAX_DECIMAL_LENGTH = 32;
const MAX_IDENTITY_LENGTH = 512;
const MAX_ALLOWED_ROOTS = 64;

const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const JOB_ID_RE = /^[a-z0-9]{1,64}$/;
const DECIMAL_RE = /^(0|[1-9][0-9]*)$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const RESERVED_WIN_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$|clock\$)(\..*)?$/i;

const JOURNAL_KEYS = Object.freeze([
  "version",
  "jobId",
  "hostInstanceId",
  "rootReal",
  "rootIdentity",
  "stagePath",
  "livePath",
  "backupPath",
  "workerSessionId",
  "protocolSha256",
  "promptSha256",
  "phase",
  "snapshots",
]);

const SNAPSHOT_KEYS = Object.freeze(["stage", "live", "backup"]);
const IDENTITY_KEYS = Object.freeze(["dev", "ino", "kind", "nlink"]);
const IDENTITY_KINDS = Object.freeze(["dir", "file", "other"]);
const OBSERVATION_KEYS = Object.freeze(["hostInstanceId", "worker", "root", "stage", "live", "backup"]);
const ENTRY_KEYS = Object.freeze(["state", "identity"]);
const WORKER_KEYS = Object.freeze(["state", "proof", "sessionId"]);
const ENTRY_STATES = Object.freeze(["present", "absent", "unknown"]);
const WORKER_STATES = Object.freeze(["alive", "stopped", "unknown"]);
/**
 * The ONLY proof vocabulary `planRecovery` accepts for `observations.worker.proof`, exported so a
 * liveness provider can be tested against it instead of restating it (two modules disagreeing on this
 * vocabulary is exactly how a production provider came to hand the planner a value it rejected as
 * malformed data). Read-only: a frozen array of three strings grants no authority, it only names what
 * the planner already decides on.
 */
export const WORKER_PROOFS = Object.freeze(["process-exit", "host-registry", "worker-session-id"]);

// ---------- small helpers ----------

function fail(code, message) {
  throw new JournalError(code, message);
}

/**
 * `Array.isArray` that never throws. It is not trap-free: on a revoked Proxy it throws a raw
 * TypeError outside any handler, which would escape as an untyped failure instead of a JournalError.
 */
function isArraySafe(value) {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}

/**
 * Noncoercing type label for diagnostics. Uses only `typeof` and a guarded `Array.isArray`, so it
 * never runs caller code: no getter, no `toJSON`, no `valueOf`, no `Symbol.toPrimitive`, no proxy
 * trap other than the caught `IsArray`. A value whose reflection throws is labelled "uninspectable
 * object" rather than being allowed to throw.
 */
function typeName(value) {
  if (value === null) return "null";
  if (typeof value !== "object") return typeof value;
  let isArray;
  try {
    isArray = Array.isArray(value);
  } catch {
    return "uninspectable object";
  }
  return isArray ? "array" : "object";
}

const MAX_LABEL_LENGTH = 48;

/**
 * Noncoercing diagnostic text for one rejected value. Deliberately NEVER calls `String(value)`,
 * `JSON.stringify(value)` or any method on an untrusted object, because that can invoke a `toJSON`
 * method or a getter (running caller code for a mere diagnostic or mutating state), throw a raw
 * TypeError on a BigInt or a cycle, and depend on values that were never validated. Strings are
 * quoted from a truncated copy so a hostile field cannot inject lines into a log or blow up the
 * message; every other type is described by its type only.
 */
function valueLabel(value) {
  const type = typeName(value);
  if (type === "string") {
    const text = value.length > MAX_LABEL_LENGTH ? `${value.slice(0, MAX_LABEL_LENGTH)}...` : value;
    return `the string ${JSON.stringify(text)}`;
  }
  if (type === "number") return `the number ${Object.is(value, -0) ? "-0" : String(value)}`;
  if (type === "boolean") return `the boolean ${value === true ? "true" : "false"}`;
  return `a value of type ${type}`;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  let proto;
  try {
    // Both steps reflect on an untrusted object, so both stay inside one guard: a revoked Proxy
    // throws on `IsArray` and a hostile `getPrototypeOf` trap can throw too, and neither may escape
    // as a raw TypeError.
    if (Array.isArray(value)) return false;
    proto = Object.getPrototypeOf(value);
  } catch {
    return false;
  }
  return proto === Object.prototype || proto === null;
}

/**
 * Read the own properties of a plain object exactly once, rejecting symbols, accessors and
 * non-enumerable properties, and return a Map of captured values. Using captured descriptor values
 * means every later check sees the same value that was validated.
 */
function ownData(object, label, code) {
  if (!isPlainObject(object)) fail(code, `${label} must be a plain object, got ${typeName(object)}`);
  let keys;
  try {
    keys = Reflect.ownKeys(object);
  } catch {
    fail(code, `${label} cannot be inspected`);
  }
  const values = new Map();
  for (const key of keys) {
    if (typeof key !== "string") fail(ERROR_CODES.UNKNOWN_KEY, `${label} must not have symbol keys`);
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(object, key);
    } catch {
      fail(code, `${label} cannot be inspected`);
    }
    if (!descriptor) fail(code, `${label}.${key} disappeared while it was being read`);
    if (typeof descriptor.get === "function" || typeof descriptor.set === "function") {
      fail(ERROR_CODES.UNKNOWN_KEY, `${label}.${key} must be a plain data property, not an accessor`);
    }
    if (descriptor.enumerable !== true) {
      fail(ERROR_CODES.UNKNOWN_KEY, `${label}.${key} must be an enumerable own property`);
    }
    values.set(key, descriptor.value);
  }
  return values;
}

/** Closed own-key schema check. `allowed` is the complete set of permitted keys. */
function assertKeys(values, allowed, label, code) {
  for (const key of values.keys()) {
    if (!allowed.includes(key)) fail(ERROR_CODES.UNKNOWN_KEY, `${label} has an unknown key "${key}"`);
  }
  for (const key of allowed) {
    if (!values.has(key)) fail(code, `${label}.${key} is required`);
  }
}

function normalizeForCompare(value) {
  const resolved = path.normalize(value);
  const root = path.parse(resolved).root;
  const trimmed = resolved.length > root.length ? resolved.replace(/[\\/]+$/, "") : resolved;
  return isWin ? trimmed.toLowerCase() : trimmed;
}

/** Case/format-insensitive path equality for the host platform (canonical inputs expected). */
function samePath(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  return normalizeForCompare(a) === normalizeForCompare(b);
}

function token(raw, label, code) {
  if (typeof raw !== "string") fail(code, `${label} must be a string, got ${typeName(raw)}`);
  if (raw.length < MIN_TOKEN_LENGTH || raw.length > MAX_TOKEN_LENGTH) {
    fail(code, `${label} must be ${MIN_TOKEN_LENGTH}-${MAX_TOKEN_LENGTH} characters`);
  }
  if (!TOKEN_RE.test(raw)) {
    fail(code, `${label} must be ASCII letters, digits, ".", "_" or "-" and start with a letter or digit`);
  }
  if (raw.includes("..")) fail(code, `${label} must not contain ".."`);
  if (raw.endsWith(".")) fail(code, `${label} must not end with "."`);
  return raw;
}

// ---------- paths ----------

/**
 * Validate one caller-supplied absolute path and return its canonical form. Stricter than
 * `path.resolve`: no traversal, no UNC/device path, no Windows stream syntax, no reserved device
 * name, no trailing separator, no control characters.
 */
function canonicalPath(raw, label, code) {
  if (typeof raw !== "string") fail(code, `${label} must be a string, got ${typeName(raw)}`);
  if (raw.length === 0) fail(code, `${label} is empty`);
  if (raw.length > MAX_PATH_LENGTH) fail(code, `${label} is longer than ${MAX_PATH_LENGTH} characters`);
  if (raw.includes("\u0000")) fail(code, `${label} contains a NUL byte`);
  if (/[\u0000-\u001f\u007f]/.test(raw)) fail(code, `${label} contains control characters`);
  if (!path.isAbsolute(raw)) fail(code, `${label} must be an absolute path`);
  if (/[\\/]$/.test(raw)) fail(code, `${label} must not end with a path separator`);

  if (isWin) {
    if (/^[\\/]{2}/.test(raw)) fail(code, `${label} must not be a UNC, device or extended-length path`);
    if (!/^[a-zA-Z]:[\\/]/.test(raw)) fail(code, `${label} must be a drive-qualified absolute path`);
  } else if (raw.startsWith("//")) {
    fail(code, `${label} must not be a UNC-like path`);
  }

  const segments = raw.split(isWin ? /[\\/]+/ : /\/+/);
  for (const [index, segment] of segments.entries()) {
    if (segment.length === 0) continue;
    if (segment === "." || segment === "..") fail(code, `${label} must not contain a "${segment}" segment`);
    if (!isWin) continue;
    if (index === 0 && /^[a-zA-Z]:$/.test(segment)) continue;
    if (/[<>"|?*]/.test(segment)) fail(code, `${label} contains a character Windows does not allow`);
    if (segment.includes(":")) fail(code, `${label} contains a Windows alternate-data-stream separator`);
    if (/[. ]$/.test(segment)) fail(code, `${label} contains a segment ending in a dot or space`);
    if (RESERVED_WIN_NAMES.test(segment)) fail(code, `${label} uses a reserved Windows device name`);
  }

  let resolved;
  try {
    resolved = path.resolve(raw);
  } catch {
    fail(code, `${label} cannot be resolved`);
  }
  const root = path.parse(resolved).root;
  if (root.length === 0 || !path.isAbsolute(root)) fail(code, `${label} has no absolute filesystem root`);
  if (!samePath(resolved, raw)) fail(code, `${label} is not in canonical lexical form`);
  return resolved;
}

/** Canonical allowlisted repository root: additionally rejected when it is a filesystem root. */
function canonicalRoot(raw, label, code) {
  const resolved = canonicalPath(raw, label, code);
  if (samePath(resolved, path.parse(resolved).root)) fail(code, `${label} must not be a filesystem root`);
  return resolved;
}

/** Bind one record path to its exact required value; anything else is a forged binding. */
function bindExactPath(raw, expected, label) {
  const resolved = canonicalPath(raw, label, ERROR_CODES.INVALID_PATH);
  if (!samePath(resolved, expected)) {
    fail(ERROR_CODES.FORGED_PATH, `${label} must be exactly ${JSON.stringify(expected)}, got ${JSON.stringify(resolved)}`);
  }
  return resolved;
}

// ---------- identities ----------

function decimalId(value, label) {
  if (typeof value !== "string") fail(ERROR_CODES.INVALID_IDENTITY, `${label} must be a base-10 string`);
  if (value.length === 0 || value.length > MAX_DECIMAL_LENGTH) {
    fail(ERROR_CODES.INVALID_IDENTITY, `${label} must be a non-empty base-10 string of at most ${MAX_DECIMAL_LENGTH} digits`);
  }
  if (!DECIMAL_RE.test(value)) {
    fail(ERROR_CODES.INVALID_IDENTITY, `${label} must be a normalized non-negative base-10 string (no sign, no leading zeros)`);
  }
  return value;
}

/**
 * Parse a canonical identity JSON string into a frozen `{dev, ino, kind, nlink}` object whose values
 * are all strings (the same shape this package's identity primitive returns for an inspected entry).
 */
function parseIdentity(raw, label) {
  if (typeof raw !== "string") fail(ERROR_CODES.INVALID_IDENTITY, `${label} must be a JSON string, got ${typeName(raw)}`);
  if (raw.length === 0) fail(ERROR_CODES.INVALID_IDENTITY, `${label} is empty`);
  if (raw.length > MAX_IDENTITY_LENGTH) {
    fail(ERROR_CODES.INVALID_IDENTITY, `${label} is longer than ${MAX_IDENTITY_LENGTH} characters`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(ERROR_CODES.INVALID_IDENTITY, `${label} is not valid JSON`);
  }
  const values = ownData(parsed, label, ERROR_CODES.INVALID_IDENTITY);
  for (const key of values.keys()) {
    if (!IDENTITY_KEYS.includes(key)) fail(ERROR_CODES.INVALID_IDENTITY, `${label} has an unknown key "${key}"`);
  }
  for (const key of IDENTITY_KEYS) {
    if (!values.has(key)) fail(ERROR_CODES.INVALID_IDENTITY, `${label}.${key} is required`);
  }
  const dev = decimalId(values.get("dev"), `${label}.dev`);
  const ino = decimalId(values.get("ino"), `${label}.ino`);
  const kind = values.get("kind");
  if (!IDENTITY_KINDS.includes(kind)) {
    fail(ERROR_CODES.INVALID_IDENTITY, `${label}.kind must be one of ${IDENTITY_KINDS.join(", ")}`);
  }
  const nlink = decimalId(values.get("nlink"), `${label}.nlink`);
  const canonical = JSON.stringify({ dev, ino, kind, nlink });
  if (canonical !== raw) {
    fail(ERROR_CODES.INVALID_IDENTITY, `${label} is not canonically serialized; expected exactly ${canonical}`);
  }
  return Object.freeze({ dev, ino, kind, nlink });
}

/** Every path this journal binds is a directory, so a non-directory identity is refused outright. */
function parseDirectoryIdentity(raw, label) {
  const identity = parseIdentity(raw, label);
  if (identity.kind !== "dir") {
    fail(ERROR_CODES.INVALID_IDENTITY, `${label} must describe a directory (kind "dir"), got "${identity.kind}"`);
  }
  return identity;
}

/**
 * Identity comparison for recovery decisions: dev, ino and kind must match exactly. `nlink` is
 * deliberately excluded — a directory's link count changes as subdirectories appear and disappear.
 */
function sameIdentity(observed, expected) {
  return observed.dev === expected.dev && observed.ino === expected.ino && observed.kind === expected.kind;
}

// ---------- journal normalization ----------

function normalizeSnapshots(raw) {
  const values = ownData(raw, "journal snapshots", ERROR_CODES.INVALID_RECORD);
  assertKeys(values, SNAPSHOT_KEYS, "journal snapshots", ERROR_CODES.INVALID_RECORD);
  const snapshots = {};
  for (const key of SNAPSHOT_KEYS) {
    const value = values.get(key);
    // Validate now, but keep the canonical JSON string: the normalized record must itself be a
    // valid version-1 record, so a caller can persist and re-validate it without loss.
    if (value !== null) parseDirectoryIdentity(value, `journal snapshots.${key}`);
    snapshots[key] = value;
  }
  return Object.freeze(snapshots);
}

function enforcePhaseInvariants(phase, snapshots) {
  const check = (condition, message) => {
    if (!condition) fail(ERROR_CODES.INCONSISTENT_PHASE, message);
  };
  switch (phase) {
    case "created":
      check(snapshots.stage === null, 'phase "created" must not bind a staging identity (nothing was staged yet)');
      check(snapshots.backup === null, 'phase "created" must not bind a backup identity');
      break;
    case "worker-running":
    case "worker-stopped":
    case "validated":
      check(snapshots.stage !== null, `phase "${phase}" requires a bound staging identity`);
      check(snapshots.backup === null, `phase "${phase}" must not bind a backup identity`);
      break;
    case "live-moved":
      check(snapshots.stage !== null, 'phase "live-moved" requires a bound staging identity');
      check(snapshots.live === null, 'phase "live-moved" must bind the live path as absent');
      break;
    case "published":
      check(snapshots.stage === null, 'phase "published" must bind the staging path as absent');
      check(snapshots.live !== null, 'phase "published" requires the published candidate identity as snapshots.live');
      break;
    case "rolled-back":
    case "aborted":
      check(snapshots.backup === null, `phase "${phase}" must not bind a backup identity`);
      break;
    default:
      fail(ERROR_CODES.INVALID_PHASE, `unknown phase ${valueLabel(phase)}`);
  }
}

/**
 * Structural normalization shared by `validateJournal` (with the caller's allowlist) and
 * `planRecovery` (re-checking a previously validated record without re-deriving the allowlist).
 * `allowedRoots` is an array of canonical roots, or `null` to skip the allowlist test.
 *
 * `planRecovery` passes `null` and that is sound ONLY because it is reached exclusively for records
 * already branded by `validateJournal`, which did run the allowlist test against roots supplied by
 * the trusted caller. Never call this with `null` on an unbranded record: the resulting record would
 * look authorized while no allowlist was ever consulted.
 */
function normalizeJournal(record, allowedRoots) {
  const values = ownData(record, "journal record", ERROR_CODES.INVALID_RECORD);
  assertKeys(values, JOURNAL_KEYS, "journal record", ERROR_CODES.INVALID_RECORD);

  const declaredVersion = values.get("version");
  if (declaredVersion !== version) {
    fail(ERROR_CODES.INVALID_VERSION, `journal version must be the number ${version}, got ${valueLabel(declaredVersion)}`);
  }

  const jobId = values.get("jobId");
  if (typeof jobId !== "string" || !JOB_ID_RE.test(jobId)) {
    fail(ERROR_CODES.INVALID_JOB_ID, `jobId must be 1-64 lowercase ASCII letters or digits, got ${valueLabel(jobId)}`);
  }

  const hostInstanceId = token(values.get("hostInstanceId"), "hostInstanceId", ERROR_CODES.INVALID_HOST_INSTANCE_ID);
  const workerSessionId = token(values.get("workerSessionId"), "workerSessionId", ERROR_CODES.INVALID_SESSION_ID);

  const rootReal = canonicalRoot(values.get("rootReal"), "rootReal", ERROR_CODES.INVALID_ROOT);
  if (allowedRoots !== null && !allowedRoots.some((allowed) => samePath(allowed, rootReal))) {
    fail(
      ERROR_CODES.ROOT_NOT_ALLOWED,
      `rootReal ${JSON.stringify(rootReal)} is not one of the ${allowedRoots.length} allowlisted canonical root(s) supplied by the caller`,
    );
  }
  const rootIdentity = values.get("rootIdentity");
  parseDirectoryIdentity(rootIdentity, "rootIdentity");

  const stagePath = bindExactPath(
    values.get("stagePath"),
    path.join(rootReal, `${WIKI_DIR_NAME}.staging-${jobId}`),
    "stagePath",
  );
  const livePath = bindExactPath(values.get("livePath"), path.join(rootReal, WIKI_DIR_NAME), "livePath");
  const backupPath = bindExactPath(
    values.get("backupPath"),
    path.join(rootReal, `${WIKI_DIR_NAME}.bak-${jobId}`),
    "backupPath",
  );

  const protocolSha256 = values.get("protocolSha256");
  if (typeof protocolSha256 !== "string" || !SHA256_RE.test(protocolSha256)) {
    fail(ERROR_CODES.INVALID_HASH, "protocolSha256 must be 64 lowercase hexadecimal characters");
  }
  const promptSha256 = values.get("promptSha256");
  if (typeof promptSha256 !== "string" || !SHA256_RE.test(promptSha256)) {
    fail(ERROR_CODES.INVALID_HASH, "promptSha256 must be 64 lowercase hexadecimal characters");
  }

  const phase = values.get("phase");
  if (!PHASES.includes(phase)) {
    fail(ERROR_CODES.INVALID_PHASE, `phase must be one of ${PHASES.join(", ")}, got ${valueLabel(phase)}`);
  }

  const snapshots = normalizeSnapshots(values.get("snapshots"));
  enforcePhaseInvariants(phase, snapshots);

  return Object.freeze({
    version,
    jobId,
    hostInstanceId,
    rootReal,
    rootIdentity,
    stagePath,
    livePath,
    backupPath,
    workerSessionId,
    protocolSha256,
    promptSha256,
    phase,
    snapshots,
  });
}

function readAllowedRoots(raw) {
  if (!isArraySafe(raw)) {
    fail(
      ERROR_CODES.INVALID_OPTIONS,
      `allowedRoots must be an array of canonical absolute roots, got ${typeName(raw)}`,
    );
  }
  // `length` is a trap on an array Proxy and a hostile one can throw or return nonsense; read it
  // once inside a guard and validate it before using it as a loop bound.
  let length;
  try {
    length = raw.length;
  } catch {
    fail(ERROR_CODES.INVALID_OPTIONS, "allowedRoots cannot be inspected");
  }
  if (!Number.isSafeInteger(length) || length < 0) {
    fail(ERROR_CODES.INVALID_OPTIONS, "allowedRoots cannot be inspected");
  }
  if (length === 0) fail(ERROR_CODES.INVALID_OPTIONS, "allowedRoots must not be empty");
  if (length > MAX_ALLOWED_ROOTS) {
    fail(ERROR_CODES.INVALID_OPTIONS, `allowedRoots must not have more than ${MAX_ALLOWED_ROOTS} entries`);
  }
  const roots = [];
  for (let index = 0; index < length; index++) {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(raw, String(index));
    } catch {
      fail(ERROR_CODES.INVALID_OPTIONS, `allowedRoots[${index}] cannot be read`);
    }
    if (
      !descriptor ||
      typeof descriptor.get === "function" ||
      typeof descriptor.set === "function" ||
      descriptor.enumerable !== true
    ) {
      fail(ERROR_CODES.INVALID_OPTIONS, `allowedRoots[${index}] must be a plain data element`);
    }
    if (typeof descriptor.value !== "string") {
      fail(ERROR_CODES.INVALID_OPTIONS, `allowedRoots[${index}] must be a string, got ${typeName(descriptor.value)}`);
    }
    roots.push(canonicalRoot(descriptor.value, `allowedRoots[${index}]`, ERROR_CODES.INVALID_ROOT));
  }
  return Object.freeze(roots);
}

// ---------- observations ----------

function normalizeEntry(raw, label) {
  const values = ownData(raw, label, ERROR_CODES.INVALID_OBSERVATIONS);
  for (const key of values.keys()) {
    if (!ENTRY_KEYS.includes(key)) fail(ERROR_CODES.INVALID_OBSERVATIONS, `${label} has an unknown key "${key}"`);
  }
  if (!values.has("state")) fail(ERROR_CODES.INVALID_OBSERVATIONS, `${label}.state is required`);
  const state = values.get("state");
  if (!ENTRY_STATES.includes(state)) {
    fail(ERROR_CODES.INVALID_OBSERVATIONS, `${label}.state must be one of ${ENTRY_STATES.join(", ")}`);
  }
  if (state === "present") {
    if (!values.has("identity")) fail(ERROR_CODES.INVALID_OBSERVATIONS, `${label}.identity is required when state is "present"`);
    return Object.freeze({ state, identity: parseDirectoryIdentity(values.get("identity"), `${label}.identity`) });
  }
  if (values.has("identity")) {
    fail(ERROR_CODES.INVALID_OBSERVATIONS, `${label}.identity is only allowed when state is "present"`);
  }
  return Object.freeze({ state });
}

function normalizeWorker(raw) {
  const values = ownData(raw, "observations.worker", ERROR_CODES.INVALID_OBSERVATIONS);
  for (const key of values.keys()) {
    if (!WORKER_KEYS.includes(key)) fail(ERROR_CODES.INVALID_OBSERVATIONS, `observations.worker has an unknown key "${key}"`);
  }
  if (!values.has("state")) fail(ERROR_CODES.INVALID_OBSERVATIONS, "observations.worker.state is required");
  const state = values.get("state");
  if (!WORKER_STATES.includes(state)) {
    fail(ERROR_CODES.INVALID_OBSERVATIONS, `observations.worker.state must be one of ${WORKER_STATES.join(", ")}`);
  }
  const proof = values.has("proof") ? values.get("proof") : undefined;
  if (proof !== undefined) {
    if (!WORKER_PROOFS.includes(proof)) {
      fail(ERROR_CODES.INVALID_OBSERVATIONS, `observations.worker.proof must be one of ${WORKER_PROOFS.join(", ")}`);
    }
    if (state !== "stopped") {
      fail(ERROR_CODES.INVALID_OBSERVATIONS, 'observations.worker.proof is only meaningful when state is "stopped"');
    }
  }
  const sessionId = values.has("sessionId")
    ? token(values.get("sessionId"), "observations.worker.sessionId", ERROR_CODES.INVALID_OBSERVATIONS)
    : undefined;
  return Object.freeze({
    state,
    ...(proof === undefined ? {} : { proof }),
    ...(sessionId === undefined ? {} : { sessionId }),
  });
}

function normalizeObservations(raw) {
  const values = ownData(raw, "observations", ERROR_CODES.INVALID_OBSERVATIONS);
  assertKeys(values, OBSERVATION_KEYS, "observations", ERROR_CODES.INVALID_OBSERVATIONS);
  return Object.freeze({
    hostInstanceId: token(values.get("hostInstanceId"), "observations.hostInstanceId", ERROR_CODES.INVALID_OBSERVATIONS),
    worker: normalizeWorker(values.get("worker")),
    root: normalizeEntry(values.get("root"), "observations.root"),
    stage: normalizeEntry(values.get("stage"), "observations.stage"),
    live: normalizeEntry(values.get("live"), "observations.live"),
    backup: normalizeEntry(values.get("backup"), "observations.backup"),
  });
}

// ---------- plan result ----------

function makeResult(base, decision, code, reason, actions = []) {
  if (!DECISIONS.includes(decision)) fail(ERROR_CODES.INVALID_RECORD, `internal: unknown decision ${JSON.stringify(decision)}`);
  if (decision !== "restore-backup" && decision !== "cleanup" && actions.length !== 0) {
    fail(ERROR_CODES.INVALID_RECORD, `internal: decision "${decision}" must not carry actions`);
  }
  if (typeof code !== "string" || code.length === 0) fail(ERROR_CODES.INVALID_RECORD, "internal: a result needs a code");
  if (typeof reason !== "string" || reason.length === 0) fail(ERROR_CODES.INVALID_RECORD, "internal: a result needs a reason");
  const plan = Object.freeze({
    version,
    jobId: base.jobId,
    phase: base.phase,
    restart: base.restart,
    worker: base.worker,
    decision,
    code,
    reason,
    actions: Object.freeze(actions),
  });
  // Brand the returned object: this exact plan is the only authorization the trusted executor accepts
  // before an effect, and `Object.freeze` means the branded content cannot be edited afterwards.
  AUTHORIZED_PLANS.add(plan);
  return plan;
}

const SYMBOLIC_NOTE =
  "symbolic only: nothing was renamed or deleted. The executor must re-verify the bound identity and the destination absence immediately before acting, and must never act on a filename, prefix or mtime match.";

function restoreBackupAction(journal, expectedBackup, expectedRoot) {
  return Object.freeze({
    action: "restore-backup",
    src: journal.backupPath,
    dest: journal.livePath,
    expect: Object.freeze({
      src: expectedBackup,
      srcParent: expectedRoot,
      destParent: expectedRoot,
    }),
    requiresDestinationAbsent: true,
    note: SYMBOLIC_NOTE,
  });
}

function removeAction(action, targetPath, expectedIdentity, expectedRoot) {
  return Object.freeze({
    action,
    path: targetPath,
    identity: expectedIdentity,
    parentIdentity: expectedRoot,
    note: `${SYMBOLIC_NOTE} A removal cannot be made identity-safe with portable Node primitives, so the executor must fail closed rather than remove a path it cannot re-verify.`,
  });
}

// ---------- public API ----------

/**
 * Validate and normalize one version-1 transaction journal record.
 *
 * @param {object} record untrusted record to validate
 * @param {{allowedRoots: string[]}} options REQUIRED; canonical absolute repository roots the
 *   trusted caller has already authorized (no discovery, no defaults)
 * @returns {Readonly<object>} frozen normalized record; use this object, not the input. This exact
 *   object is branded as the only record `planRecovery` will accept, so a caller that must persist
 *   it has to re-validate the reloaded copy with the same external allowlist before planning
 * @throws {JournalError} on any malformed, forged, unallowlisted or inconsistent input
 */
export function validateJournal(record, options) {
  const optionValues = ownData(options, "options", ERROR_CODES.INVALID_OPTIONS);
  for (const key of optionValues.keys()) {
    if (key !== "allowedRoots") fail(ERROR_CODES.INVALID_OPTIONS, `unknown option "${key}"`);
  }
  if (!optionValues.has("allowedRoots")) {
    fail(ERROR_CODES.INVALID_OPTIONS, "allowedRoots is required: the trusted caller must supply the allowlisted canonical root(s)");
  }
  const allowedRoots = readAllowedRoots(optionValues.get("allowedRoots"));
  const normalized = normalizeJournal(record, allowedRoots);
  // Brand the returned (frozen, detached) object. Nothing else in this module adds to the WeakSet,
  // and `Object.freeze` means the branded content cannot be edited afterwards to repoint a root.
  AUTHORIZED_RECORDS.add(normalized);
  return normalized;
}

/**
 * Decide what (if anything) may be done about a validated transaction after a crash or restart.
 * Pure and deterministic: no filesystem access, no timers, no persistence.
 *
 * @param {object} validRecord MUST be an object returned by `validateJournal` in this module
 *   instance. A structurally valid copy, clone or deserialized record is refused; re-validate it
 *   with the caller's external allowlist first
 * @param {object} observations trusted observations of actual identities and worker liveness
 * @returns {Readonly<{version:number, jobId:string, phase:string, restart:boolean, worker:string,
 *   decision:"no-op"|"restore-backup"|"cleanup"|"manual"|"quarantine", code:string, reason:string,
 *   actions: ReadonlyArray<object>}>}
 * @throws {JournalError} `record-not-validated` when the record is not one `validateJournal`
 *   returned; other codes when observations are malformed; a valid but ambiguous state returns
 *   `manual`/`quarantine` with no actions instead
 */
export function planRecovery(validRecord, observations) {
  // Provenance gate, FIRST and before any action can be computed. Only a record this module both
  // validated and allowlist-checked may plan a rename or a removal; structural re-validation below
  // cannot stand in for that, because it runs with `allowedRoots === null` and an unbranded
  // well-formed record (clone, JSON round trip, deserialized journal, forged root) would otherwise
  // authorize cleanup of a directory the trusted caller never allowlisted. Nothing a caller supplies
  // here can re-brand it: the WeakSet is private and clones are never members.
  if (!AUTHORIZED_RECORDS.has(validRecord)) {
    fail(
      ERROR_CODES.RECORD_NOT_VALIDATED,
      "planRecovery accepts only the object returned by validateJournal(record, { allowedRoots }) in this module instance; a structurally valid copy, clone, JSON round trip or deserialized record is not authorized. Re-validate it with the trusted caller's allowlist first",
    );
  }
  // Re-validation is kept as defence in depth: it re-checks the (frozen) branded content and rebuilds
  // the decisions from captured descriptor values rather than from live property reads.
  const journal = normalizeJournal(validRecord, null);
  const obs = normalizeObservations(observations);

  const restart = obs.hostInstanceId !== journal.hostInstanceId;
  const base = Object.freeze({ jobId: journal.jobId, phase: journal.phase, restart, worker: obs.worker.state });
  const result = (decision, code, reason, actions) => makeResult(base, decision, code, reason, actions);

  // ---- liveness gate: no trust in labels or session ids, and an old host needs independent proof ----
  if (obs.worker.state === "alive") {
    return result(
      "quarantine",
      "worker-alive",
      "a worker is reported alive for this transaction; nothing may be renamed or deleted, and the repository fence stays raised",
    );
  }
  if (obs.worker.state === "unknown") {
    return result(
      "quarantine",
      "worker-liveness-unknown",
      "worker liveness could not be established; an unproven worker may still be writing, so nothing may be renamed or deleted",
    );
  }
  if (obs.worker.proof === undefined) {
    return result(
      "quarantine",
      "worker-proof-missing",
      'the worker is reported stopped but no independent proof was supplied; "stopped" alone is not evidence',
    );
  }
  if (obs.worker.proof === "worker-session-id") {
    return result(
      "quarantine",
      "worker-proof-session-id-only",
      "a worker session id is not proof of termination, whether or not it matches the recorded session (a restarted Host cannot vouch for an old process)",
    );
  }
  if (restart && obs.worker.proof !== "process-exit") {
    return result(
      "quarantine",
      "worker-proof-not-independent",
      "the record was written by a different Host instance; only independent proof that the process exited is acceptable, not the current instance's registry",
    );
  }

  // ---- root authorization/identity: recovery is never triggered for an unknown or replaced root ----
  const rootIdentity = parseDirectoryIdentity(journal.rootIdentity, "journal rootIdentity");
  if (obs.root.state === "unknown") {
    return result("manual", "root-observation-unknown", "the repository root could not be observed; no recovery is planned");
  }
  if (obs.root.state === "absent") {
    return result("manual", "root-missing", "the recorded repository root is absent; nothing is renamed or deleted");
  }
  if (!sameIdentity(obs.root.identity, rootIdentity)) {
    return result(
      "quarantine",
      "root-identity-mismatch",
      "the observed repository root identity does not match the bound root identity; the root may have been replaced, so nothing is touched",
    );
  }

  // ---- artifact observation gate: any unknown observation is ambiguity ----
  const artifacts = ["stage", "live", "backup"];
  const unknown = artifacts.filter((name) => obs[name].state === "unknown");
  if (unknown.length > 0) {
    return result(
      "manual",
      "artifact-observation-unknown",
      `${unknown.length} artifact observation(s) are unknown (${unknown.join(", ")}); an unobserved path cannot be safely renamed or deleted`,
    );
  }

  const stageIdentity =
    journal.snapshots.stage === null ? null : parseDirectoryIdentity(journal.snapshots.stage, "journal snapshots.stage");
  const liveIdentity =
    journal.snapshots.live === null ? null : parseDirectoryIdentity(journal.snapshots.live, "journal snapshots.live");
  const backupIdentity =
    journal.snapshots.backup === null ? null : parseDirectoryIdentity(journal.snapshots.backup, "journal snapshots.backup");

  const matches = (entry, expected) => entry.state === "present" && sameIdentity(entry.identity, expected);
  const liveMatches = () => (liveIdentity === null ? obs.live.state === "absent" : matches(obs.live, liveIdentity));

  const drift = (artifact) =>
    result(
      "quarantine",
      `${artifact}-identity-drift`,
      `the observed ${artifact} directory does not have the identity bound in the journal; it may have been swapped, so nothing is touched`,
    );
  const unexpected = (artifact) =>
    result(
      "manual",
      `unexpected-${artifact}`,
      `a ${artifact} artifact exists that this journal never bound; it is not renamed or deleted because only a journal-bound identity may authorize a mutation`,
    );
  const missing = (artifact) =>
    result(
      "manual",
      `${artifact}-missing`,
      `the journal-bound ${artifact} directory is absent; nothing is renamed or deleted`,
    );

  switch (journal.phase) {
    // ---------------- pre-mutation ----------------
    case "created": {
      if (obs.stage.state === "present") return unexpected("staging");
      if (obs.backup.state === "present") return unexpected("backup");
      if (!liveMatches()) return liveIdentity === null ? unexpected("live") : drift("live");
      return result(
        "no-op",
        "pre-mutation",
        "the transaction was journaled before any mutation and its artifacts agree with the record; nothing needs recovery",
      );
    }

    // ---------------- worker owned the staging directory ----------------
    case "worker-running":
    case "worker-stopped": {
      if (stageIdentity === null || !matches(obs.stage, stageIdentity)) {
        return obs.stage.state === "absent" ? missing("staging") : drift("staging");
      }
      if (!liveMatches()) return liveIdentity === null ? unexpected("live") : drift("live");
      if (obs.backup.state === "present") return unexpected("backup");
      return result(
        "manual",
        "transaction-incomplete",
        "the worker stopped before validation and publication; the previously published wiki is unchanged by the record, and the staging candidate is retained for an operator decision. Nothing is promoted or deleted automatically",
      );
    }

    // ---------------- candidate validated, publication not recorded ----------------
    case "validated": {
      if (stageIdentity === null || !matches(obs.stage, stageIdentity)) {
        return obs.stage.state === "absent" ? missing("staging") : drift("staging");
      }
      if (liveIdentity === null) {
        // First generation: no live wiki existed, so an absent live path is the recorded state.
        if (obs.live.state === "present") return unexpected("live");
        if (obs.backup.state === "present") return unexpected("backup");
        return result(
          "manual",
          "publication-not-started",
          "the candidate is validated in staging and no live wiki exists yet; publication is not automatic and the candidate is retained",
        );
      }
      if (obs.live.state === "present") {
        if (!matches(obs.live, liveIdentity)) return drift("live");
        if (obs.backup.state === "present") return unexpected("backup");
        return result(
          "manual",
          "publication-not-started",
          "the candidate is validated and the live wiki is still the recorded one; publication is not automatic",
        );
      }
      if (obs.live.state === "absent") {
        if (obs.backup.state === "present") {
          if (!matches(obs.backup, liveIdentity)) return drift("backup");
          return result(
            "restore-backup",
            "crash-between-renames",
            "the live directory is missing and the backup holds the identity that was live when the transaction started; the only safe automatic action is to restore that exact backup and leave the candidate staged",
            [restoreBackupAction(journal, liveIdentity, rootIdentity)],
          );
        }
        return result(
          "manual",
          "live-missing",
          "the recorded live directory is absent and no matching backup exists; nothing is renamed or deleted",
        );
      }
      return drift("live");
    }

    // ---------------- live directory moved to the backup path ----------------
    case "live-moved": {
      if (stageIdentity === null || !matches(obs.stage, stageIdentity)) {
        return obs.stage.state === "absent" ? missing("staging") : drift("staging");
      }
      if (obs.live.state === "present") return unexpected("live");
      if (backupIdentity === null) {
        // No published wiki existed, so the "move" had nothing to move.
        if (obs.backup.state === "present") return unexpected("backup");
        return result(
          "manual",
          "publication-incomplete",
          "the transaction recorded a live move but bound no previous live wiki; the validated candidate stays staged and publication is not automatic",
        );
      }
      if (obs.backup.state === "absent") return missing("backup");
      if (!matches(obs.backup, backupIdentity)) return drift("backup");
      return result(
        "restore-backup",
        "rollback-gap",
        "the live directory is inside the publication gap and the backup still holds the identity bound before the move; restoring that exact backup is the only safe automatic action",
        [restoreBackupAction(journal, backupIdentity, rootIdentity)],
      );
    }

    // ---------------- candidate is live; the previous wiki is only a backup ----------------
    case "published": {
      if (obs.stage.state === "present") return unexpected("staging");
      if (obs.live.state === "absent") {
        return result(
          "manual",
          "published-live-missing",
          "the record says the candidate was published, but the live directory is absent; the published state cannot be re-created automatically and no cleanup is planned",
        );
      }
      if (liveIdentity === null || !matches(obs.live, liveIdentity)) return drift("live");
      if (backupIdentity === null) {
        if (obs.backup.state === "present") return unexpected("backup");
        return result("no-op", "published", "the transaction is published and no backup artifact is bound or present");
      }
      if (obs.backup.state === "absent") {
        return result("no-op", "backup-already-removed", "the transaction is published and its bound backup was already removed");
      }
      if (!matches(obs.backup, backupIdentity)) return drift("backup");
      return result(
        "cleanup",
        "stale-backup",
        "the transaction is published, the live directory has the bound candidate identity and the backup still has the bound previous identity; the backup may be removed",
        [removeAction("remove-backup", journal.backupPath, backupIdentity, rootIdentity)],
      );
    }

    // ---------------- terminal: rolled back / aborted ----------------
    case "rolled-back":
    case "aborted": {
      const terminal = journal.phase === "rolled-back" ? "rolled-back" : "aborted";
      if (obs.backup.state === "present") return unexpected("backup");
      if (!liveMatches()) return liveIdentity === null ? unexpected("live") : drift("live");
      if (stageIdentity === null) {
        if (obs.stage.state === "present") return unexpected("staging");
        return result("no-op", `${terminal}-clean`, `the transaction is ${terminal} and no staging artifact was bound or present`);
      }
      if (obs.stage.state === "absent") {
        return result(
          "no-op",
          `${terminal}-staging-already-removed`,
          `the transaction is ${terminal} and its bound staging directory is already gone`,
        );
      }
      if (!matches(obs.stage, stageIdentity)) return drift("staging");
      return result(
        "cleanup",
        `${terminal}-staging`,
        `the transaction is ${terminal}, the worker is proven stopped and the staging directory still has its bound identity; the staging directory may be removed`,
        [removeAction("remove-staging", journal.stagePath, stageIdentity, rootIdentity)],
      );
    }

    default:
      // normalizeJournal already rejected unknown phases; this is unreachable.
      fail(ERROR_CODES.INVALID_PHASE, `unknown phase ${valueLabel(journal.phase)}`);
  }
}

/**
 * Read-only provenance probe for planner results: `true` only for a frozen object `planRecovery`
 * returned from this module instance.
 *
 * It is a membership test, never a shape test: a structural twin (spread copy, JSON round trip, an
 * object rebuilt field by field) is not a member, so a caller cannot assemble a plausible plan and
 * have it accepted. It is deliberately the ONLY addition to the brand surface — there is no matching
 * setter, so nothing here lets a caller create or transfer a brand — and exporting a predicate that
 * only READS membership gives no authority away: the trusted executor uses it to refuse an unbranded
 * plan before any filesystem effect, which is why a check deferred to journal advancement is not
 * enough.
 *
 * @param {unknown} value any candidate
 * @returns {boolean} `true` only for a plan this module instance produced
 */
export function isRecoveryPlan(value) {
  return value !== null && typeof value === "object" && AUTHORIZED_PLANS.has(value);
}
