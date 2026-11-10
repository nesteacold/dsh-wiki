// dsh-wiki — offline adversarial tests for lib/journal.js (spec 007, T018).
//
// Drives the pure schema validator and recovery planner directly: no DSH Host, no network, no live
// wiki, no journal persistence. The planner is proved to be inert by observing a real temporary
// fixture tree that must be byte-identical before and after every call.
//
// Run with:
//   node --test plugins/dsh-wiki/tools/journal-test.mjs
import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { pathToFileURL } from "node:url";

const here = import.meta.dirname;
const moduleUrl = pathToFileURL(path.join(here, "..", "lib", "journal.js")).href;
const journalModule = await import(moduleUrl);
const { DECISIONS, ERROR_CODES, JournalError, PHASES, WORKER_PROOFS, isRecoveryPlan, planRecovery, validateJournal, version } = journalModule;

const isWin = process.platform === "win32";

// ---------- fixtures ----------

const JOB_ID = "0123456789abcdef";
const HOST_ID = "host-0123456789abcdef";
const OTHER_HOST_ID = "host-fedcba9876543210";
const SESSION_ID = "session-0123456789ab";
const ROOT = isWin ? "C:\\wikis\\alpha" : "/wikis/alpha";
const OTHER_ROOT = isWin ? "C:\\wikis\\beta" : "/wikis/beta";
const STAGE = path.join(ROOT, `.dsh-wiki.staging-${JOB_ID}`);
const LIVE = path.join(ROOT, ".dsh-wiki");
const BACKUP = path.join(ROOT, `.dsh-wiki.bak-${JOB_ID}`);
const OPTIONS = Object.freeze({ allowedRoots: Object.freeze([ROOT]) });
const PROTOCOL_HASH = "a".repeat(64);
const PROMPT_HASH = "b".repeat(64);

function identityJson(dev = "1", ino = "2", kind = "dir", nlink = "1") {
  return JSON.stringify({ dev, ino, kind, nlink });
}

const ROOT_ID = identityJson("10", "20");
const LIVE_ID = identityJson("10", "30");
const STAGE_ID = identityJson("10", "40");
const BACKUP_ID = identityJson("10", "50");

/** snapshots bound by a well-formed record in each phase. */
const PHASE_SNAPSHOTS = Object.freeze({
  created: { stage: null, live: LIVE_ID, backup: null },
  "worker-running": { stage: STAGE_ID, live: LIVE_ID, backup: null },
  "worker-stopped": { stage: STAGE_ID, live: LIVE_ID, backup: null },
  validated: { stage: STAGE_ID, live: LIVE_ID, backup: null },
  "live-moved": { stage: STAGE_ID, live: null, backup: LIVE_ID },
  published: { stage: null, live: STAGE_ID, backup: LIVE_ID },
  "rolled-back": { stage: STAGE_ID, live: LIVE_ID, backup: null },
  aborted: { stage: STAGE_ID, live: LIVE_ID, backup: null },
});

function journalRecord(overrides = {}) {
  return {
    version: 1,
    jobId: JOB_ID,
    hostInstanceId: HOST_ID,
    rootReal: ROOT,
    rootIdentity: ROOT_ID,
    stagePath: STAGE,
    livePath: LIVE,
    backupPath: BACKUP,
    workerSessionId: SESSION_ID,
    protocolSha256: PROTOCOL_HASH,
    promptSha256: PROMPT_HASH,
    phase: "created",
    snapshots: { ...PHASE_SNAPSHOTS.created },
    ...overrides,
  };
}

function recordForPhase(phase) {
  return journalRecord({ phase, snapshots: { ...PHASE_SNAPSHOTS[phase] } });
}

/**
 * A structurally perfect record rooted outside the fixture allowlist. Every path is correctly bound
 * to the other root, so only the caller's allowlist (consulted inside `validateJournal`) separates it
 * from an authorized record: this is the forged-root shape a hostile store or a confused caller
 * could otherwise hand to `planRecovery`.
 */
function forgedRootRecord(phase = "published") {
  return {
    ...recordForPhase(phase),
    rootReal: OTHER_ROOT,
    stagePath: path.join(OTHER_ROOT, `.dsh-wiki.staging-${JOB_ID}`),
    livePath: path.join(OTHER_ROOT, ".dsh-wiki"),
    backupPath: path.join(OTHER_ROOT, `.dsh-wiki.bak-${JOB_ID}`),
  };
}

const comparablePath = (value) => (isWin ? value.toLowerCase() : value);

const present = (identity) => ({ state: "present", identity });
const ABSENT = Object.freeze({ state: "absent" });
const UNKNOWN = Object.freeze({ state: "unknown" });

function observations(overrides = {}) {
  return {
    hostInstanceId: HOST_ID,
    worker: { state: "stopped", proof: "host-registry" },
    root: present(ROOT_ID),
    stage: ABSENT,
    live: ABSENT,
    backup: ABSENT,
    ...overrides,
  };
}

/** Observations that exactly match what the record binds for one phase. */
function observedFor(phase, overrides = {}) {
  const snapshots = PHASE_SNAPSHOTS[phase];
  return observations({
    stage: snapshots.stage === null ? ABSENT : present(snapshots.stage),
    live: snapshots.live === null ? ABSENT : present(snapshots.live),
    backup: snapshots.backup === null ? ABSENT : present(snapshots.backup),
    ...overrides,
  });
}

function planFor(phase, overrides = {}) {
  return planRecovery(validateJournal(recordForPhase(phase), OPTIONS), observedFor(phase, overrides));
}

// ---------- assertion helpers ----------

function assertCode(fn, code, label) {
  let error;
  try {
    fn();
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, `${label}: expected ${code}, but the call succeeded`);
  assert.ok(
    error instanceof JournalError,
    `${label}: expected JournalError, got ${error?.name ?? typeof error}: ${error?.message ?? error}`,
  );
  assert.equal(error.code, code, `${label}: expected ${code}, got ${error.code} (${error.message})`);
  return error;
}

function assertNoActions(result, label) {
  assert.deepEqual(result.actions, [], `${label}: ${result.decision} must not carry actions`);
  assert.ok(Object.isFrozen(result.actions), `${label}: actions must be frozen`);
  assert.ok(Object.isFrozen(result), `${label}: result must be frozen`);
  assert.ok(DECISIONS.includes(result.decision), `${label}: unknown decision ${result.decision}`);
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

let base;
let fixtureCounter = 0;

before(() => {
  base = mkdtempSync(path.join(tmpdir(), "dsh-wiki-journal-"));
});

after(() => {
  rmSync(base, { recursive: true, force: true });
});

function fixtureSnapshot(root) {
  const output = [];
  const walk = (directory, prefix) => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const relative = prefix.length === 0 ? name : `${prefix}/${name}`;
      const stats = lstatSync(absolute);
      if (stats.isDirectory()) {
        output.push({ path: relative, kind: "dir" });
        walk(absolute, relative);
      } else if (stats.isFile()) {
        output.push({ path: relative, kind: "file", content: readFileSync(absolute, "utf8") });
      } else {
        output.push({ path: relative, kind: "other" });
      }
    }
  };
  walk(root, "");
  return output;
}

// =====================================================================================
// module contract
// =====================================================================================

test("exports the version-1 API and its schema constants", () => {
  assert.equal(version, 1);
  assert.equal(typeof validateJournal, "function");
  assert.equal(typeof planRecovery, "function");
  assert.ok(Object.isFrozen(PHASES));
  assert.ok(Object.isFrozen(DECISIONS));
  assert.ok(Object.isFrozen(ERROR_CODES));
  assert.deepEqual([...PHASES], [
    "created",
    "worker-running",
    "worker-stopped",
    "validated",
    "live-moved",
    "published",
    "rolled-back",
    "aborted",
  ]);
  assert.deepEqual([...DECISIONS], ["no-op", "restore-backup", "cleanup", "manual", "quarantine"]);
  const error = new JournalError("sample-code", "sample message");
  assert.ok(error instanceof Error);
  assert.equal(error.name, "JournalError");
  assert.equal(error.code, "sample-code");
});

test("the module imports only node:path", () => {
  const source = readFileSync(path.join(here, "..", "lib", "journal.js"), "utf8");
  const specifiers = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);
  assert.deepEqual(specifiers, ["node:path"], "journal.js must import nothing but node:path");
  assert.ok(!/\bimport\s*\(/.test(source), "journal.js must not use dynamic import");
});

test("validation and planning never mutate the filesystem", () => {
  fixtureCounter += 1;
  const root = path.join(base, `fixture-${fixtureCounter}`);
  const fixtures = {
    live: path.join(root, ".dsh-wiki"),
    backup: path.join(root, `.dsh-wiki.bak-${JOB_ID}`),
    staging: path.join(root, `.dsh-wiki.staging-${JOB_ID}`),
    forged: path.join(root, `.dsh-wiki.bak-forged`),
  };
  for (const directory of Object.values(fixtures)) mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(fixtures.live, "wiki.json"), '{"pages":[]}');
  writeFileSync(path.join(fixtures.backup, "wiki.json"), '{"pages":["old"]}');
  writeFileSync(path.join(fixtures.staging, "pages.md"), "# candidate");
  writeFileSync(path.join(fixtures.forged, "wiki.json"), '{"pages":["forged"]}');

  const record = { ...recordForPhase("published"), rootReal: root, rootIdentity: ROOT_ID };
  const normalize = (value) => (isWin ? value.toLowerCase() : value);
  const rooted = {
    ...record,
    stagePath: path.join(root, `.dsh-wiki.staging-${JOB_ID}`),
    livePath: path.join(root, ".dsh-wiki"),
    backupPath: path.join(root, `.dsh-wiki.bak-${JOB_ID}`),
  };
  const before = fixtureSnapshot(root);

  const normalized = validateJournal(rooted, { allowedRoots: [root] });
  const result = planRecovery(
    normalized,
    observations({
      root: present(ROOT_ID),
      stage: ABSENT,
      live: present(STAGE_ID),
      backup: present(LIVE_ID),
    }),
  );
  assert.equal(result.decision, "cleanup");
  assert.equal(normalize(result.actions[0].path), normalize(fixtures.backup));

  assert.deepEqual(fixtureSnapshot(root), before, "the fixture tree must be untouched");
  assert.ok(existsSync(fixtures.forged), "an unbound forged backup must survive planning");
});

// =====================================================================================
// validateJournal — accepted records
// =====================================================================================

test("validateJournal accepts a valid record for every phase", () => {
  for (const phase of PHASES) {
    const record = deepFreeze(recordForPhase(phase));
    const normalized = validateJournal(record, OPTIONS);
    assert.ok(Object.isFrozen(normalized), `${phase}: normalized record must be frozen`);
    assert.equal(normalized.version, 1);
    assert.equal(normalized.phase, phase);
    assert.equal(normalized.jobId, JOB_ID);
    assert.equal(normalized.hostInstanceId, HOST_ID);
    assert.equal(normalized.workerSessionId, SESSION_ID);
    assert.equal(normalized.rootReal, ROOT);
    assert.equal(normalized.rootIdentity, ROOT_ID);
    assert.equal(normalized.stagePath, STAGE);
    assert.equal(normalized.livePath, LIVE);
    assert.equal(normalized.backupPath, BACKUP);
    assert.equal(normalized.protocolSha256, PROTOCOL_HASH);
    assert.equal(normalized.promptSha256, PROMPT_HASH);
    assert.deepEqual({ ...normalized.snapshots }, PHASE_SNAPSHOTS[phase]);
  }
});

test("validateJournal accepts a first-generation record (no live wiki bound)", () => {
  const record = journalRecord({
    phase: "worker-running",
    snapshots: { stage: STAGE_ID, live: null, backup: null },
  });
  const normalized = validateJournal(record, OPTIONS);
  assert.equal(normalized.snapshots.live, null);
});

test("validateJournal returns a detached frozen copy, not the input", () => {
  const record = recordForPhase("published");
  const snapshotBefore = JSON.stringify(record);
  const normalized = validateJournal(record, OPTIONS);

  record.phase = "aborted";
  record.snapshots.live = LIVE_ID;
  record.rootReal = OTHER_ROOT;
  record.jobId = "ffff";

  assert.equal(JSON.stringify(recordForPhase("published")), snapshotBefore);
  assert.equal(normalized.phase, "published");
  assert.equal(normalized.snapshots.live, STAGE_ID);
  assert.equal(normalized.rootReal, ROOT);
  assert.equal(normalized.jobId, JOB_ID);
  assert.ok(Object.isFrozen(normalized.snapshots));
});

test("validateJournal accepts a null-prototype record and snapshots object", () => {
  const record = Object.assign(Object.create(null), recordForPhase("created"));
  record.snapshots = Object.assign(Object.create(null), PHASE_SNAPSHOTS.created);
  const normalized = validateJournal(record, OPTIONS);
  assert.equal(normalized.phase, "created");
});

test("validateJournal matches the allowlisted root case-insensitively on Windows", { skip: !isWin }, () => {
  const normalized = validateJournal(recordForPhase("created"), { allowedRoots: [ROOT.toLowerCase()] });
  assert.equal(normalized.rootReal, ROOT);
  assert.equal(normalized.stagePath, STAGE);
});

test("validateJournal and planRecovery never mutate their inputs", () => {
  const frozenRecord = deepFreeze(recordForPhase("validated"));
  const frozenObservations = deepFreeze(
    observations({ stage: present(STAGE_ID), live: ABSENT, backup: present(LIVE_ID) }),
  );
  const recordBefore = JSON.stringify(frozenRecord);
  const observationsBefore = JSON.stringify(frozenObservations);

  const normalized = validateJournal(frozenRecord, OPTIONS);
  const result = planRecovery(normalized, frozenObservations);
  assert.equal(result.decision, "restore-backup");
  assert.equal(JSON.stringify(frozenRecord), recordBefore, "the record input must be untouched");
  assert.equal(JSON.stringify(frozenObservations), observationsBefore, "the observations input must be untouched");

  const looseRecord = recordForPhase("published");
  const looseObservations = observedFor("published");
  const looseRecordBefore = JSON.stringify(looseRecord);
  const looseObservationsBefore = JSON.stringify(looseObservations);
  planRecovery(validateJournal(looseRecord, OPTIONS), looseObservations);
  assert.equal(JSON.stringify(looseRecord), looseRecordBefore);
  assert.equal(JSON.stringify(looseObservations), looseObservationsBefore);
});

// =====================================================================================
// validateJournal — closed own-key schema, no prototype pollution
// =====================================================================================

test("validateJournal rejects an unknown top-level key", () => {
  const record = recordForPhase("created");
  record.extra = true;
  assertCode(() => validateJournal(record, OPTIONS), "unknown-key", "unknown key");
});

test("validateJournal rejects a missing top-level key", () => {
  for (const key of ["version", "jobId", "hostInstanceId", "rootReal", "rootIdentity", "stagePath", "livePath", "backupPath", "workerSessionId", "protocolSha256", "promptSha256", "phase", "snapshots"]) {
    const record = recordForPhase("created");
    delete record[key];
    assertCode(() => validateJournal(record, OPTIONS), ERROR_CODES.INVALID_RECORD, `missing ${key}`);
  }
});

test("validateJournal rejects symbol keys", () => {
  const record = recordForPhase("created");
  record[Symbol("hidden")] = "x";
  assertCode(() => validateJournal(record, OPTIONS), "unknown-key", "symbol key");
});

test("validateJournal rejects accessor properties", () => {
  const record = recordForPhase("created");
  Object.defineProperty(record, "phase", {
    get() {
      return "created";
    },
    enumerable: true,
    configurable: true,
  });
  assertCode(() => validateJournal(record, OPTIONS), "unknown-key", "getter phase");
});

test("validateJournal rejects non-enumerable own properties", () => {
  const record = recordForPhase("created");
  Object.defineProperty(record, "hidden", { value: true, enumerable: false, configurable: true });
  assertCode(() => validateJournal(record, OPTIONS), "unknown-key", "non-enumerable key");
});

test("validateJournal rejects non-plain records", () => {
  const cases = [
    ["array", [1, 2]],
    ["map", new Map()],
    ["date", new Date(0)],
    ["string", "record"],
    ["number", 7],
    ["null", null],
    ["undefined", undefined],
    ["class instance", new (class Record {})()],
    ["array-like object", Object.assign(Object.create({ inherited: true }), recordForPhase("created"))],
  ];
  for (const [label, value] of cases) {
    assertCode(() => validateJournal(value, OPTIONS), ERROR_CODES.INVALID_RECORD, label);
  }
});

test("validateJournal rejects a __proto__ own key without polluting Object.prototype", () => {
  const record = JSON.parse(JSON.stringify(recordForPhase("created")));
  Object.defineProperty(record, "__proto__", { value: { polluted: "yes" }, enumerable: true, configurable: true });
  assert.ok(Object.hasOwn(record, "__proto__"), "the forged key must be an own property for this test");
  assertCode(() => validateJournal(record, OPTIONS), "unknown-key", "__proto__ own key");
  assert.equal({}.polluted, undefined, "Object.prototype must not be polluted");
});

test("validateJournal rejects snapshot schema violations", () => {
  const cases = [
    ["extra snapshot key", { ...PHASE_SNAPSHOTS.created, extra: null }, "unknown-key"],
    ["missing snapshot key", { stage: null, live: null }, ERROR_CODES.INVALID_RECORD],
    ["snapshot as array", [null, null, null], ERROR_CODES.INVALID_RECORD],
    ["snapshot as string", "stage", ERROR_CODES.INVALID_RECORD],
    ["snapshot value as number", { stage: 1, live: null, backup: null }, "invalid-identity"],
    ["snapshot value as object", { stage: { dev: "1" }, live: null, backup: null }, "invalid-identity"],
  ];
  for (const [label, snapshots, code] of cases) {
    const record = recordForPhase("created");
    record.snapshots = snapshots;
    assertCode(() => validateJournal(record, OPTIONS), code, label);
  }

  const record = recordForPhase("created");
  record.snapshots = Object.assign(Object.create({ inherited: true }), PHASE_SNAPSHOTS.created);
  assertCode(() => validateJournal(record, OPTIONS), ERROR_CODES.INVALID_RECORD, "non-plain snapshots");
});

// =====================================================================================
// validateJournal — field values
// =====================================================================================

test("validateJournal rejects unknown schema versions", () => {
  for (const value of [0, 2, "1", 1.0 + 1, null, true, [1], { version: 1 }]) {
    const record = recordForPhase("created");
    record.version = value;
    assertCode(() => validateJournal(record, OPTIONS), "invalid-version", `version ${JSON.stringify(value)}`);
  }
});

test("validateJournal rejects unsafe job ids", () => {
  for (const value of ["", "ABC", "ABC123", "job-1", "job.1", "job_1", "..", "a".repeat(65), "a/b", "a\\b", " job", 12, null]) {
    const record = recordForPhase("created");
    record.jobId = value;
    assertCode(() => validateJournal(record, OPTIONS), "invalid-job-id", `jobId ${JSON.stringify(value)}`);
  }
});

test("validateJournal rejects unsafe host instance ids", () => {
  for (const value of ["", "short", "host 1", "host/1", "host\\1", "host..1", "host.1", "a".repeat(257), 7, null]) {
    const record = recordForPhase("created");
    record.hostInstanceId = value;
    assertCode(() => validateJournal(record, OPTIONS), "invalid-host-instance-id", `hostInstanceId ${JSON.stringify(value)}`);
  }
});

test("validateJournal rejects unsafe worker session ids", () => {
  for (const value of ["", "short", "session id", "session/id", "session\\id", "session..1", "s".repeat(257), 7, null]) {
    const record = recordForPhase("created");
    record.workerSessionId = value;
    assertCode(() => validateJournal(record, OPTIONS), "invalid-session-id", `workerSessionId ${JSON.stringify(value)}`);
  }
});

test("validateJournal rejects non-canonical hashes", () => {
  for (const value of [
    "a".repeat(63),
    "a".repeat(65),
    "A".repeat(64),
    "g".repeat(64),
    `${"a".repeat(63)} `,
    "",
    null,
    7,
    ["a".repeat(64)],
  ]) {
    const record = recordForPhase("created");
    record.protocolSha256 = value;
    assertCode(() => validateJournal(record, OPTIONS), "invalid-hash", `protocolSha256 ${String(value)}`);

    const other = recordForPhase("created");
    other.promptSha256 = value;
    assertCode(() => validateJournal(other, OPTIONS), "invalid-hash", `promptSha256 ${String(value)}`);
  }
});

test("validateJournal rejects unknown or malformed phases", () => {
  for (const value of ["", "Created", "publishing", "done", 1, null, ["created"]]) {
    const record = recordForPhase("created");
    record.phase = value;
    assertCode(() => validateJournal(record, OPTIONS), "invalid-phase", `phase ${JSON.stringify(value)}`);
  }
});

test("validateJournal rejects phase/snapshot combinations that could name the wrong directory", () => {
  const cases = [
    ["created with staging bound", "created", { stage: STAGE_ID, live: LIVE_ID, backup: null }],
    ["created with backup bound", "created", { stage: null, live: LIVE_ID, backup: LIVE_ID }],
    ["worker-running without staging", "worker-running", { stage: null, live: LIVE_ID, backup: null }],
    ["worker-stopped with backup", "worker-stopped", { stage: STAGE_ID, live: LIVE_ID, backup: LIVE_ID }],
    ["validated with backup", "validated", { stage: STAGE_ID, live: LIVE_ID, backup: LIVE_ID }],
    ["live-moved without staging", "live-moved", { stage: null, live: null, backup: LIVE_ID }],
    ["live-moved with live present", "live-moved", { stage: STAGE_ID, live: LIVE_ID, backup: LIVE_ID }],
    ["published with staging", "published", { stage: STAGE_ID, live: STAGE_ID, backup: LIVE_ID }],
    ["published without live", "published", { stage: null, live: null, backup: LIVE_ID }],
    ["rolled-back with backup", "rolled-back", { stage: STAGE_ID, live: LIVE_ID, backup: LIVE_ID }],
    ["aborted with backup", "aborted", { stage: STAGE_ID, live: LIVE_ID, backup: LIVE_ID }],
  ];
  for (const [label, phase, snapshots] of cases) {
    const record = journalRecord({ phase, snapshots });
    assertCode(() => validateJournal(record, OPTIONS), "inconsistent-phase", label);
  }
});

test("validateJournal still rejects mismatched artifact identities for any kind", () => {
  const record = recordForPhase("created");
  record.snapshots = { stage: null, live: identityJson("10", "30", "dir", "1"), backup: null };
  assert.equal(validateJournal(record, OPTIONS).snapshots.live, identityJson("10", "30", "dir", "1"));
});

// =====================================================================================
// validateJournal — roots and options
// =====================================================================================

test("validateJournal requires an allowlist supplied by the caller", () => {
  const record = recordForPhase("created");
  const optionCases = [
    ["missing options", undefined, ERROR_CODES.INVALID_OPTIONS],
    ["null options", null, ERROR_CODES.INVALID_OPTIONS],
    ["non-object options", "roots", ERROR_CODES.INVALID_OPTIONS],
    ["missing allowedRoots", {}, ERROR_CODES.INVALID_OPTIONS],
    ["extra option", { allowedRoots: [ROOT], allowDiscovery: true }, ERROR_CODES.INVALID_OPTIONS],
    ["empty allowedRoots", { allowedRoots: [] }, ERROR_CODES.INVALID_OPTIONS],
    ["non-array allowedRoots", { allowedRoots: ROOT }, ERROR_CODES.INVALID_OPTIONS],
    ["non-string element", { allowedRoots: [ROOT, 7] }, ERROR_CODES.INVALID_OPTIONS],
    ["too many roots", { allowedRoots: Array.from({ length: 65 }, (_, index) => `${ROOT}${index}`) }, ERROR_CODES.INVALID_OPTIONS],
    ["relative root", { allowedRoots: ["relative/root"] }, ERROR_CODES.INVALID_ROOT],
    ["traversal root", { allowedRoots: [`${ROOT}${path.sep}..${path.sep}other`] }, ERROR_CODES.INVALID_ROOT],
    ["trailing separator", { allowedRoots: [`${ROOT}${path.sep}`] }, ERROR_CODES.INVALID_ROOT],
  ];
  for (const [label, options, code] of optionCases) {
    assertCode(() => validateJournal(record, options), code, label);
  }
});

test("validateJournal authorizes an exact allowlisted root only, never a subdirectory of one", () => {
  const subRoot = path.join(ROOT, "nested-repo");
  const record = recordForPhase("created");
  record.rootReal = subRoot;
  record.stagePath = path.join(subRoot, `.dsh-wiki.staging-${JOB_ID}`);
  record.livePath = path.join(subRoot, ".dsh-wiki");
  record.backupPath = path.join(subRoot, `.dsh-wiki.bak-${JOB_ID}`);
  assertCode(() => validateJournal(record, OPTIONS), "root-not-allowed", "subdirectory of an allowlisted root");
});

test("validateJournal refuses a root that is not allowlisted", () => {
  const record = recordForPhase("created");
  record.rootReal = OTHER_ROOT;
  record.stagePath = path.join(OTHER_ROOT, `.dsh-wiki.staging-${JOB_ID}`);
  record.livePath = path.join(OTHER_ROOT, ".dsh-wiki");
  record.backupPath = path.join(OTHER_ROOT, `.dsh-wiki.bak-${JOB_ID}`);
  assertCode(() => validateJournal(record, OPTIONS), "root-not-allowed", "unknown root");

  const many = validateJournal(record, { allowedRoots: [ROOT, OTHER_ROOT] });
  assert.equal(many.rootReal, OTHER_ROOT);
});

test("validateJournal rejects malformed roots", () => {
  const cases = [
    ["empty", ""],
    ["relative", "wikis/alpha"],
    ["not a string", 42],
    ["filesystem root", path.parse(ROOT).root],
    ["dot segment", `${ROOT}${path.sep}.${path.sep}x`],
    ["dotdot segment", `${ROOT}${path.sep}..`],
    ["trailing separator", `${ROOT}${path.sep}`],
    ["nul byte", `${ROOT}\u0000x`],
    ["control char", `${ROOT}\u0001x`],
    ["overlong", `${ROOT}${path.sep}${"a".repeat(4096)}`],
  ];
  for (const [label, root] of cases) {
    const record = recordForPhase("created");
    record.rootReal = root;
    assertCode(() => validateJournal(record, { allowedRoots: [ROOT] }), ERROR_CODES.INVALID_ROOT, label);
  }
});

test("validateJournal rejects UNC, device and stream syntax in roots", { skip: !isWin }, () => {
  const cases = [
    ["UNC", "\\\\server\\share\\repo"],
    ["device", "\\\\.\\C:\\repo"],
    ["extended-length", "\\\\?\\C:\\repo"],
    ["stream", "C:\\repo:stream"],
    ["reserved name", "C:\\repo\\con\\wiki"],
    ["trailing dot segment", "C:\\repo\\wiki."],
  ];
  for (const [label, root] of cases) {
    const record = recordForPhase("created");
    record.rootReal = root;
    assertCode(() => validateJournal(record, { allowedRoots: [root] }), ERROR_CODES.INVALID_ROOT, label);
  }
});

// =====================================================================================
// validateJournal — forged artifact paths
// =====================================================================================

test("validateJournal rejects a staging path that is not exactly bound to the job id", () => {
  const cases = [
    ["other job id", path.join(ROOT, ".dsh-wiki.staging-ffff")],
    ["no job id", path.join(ROOT, ".dsh-wiki.staging-")],
    ["live path", LIVE],
    ["backup path", BACKUP],
    ["inside live", path.join(LIVE, `.dsh-wiki.staging-${JOB_ID}`)],
    ["nested", path.join(ROOT, `.dsh-wiki.staging-${JOB_ID}`, "sub")],
    ["sibling root", path.join(OTHER_ROOT, `.dsh-wiki.staging-${JOB_ID}`)],
  ];
  for (const [label, value] of cases) {
    const record = recordForPhase("worker-running");
    record.stagePath = value;
    assertCode(() => validateJournal(record, OPTIONS), "forged-path", `stagePath ${label}`);
  }
});

test("validateJournal rejects a forged backup path", () => {
  const cases = [
    ["bare prefix", path.join(ROOT, ".dsh-wiki.bak")],
    ["other job id", path.join(ROOT, ".dsh-wiki.bak-ffff")],
    ["extra suffix", path.join(ROOT, `.dsh-wiki.bak-${JOB_ID}-extra`)],
    ["nested", path.join(ROOT, `.dsh-wiki.bak-${JOB_ID}`, "x")],
    ["live path", LIVE],
    ["sibling root", path.join(OTHER_ROOT, `.dsh-wiki.bak-${JOB_ID}`)],
  ];
  for (const [label, value] of cases) {
    const record = recordForPhase("published");
    record.backupPath = value;
    assertCode(() => validateJournal(record, OPTIONS), "forged-path", `backupPath ${label}`);
  }
});

test("validateJournal rejects a forged live path", () => {
  const cases = [
    ["different name", path.join(ROOT, ".dsh-wiki-bak")],
    ["nested", path.join(ROOT, ".dsh-wiki", "site")],
    ["root itself", ROOT],
    ["sibling root", path.join(OTHER_ROOT, ".dsh-wiki")],
  ];
  for (const [label, value] of cases) {
    const record = recordForPhase("created");
    record.livePath = value;
    assertCode(() => validateJournal(record, OPTIONS), "forged-path", `livePath ${label}`);
  }
});

test("validateJournal rejects malformed artifact path syntax", () => {
  const cases = [
    ["relative", ".dsh-wiki"],
    ["traversal", `${ROOT}${path.sep}.dsh-wiki${path.sep}..${path.sep}x`],
    ["trailing separator", `${LIVE}${path.sep}`],
    ["nul", `${LIVE}\u0000`],
    ["non-string", { path: LIVE }],
  ];
  for (const [label, value] of cases) {
    const record = recordForPhase("created");
    record.livePath = value;
    assertCode(() => validateJournal(record, OPTIONS), "invalid-path", `livePath ${label}`);
  }
});

// =====================================================================================
// validateJournal — identities
// =====================================================================================

test("validateJournal rejects identities that are not canonical JSON strings", () => {
  const cases = [
    ["object", { dev: "1", ino: "2", kind: "dir", nlink: "1" }],
    ["number", 7],
    ["null", null],
    ["empty string", ""],
    ["invalid json", "not-json"],
    ["array", '["1","2","dir","1"]'],
    ["json null", "null"],
    ["overlong", `{"dev":"${"1".repeat(600)}"}`],
  ];
  for (const [label, value] of cases) {
    const record = recordForPhase("created");
    record.rootIdentity = value;
    assertCode(() => validateJournal(record, OPTIONS), "invalid-identity", `rootIdentity ${label}`);
  }
});

test("validateJournal rejects identities with missing, extra or duplicate keys", () => {
  const cases = [
    ["missing nlink", '{"dev":"1","ino":"2","kind":"dir"}'],
    ["missing dev", '{"ino":"2","kind":"dir","nlink":"1"}'],
    ["extra key", '{"dev":"1","ino":"2","kind":"dir","nlink":"1","uid":"0"}'],
    ["duplicate key", '{"dev":"1","dev":"1","ino":"2","kind":"dir","nlink":"1"}'],
    ["proto key", '{"dev":"1","ino":"2","kind":"dir","nlink":"1","__proto__":{"x":1}}'],
  ];
  for (const [label, value] of cases) {
    const record = recordForPhase("created");
    record.snapshots = { stage: null, live: value, backup: null };
    assertCode(() => validateJournal(record, OPTIONS), "invalid-identity", label);
  }
});

test("validateJournal rejects non-normalized decimal identity fields", () => {
  const cases = [
    ["negative", identityJson("-1", "2")],
    ["leading zero", identityJson("01", "2")],
    ["plus sign", identityJson("+1", "2")],
    ["float", identityJson("1.5", "2")],
    ["exponent", identityJson("1e3", "2")],
    ["empty", identityJson("", "2")],
    ["number instead of string", '{"dev":1,"ino":"2","kind":"dir","nlink":"1"}'],
    ["null field", '{"dev":null,"ino":"2","kind":"dir","nlink":"1"}'],
    ["40 digits", identityJson("1".repeat(40), "2")],
  ];
  for (const [label, value] of cases) {
    const record = recordForPhase("created");
    record.rootIdentity = value;
    assertCode(() => validateJournal(record, OPTIONS), "invalid-identity", label);
  }
});

test("validateJournal rejects non-directory identities for bound directories", () => {
  for (const kind of ["file", "other", "link", "DIR", ""]) {
    const record = recordForPhase("published");
    record.snapshots = { stage: null, live: identityJson("10", "40", kind), backup: LIVE_ID };
    assertCode(() => validateJournal(record, OPTIONS), "invalid-identity", `kind ${JSON.stringify(kind)}`);

    const rootCase = recordForPhase("created");
    rootCase.rootIdentity = identityJson("10", "20", kind);
    assertCode(() => validateJournal(rootCase, OPTIONS), "invalid-identity", `root kind ${JSON.stringify(kind)}`);
  }
});

test("validateJournal requires byte-identical canonical identity serialization", () => {
  const cases = [
    ["whitespace", '{"dev": "10", "ino": "20", "kind": "dir", "nlink": "1"}'],
    ["reordered keys", '{"ino":"20","dev":"10","kind":"dir","nlink":"1"}'],
    ["uppercase kind value is accepted only if canonical", '{"dev":"10","ino":"20","kind":"dir","nlink":"01"}'],
    ["trailing newline", `${identityJson("10", "20")}\n`],
  ];
  for (const [label, value] of cases) {
    const record = recordForPhase("created");
    record.rootIdentity = value;
    assertCode(() => validateJournal(record, OPTIONS), "invalid-identity", label);
  }
  // The canonical form itself is accepted.
  assert.equal(validateJournal(recordForPhase("created"), OPTIONS).rootIdentity, identityJson("10", "20"));
});

// =====================================================================================
// planRecovery — inputs
// =====================================================================================

test("planRecovery refuses any record validateJournal in this module did not return", () => {
  // Structural validity is NOT authority: `validateJournal` is where the caller's allowlist is
  // consulted, so every unbranded input below is refused before any decision or action is computed.
  const corrupt = [
    ["null", null],
    ["undefined", undefined],
    ["string", "record"],
    ["empty object", {}],
    ["extra key", { ...recordForPhase("published"), extra: true }],
    ["forged path", { ...recordForPhase("published"), backupPath: path.join(ROOT, ".dsh-wiki.bak-ffff") }],
    ["unknown phase", { ...recordForPhase("published"), phase: "done" }],
    ["missing snapshots", (({ snapshots, ...rest }) => rest)(recordForPhase("published"))],
    ["inconsistent phase", { ...recordForPhase("published"), snapshots: { stage: STAGE_ID, live: STAGE_ID, backup: LIVE_ID } }],
    ["structurally perfect record", recordForPhase("published")],
  ];
  for (const [label, record] of corrupt) {
    assertCode(() => planRecovery(record, observedFor("published")), "record-not-validated", `record ${label}`);
  }
  assert.equal(ERROR_CODES.RECORD_NOT_VALIDATED, "record-not-validated");
  // The provenance gate runs before anything else, so a bad record cannot even reach the observation
  // checks — an unauthorized record never yields a decision, a reason or an action.
  assertCode(
    () => planRecovery(recordForPhase("published"), undefined),
    "record-not-validated",
    "unauthorized record with no observations",
  );
  assertCode(
    () => planRecovery(null, { bogus: true }),
    "record-not-validated",
    "unauthorized record with malformed observations",
  );
});

test("planRecovery refuses copies, clones and round trips of a validated record", () => {
  const valid = validateJournal(recordForPhase("published"), OPTIONS);
  const attempts = [
    ["spread copy", { ...valid }],
    ["spread copy with snapshots", { ...valid, snapshots: { ...valid.snapshots } }],
    ["Object.assign copy", Object.assign({}, valid)],
    ["null-prototype copy", Object.assign(Object.create(null), valid)],
    ["deep frozen structural twin", deepFreeze({ ...valid, snapshots: { ...valid.snapshots } })],
    ["JSON round trip", JSON.parse(JSON.stringify(valid))],
    ["JSON round trip (re-parsed string)", JSON.parse(`${JSON.stringify(valid)}`)],
    ["prototype inheriting the validated record", Object.create(valid)],
    ["proxy of the validated record", new Proxy(valid, {})],
    ["proxy returning the validated record's values", new Proxy({ ...valid }, {})],
  ];
  for (const [label, record] of attempts) {
    const error = assertCode(
      () => planRecovery(record, observedFor("published")),
      "record-not-validated",
      label,
    );
    assert.ok(error instanceof JournalError, `${label}: refusal must be a typed JournalError`);
    assert.equal(error.name, "JournalError", `${label}: refusal must be a typed JournalError`);
  }
  // The object validateJournal returned is still the authority, and only that object.
  assert.equal(planRecovery(valid, observedFor("published")).decision, "cleanup");
  // Two validations produce two distinct branded objects; the brand is per object, not a global flag.
  const second = validateJournal(recordForPhase("published"), OPTIONS);
  assert.notEqual(second, valid);
  assert.equal(planRecovery(second, observedFor("published")).decision, "cleanup");
  // A branded record cannot be repointed to another root: it is frozen, so the brand cannot be abused.
  assert.throws(() => {
    valid.rootReal = OTHER_ROOT;
  }, TypeError, "a validated record must be immutable, so its brand cannot be re-pointed");
  assert.equal(valid.rootReal, ROOT);
  assert.equal(planRecovery(valid, observedFor("published")).decision, "cleanup");
});

test("planRecovery refuses a plan result, an observations object or a snapshot map as a record", () => {
  const valid = validateJournal(recordForPhase("published"), OPTIONS);
  const plan = planRecovery(valid, observedFor("published"));
  assertCode(() => planRecovery(plan, observedFor("published")), "record-not-validated", "plan result");
  assertCode(() => planRecovery(observedFor("published"), observedFor("published")), "record-not-validated", "observations");
  assertCode(() => planRecovery(valid.snapshots, observedFor("published")), "record-not-validated", "snapshot map");
  assertCode(() => planRecovery(OPTIONS, observedFor("published")), "record-not-validated", "options object");
  // The brand stays private: no export may let a caller authorize a record itself. If this list ever
  // grows by an "authorize"/"brand"/"trust" helper, the provenance gate is defeatable from outside.
  // `isRecoveryPlan` is the one permitted addition: a read-only membership probe on the plan brand
  // (the trusted executor needs it to refuse an unbranded plan before a filesystem effect). It can
  // only report membership — there is no matching setter — so it grants no authority.
  assert.deepEqual(Object.keys(journalModule).sort(), [
    "DECISIONS",
    "ERROR_CODES",
    "JournalError",
    "PHASES",
    "WORKER_PROOFS",
    "isRecoveryPlan",
    "planRecovery",
    "validateJournal",
    "version",
  ]);
});

test("WORKER_PROOFS is the frozen, documented proof vocabulary and nothing else", () => {
  // The production liveness provider speaks THIS vocabulary (lib/index.js workerLiveness), so a proof
  // string the planner does not accept is a wiring bug that makes recovery throw instead of act. The
  // set is exported read-only: naming the three accepted values grants no authority over a record.
  assert.deepEqual([...WORKER_PROOFS], ["process-exit", "host-registry", "worker-session-id"]);
  assert.equal(Object.isFrozen(WORKER_PROOFS), true, "the exported list must be frozen");
  assert.throws(() => { WORKER_PROOFS.push("epoch-host-dead"); }, TypeError, "the list is immutable");
  assert.deepEqual([...WORKER_PROOFS], ["process-exit", "host-registry", "worker-session-id"]);
  // Every proof the provider may return must be ACCEPTED by the validator (no throw); whether it is a
  // strong enough proof is a separate, per-situation decision the planner makes below:
  // process-exit and host-registry allow the planned cleanup (no restart here), while a worker session
  // id is a well-formed proof that never authorizes anything.
  for (const proof of [...WORKER_PROOFS]) {
    const valid = validateJournal(recordForPhase("published"), OPTIONS);
    const plan = planRecovery(valid, observedFor("published", { worker: { state: "stopped", proof } }));
    if (proof === "worker-session-id") {
      assert.equal(plan.decision, "quarantine");
      assert.equal(plan.code, "worker-proof-session-id-only");
    } else {
      assert.equal(plan.decision, "cleanup", `${proof} must be accepted as a usable proof`);
    }
  }
  assertCode(
    () => planRecovery(
      validateJournal(recordForPhase("published"), OPTIONS),
      observedFor("published", { worker: { state: "stopped", proof: "epoch-host-dead" } }),
    ),
    "invalid-observations",
    "a proof string outside WORKER_PROOFS is malformed data, not a plan",
  );
});

test("isRecoveryPlan is a membership test on planner results, never a shape test", () => {
  const valid = validateJournal(recordForPhase("published"), OPTIONS);
  const plan = planRecovery(valid, observedFor("published"));
  assert.equal(plan.decision, "cleanup");
  // The planner's own frozen result is the only thing that answers true.
  assert.equal(isRecoveryPlan(plan), true);
  // Structural twins are not members, however perfect they are: this is what makes the executor's
  // pre-effect gate meaningful for a forged plan whose jobId, phase, paths and identities are right.
  const lookAlikes = [
    ["shallow clone", { ...plan }],
    ["shallow clone with a copied actions array", { ...plan, actions: [...plan.actions] }],
    ["deep JSON round trip", JSON.parse(JSON.stringify(plan))],
    ["deep frozen structural twin", deepFreeze(JSON.parse(JSON.stringify(plan)))],
    ["Object.assign copy", Object.assign({}, plan)],
    ["prototype inheriting the real plan", Object.create(plan)],
    ["proxy of the real plan", new Proxy(plan, {})],
    ["the branded record it was planned from", valid],
    ["a record's snapshots map", valid.snapshots],
    ["null", null],
    ["undefined", undefined],
    ["a string", "cleanup"],
    ["a number", 1],
    ["an array", []],
    ["a plain object", { decision: "cleanup", actions: [] }],
  ];
  for (const [label, value] of lookAlikes) {
    assert.equal(isRecoveryPlan(value), false, `${label} must not be a recovery plan`);
  }
  // Every decision is branded, including the ones that carry no actions, and a new validation of the
  // same record yields a plan that is a member again while the earlier one keeps its own membership.
  for (const [phase, decision] of [
    ["created", "no-op"],
    ["validated", "manual"],
    ["live-moved", "restore-backup"],
    ["published", "cleanup"],
  ]) {
    const result = planFor(phase);
    assert.equal(result.decision, decision, phase);
    assert.equal(isRecoveryPlan(result), true, `${phase}: every planner result must be branded`);
    assert.equal(isRecoveryPlan(JSON.parse(JSON.stringify(result))), false, `${phase}: a copy must not be`);
  }
});

test("a forged-root record never plans a cleanup or a restore without an external allowlist", () => {
  // Cleanup shape: published, with a bound backup still present under the forged root.
  const forgedCleanup = forgedRootRecord("published");
  const cleanupObservations = observedFor("published");
  // Restore shape: a validated candidate with a live gap and the bound backup still present.
  const forgedRestore = forgedRootRecord("validated");
  const restoreObservations = observations({ stage: present(STAGE_ID), live: ABSENT, backup: present(LIVE_ID) });

  // The forged root is structurally indistinguishable from an authorized record for OTHER_ROOT: when
  // a trusted caller explicitly allowlists that root, both actions ARE planned. That is the whole
  // point — only the allowlist decision, never the record's shape, may authorize them.
  const authorizedCleanup = planRecovery(
    validateJournal(forgedCleanup, { allowedRoots: [OTHER_ROOT] }),
    cleanupObservations,
  );
  assert.equal(authorizedCleanup.decision, "cleanup");
  assert.equal(comparablePath(authorizedCleanup.actions[0].path), comparablePath(path.join(OTHER_ROOT, `.dsh-wiki.bak-${JOB_ID}`)));

  const authorizedRestore = planRecovery(
    validateJournal(forgedRestore, { allowedRoots: [OTHER_ROOT] }),
    restoreObservations,
  );
  assert.equal(authorizedRestore.decision, "restore-backup");
  assert.equal(comparablePath(authorizedRestore.actions[0].src), comparablePath(path.join(OTHER_ROOT, `.dsh-wiki.bak-${JOB_ID}`)));
  assert.equal(comparablePath(authorizedRestore.actions[0].dest), comparablePath(path.join(OTHER_ROOT, ".dsh-wiki")));

  // Without that explicit decision the same records are refused before any action exists — directly,
  // as a structural clone, and after a persistence round trip.
  assertCode(() => planRecovery(forgedCleanup, cleanupObservations), "record-not-validated", "forged cleanup record");
  assertCode(() => planRecovery({ ...forgedCleanup }, cleanupObservations), "record-not-validated", "forged cleanup clone");
  assertCode(
    () => planRecovery(JSON.parse(JSON.stringify(forgedCleanup)), cleanupObservations),
    "record-not-validated",
    "forged cleanup after a JSON round trip",
  );
  assertCode(() => planRecovery(forgedRestore, restoreObservations), "record-not-validated", "forged restore record");
  assertCode(() => planRecovery({ ...forgedRestore }, restoreObservations), "record-not-validated", "forged restore clone");

  // And the fixture allowlist does not cover the forged root, so validateJournal cannot brand it here.
  assertCode(() => validateJournal(forgedCleanup, OPTIONS), "root-not-allowed", "forged cleanup root");
  assertCode(() => validateJournal(forgedRestore, OPTIONS), "root-not-allowed", "forged restore root");
});

test("a persisted record must be re-validated with the external allowlist before it can plan", () => {
  const valid = validateJournal(recordForPhase("published"), OPTIONS);
  // Persist and reload, exactly as a trusted store would after a crash.
  const reloaded = JSON.parse(JSON.stringify(valid));
  assert.deepEqual(reloaded, { ...valid }, "the reloaded record must be structurally identical");
  const cleanupObservations = observedFor("published");
  assertCode(() => planRecovery(reloaded, cleanupObservations), "record-not-validated", "reloaded record");

  // Re-validation with the caller's own allowlist is the only way back to authority.
  const revalidated = validateJournal(reloaded, OPTIONS);
  const plan = planRecovery(revalidated, cleanupObservations);
  assert.equal(plan.decision, "cleanup");
  assert.equal(comparablePath(plan.actions[0].path), comparablePath(BACKUP));

  // Re-validating against an allowlist that does not cover the record's root still refuses, and the
  // reloaded copy stays unbranded, so planRecovery keeps refusing it.
  assertCode(() => validateJournal(reloaded, { allowedRoots: [OTHER_ROOT] }), "root-not-allowed", "reloaded root not allowlisted");
  assertCode(() => planRecovery(reloaded, cleanupObservations), "record-not-validated", "reloaded record after a failed re-validation");
});

test("planRecovery refuses malformed observations", () => {
  const valid = validateJournal(recordForPhase("published"), OPTIONS);
  const cases = [
    ["missing observations", undefined, ERROR_CODES.INVALID_OBSERVATIONS],
    ["missing key", (({ root, ...rest }) => rest)(observations()), ERROR_CODES.INVALID_OBSERVATIONS],
    ["unknown key", { ...observations(), extra: true }, "unknown-key"],
    ["bad host id", observations({ hostInstanceId: "short" }), ERROR_CODES.INVALID_OBSERVATIONS],
    ["bad worker state", observations({ worker: { state: "idle" } }), ERROR_CODES.INVALID_OBSERVATIONS],
    ["proof on an alive worker", observations({ worker: { state: "alive", proof: "process-exit" } }), ERROR_CODES.INVALID_OBSERVATIONS],
    ["unknown proof", observations({ worker: { state: "stopped", proof: "trust-me" } }), ERROR_CODES.INVALID_OBSERVATIONS],
    ["bad session id", observations({ worker: { state: "stopped", proof: "process-exit", sessionId: "x" } }), ERROR_CODES.INVALID_OBSERVATIONS],
    ["entry missing state", observations({ stage: { identity: STAGE_ID } }), ERROR_CODES.INVALID_OBSERVATIONS],
    ["entry present without identity", observations({ stage: { state: "present" } }), ERROR_CODES.INVALID_OBSERVATIONS],
    ["entry absent with identity", observations({ stage: { state: "absent", identity: STAGE_ID } }), ERROR_CODES.INVALID_OBSERVATIONS],
    ["entry unknown state", observations({ stage: { state: "probably" } }), ERROR_CODES.INVALID_OBSERVATIONS],
    ["entry non-object", observations({ stage: "absent" }), ERROR_CODES.INVALID_OBSERVATIONS],
    ["root identity not a directory", observations({ root: present(identityJson("10", "20", "file")) }), ERROR_CODES.INVALID_IDENTITY],
    ["root identity malformed", observations({ root: present("{}") }), ERROR_CODES.INVALID_IDENTITY],
  ];
  for (const [label, value, code] of cases) {
    assertCode(() => planRecovery(valid, value), code, label);
  }
});

// =====================================================================================
// planRecovery — liveness and root gates
// =====================================================================================

test("planRecovery quarantines every phase while the worker is alive or unknown", () => {
  for (const phase of PHASES) {
    for (const worker of [
      { state: "alive" },
      { state: "unknown" },
    ]) {
      const result = planFor(phase, { worker });
      assert.equal(result.decision, "quarantine", `${phase}/${worker.state}`);
      assert.equal(result.phase, phase);
      assertNoActions(result, `${phase}/${worker.state}`);
    }
  }
});

test("planRecovery quarantines a stopped worker without proof", () => {
  for (const phase of PHASES) {
    const result = planFor(phase, { worker: { state: "stopped" } });
    assert.equal(result.decision, "quarantine", phase);
    assert.equal(result.code, "worker-proof-missing");
    assertNoActions(result, phase);
  }
});

test("planRecovery never accepts a session id as proof of termination", () => {
  for (const phase of PHASES) {
    const sameHost = planFor(phase, {
      worker: { state: "stopped", proof: "worker-session-id", sessionId: SESSION_ID },
    });
    assert.equal(sameHost.decision, "quarantine", `${phase}: same host`);
    assert.equal(sameHost.code, "worker-proof-session-id-only");
    assertNoActions(sameHost, `${phase}: same host`);

    const restarted = planFor(phase, {
      hostInstanceId: OTHER_HOST_ID,
      worker: { state: "stopped", proof: "worker-session-id", sessionId: SESSION_ID },
    });
    assert.equal(restarted.decision, "quarantine", `${phase}: restart`);
    assert.equal(restarted.code, "worker-proof-session-id-only");
    assertNoActions(restarted, `${phase}: restart`);
  }
});

test("planRecovery requires independent proof across a restart", () => {
  for (const phase of PHASES) {
    const weak = planFor(phase, {
      hostInstanceId: OTHER_HOST_ID,
      worker: { state: "stopped", proof: "host-registry" },
    });
    assert.equal(weak.decision, "quarantine", `${phase}: old host registry`);
    assert.equal(weak.code, "worker-proof-not-independent");
    assert.equal(weak.restart, true);
    assertNoActions(weak, `${phase}: old host registry`);
  }

  const proven = planFor("published", {
    hostInstanceId: OTHER_HOST_ID,
    worker: { state: "stopped", proof: "process-exit" },
  });
  assert.equal(proven.decision, "cleanup");
  assert.equal(proven.restart, true);

  const sameHost = planFor("published", { worker: { state: "stopped", proof: "process-exit" } });
  assert.equal(sameHost.decision, "cleanup");
  assert.equal(sameHost.restart, false);
});

test("planRecovery refuses an unobserved, missing or replaced root", () => {
  const valid = validateJournal(recordForPhase("published"), OPTIONS);
  const cases = [
    ["unknown", observations({ root: UNKNOWN, stage: ABSENT, live: present(STAGE_ID), backup: present(LIVE_ID) })],
    ["absent", observations({ root: ABSENT, stage: ABSENT, live: present(STAGE_ID), backup: present(LIVE_ID) })],
    [
      "replaced",
      observations({ root: present(identityJson("99", "98")), stage: ABSENT, live: present(STAGE_ID), backup: present(LIVE_ID) }),
    ],
  ];
  for (const [label, value] of cases) {
    const result = planRecovery(valid, value);
    assert.ok(["manual", "quarantine"].includes(result.decision), `${label}: ${result.decision}`);
    assertNoActions(result, `root ${label}`);
  }
});

test("planRecovery quarantines any unknown artifact observation, including several at once", () => {
  for (const phase of PHASES) {
    for (const artifact of ["stage", "live", "backup"]) {
      const result = planFor(phase, { [artifact]: UNKNOWN });
      assert.equal(result.decision, "manual", `${phase}/${artifact}`);
      assert.equal(result.code, "artifact-observation-unknown");
      assertNoActions(result, `${phase}/${artifact}`);
    }
    const all = planFor(phase, { stage: UNKNOWN, live: UNKNOWN, backup: UNKNOWN });
    assert.equal(all.decision, "manual", `${phase}: all unknown`);
    assert.equal(all.code, "artifact-observation-unknown");
    assert.match(all.reason, /stage, live, backup/);
    assertNoActions(all, `${phase}: all unknown`);
  }
});

// =====================================================================================
// planRecovery — per-phase decisions
// =====================================================================================

test("created: consistent state is a no-op", () => {
  const result = planFor("created");
  assert.equal(result.decision, "no-op");
  assert.equal(result.code, "pre-mutation");
  assertNoActions(result, "created");

  const firstGeneration = planRecovery(
    validateJournal(journalRecord({ phase: "created", snapshots: { stage: null, live: null, backup: null } }), OPTIONS),
    observations({ stage: ABSENT, live: ABSENT, backup: ABSENT }),
  );
  assert.equal(firstGeneration.decision, "no-op");
});

test("created: unexpected or drifting artifacts never authorize a mutation", () => {
  const staging = planFor("created", { stage: present(STAGE_ID) });
  assert.equal(staging.decision, "manual");
  assert.equal(staging.code, "unexpected-staging");
  assertNoActions(staging, "created/unexpected staging");

  const backup = planFor("created", { backup: present(BACKUP_ID) });
  assert.equal(backup.decision, "manual");
  assert.equal(backup.code, "unexpected-backup");
  assertNoActions(backup, "created/unexpected backup");

  const liveDrift = planFor("created", { live: present(STAGE_ID) });
  assert.equal(liveDrift.decision, "quarantine");
  assert.equal(liveDrift.code, "live-identity-drift");
  assertNoActions(liveDrift, "created/live drift");
});

test("worker-running and worker-stopped: interrupted transactions need an operator", () => {
  for (const phase of ["worker-running", "worker-stopped"]) {
    const consistent = planFor(phase);
    assert.equal(consistent.decision, "manual", phase);
    assert.equal(consistent.code, "transaction-incomplete");
    assertNoActions(consistent, `${phase}: consistent`);

    const drift = planFor(phase, { stage: present(identityJson("10", "41")) });
    assert.equal(drift.decision, "quarantine", `${phase}: stage drift`);
    assert.equal(drift.code, "staging-identity-drift");
    assertNoActions(drift, `${phase}: stage drift`);

    const missingStage = planFor(phase, { stage: ABSENT });
    assert.equal(missingStage.decision, "manual", `${phase}: missing stage`);
    assert.equal(missingStage.code, "staging-missing");
    assertNoActions(missingStage, `${phase}: missing stage`);

    const liveDrift = planFor(phase, { live: present(identityJson("10", "31")) });
    assert.equal(liveDrift.decision, "quarantine", `${phase}: live drift`);
    assert.equal(liveDrift.code, "live-identity-drift");
    assertNoActions(liveDrift, `${phase}: live drift`);

    const extraBackup = planFor(phase, { backup: present(BACKUP_ID) });
    assert.equal(extraBackup.decision, "manual", `${phase}: extra backup`);
    assert.equal(extraBackup.code, "unexpected-backup");
    assertNoActions(extraBackup, `${phase}: extra backup`);
  }
});

test("validated: an unpublished candidate is never promoted or deleted automatically", () => {
  const result = planFor("validated");
  assert.equal(result.decision, "manual");
  assert.equal(result.code, "publication-not-started");
  assertNoActions(result, "validated");

  const firstGeneration = planRecovery(
    validateJournal(journalRecord({ phase: "validated", snapshots: { stage: STAGE_ID, live: null, backup: null } }), OPTIONS),
    observations({ stage: present(STAGE_ID), live: ABSENT, backup: ABSENT }),
  );
  assert.equal(firstGeneration.decision, "manual");
  assert.equal(firstGeneration.code, "publication-not-started");
  assertNoActions(firstGeneration, "validated/first generation");
});

test("validated: a crash between the two renames restores the exact bound backup", () => {
  const result = planFor("validated", { live: ABSENT, backup: present(LIVE_ID) });
  assert.equal(result.decision, "restore-backup");
  assert.equal(result.code, "crash-between-renames");
  assert.equal(result.actions.length, 1);
  const [action] = result.actions;
  assert.ok(Object.isFrozen(action));
  assert.equal(action.action, "restore-backup");
  assert.equal(action.src, BACKUP);
  assert.equal(action.dest, LIVE);
  assert.equal(action.requiresDestinationAbsent, true);
  assert.deepEqual({ ...action.expect.src }, { dev: "10", ino: "30", kind: "dir", nlink: "1" });
  assert.deepEqual({ ...action.expect.srcParent }, { dev: "10", ino: "20", kind: "dir", nlink: "1" });
  assert.deepEqual({ ...action.expect.destParent }, { dev: "10", ino: "20", kind: "dir", nlink: "1" });
});

test("validated: a backup with the wrong identity, or two live copies, quarantines", () => {
  const forgedBackup = planFor("validated", { live: ABSENT, backup: present(BACKUP_ID) });
  assert.equal(forgedBackup.decision, "quarantine");
  assert.equal(forgedBackup.code, "backup-identity-drift");
  assertNoActions(forgedBackup, "validated/forged backup");

  const twoCopies = planFor("validated", { live: present(LIVE_ID), backup: present(LIVE_ID) });
  assert.equal(twoCopies.decision, "manual");
  assert.equal(twoCopies.code, "unexpected-backup");
  assertNoActions(twoCopies, "validated/two copies");

  const lostLive = planFor("validated", { live: ABSENT, backup: ABSENT });
  assert.equal(lostLive.decision, "manual");
  assert.equal(lostLive.code, "live-missing");
  assertNoActions(lostLive, "validated/live missing");

  const liveDrift = planFor("validated", { live: present(STAGE_ID) });
  assert.equal(liveDrift.decision, "quarantine");
  assert.equal(liveDrift.code, "live-identity-drift");
  assertNoActions(liveDrift, "validated/live drift");
});

test("live-moved: the publication gap rolls back to the bound backup", () => {
  const result = planFor("live-moved");
  assert.equal(result.decision, "restore-backup");
  assert.equal(result.code, "rollback-gap");
  assert.equal(result.actions.length, 1);
  const [action] = result.actions;
  assert.equal(action.action, "restore-backup");
  assert.equal(action.src, BACKUP);
  assert.equal(action.dest, LIVE);
  assert.deepEqual({ ...action.expect.src }, { dev: "10", ino: "30", kind: "dir", nlink: "1" });
});

test("live-moved: missing, forged or reappearing paths quarantine or require an operator", () => {
  const missingBackup = planFor("live-moved", { backup: ABSENT });
  assert.equal(missingBackup.decision, "manual");
  assert.equal(missingBackup.code, "backup-missing");
  assertNoActions(missingBackup, "live-moved/missing backup");

  const forgedBackup = planFor("live-moved", { backup: present(BACKUP_ID) });
  assert.equal(forgedBackup.decision, "quarantine");
  assert.equal(forgedBackup.code, "backup-identity-drift");
  assertNoActions(forgedBackup, "live-moved/forged backup");

  const reappeared = planFor("live-moved", { live: present(LIVE_ID) });
  assert.equal(reappeared.decision, "manual");
  assert.equal(reappeared.code, "unexpected-live");
  assertNoActions(reappeared, "live-moved/live reappeared");

  const drift = planFor("live-moved", { stage: present(identityJson("10", "41")) });
  assert.equal(drift.decision, "quarantine");
  assert.equal(drift.code, "staging-identity-drift");
  assertNoActions(drift, "live-moved/stage drift");
});

test("live-moved: a first generation with nothing to move stays manual", () => {
  const record = journalRecord({
    phase: "live-moved",
    snapshots: { stage: STAGE_ID, live: null, backup: null },
  });
  const consistent = planRecovery(
    validateJournal(record, OPTIONS),
    observations({ stage: present(STAGE_ID), live: ABSENT, backup: ABSENT }),
  );
  assert.equal(consistent.decision, "manual");
  assert.equal(consistent.code, "publication-incomplete");
  assertNoActions(consistent, "live-moved/first generation");

  const extraBackup = planRecovery(
    validateJournal(record, OPTIONS),
    observations({ stage: present(STAGE_ID), live: ABSENT, backup: present(BACKUP_ID) }),
  );
  assert.equal(extraBackup.decision, "manual");
  assert.equal(extraBackup.code, "unexpected-backup");
  assertNoActions(extraBackup, "live-moved/first generation extra backup");
});

test("published: cleanup requires both the bound backup and the bound candidate identity", () => {
  const result = planFor("published");
  assert.equal(result.decision, "cleanup");
  assert.equal(result.code, "stale-backup");
  assert.equal(result.actions.length, 1);
  const [action] = result.actions;
  assert.ok(Object.isFrozen(action));
  assert.equal(action.action, "remove-backup");
  assert.equal(action.path, BACKUP);
  assert.deepEqual({ ...action.identity }, { dev: "10", ino: "30", kind: "dir", nlink: "1" });
  assert.deepEqual({ ...action.parentIdentity }, { dev: "10", ino: "20", kind: "dir", nlink: "1" });

  const noBackup = planFor("published", { backup: ABSENT });
  assert.equal(noBackup.decision, "no-op");
  assert.equal(noBackup.code, "backup-already-removed");
  assertNoActions(noBackup, "published/no backup");

  const liveDrift = planFor("published", { live: present(LIVE_ID) });
  assert.equal(liveDrift.decision, "quarantine");
  assert.equal(liveDrift.code, "live-identity-drift");
  assertNoActions(liveDrift, "published/live drift");

  const forgedBackup = planFor("published", { backup: present(BACKUP_ID) });
  assert.equal(forgedBackup.decision, "quarantine");
  assert.equal(forgedBackup.code, "backup-identity-drift");
  assertNoActions(forgedBackup, "published/forged backup");

  const liveMissing = planFor("published", { live: ABSENT });
  assert.equal(liveMissing.decision, "manual");
  assert.equal(liveMissing.code, "published-live-missing");
  assertNoActions(liveMissing, "published/live missing");

  const strayStaging = planFor("published", { stage: present(STAGE_ID) });
  assert.equal(strayStaging.decision, "manual");
  assert.equal(strayStaging.code, "unexpected-staging");
  assertNoActions(strayStaging, "published/stray staging");
});

test("published: a first-generation publication without a backup is a no-op", () => {
  const record = journalRecord({
    phase: "published",
    snapshots: { stage: null, live: STAGE_ID, backup: null },
  });
  const result = planRecovery(
    validateJournal(record, OPTIONS),
    observations({ stage: ABSENT, live: present(STAGE_ID), backup: ABSENT }),
  );
  assert.equal(result.decision, "no-op");
  assert.equal(result.code, "published");
  assertNoActions(result, "published/first generation");

  const strayBackup = planRecovery(
    validateJournal(record, OPTIONS),
    observations({ stage: ABSENT, live: present(STAGE_ID), backup: present(BACKUP_ID) }),
  );
  assert.equal(strayBackup.decision, "manual");
  assert.equal(strayBackup.code, "unexpected-backup");
  assertNoActions(strayBackup, "published/unbound backup");
});

test("rolled-back: only the bound staging directory may be cleaned up", () => {
  const result = planFor("rolled-back");
  assert.equal(result.decision, "cleanup");
  assert.equal(result.code, "rolled-back-staging");
  assert.equal(result.actions.length, 1);
  const [action] = result.actions;
  assert.equal(action.action, "remove-staging");
  assert.equal(action.path, STAGE);
  assert.deepEqual({ ...action.identity }, { dev: "10", ino: "40", kind: "dir", nlink: "1" });

  const drift = planFor("rolled-back", { stage: present(identityJson("10", "41")) });
  assert.equal(drift.decision, "quarantine");
  assert.equal(drift.code, "staging-identity-drift");
  assertNoActions(drift, "rolled-back/stage drift");

  const gone = planFor("rolled-back", { stage: ABSENT });
  assert.equal(gone.decision, "no-op");
  assert.equal(gone.code, "rolled-back-staging-already-removed");
  assertNoActions(gone, "rolled-back/stage gone");

  const extraBackup = planFor("rolled-back", { backup: present(BACKUP_ID) });
  assert.equal(extraBackup.decision, "manual");
  assert.equal(extraBackup.code, "unexpected-backup");
  assertNoActions(extraBackup, "rolled-back/backup present");

  const liveDrift = planFor("rolled-back", { live: present(identityJson("10", "31")) });
  assert.equal(liveDrift.decision, "quarantine");
  assert.equal(liveDrift.code, "live-identity-drift");
  assertNoActions(liveDrift, "rolled-back/live drift");
});

test("aborted: bound staging cleanup, unknown artifacts never deleted", () => {
  const result = planFor("aborted");
  assert.equal(result.decision, "cleanup");
  assert.equal(result.code, "aborted-staging");
  assert.equal(result.actions[0].action, "remove-staging");

  const gone = planFor("aborted", { stage: ABSENT });
  assert.equal(gone.decision, "no-op");
  assert.equal(gone.code, "aborted-staging-already-removed");

  const unbound = planRecovery(
    validateJournal(journalRecord({ phase: "aborted", snapshots: { stage: null, live: LIVE_ID, backup: null } }), OPTIONS),
    observations({ stage: present(STAGE_ID), live: present(LIVE_ID), backup: ABSENT }),
  );
  assert.equal(unbound.decision, "manual");
  assert.equal(unbound.code, "unexpected-staging");
  assertNoActions(unbound, "aborted/unbound staging");
});

test("planRecovery matches identity by dev/ino/kind and ignores nlink", () => {
  const nlinkChanged = planFor("worker-running", { stage: present(identityJson("10", "40", "dir", "9")) });
  assert.equal(nlinkChanged.decision, "manual");
  assert.equal(nlinkChanged.code, "transaction-incomplete");

  const dirNameSwapped = planFor("worker-running", { stage: present(identityJson("11", "40")) });
  assert.equal(dirNameSwapped.decision, "quarantine");
  assert.equal(dirNameSwapped.code, "staging-identity-drift");

  const deviceSwapped = planFor("worker-running", { stage: present(identityJson("10", "999")) });
  assert.equal(deviceSwapped.decision, "quarantine");
  assert.equal(deviceSwapped.code, "staging-identity-drift");

  const rootNlinkChanged = planFor("created", { root: present(identityJson("10", "20", "dir", "7")) });
  assert.equal(rootNlinkChanged.decision, "no-op");
});

test("planRecovery results are frozen, serializable data with no effects", () => {
  const samples = [
    planFor("created"),
    planFor("validated", { live: ABSENT, backup: present(LIVE_ID) }),
    planFor("published"),
    planFor("aborted"),
    planFor("published", { worker: { state: "alive" } }),
    planFor("published", { live: UNKNOWN }),
  ];
  for (const result of samples) {
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.actions));
    assert.deepEqual(JSON.parse(JSON.stringify(result)), { ...result, actions: result.actions.map((a) => ({ ...a })) });
    assert.ok(["restore-backup", "cleanup"].includes(result.decision) || result.actions.length === 0);
    assert.equal(typeof result.jobId, "string");
    assert.equal(typeof result.phase, "string");
    assert.equal(typeof result.restart, "boolean");
    assert.equal(typeof result.code, "string");
    assert.equal(typeof result.reason, "string");
  }
});

test("planRecovery never invents paths outside the validated record", () => {
  for (const phase of ["validated", "live-moved", "published", "rolled-back", "aborted"]) {
    const result = planFor(phase);
    for (const action of result.actions) {
      const target = action.dest ?? action.path;
      assert.ok(
        target === STAGE || target === LIVE || target === BACKUP,
        `${phase}: action target ${target} must be one of the record's bound paths`,
      );
    }
  }
});

// =====================================================================================
// hostile values and diagnostics — typed refusals, no coercion, no reflection escape
// =====================================================================================

const RECORD_KEYS = [
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
];

/** A revoked Proxy: every reflection step on it now throws a raw TypeError outside any handler. */
function revokedProxy(target = {}) {
  const revocable = Proxy.revocable(target, {});
  revocable.revoke();
  return revocable.proxy;
}

test("a rejected version, job id or phase is never serialized and never coerced", () => {
  // These diagnostics used to reach `JSON.stringify`, which threw a raw TypeError for a BigInt or a
  // cycle and invoked `toJSON` — i.e. caller code — for everything else. A refusal must be a typed
  // JournalError whose message description cannot run or throw anything.
  let coercions = 0;
  const spy = {};
  Object.defineProperties(spy, {
    toJSON: {
      get() {
        coercions += 1;
        return () => 1;
      },
      enumerable: false,
      configurable: true,
    },
    toString: {
      get() {
        coercions += 1;
        return () => "1";
      },
      enumerable: false,
      configurable: true,
    },
    valueOf: {
      get() {
        coercions += 1;
        return () => 1;
      },
      enumerable: false,
      configurable: true,
    },
  });
  spy[Symbol.toPrimitive] = () => {
    coercions += 1;
    return 1;
  };
  const cyclic = {};
  cyclic.self = cyclic;

  const cases = [
    ["version", 10n, ERROR_CODES.INVALID_VERSION, "bigint"],
    ["version", cyclic, ERROR_CODES.INVALID_VERSION, "object"],
    ["version", spy, ERROR_CODES.INVALID_VERSION, "object"],
    ["jobId", 10n, ERROR_CODES.INVALID_JOB_ID, "bigint"],
    ["jobId", cyclic, ERROR_CODES.INVALID_JOB_ID, "object"],
    ["jobId", spy, ERROR_CODES.INVALID_JOB_ID, "object"],
    ["phase", 10n, ERROR_CODES.INVALID_PHASE, "bigint"],
    ["phase", cyclic, ERROR_CODES.INVALID_PHASE, "object"],
    ["phase", spy, ERROR_CODES.INVALID_PHASE, "object"],
  ];
  for (const [field, value, code, type] of cases) {
    const record = recordForPhase("created");
    record[field] = value;
    const error = assertCode(() => validateJournal(record, OPTIONS), code, `${field} as ${type}`);
    assert.equal(error.name, "JournalError", `${field} as ${type}: a refusal must be a JournalError`);
    assert.ok(
      error.message.includes(`a value of type ${type}`),
      `${field} as ${type}: the diagnostic must name the type, got: ${error.message}`,
    );
    assert.equal(coercions, 0, `${field} as ${type}: diagnostics must not read toJSON/toString/valueOf/Symbol.toPrimitive`);
  }
  // A cyclic object and a coercion trap would each have made the old message itself fail.
  assert.equal(coercions, 0, "no coercion may run for any diagnostic");
});

test("a rejected string field is quoted from a bounded copy, not echoed verbatim", () => {
  const hostile = `${"a".repeat(4096)}\nFAKE LOG LINE ${"b".repeat(4096)}`;
  for (const [field, code] of [
    ["version", ERROR_CODES.INVALID_VERSION],
    ["jobId", ERROR_CODES.INVALID_JOB_ID],
    ["phase", ERROR_CODES.INVALID_PHASE],
  ]) {
    const record = recordForPhase("created");
    record[field] = hostile;
    const error = assertCode(() => validateJournal(record, OPTIONS), code, `${field} hostile string`);
    assert.ok(!error.message.includes("\n"), `${field}: the diagnostic must not contain a raw newline`);
    assert.ok(
      !error.message.includes("b".repeat(64)),
      `${field}: the diagnostic must truncate the rejected value instead of echoing it`,
    );
    assert.ok(error.message.length < 300, `${field}: the diagnostic must stay bounded, got ${error.message.length}`);
  }
});

test("revoked proxies are refused with a typed error, never a raw TypeError", () => {
  const valid = validateJournal(recordForPhase("published"), OPTIONS);
  const plain = recordForPhase("created");

  const recordProxied = recordForPhase("created");
  recordProxied.snapshots = revokedProxy({ ...PHASE_SNAPSHOTS.created });

  const versionProxied = recordForPhase("created");
  versionProxied.version = revokedProxy({});
  const jobIdProxied = recordForPhase("created");
  jobIdProxied.jobId = revokedProxy({});
  const phaseProxied = recordForPhase("created");
  phaseProxied.phase = revokedProxy({});
  const rootProxied = recordForPhase("created");
  rootProxied.rootReal = revokedProxy({});

  const cases = [
    ["options", () => validateJournal(plain, revokedProxy()), ERROR_CODES.INVALID_OPTIONS],
    [
      "allowedRoots array",
      () => validateJournal(plain, { allowedRoots: revokedProxy([ROOT]) }),
      ERROR_CODES.INVALID_OPTIONS,
    ],
    ["record", () => validateJournal(revokedProxy(recordForPhase("created")), OPTIONS), ERROR_CODES.INVALID_RECORD],
    ["snapshots", () => validateJournal(recordProxied, OPTIONS), ERROR_CODES.INVALID_RECORD],
    ["version value", () => validateJournal(versionProxied, OPTIONS), ERROR_CODES.INVALID_VERSION],
    ["jobId value", () => validateJournal(jobIdProxied, OPTIONS), ERROR_CODES.INVALID_JOB_ID],
    ["phase value", () => validateJournal(phaseProxied, OPTIONS), ERROR_CODES.INVALID_PHASE],
    ["rootReal value", () => validateJournal(rootProxied, OPTIONS), ERROR_CODES.INVALID_ROOT],
    // A record is checked for provenance before anything reflects on it, so a revoked record Proxy is
    // still refused by the brand gate rather than by a raw reflection failure.
    [
      "planRecovery record",
      () => planRecovery(revokedProxy(recordForPhase("published")), observedFor("published")),
      "record-not-validated",
    ],
    ["observations", () => planRecovery(valid, revokedProxy()), ERROR_CODES.INVALID_OBSERVATIONS],
    ["observations.worker", () => planRecovery(valid, observations({ worker: revokedProxy() })), ERROR_CODES.INVALID_OBSERVATIONS],
    ["observations.stage", () => planRecovery(valid, observations({ stage: revokedProxy() })), ERROR_CODES.INVALID_OBSERVATIONS],
    ["observations.root", () => planRecovery(valid, observations({ root: revokedProxy() })), ERROR_CODES.INVALID_OBSERVATIONS],
  ];
  for (const [label, call, code] of cases) {
    const error = assertCode(call, code, label);
    assert.equal(error.name, "JournalError", `${label}: a revoked Proxy must be a typed refusal`);
  }

  // `Array.isArray` throws on a revoked Proxy, so the diagnostic names it without inspecting it.
  const error = assertCode(() => validateJournal(plain, revokedProxy()), ERROR_CODES.INVALID_OPTIONS, "options label");
  assert.ok(
    error.message.includes("uninspectable object"),
    `the diagnostic must describe an uninspectable value without inspecting it, got: ${error.message}`,
  );
});

test("hostile proxies whose traps throw are refused with a typed error", () => {
  const valid = validateJournal(recordForPhase("published"), OPTIONS);
  const throwingTraps = {
    get() {
      throw new TypeError("hostile get trap");
    },
    has() {
      throw new TypeError("hostile has trap");
    },
    getPrototypeOf() {
      throw new TypeError("hostile getPrototypeOf trap");
    },
    ownKeys() {
      throw new TypeError("hostile ownKeys trap");
    },
    getOwnPropertyDescriptor() {
      throw new TypeError("hostile getOwnPropertyDescriptor trap");
    },
  };
  const hostile = () => new Proxy({}, throwingTraps);
  const hostileNullProto = () => new Proxy(Object.create(null), throwingTraps);
  const hostileKeys = () =>
    new Proxy(Object.create(null), {
      ownKeys: () => ["version"],
      getOwnPropertyDescriptor() {
        throw new TypeError("hostile getOwnPropertyDescriptor trap");
      },
    });
  const hostileArrayLength = new Proxy([ROOT], {
    get(target, key, receiver) {
      if (key === "length") throw new TypeError("hostile length trap");
      return Reflect.get(target, key, receiver);
    },
  });

  const cases = [
    ["record with throwing traps", () => validateJournal(hostile(), OPTIONS), ERROR_CODES.INVALID_RECORD],
    ["null-prototype record with throwing traps", () => validateJournal(hostileNullProto(), OPTIONS), ERROR_CODES.INVALID_RECORD],
    ["record whose descriptors throw", () => validateJournal(hostileKeys(), OPTIONS), ERROR_CODES.INVALID_RECORD],
    ["options with throwing traps", () => validateJournal(recordForPhase("created"), hostile()), ERROR_CODES.INVALID_OPTIONS],
    [
      "observations with throwing traps",
      () => planRecovery(valid, hostileNullProto()),
      ERROR_CODES.INVALID_OBSERVATIONS,
    ],
    [
      "allowedRoots with a throwing length trap",
      () => validateJournal(recordForPhase("created"), { allowedRoots: hostileArrayLength }),
      ERROR_CODES.INVALID_OPTIONS,
    ],
  ];
  for (const [label, call, code] of cases) {
    assertCode(call, code, label);
  }

  // A proxy that only lies about property *reads* cannot affect validation: values come from
  // descriptors, so the `get` trap is never reached and the record validates normally.
  let getTrapCalls = 0;
  const readLiar = new Proxy(recordForPhase("created"), {
    get() {
      getTrapCalls += 1;
      throw new TypeError("hostile get trap");
    },
  });
  const normalized = validateJournal(readLiar, OPTIONS);
  assert.equal(normalized.phase, "created");
  assert.equal(getTrapCalls, 0, "validation must read descriptors, never properties");
});

test("no getter on a record, options, snapshots or observations object is ever invoked", () => {
  let reads = 0;
  const accessor = (value) => ({
    get() {
      reads += 1;
      return value;
    },
    enumerable: true,
    configurable: true,
  });

  const record = {};
  for (const key of RECORD_KEYS) Object.defineProperty(record, key, accessor("x"));
  assertCode(() => validateJournal(record, OPTIONS), "unknown-key", "record getters");
  assert.equal(reads, 0, "validation must reject accessors without invoking them");

  const options = {};
  Object.defineProperty(options, "allowedRoots", accessor([ROOT]));
  assertCode(() => validateJournal(recordForPhase("created"), options), "unknown-key", "options getter");
  assert.equal(reads, 0, "the options accessor must not be invoked");

  const snapshots = {};
  for (const key of ["stage", "live", "backup"]) Object.defineProperty(snapshots, key, accessor(null));
  const snapshotsRecord = recordForPhase("created");
  snapshotsRecord.snapshots = snapshots;
  assertCode(() => validateJournal(snapshotsRecord, OPTIONS), "unknown-key", "snapshots getters");
  assert.equal(reads, 0, "the snapshots accessors must not be invoked");

  const rootArray = [ROOT];
  Object.defineProperty(rootArray, "0", accessor(ROOT));
  assertCode(
    () => validateJournal(recordForPhase("created"), { allowedRoots: rootArray }),
    ERROR_CODES.INVALID_OPTIONS,
    "allowedRoots element accessor",
  );
  assert.equal(reads, 0, "the allowlist element accessor must not be invoked");

  const valid = validateJournal(recordForPhase("published"), OPTIONS);
  const observed = observations();
  Object.defineProperty(observed, "worker", accessor({ state: "stopped", proof: "host-registry" }));
  assertCode(() => planRecovery(valid, observed), "unknown-key", "observations getter");
  assert.equal(reads, 0, "the observations accessor must not be invoked");

  const entry = {};
  Object.defineProperty(entry, "state", accessor("present"));
  assertCode(() => planRecovery(valid, observations({ stage: entry })), "unknown-key", "entry getter");
  assert.equal(reads, 0, "the entry accessor must not be invoked");
  assert.equal(reads, 0, "no getter may run for any refused input");
});

test("the header documents the exact phase write order the trusted store must follow", () => {
  const source = readFileSync(path.join(here, "..", "lib", "journal.js"), "utf8");
  assert.ok(source.includes("REQUIRED WRITE ORDER"), "journal.js must document the required write order");
  const durable = source.indexOf("`validated` is made DURABLE before the first rename");
  const afterFirstRename = source.indexOf("`live-moved` is written strictly AFTER that first rename");
  const afterPromotion = source.indexOf("`published` is written strictly AFTER the promotion");
  assert.ok(durable > 0, "the validated-before-first-rename rule must be documented");
  assert.ok(afterFirstRename > durable, "live-moved must be documented as written after the first rename");
  assert.ok(afterPromotion > afterFirstRename, "published must be documented as written after the promotion");
  assert.ok(
    source.indexOf("Recovery itself never writes") > afterPromotion,
    "recovery must be documented as never writing the journal",
  );
});
