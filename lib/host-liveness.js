// dsh-wiki — durable host-epoch record PER HOST INSTANCE plus a per-record liveness verdict
// (spec 007 / T028). WIRED: lib/index.js builds the manager's `workerLiveness` provider on top of
// this module and, for every journal record written by ANOTHER host instance, asks
// `proveEpochFor({ dir, hostInstanceId: record.hostInstanceId })` for that record's OWN verdict.
// It still cannot release a fence on its own, because nothing exposes reconcile — see the T028
// slice notes in specs/007-wiki-pipeline-i18n-models/tasks.md.
//
// WHY THE PROOF IS PER RECORD OWNER (do not regress this)
//   A journal record names the host instance that wrote it (`hostInstanceId`). The only honest
//   question is "is the host process of THAT instance still running?". An earlier wiring kept ONE
//   global verdict captured from a single shared `host-epoch.json` and applied it to every foreign
//   record, so a dead previous host turned EVERY foreign journal record into `stopped`. That proved
//   "the host that wrote the shared epoch file died", not "the host that owns THIS worker died".
//   One record per instance fixes it structurally: instance A's record says nothing about instance
//   B, and B without a record is `unknown` — never death (see ABSENCE IS NOT DEATH below).
//
// WHAT THIS PROVES — AND WHAT IT DOES NOT
//   `proveEpochFor()` answers exactly one question: is the HOST process that wrote THAT instance's
//   epoch record still running? It does NOT answer "did the worker that was writing this wiki
//   stop?". Converting one verdict into the other requires an assumption: workers cannot outlive
//   their host process. That holds here because workers are in-process subagents of the host (see
//   jobs.js), but it is an assumption, not a measurement — a host that ever spawns workers
//   out-of-process would invalidate it. Do not let a log line, plan reason or UI string promote
//   `verdict: "dead"` into "the worker stopped": the caller must state the assumption, and this
//   file cannot carry the stronger claim.
//
// MECHANICS
//   `acquireHostEpoch({ dir, hostInstanceId })` writes `{ epochId, hostInstanceId, pid, procStart,
//   procStartTicks, startedAt }` to `<dir>/<hostInstanceId>.json` (the caller passes
//   `<journal store>/host-epoch` as `dir`) through a temporary file plus ONE rename, so a crash
//   mid-write leaves the previous record intact. Because the FILE NAME is the instance token, a new
//   host can never clobber another instance's record: acquiring only ever replaces the CURRENT
//   instance's own record, and only while that record is absent or proven dead. `release()` removes
//   the record only while it still holds this epoch's `epochId`, so a host that was taken over
//   cannot delete its successor's epoch.
//   `procStartTicks` is THIS process's OS start time as .NET ticks (100 ns units from 0001-01-01),
//   queried once at acquire time and stored as a decimal STRING because the value exceeds 2^53 — a
//   JSON number would be rounded on write or read. That is what makes a recycled pid detectable:
//   the recorded ticks are compared with the OS-reported start ticks of the recorded pid, and a
//   mismatch means a DIFFERENT process now owns the pid. Both sides of that comparison are OS time,
//   so no wall clock is involved (see LIMITATIONS). `procStart` (wall-clock ms) and `startedAt`
//   (ISO) are written for humans only and are never compared.
//
// VERDICTS — `unknown` is NEVER reported as dead
//   Existence is clock-independent; only identity needs the OS tick anchor. The pid probe therefore
//   runs FIRST: a pid that no longer exists is dead whatever else the record holds. Only while the
//   pid EXISTS does the anchor decide between alive/process-matches and dead/pid-reused — a missing
//   anchor at that point is `unknown`, because a live pid with no anchor could be either.
//
//   unknown / epoch-unknown          no record file for THAT host instance. ABSENCE IS NOT DEATH:
//                                    every host that never opened this store has no record, and a
//                                    missing file proves nothing about any process. This replaces
//                                    the old `dead/no-previous-epoch`, which let an absent record
//                                    stand in for a dead host.
//   dead    / process-gone           the recorded pid no longer exists (kill(pid, 0) -> ESRCH),
//                                    whether or not the record carries an anchor
//   dead    / pid-reused             the pid exists, but its OS start ticks are not the recorded ones
//   alive   / process-matches        the pid exists and its OS start ticks match (see tolerance)
//   unknown / corrupt-record         the record file is not valid JSON
//   unknown / invalid-record         JSON, but not a usable { epochId, hostInstanceId, pid,
//                                    procStart, procStartTicks } (a procStartTicks that is a JSON
//                                    number has already lost precision and is unusable, so it is
//                                    rejected too), or a record whose stored hostInstanceId is not
//                                    the instance whose file it is
//   unknown / epoch-unreadable       the record exists and could not be read at all
//   unknown / anchor-missing         the pid EXISTS but the record carries no usable OS start ticks
//                                    — written before `procStartTicks` existed (only the old
//                                    wall-clock `procStart`), or acquired while the OS query failed
//                                    (`procStartTicks: null`). Identity cannot be proven, so it is
//                                    never guessed alive and never guessed pid-reused; the same
//                                    record with a GONE pid is still dead/process-gone, because
//                                    existence is measured without a clock
//   unknown / permission-denied      kill(pid, 0) -> EPERM: the pid may exist; we cannot inspect it
//   unknown / signal-failed          kill(pid, 0) failed for another reason
//   unknown / start-time-unavailable no OS start-time source (non-Windows, or the query failed)
//   unknown / start-time-timeout     the start-time query exceeded its 5 s timeout
//   unknown / start-time-invalid     the query returned a value that is not a post-1970 tick count
//
// LIMITATIONS (read before claiming anything downstream)
//   * No wall-clock anchor for identity. Existence is clock-independent; only identity needs the
//     OS tick anchor. The identity verdict compares OS start ticks with OS start ticks
//     (`procStartTicks` taken at acquire time, re-queried for the recorded pid at prove time), so a
//     wall clock step (NTP correction, VM snapshot/resume, manual change) between the host's start
//     and the epoch write cannot turn a still-running host into `dead/pid-reused`. There is also no
//     wall-clock fallback that could: for an EXISTING pid, a record without a usable anchor is
//     `unknown` (anchor-missing, or invalid-record for a malformed field), which refuses a takeover
//     instead of granting it. A GONE pid needs no anchor at all — it is `dead/process-gone` — so a
//     legacy record whose host is provably gone no longer blocks the next host. The old wall-clock
//     `procStart` is still written for humans and is not compared to anything, so a record that
//     carries only `procStart` (written before this field existed) proves identity no better than
//     no anchor at all; its existence check is unaffected.
//   * One record per instance accumulates. A record is only removed by `release()`; nothing sweeps
//     records of instances that exited without releasing. Their verdicts stay correct (gone pid =>
//     dead), but the directory grows with the number of host instances that ever claimed it. No
//     pruning happens here on purpose: deleting a record destroys the only evidence that instance
//     left, and this module must never convert "no evidence" into "dead".
//   * Start-time tolerance. Both values come from the same OS source, so for one process they are
//     expected to be identical; START_TOLERANCE_MS (2 s) is a safety margin, not a measured drift.
//     A pid recycled by a process created within 2 s of the recorded creation time would be read as
//     alive — that requires the previous host to have died within 2 s of its own start.
//   * Windows only for the start-time proof. Ticks from
//     `(Get-Process -Id <pid>).StartTime.ToUniversalTime().Ticks` count 100 ns units from
//     0001-01-01 (not the Unix epoch) and exceed 2^53, so they are compared as BigInt and stored as
//     a decimal string. On every other platform an existing pid is `unknown`, never `dead`, and
//     acquire stores `procStartTicks: null`.
//   * No atomic no-replace. The refusal check and the rename are separate calls; two hosts with the
//     SAME instance token racing can both observe "dead" and both write (last rename wins). Hosts
//     with different tokens touch different files. Likewise `release()` reads the record, then
//     unlinks it: a takeover landing in that window loses its record. Nothing here can create a
//     lock portably, so this is a documented TOCTOU, not a claim of mutual exclusion.
//   * A pid can be probed and then exit before the start-time query runs (Get-Process then fails);
//     that race yields `unknown`, which is the honest answer, not `dead`.
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";

// ---------- public contract ----------

// The host instance token doubles as the record's file name, so it must be a safe single path
// segment: the same token rule the journal store pins into every record (no separators, no "..").
const INSTANCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * File name of one host instance's durable epoch record inside the caller's record directory.
 * Throws instead of silently sanitizing: a bad token must not become a path elsewhere on disk.
 */
export function hostEpochFileName(hostInstanceId) {
  if (typeof hostInstanceId !== "string" || !INSTANCE_ID_PATTERN.test(hostInstanceId)) {
    throw new TypeError("hostInstanceId must be a non-empty token of [A-Za-z0-9._-] starting with a letter or digit");
  }
  return `${hostInstanceId}.json`;
}

/** Verdict values. Consumers branch on these strings; do not rename. */
export const VERDICT = Object.freeze({ DEAD: "dead", ALIVE: "alive", UNKNOWN: "unknown" });

/** Stable reason codes; `unknown` reasons are short codes by contract, never prose. */
export const REASON = Object.freeze({
  EPOCH_UNKNOWN: "epoch-unknown",
  PROCESS_GONE: "process-gone",
  PID_REUSED: "pid-reused",
  PROCESS_MATCHES: "process-matches",
  CORRUPT_RECORD: "corrupt-record",
  INVALID_RECORD: "invalid-record",
  EPOCH_UNREADABLE: "epoch-unreadable",
  ANCHOR_MISSING: "anchor-missing",
  PERMISSION_DENIED: "permission-denied",
  SIGNAL_FAILED: "signal-failed",
  START_TIME_UNAVAILABLE: "start-time-unavailable",
  START_TIME_TIMEOUT: "start-time-timeout",
  START_TIME_INVALID: "start-time-invalid",
});

// ---------- constants ----------

const isWin = process.platform === "win32";

// .NET ticks are 100 ns units counted from 0001-01-01; a 2026 timestamp is ~6.39e17, above 2^53.
// Every tick value is kept as a decimal string on disk and as BigInt in memory; never a JSON number.
const DOTNET_EPOCH_TICKS = 621355968000000000n;
const TICKS_PER_MS = 10000n;
const START_TIME_TIMEOUT_MS = 5000;
// Both sides of the comparison are OS ticks, so the same process should compare exactly equal. This
// margin only absorbs platform rounding; a recycled pid would need the previous host to have died
// within 2 s of its own start to be read as alive (see LIMITATIONS).
const START_TOLERANCE_MS = 2000;
const START_TOLERANCE_TICKS = BigInt(START_TOLERANCE_MS) * TICKS_PER_MS;
const TICKS_PATTERN = /^\d+$/;

const epochFile = (dir, hostInstanceId) => path.join(dir, hostEpochFileName(hostInstanceId));

const verdict = (value, reason, previous) => Object.freeze({ verdict: value, reason, previous });

function requireDir(dir, caller) {
  if (typeof dir !== "string" || dir.length === 0) {
    throw new TypeError(`${caller} requires dir: a non-empty directory path`);
  }
  return dir;
}

function requireHostInstanceId(hostInstanceId, caller) {
  // Reuse the file-name rule so the proof target and the record name can never disagree.
  hostEpochFileName(hostInstanceId);
  return hostInstanceId;
}

const isPositiveInteger = (value) => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/**
 * The record fields the proof actually relies on. Anything else on disk is ignored rather than
 * trusted: a record that cannot supply these values is `invalid-record` (unknown), never dead.
 *
 * `procStartTicks` is the identity anchor and is returned as the EXACT stored string (or null when
 * the record has no usable anchor: field absent on a pre-anchor record, or explicitly null because
 * the acquire-time query failed). A null anchor is a VALID record with an unverifiable identity —
 * `anchor-missing` at prove time — not an invalid one, so it is never guessed alive. It can still be
 * proven dead by a gone pid: the anchor decides identity, not existence. A malformed anchor (not a
 * decimal string, or not a post-1970 tick count) is `invalid-record` instead.
 */
function normalizeRecord(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { epochId, hostInstanceId, pid, procStart, procStartTicks } = raw;
  if (typeof epochId !== "string" || epochId.length === 0) return null;
  if (typeof hostInstanceId !== "string" || !INSTANCE_ID_PATTERN.test(hostInstanceId)) return null;
  if (!isPositiveInteger(pid)) return null;
  // Wall-clock creation time, written for humans only; the verdict never compares this value.
  if (!Number.isSafeInteger(procStart) || procStart <= 0) return null;
  let anchor = null;
  if (procStartTicks !== undefined && procStartTicks !== null) {
    // A JSON number here has already lost precision, so it cannot be an identity anchor.
    if (typeof procStartTicks !== "string" || !TICKS_PATTERN.test(procStartTicks)) return null;
    if (BigInt(procStartTicks) <= DOTNET_EPOCH_TICKS) return null;
    anchor = procStartTicks;
  }
  return { epochId, hostInstanceId, pid, procStart, procStartTicks: anchor };
}

/**
 * Read + classify ONE instance's record. Returns { record } | { missing: true } | { reason }.
 * `hostInstanceId` selects the file; a record that names another instance is not this instance's
 * proof and is rejected as invalid rather than trusted by file position.
 */
async function readEpochRecord(dir, hostInstanceId) {
  let text;
  try {
    text = await readFile(epochFile(dir, hostInstanceId), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { missing: true };
    return { reason: REASON.EPOCH_UNREADABLE };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { reason: REASON.CORRUPT_RECORD };
  }
  const record = normalizeRecord(raw);
  if (!record) return { reason: REASON.INVALID_RECORD };
  if (record.hostInstanceId !== hostInstanceId) return { reason: REASON.INVALID_RECORD };
  return { record };
}

// ---------- start-time query ----------

/**
 * Ask the OS for a pid's creation time as .NET ticks. Resolves { ticks } or { reason }; it never
 * throws and never guesses. `pid` is always an already-validated positive integer, so it cannot
 * inject into the command string.
 */
function queryWindowsStartTicks(pid) {
  return new Promise((resolve) => {
    execFile(
      "powershell",
      ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks`],
      { timeout: START_TIME_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        if (error) {
          const timedOut = error.killed === true || Boolean(error.signal);
          resolve({ reason: timedOut ? REASON.START_TIME_TIMEOUT : REASON.START_TIME_UNAVAILABLE });
          return;
        }
        const text = String(stdout ?? "").trim();
        if (!/^\d+$/.test(text)) {
          // Get-Process prints nothing when the process vanished between the probe and the query.
          resolve({ reason: REASON.START_TIME_UNAVAILABLE });
          return;
        }
        resolve({ ticks: BigInt(text) });
      },
    );
  });
}

/**
 * This process's own OS start time as a decimal tick string, asked once at acquire time. Returns
 * null when there is no usable answer (non-Windows, query failed, timeout, pre-1970 value): the
 * record then carries no anchor, so its identity is never provable — a later proof of it can be
 * `dead/process-gone` (existence needs no clock) but never alive or pid-reused. Never throws — a
 * failed anchor must not stop this host from claiming its epoch.
 */
async function readOwnStartTicks() {
  if (!isWin) return null;
  const query = await queryWindowsStartTicks(process.pid);
  if (query.reason || typeof query.ticks !== "bigint") return null;
  if (query.ticks <= DOTNET_EPOCH_TICKS) return null;
  return query.ticks.toString();
}

/**
 * Decide what the recorded pid means.
 *
 * Existence comes first because it needs no clock: `kill(pid, 0) -> ESRCH` proves the recorded
 * process is gone, so the record is dead whether or not it carries an anchor. Identity is only in
 * question while the pid EXISTS, and that is exactly what the OS start ticks decide: on this
 * platform the start time separates "the same host is still running" from "a new process got the
 * pid". With no anchor at that point a live pid could be either, so the answer is `unknown` — never
 * guessed alive, never guessed dead. A wall-clock fallback is the defect this module must not carry.
 */
async function probeProcess(pid, procStartTicks) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error?.code === "ESRCH") return { verdict: VERDICT.DEAD, reason: REASON.PROCESS_GONE };
    // EPERM means the pid may well exist; we simply cannot inspect it. Unknown is the fail-safe.
    if (error?.code === "EPERM") return { verdict: VERDICT.UNKNOWN, reason: REASON.PERMISSION_DENIED };
    return { verdict: VERDICT.UNKNOWN, reason: REASON.SIGNAL_FAILED };
  }

  // The pid exists, so only its identity is unresolved: that needs the anchor, and there is none.
  if (procStartTicks === null) return { verdict: VERDICT.UNKNOWN, reason: REASON.ANCHOR_MISSING };

  // Without a start-time source, a live pid could still be a recycled one; never call that dead.
  if (!isWin) return { verdict: VERDICT.UNKNOWN, reason: REASON.START_TIME_UNAVAILABLE };

  const query = await queryWindowsStartTicks(pid);
  if (query.reason) return { verdict: VERDICT.UNKNOWN, reason: query.reason };

  const actualTicks = query.ticks - DOTNET_EPOCH_TICKS;
  if (actualTicks <= 0n) return { verdict: VERDICT.UNKNOWN, reason: REASON.START_TIME_INVALID };

  // Both sides are .NET ticks straight from the OS, so a wall-clock step cannot move either one.
  const recordedTicks = BigInt(procStartTicks);
  const drift = query.ticks - recordedTicks;
  const driftTicks = drift < 0n ? -drift : drift;
  if (driftTicks <= START_TOLERANCE_TICKS) return { verdict: VERDICT.ALIVE, reason: REASON.PROCESS_MATCHES };
  return { verdict: VERDICT.DEAD, reason: REASON.PID_REUSED };
}

// ---------- public API ----------

/**
 * Is the host process that wrote `<dir>/<hostInstanceId>.json` still running?
 *
 * It resolves ONLY that instance's record: no other record is consulted and no remembered verdict
 * is applied, so one instance's death can never be reported as another instance's death.
 *
 * @param {{dir: string, hostInstanceId: string}} options directory holding the records and the
 *   instance token owned by the record to prove
 * @returns {Promise<{verdict: "dead"|"alive"|"unknown", reason: string, previous: object|null}>}
 *   `previous` is the validated identity of the recorded epoch, or null when there is nothing
 *   trustworthy to report. `unknown` means "not proven either way" and must never be acted on as
 *   if it were dead. A missing record is `unknown/epoch-unknown`, never dead.
 */
export async function proveEpochFor({ dir, hostInstanceId } = {}) {
  const targetDir = requireDir(dir, "proveEpochFor");
  const instance = requireHostInstanceId(hostInstanceId, "proveEpochFor");
  const read = await readEpochRecord(targetDir, instance);
  // ABSENCE IS NOT DEATH. A missing file means only "this instance wrote no epoch here", which is
  // also true of every host that never opened this store. Reporting it dead is the defect that let
  // one instance's death mark another instance's journal records stopped; `unknown` is the honest
  // answer and keeps the caller fail-closed.
  if (read.missing) return verdict(VERDICT.UNKNOWN, REASON.EPOCH_UNKNOWN, null);
  if (read.reason) return verdict(VERDICT.UNKNOWN, read.reason, null);
  const probe = await probeProcess(read.record.pid, read.record.procStartTicks);
  return verdict(probe.verdict, probe.reason, read.record);
}

/**
 * Claim the host epoch for this host instance, replacing only that instance's own record.
 *
 * The identity anchor is written from the OS in this call (`procStartTicks`), so the value the next
 * proof compares against is the same kind of measurement it takes itself — never a wall-clock
 * estimate that a clock step could have shifted.
 *
 * Another instance's record is a different file and is never touched by this call; only the
 * CURRENT instance's record can refuse the write. Absence of our own record is not a refusal —
 * a host instance that never claimed here has nothing of its own to overwrite.
 *
 * @param {{dir: string, hostInstanceId: string, takeover?: boolean}} options
 * @returns {Promise<{epochId: string, hostInstanceId: string, pid: number, procStart: number,
 *   procStartTicks: string|null, release: () => Promise<boolean>}
 *   | {refused: true, previous: {verdict: string, reason: string, previous: object|null}}>}
 *   `refused` covers a live OR unproven own record, including a corrupt one: an unproven previous
 *   claim of this same instance is not permission to overwrite it.
 */
export async function acquireHostEpoch({ dir, hostInstanceId, takeover = false } = {}) {
  const targetDir = requireDir(dir, "acquireHostEpoch");
  const instance = requireHostInstanceId(hostInstanceId, "acquireHostEpoch");

  const previous = await proveEpochFor({ dir: targetDir, hostInstanceId: instance });
  const absent = previous.reason === REASON.EPOCH_UNKNOWN;
  if (!absent && previous.verdict !== VERDICT.DEAD && takeover !== true) {
    return { refused: true, previous };
  }

  const record = {
    epochId: randomUUID(),
    hostInstanceId: instance,
    pid: process.pid,
    // Debug only: never compared, because a wall clock step would make it lie.
    procStart: Math.round(Date.now() - process.uptime() * 1000),
    procStartTicks: await readOwnStartTicks(),
    startedAt: new Date().toISOString(),
  };

  const file = epochFile(targetDir, instance);
  const temp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    await rename(temp, file);
  } catch (error) {
    // The rename never happened, so the previous record is still the authoritative one.
    try {
      await unlink(temp);
    } catch {
      /* the temp file may already be gone; nothing else is touched */
    }
    throw error;
  }

  /**
   * Drop this epoch's claim. Only our OWN record and only while it still carries OUR epochId is
   * removed, so a host that was taken over cannot delete its successor's epoch and no other
   * instance's record is ever touched. Idempotent: a second call is false.
   */
  const release = async () => {
    const current = await readEpochRecord(targetDir, instance);
    if (current.missing || current.reason) return false;
    if (current.record.epochId !== record.epochId) return false;
    try {
      await unlink(epochFile(targetDir, instance));
      return true;
    } catch {
      // The record was already gone or could not be removed; reporting the truth is the point.
      return false;
    }
  };

  return {
    epochId: record.epochId,
    hostInstanceId: record.hostInstanceId,
    pid: record.pid,
    procStart: record.procStart,
    procStartTicks: record.procStartTicks,
    release,
  };
}
