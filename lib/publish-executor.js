// dsh-wiki — dormant trusted EXECUTOR for journal recovery plans (spec 007, T018/T020 follow-up).
//
// WHAT THIS IS
//   executeRecoveryPlan(plan, { store, snapshot, io }) performs ONLY the symbolic actions that
//   journal.js `planRecovery` produced (`restore-backup`, `remove-backup`, `remove-staging`), after
//   re-verifying every identity with fs-contain. `manual`, `quarantine` and `no-op` plans (and any plan
//   with no actions) have ZERO effects: no rename, no removal, no store write.
//   observePath(target, {io?})           builds one `planRecovery` observation entry (present/absent/
//                                        unknown) from fs-contain `identityOf`; never lists a directory.
//   removeVerifiedTree(target, expectedIdentity, parentIdentity, {io?}) is the identity-verified
//                                        recursive removal used for staging/backup cleanup.
//                                        `io.fs` overrides fs-contain primitives, `io.rm` the removal.
//
// PROVENANCE GATE — why a forged-but-consistent plan cannot reach an effect
//   Before ANY rename or removal (including the cleanup path, which never calls `store.advance()` at
//   all) the plan must be an object this process's `planRecovery` returned (`isRecoveryPlan`), and
//   `snapshot.record` must be the object the trusted journal store issued (proved by handing it to
//   `planRecovery`, whose record gate refuses anything else). Every other check below inspects plan
//   TEXT, so a plan carrying the right jobId, phase, paths and identities would pass all of them; a
//   check deferred to journal advancement runs after the rename and never runs for a cleanup.
//
// WHAT THIS IS NOT (read before trusting it)
//   * NOT atomic. Every check (identity, ancestors, scanTree, destination absence) is a point-in-time
//     syscall separated from the rename/rm it guards. A process with write access to the repository
//     root can swap a path in that window (TOCTOU). Node has no fd-relative/no-follow unlink or
//     RENAME_NOREPLACE, so this window cannot be closed here; it is narrowed (identity re-verified
//     immediately before the operation) and documented, not removed.
//   * NOT power-loss safe. The journal store reports `file-flushed` on Windows; a power cut can lose
//     the newest record, a rename, or both. After such a loss reconcile will see a state that
//     disagrees with the record and fall to manual/quarantine; it never guesses.
//   * NOT an authenticity layer for the store, the observations or the filesystem. It proves that the
//     plan is a `planRecovery` result and that the record is a `validateJournal` result the trusted
//     store issued; the caller still supplies the worker observations, and filesystem identity stays
//     an anti-swap check against a cooperating-but-sloppy or accidental adversary, not a signature.
//   * Removal refuses anything it cannot prove link-free: `scanTree` rejects symlinks/junctions,
//     hardlinked files, non-regular entries and over-large trees BEFORE any deletion, and the target
//     identity is re-verified right before `rm`. `rm` itself never follows links, but a link planted
//     after the scan is not detected until the rm call (documented TOCTOU).
//   * The record is advanced only for `restore-backup` (live-moved -> rolled-back, validated ->
//     aborted). Cleanup plans run on already-terminal records, which have no successor phase.
//
// Dependencies: node builtins + fs-contain.js + journal.js (the provenance gate and the brand probe).
// No DSH imports.

import { rm } from "node:fs/promises";
import path from "node:path";

import { ERROR_CODES as FS_CODES, FsContainError, guardedRename, identityOf, scanTree, verifySame } from "./fs-contain.js";
import { ERROR_CODES as JOURNAL_CODES, JournalError, isRecoveryPlan, planRecovery } from "./journal.js";

export class ExecutorError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ExecutorError";
    this.code = code;
    Object.assign(this, details);
  }
}

const NO_EFFECT_DECISIONS = new Set(["no-op", "manual", "quarantine"]);

/** Refusal codes, additive to the ones this module already used. Neither message carries a path. */
const PLAN_NOT_TRUSTED = "plan-not-trusted";
const RECORD_NOT_TRUSTED = "record-not-trusted";
// An unpinned store can advance another instance's record; that is recovery-only authority and is never
// granted implicitly, so a caller that did not say `recovery: true` is refused with this documented code.
const RECOVERY_NOT_DECLARED = "recovery-not-declared";

const PLAN_NOT_TRUSTED_MESSAGE =
  "executeRecoveryPlan acts only on a plan the trusted planner returned; a rebuilt, cloned, persisted or forged plan is refused before any path is touched. Nothing was done";
const RECORD_NOT_TRUSTED_MESSAGE =
  "the snapshot's record was not issued by the trusted journal store; an unbranded clone or a forged record is never acted on. Nothing was done";

/** dev/ino/kind comparison, the same identity rule journal.js and the store use (`nlink` is not one). */
const sameBoundIdentity = (a, b) =>
  a !== null &&
  typeof a === "object" &&
  b !== null &&
  typeof b === "object" &&
  String(a.dev) === String(b.dev) &&
  String(a.ino) === String(b.ino) &&
  String(a.kind) === String(b.kind);

/**
 * Prove the snapshot's record is the trusted store's, before any effect. A store only ever issues the
 * object `validateJournal` returned, and `planRecovery` refuses every other object with
 * `record-not-validated` at its provenance gate — which runs before it looks at observations. That
 * makes this deliberately observation-free call the record's provenance test: an unbranded record (a
 * clone, a JSON round trip, a forged record with plausible paths) is refused here, while a branded one
 * falls through to the observation check, which is exactly the refusal a call without observations
 * must produce. Anything unexpected fails closed as untrusted rather than passing.
 */
function assertTrustedRecord(record) {
  try {
    planRecovery(record, {});
  } catch (error) {
    // Only the refusal this call's own missing observations must produce counts as proof. The ordering
    // it relies on (record gate before observation checks) is pinned by journal-test; anything else —
    // an unbranded record, or any unexpected throw — fails closed as untrusted.
    if (error instanceof JournalError && error.code === JOURNAL_CODES.INVALID_OBSERVATIONS) return;
    throw new ExecutorError(RECORD_NOT_TRUSTED, RECORD_NOT_TRUSTED_MESSAGE);
  }
  // Unreachable: planning needs observations. Treated as untrusted, never as proof.
  throw new ExecutorError(RECORD_NOT_TRUSTED, RECORD_NOT_TRUSTED_MESSAGE);
}

/** Canonical identity JSON string exactly as journal.js requires (dev, ino, kind, nlink). */
export const identityJson = (identity) => JSON.stringify({ dev: identity.dev, ino: identity.ino, kind: identity.kind, nlink: identity.nlink });

/**
 * One planRecovery observation entry for `target`. Only a link-free existing DIRECTORY is "present";
 * a missing path is "absent"; everything else (junction/symlink in any ancestor or the entry, file,
 * unreadable) is "unknown", which planRecovery treats as ambiguity (never an action).
 */
export async function observePath(target, options = {}) {
  try {
    const identity = await identityOf(target, options.io ? { io: options.io } : {});
    if (identity.kind !== "dir") return { state: "unknown" };
    return { state: "present", identity: identityJson(identity) };
  } catch (error) {
    if (error instanceof FsContainError && error.code === FS_CODES.PATH_NOT_FOUND) return { state: "absent" };
    return { state: "unknown" };
  }
}

/**
 * Remove a directory tree only if it is exactly the bound identity and provably link-free.
 * Order: verify target + parent identity -> scanTree (rejects links/hardlinks/non-regular, bounded)
 * -> verify again immediately before -> one recursive rm. Any failure throws BEFORE removal.
 */
export async function removeVerifiedTree(target, expectedIdentity, parentIdentity, options = {}) {
  const fsOptions = options.io?.fs ? { io: options.io.fs } : {};
  const remove = options.io?.rm ?? rm;
  const parent = path.dirname(target);
  await verifySame(target, expectedIdentity, fsOptions);
  await verifySame(parent, parentIdentity, fsOptions);
  await scanTree(target, fsOptions);
  // Narrow the window: identity of the target and its parent re-verified immediately before rm.
  await verifySame(target, expectedIdentity, fsOptions);
  await verifySame(parent, parentIdentity, fsOptions);
  await remove(target, { recursive: true, force: false });
}

const parseIdentity = (text) => (text === null ? null : JSON.parse(text));

/**
 * Execute a recovery plan. `snapshot` MUST be the store snapshot of the record the plan was built
 * from (it is the compare-and-swap authority for the single record advance).
 * @returns {{executed:boolean, effects:number, decision:string, code:string, advancedTo?:string}}
 */
export async function executeRecoveryPlan(plan, { store, snapshot, io, recovery = false } = {}) {
  // Provenance gate, FIRST and before every shape test: everything below reads plan TEXT, and a forged
  // plan carrying the right jobId, phase, paths and identities passes all of it. Deferring this to
  // `store.advance()` would be too late — the rename has already happened — and the cleanup path never
  // advances a record at all.
  if (!isRecoveryPlan(plan)) throw new ExecutorError(PLAN_NOT_TRUSTED, PLAN_NOT_TRUSTED_MESSAGE);
  if (plan === null || typeof plan !== "object" || typeof plan.decision !== "string" || !Array.isArray(plan.actions)) {
    throw new ExecutorError("invalid-plan", "executeRecoveryPlan needs a planRecovery result");
  }
  if (NO_EFFECT_DECISIONS.has(plan.decision) || plan.actions.length === 0) {
    if (plan.decision === "restore-backup" || plan.decision === "cleanup") {
      throw new ExecutorError("invalid-plan", `a ${plan.decision} plan must carry actions`);
    }
    return { executed: false, effects: 0, decision: plan.decision, code: plan.code };
  }
  if (plan.decision !== "restore-backup" && plan.decision !== "cleanup") {
    throw new ExecutorError("invalid-plan", `unknown decision ${JSON.stringify(plan.decision)}`);
  }
  const record = snapshot?.record;
  if (!record || typeof store?.advance !== "function") {
    throw new ExecutorError("invalid-input", "a store with advance() and the snapshot of the planned record are required");
  }
  // The plan proves a trusted planner ran; the record proves the store the caller handed over is the
  // one that record came from. Both are checked before a path is touched, not by the later advance().
  assertTrustedRecord(record);
  if (record.jobId !== plan.jobId || record.phase !== plan.phase) {
    throw new ExecutorError("plan-record-mismatch", "the plan was not built from this snapshot's record; nothing was done");
  }
  if (plan.actions.length !== 1) {
    throw new ExecutorError("invalid-plan", "exactly one action per plan is supported; nothing was done");
  }
  const action = plan.actions[0];
  const fsOptions = io?.fs ? { io: io.fs } : {};

  if (plan.decision === "restore-backup") {
    if (action.action !== "restore-backup") throw new ExecutorError("invalid-plan", "restore-backup plan carries a different action");
    if (record.phase !== "validated" && record.phase !== "live-moved") {
      throw new ExecutorError("invalid-plan", `restore-backup is not valid for phase ${record.phase}`);
    }
    // Paths come from the validated record, never from the plan text: a plan cannot redirect a rename.
    if (action.src !== record.backupPath || action.dest !== record.livePath) {
      throw new ExecutorError("path-not-bound", "the action paths are not the record's bound backup/live paths; nothing was done");
    }
    // A restarted Host's pinned store would refuse the advance AFTER the rename: refuse before any effect.
    // An UNPINNED store (hostInstanceId === null) is the one thing that can advance a foreign record, so
    // it is never usable by accident: the caller must state `recovery: true` explicitly, and the trusted
    // recovery route is the only caller that does. Widening nothing else: a pinned store keeps the exact
    // same rule it had before (same pin or refusal).
    if (store.hostInstanceId != null) {
      if (store.hostInstanceId !== record.hostInstanceId) {
        throw new ExecutorError("host-pin-mismatch", "this store is pinned to a different host instance than the record; use a store opened for recovery. Nothing was done");
      }
    } else if (recovery !== true) {
      throw new ExecutorError(RECOVERY_NOT_DECLARED, "this store is not pinned to any host instance, so restoring another instance's backup needs an explicit recovery:true authorization; nothing was done");
    }
    // The identity renamed against is the RECORD's bound identity — at `validated` the backup holds the
    // previous live directory, at `live-moved` it holds `snapshots.backup` — never the plan's own claim:
    // a plan whose expectation disagrees with the record is refused, not believed.
    const boundIdentity = parseIdentity(record.phase === "live-moved" ? record.snapshots.backup : record.snapshots.live);
    const rootIdentity = parseIdentity(record.rootIdentity);
    if (!boundIdentity || !rootIdentity) {
      throw new ExecutorError("identity-not-bound", "the record binds no identity for the restore; nothing was done");
    }
    if (
      !sameBoundIdentity(action.expect?.src, boundIdentity) ||
      !sameBoundIdentity(action.expect?.srcParent, rootIdentity) ||
      !sameBoundIdentity(action.expect?.destParent, rootIdentity)
    ) {
      throw new ExecutorError("identity-not-bound", "the plan's expected identities are not the record's bound ones; nothing was done");
    }
    await guardedRename(record.backupPath, record.livePath, {
      expect: { src: boundIdentity, srcParent: rootIdentity, destParent: rootIdentity },
      ...fsOptions,
    });
    const s = record.snapshots;
    const next = record.phase === "live-moved"
      ? { phase: "rolled-back", snapshots: { stage: s.stage, live: s.backup, backup: null } }
      : { phase: "aborted", snapshots: { stage: s.stage, live: s.live, backup: null } };
    try {
      await store.advance(snapshot, { ...record, ...next });
    } catch (error) {
      throw new ExecutorError("advance-failed", `the backup was restored but the journal could not record ${next.phase}: ${error?.message ?? error}; the record is stale until reconcile runs again`, { renamed: true, cause: error });
    }
    return { executed: true, effects: 1, decision: plan.decision, code: plan.code, advancedTo: next.phase };
  }

  // cleanup
  let expectedPath;
  if (action.action === "remove-backup") {
    if (record.phase !== "published") throw new ExecutorError("invalid-plan", "remove-backup is only valid for a published record");
    expectedPath = record.backupPath;
  } else if (action.action === "remove-staging") {
    if (record.phase !== "rolled-back" && record.phase !== "aborted") throw new ExecutorError("invalid-plan", "remove-staging is only valid for a rolled-back/aborted record");
    expectedPath = record.stagePath;
  } else {
    throw new ExecutorError("invalid-plan", `unknown cleanup action ${JSON.stringify(action.action)}`);
  }
  if (action.path !== expectedPath) {
    throw new ExecutorError("path-not-bound", "the action path is not the record's bound path (a forged or look-alike directory is never touched); nothing was done");
  }
  const bound = action.action === "remove-backup" ? record.snapshots.backup : record.snapshots.stage;
  const identity = parseIdentity(bound);
  if (!identity || action.identity?.dev !== identity.dev || action.identity?.ino !== identity.ino) {
    throw new ExecutorError("identity-not-bound", "the action identity is not the record's bound identity; nothing was done");
  }
  await removeVerifiedTree(expectedPath, identity, parseIdentity(record.rootIdentity), { io });
  return { executed: true, effects: 1, decision: plan.decision, code: plan.code };
}
