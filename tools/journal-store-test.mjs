// dsh-wiki — offline adversarial tests for lib/journal-store.js (spec 007, T018).
//
// Drives the dormant journal store directly: no DSH Host, no network, no live wiki, no plugin wiring.
// Every fixture is a real temporary directory created OUTSIDE the repository (under the OS temp dir),
// and the tests use the real filesystem — including Windows junctions and hardlinks where the platform
// allows them — because the whole point of the store is behaviour on a real filesystem, not on a stub.
//
// What is NOT claimed here (see the module header's LIMITATIONS): this suite proves the store's
// two-record visibility under a cooperating, stable filesystem, NOT power-loss durability, NOT
// operating-system isolation, NOT atomic no-replace and NOT worker liveness. The independent review,
// the trusted executor and the liveness proof for T018 are all still outstanding.
//
// Run with:
//   node --test plugins/dsh-wiki/tools/journal-store-test.mjs
import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { realpath as realpathCallback } from "node:fs";
import { lstat, mkdir, open, rename, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const here = import.meta.dirname;
const urlOf = (name) => pathToFileURL(path.join(here, "..", "lib", name)).href;
const {
  DEFAULT_LIMITS,
  ERROR_CODES,
  JournalStoreError,
  PHASE_STEPS,
  TERMINAL_PHASES,
  journalFileName,
  openJournalStore,
} = await import(urlOf("journal-store.js"));
const { identityOf } = await import(urlOf("fs-contain.js"));
const { planRecovery } = await import(urlOf("journal.js"));

const isWin = process.platform === "win32";
const realpathNative = (target) => (typeof realpathSync.native === "function" ? realpathSync.native(target) : realpathSync(target));

// ---------- fixtures ----------

let base;
let fixtureCounter = 0;

before(() => {
  base = realpathNative(mkdtempSync(path.join(tmpdir(), "dsh-wiki-journal-store-")));
});

after(() => {
  rmSync(base, { recursive: true, force: true });
});

function freshDir(name) {
  fixtureCounter += 1;
  const directory = path.join(base, `${String(fixtureCounter).padStart(2, "0")}-${name}`);
  mkdirSync(directory, { recursive: true });
  return realpathNative(directory);
}

const JOB_A = "0123456789abcdef";
const JOB_B = "fedcba9876543210";
const HOST_ID = "host-0123456789";
const OTHER_HOST_ID = "host-9876543210";
const SESSION_ID = "session-01234567";
const PROTOCOL_HASH = "a".repeat(64);
const PROMPT_HASH = "b".repeat(64);

/** Canonical identity JSON for one real directory. */
async function realIdentity(target) {
  return JSON.stringify(await identityOf(target));
}

/** A syntactically valid identity that belongs to nothing on disk (used for drift fixtures). */
function spareIdentity(dev, ino) {
  return JSON.stringify({ dev, ino, kind: "dir", nlink: "1" });
}

const SPARE_A = spareIdentity("77", "88");
const SPARE_B = spareIdentity("77", "99");

/**
 * One complete scenario: a repository root, a store directory beside it (never inside it), a live wiki
 * directory, a staging directory, and a record builder whose snapshots describe those real directories.
 */
async function setup(options = {}) {
  const { name = "scenario", job = JOB_A, withLive = true, withStage = true, limits, hostInstanceId, io } = options;
  const caseDir = freshDir(name);
  const repo = path.join(caseDir, "repo");
  mkdirSync(repo);
  const storeDir = path.join(caseDir, "store");
  mkdirSync(storeDir);

  const livePath = path.join(repo, ".dsh-wiki");
  const liveIdentity = withLive ? (mkdirSync(livePath), await realIdentity(livePath)) : null;
  const stagePath = path.join(repo, `.dsh-wiki.staging-${job}`);
  const stageIdentity = withStage ? (mkdirSync(stagePath), await realIdentity(stagePath)) : null;
  const backupPath = path.join(repo, `.dsh-wiki.bak-${job}`);
  const rootIdentity = await realIdentity(repo);

  const snapshotsFor = (phase) =>
    ({
      created: { stage: null, live: liveIdentity, backup: null },
      "worker-running": { stage: stageIdentity, live: liveIdentity, backup: null },
      "worker-stopped": { stage: stageIdentity, live: liveIdentity, backup: null },
      validated: { stage: stageIdentity, live: liveIdentity, backup: null },
      "live-moved": { stage: stageIdentity, live: null, backup: liveIdentity },
      published: { stage: null, live: stageIdentity, backup: liveIdentity },
      "rolled-back": { stage: stageIdentity, live: liveIdentity, backup: null },
      aborted: { stage: stageIdentity, live: liveIdentity, backup: null },
    })[phase];

  const record = (overrides = {}) => ({
    version: 1,
    jobId: job,
    hostInstanceId: HOST_ID,
    rootReal: repo,
    rootIdentity,
    stagePath,
    livePath,
    backupPath,
    workerSessionId: SESSION_ID,
    protocolSha256: PROTOCOL_HASH,
    promptSha256: PROMPT_HASH,
    phase: "created",
    snapshots: { ...snapshotsFor("created") },
    ...overrides,
  });
  const recordFor = (phase, overrides = {}) => record({ phase, snapshots: { ...snapshotsFor(phase) }, ...overrides });

  const store = await openJournalStore({
    storeDir,
    allowedRoots: [repo],
    ...(hostInstanceId === undefined ? {} : { hostInstanceId }),
    ...(limits === undefined ? {} : { limits }),
    ...(io === undefined ? {} : { io }),
  });

  return {
    caseDir,
    repo,
    storeDir,
    store,
    livePath,
    liveIdentity,
    stagePath,
    stageIdentity,
    backupPath,
    rootIdentity,
    journalPath: path.join(storeDir, journalFileName(repo)),
    record,
    recordFor,
    snapshotsFor,
  };
}

// ---------- assertion helpers ----------

function isStoreError(error) {
  return error instanceof JournalStoreError;
}

async function expectRefusal(promise, code, extra = () => {}) {
  await assert.rejects(promise, (error) => {
    assert.ok(isStoreError(error), `expected a JournalStoreError, got ${error?.name}: ${error?.message}`);
    assert.equal(error.code, code, `expected code "${code}", got "${error.code}": ${error.message}`);
    extra(error);
    return true;
  });
}

function assertFrozenSnapshot(snapshot) {
  assert.ok(Object.isFrozen(snapshot), "a snapshot must be frozen");
  assert.ok(Object.isFrozen(snapshot.record), "the snapshot's record must be frozen");
  assert.ok(Object.isFrozen(snapshot.fileIdentity), "the snapshot's fileIdentity must be frozen");
  assert.equal(typeof snapshot.sha256, "string");
  assert.match(snapshot.sha256, /^[0-9a-f]{64}$/);
  assert.match(snapshot.fileIdentity.dev, /^(0|[1-9][0-9]*)$/);
  assert.match(snapshot.fileIdentity.ino, /^(0|[1-9][0-9]*)$/);
  assert.ok(["directory-synced", "file-flushed", "unverified"].includes(snapshot.durability), "durability must be one of the documented values");
}

/** Observations the planner accepts; every entry is data, never filesystem access. */
function observations(fixture, overrides = {}) {
  return {
    hostInstanceId: HOST_ID,
    worker: { state: "stopped", proof: "process-exit" },
    root: { state: "present", identity: fixture.rootIdentity },
    stage: fixture.stageIdentity === null ? { state: "absent" } : { state: "present", identity: fixture.stageIdentity },
    live: fixture.liveIdentity === null ? { state: "absent" } : { state: "present", identity: fixture.liveIdentity },
    backup: { state: "absent" },
    ...overrides,
  };
}

/** Real filesystem io, with per-call logging and optional failure/short-circuit hooks. */
const realpathNativeAsync = promisify(typeof realpathCallback.native === "function" ? realpathCallback.native : realpathCallback);
const REAL_IO = Object.freeze({ lstat: (target) => lstat(target, { bigint: true }), realpath: realpathNativeAsync, open, mkdir, rmdir, unlink, rename });

/**
 * Build an io object that logs every call and lets a hook fail or replace a specific call. The hook
 * receives `{ name, args, next }` and may return a value, throw, or wrap the real result.
 */
function instrument(hooks = {}) {
  const calls = [];
  const io = {};
  for (const name of Object.keys(REAL_IO)) {
    io[name] = async (...args) => {
      calls.push({ name, args });
      const hook = hooks[name];
      if (typeof hook === "function") return hook({ name, args, calls, next: REAL_IO[name], io });
      return REAL_IO[name](...args);
    };
  }
  return { io, calls };
}

function fsError(code) {
  const error = new Error(`${code}: injected test failure`);
  error.code = code;
  return error;
}

/** Wrap a real FileHandle so individual operations can fail on demand (close still runs first). */
function wrapHandle(handle, faults = {}, log = []) {
  const record = (name) => {
    log.push(name);
  };
  return {
    async stat(optionsArg) {
      record("stat");
      if (Object.hasOwn(faults, "stat")) throw faults.stat;
      return handle.stat(optionsArg);
    },
    async read(buffer, offset, length, position) {
      record("read");
      if (Object.hasOwn(faults, "read")) throw faults.read;
      return handle.read(buffer, offset, length, position);
    },
    async write(buffer, offset, length, position) {
      record("write");
      if (Object.hasOwn(faults, "write")) throw faults.write;
      return handle.write(buffer, offset, length, position);
    },
    async sync() {
      record("sync");
      if (Object.hasOwn(faults, "sync")) throw faults.sync;
      return handle.sync();
    },
    async close() {
      record("close");
      const result = await handle.close();
      if (Object.hasOwn(faults, "close")) throw faults.close;
      return result;
    },
  };
}

/** Every entry in the store directory, sorted. Used to prove nothing stray is left behind. */
function storeContents(storeDir) {
  return readdirSync(storeDir).sort();
}

// ---------- 1. opening a store: trust, canonicality, overlap ----------

test("openJournalStore requires storeDir, allowedRoots and only known options", async () => {
  await expectRefusal(openJournalStore(), ERROR_CODES.INVALID_OPTIONS);
  await expectRefusal(openJournalStore({}), ERROR_CODES.INVALID_OPTIONS);
  await expectRefusal(openJournalStore({ allowedRoots: [freshDir("r")] }), ERROR_CODES.INVALID_OPTIONS, (error) => {
    assert.match(error.message, /storeDir is required/);
  });
  const caseDir = freshDir("opts");
  const storeDir = path.join(caseDir, "store");
  mkdirSync(storeDir);
  await expectRefusal(openJournalStore({ storeDir }), ERROR_CODES.INVALID_OPTIONS, (error) => {
    assert.match(error.message, /allowedRoots is required/);
  });
  await expectRefusal(openJournalStore({ storeDir, allowedRoots: [] }), ERROR_CODES.INVALID_OPTIONS);
  await expectRefusal(openJournalStore({ storeDir, allowedRoots: [freshDir("r")], extra: 1 }), ERROR_CODES.INVALID_OPTIONS, (error) => {
    assert.match(error.message, /unknown option "extra"/);
  });
  await expectRefusal(openJournalStore({ storeDir, allowedRoots: [freshDir("r")], hostInstanceId: "short" }), ERROR_CODES.INVALID_OPTIONS);
  await expectRefusal(openJournalStore({ storeDir, allowedRoots: [freshDir("r")], limits: { maxBogus: 1 } }), ERROR_CODES.INVALID_LIMIT);
  await expectRefusal(openJournalStore({ storeDir, allowedRoots: [freshDir("r")], limits: { maxRecordBytes: 0 } }), ERROR_CODES.INVALID_LIMIT);
});

test("openJournalStore refuses a listing seam in options.io (the store never enumerates)", async () => {
  const caseDir = freshDir("iolist");
  const storeDir = path.join(caseDir, "store");
  mkdirSync(storeDir);
  const repo = path.join(caseDir, "repo");
  mkdirSync(repo);
  for (const key of ["readdir", "opendir"]) {
    await expectRefusal(openJournalStore({ storeDir, allowedRoots: [repo], io: { [key]: async () => [] } }), ERROR_CODES.INVALID_IO, (error) => {
      assert.match(error.message, /never enumerates/);
    });
  }
  await expectRefusal(openJournalStore({ storeDir, allowedRoots: [repo], io: { lstat: "nope" } }), ERROR_CODES.INVALID_IO);
});

test("openJournalStore refuses a store directory that is not an existing canonical directory", async () => {
  const caseDir = freshDir("nostore");
  const repo = path.join(caseDir, "repo");
  mkdirSync(repo);
  await expectRefusal(openJournalStore({ storeDir: path.join(caseDir, "absent"), allowedRoots: [repo] }), ERROR_CODES.STORE_UNTRUSTED, (error) => {
    assert.equal(error.detail.fsCode, "path-not-found");
  });
  const file = path.join(caseDir, "file.txt");
  writeFileSync(file, "x");
  await expectRefusal(openJournalStore({ storeDir: file, allowedRoots: [repo] }), ERROR_CODES.STORE_UNTRUSTED);
});

test("openJournalStore refuses an allowlisted root that is not an existing canonical directory", async () => {
  const caseDir = freshDir("noroot");
  const storeDir = path.join(caseDir, "store");
  mkdirSync(storeDir);
  await expectRefusal(openJournalStore({ storeDir, allowedRoots: [path.join(caseDir, "absent")] }), ERROR_CODES.ROOT_UNREADABLE);
});

test("a store directory inside an allowlisted root is refused (worker-writable repository)", async () => {
  const repo = freshDir("repo-overlap");
  const storeDir = path.join(repo, ".journal");
  mkdirSync(storeDir);
  await expectRefusal(openJournalStore({ storeDir, allowedRoots: [repo] }), ERROR_CODES.STORE_OVERLAP_ROOT, (error) => {
    assert.match(error.message, /INSIDE the allowlisted repository root/);
  });
  // ...and a nested store much deeper is refused just the same.
  const deeper = path.join(repo, "a", "b", "c");
  mkdirSync(deeper, { recursive: true });
  await expectRefusal(openJournalStore({ storeDir: deeper, allowedRoots: [repo] }), ERROR_CODES.STORE_OVERLAP_ROOT);
});

test("an allowlisted root inside the store directory is refused", async () => {
  const storeDir = freshDir("store-overlap");
  const repo = path.join(storeDir, "repo");
  mkdirSync(repo);
  await expectRefusal(openJournalStore({ storeDir, allowedRoots: [repo] }), ERROR_CODES.STORE_OVERLAP_ROOT, (error) => {
    assert.match(error.message, /INSIDE the store directory/);
  });
});

test("a store directory that IS an allowlisted root is refused", async () => {
  const repo = freshDir("store-equals");
  await expectRefusal(openJournalStore({ storeDir: repo, allowedRoots: [repo] }), ERROR_CODES.STORE_OVERLAP_ROOT, (error) => {
    assert.match(error.message, /IS an allowlisted repository root/);
  });
});

test("a store directory reached through a junction is refused (no linked ancestor)", async (t) => {
  const caseDir = freshDir("junction-store");
  const realStore = path.join(caseDir, "store");
  mkdirSync(realStore);
  const linkPath = path.join(caseDir, "store-link");
  try {
    symlinkSync(realStore, linkPath, isWin ? "junction" : "dir");
  } catch (error) {
    t.skip(`this platform cannot create a directory link (${error.code})`);
    return;
  }
  await expectRefusal(openJournalStore({ storeDir: linkPath, allowedRoots: [path.join(caseDir, "repo-x")] }), ERROR_CODES.STORE_UNTRUSTED);
  const repo = path.join(caseDir, "repo");
  mkdirSync(repo);
  await expectRefusal(openJournalStore({ storeDir: linkPath, allowedRoots: [repo] }), ERROR_CODES.STORE_UNTRUSTED, (error) => {
    assert.ok(["path-link", "path-not-canonical"].includes(error.detail.fsCode), `unexpected fs code ${error.detail.fsCode}`);
  });
});

test("a store directory whose ANCESTOR is a junction is refused", async (t) => {
  const caseDir = freshDir("junction-ancestor");
  const realParent = path.join(caseDir, "real");
  const storeDir = path.join(realParent, "store");
  mkdirSync(storeDir, { recursive: true });
  const linkParent = path.join(caseDir, "link");
  try {
    symlinkSync(realParent, linkParent, isWin ? "junction" : "dir");
  } catch (error) {
    t.skip(`this platform cannot create a directory link (${error.code})`);
    return;
  }
  const repo = path.join(caseDir, "repo");
  mkdirSync(repo);
  await expectRefusal(
    openJournalStore({ storeDir: path.join(linkParent, "store"), allowedRoots: [repo] }),
    ERROR_CODES.STORE_UNTRUSTED,
    (error) => {
      assert.equal(error.detail.fsCode, "ancestor-link");
    },
  );
});

test("an allowlisted root reached through a junction is refused", async (t) => {
  const caseDir = freshDir("junction-root");
  const storeDir = path.join(caseDir, "store");
  mkdirSync(storeDir);
  const realRepo = path.join(caseDir, "repo");
  mkdirSync(realRepo);
  const linkRepo = path.join(caseDir, "repo-link");
  try {
    symlinkSync(realRepo, linkRepo, isWin ? "junction" : "dir");
  } catch (error) {
    t.skip(`this platform cannot create a directory link (${error.code})`);
    return;
  }
  await expectRefusal(openJournalStore({ storeDir, allowedRoots: [linkRepo] }), ERROR_CODES.ROOT_UNREADABLE);
});

// ---------- 2. reading a missing store ----------

test("load() returns null for a root with no record, and creates nothing", async () => {
  const fixture = await setup({ name: "missing" });
  assert.equal(await fixture.store.load(fixture.repo), null);
  assert.deepEqual(storeContents(fixture.storeDir), [], "a read must not create locks, temps or records");
});

test("load() refuses a root that is not allowlisted", async () => {
  const fixture = await setup({ name: "not-allowlisted" });
  const other = freshDir("other-root");
  await expectRefusal(fixture.store.load(other), ERROR_CODES.ROOT_NOT_ALLOWED);
});

test("each root gets its own fixed file name and never sees another root's record", async () => {
  const caseDir = freshDir("two-roots");
  const storeDir = path.join(caseDir, "store");
  mkdirSync(storeDir);
  const repoA = path.join(caseDir, "repoA");
  const repoB = path.join(caseDir, "repoB");
  mkdirSync(repoA);
  mkdirSync(repoB);
  const store = await openJournalStore({ storeDir, allowedRoots: [repoA, repoB] });
  assert.notEqual(journalFileName(repoA), journalFileName(repoB));

  const recordA = {
    version: 1,
    jobId: JOB_A,
    hostInstanceId: HOST_ID,
    rootReal: repoA,
    rootIdentity: await realIdentity(repoA),
    stagePath: path.join(repoA, `.dsh-wiki.staging-${JOB_A}`),
    livePath: path.join(repoA, ".dsh-wiki"),
    backupPath: path.join(repoA, `.dsh-wiki.bak-${JOB_A}`),
    workerSessionId: SESSION_ID,
    protocolSha256: PROTOCOL_HASH,
    promptSha256: PROMPT_HASH,
    phase: "created",
    snapshots: { stage: null, live: null, backup: null },
  };
  await store.create(recordA);
  assert.deepEqual(storeContents(storeDir), [journalFileName(repoA)]);
  assert.notEqual(await store.load(repoA), null);
  assert.equal(await store.load(repoB), null);
});

test("journalFileName is stable and case-insensitive on Windows only", () => {
  const upper = isWin ? "C:\\Wikis\\Alpha" : "/wikis/Alpha";
  const lower = isWin ? "C:\\wikis\\alpha" : "/wikis/alpha";
  const a = journalFileName(upper);
  const b = journalFileName(lower);
  if (isWin) assert.equal(a, b, "Windows paths differ only by case, so they must map to ONE journal name");
  else assert.notEqual(a, b, "case is significant on POSIX");
  assert.match(a, /^[0-9a-f]{64}\.journal\.json$/);
});

// ---------- 3. reading a corrupt, forged or swapped record ----------

test("a journal file that is not JSON is refused", async () => {
  const fixture = await setup({ name: "not-json" });
  writeFileSync(fixture.journalPath, "not json at all");
  await expectRefusal(fixture.store.load(fixture.repo), ERROR_CODES.RECORD_INVALID);
});

test("a journal file that is not canonically serialized is refused", async () => {
  const fixture = await setup({ name: "noncanonical" });
  await fixture.store.create(fixture.record());
  const canonical = readFileSync(fixture.journalPath, "utf8");
  const variants = [
    ["pretty printed", JSON.stringify(JSON.parse(canonical), null, 2)],
    ["trailing newline", `${canonical}\n`],
    ["leading space", ` ${canonical}`],
    ["reordered keys", JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(canonical)).reverse()))],
    ["duplicate key", canonical.replace('"version":1', '"version":1,"version":1')],
    ["unknown key", canonical.replace(/^\{/, '{"extra":1,')],
  ];
  for (const [label, text] of variants) {
    writeFileSync(fixture.journalPath, text);
    // An unknown key is caught by the schema validator before the canonical comparison runs.
    const expected = label === "unknown key" ? ERROR_CODES.RECORD_INVALID : ERROR_CODES.RECORD_NOT_CANONICAL;
    await expectRefusal(fixture.store.load(fixture.repo), expected);
  }
  // and the original record still loads once the canonical bytes are restored
  writeFileSync(fixture.journalPath, canonical);
  const loaded = await fixture.store.load(fixture.repo);
  assert.equal(loaded.record.phase, "created");
});

test("a journal file with a UTF-8 BOM is refused", async () => {
  const fixture = await setup({ name: "bom" });
  await fixture.store.create(fixture.record());
  const canonical = readFileSync(fixture.journalPath, "utf8");
  writeFileSync(fixture.journalPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(canonical, "utf8")]));
  await expectRefusal(fixture.store.load(fixture.repo), ERROR_CODES.RECORD_NOT_CANONICAL, (error) => {
    assert.match(error.message, /byte-order mark/);
  });
});

test("a journal file that is not valid UTF-8 is refused", async () => {
  const fixture = await setup({ name: "bad-utf8" });
  await fixture.store.create(fixture.record());
  const canonical = readFileSync(fixture.journalPath);
  const broken = Buffer.concat([canonical, Buffer.from([0xff, 0xfe])]);
  writeFileSync(fixture.journalPath, broken);
  await expectRefusal(fixture.store.load(fixture.repo), ERROR_CODES.RECORD_NOT_UTF8);
});

test("a record bound to a DIFFERENT allowlisted root is refused where it is found", async () => {
  const caseDir = freshDir("forged-root-binding");
  const storeDir = path.join(caseDir, "store");
  mkdirSync(storeDir);
  const repoA = path.join(caseDir, "repoA");
  const repoB = path.join(caseDir, "repoB");
  mkdirSync(repoA);
  mkdirSync(repoB);
  const store = await openJournalStore({ storeDir, allowedRoots: [repoA, repoB] });
  await store.create({
    version: 1,
    jobId: JOB_A,
    hostInstanceId: HOST_ID,
    rootReal: repoB, // the forged part: this record belongs to repoB...
    rootIdentity: await realIdentity(repoB),
    stagePath: path.join(repoB, `.dsh-wiki.staging-${JOB_A}`),
    livePath: path.join(repoB, ".dsh-wiki"),
    backupPath: path.join(repoB, `.dsh-wiki.bak-${JOB_A}`),
    workerSessionId: SESSION_ID,
    protocolSha256: PROTOCOL_HASH,
    promptSha256: PROMPT_HASH,
    phase: "created",
    snapshots: { stage: null, live: null, backup: null },
  });
  // ...but it is sitting in repoA's file, which is where a hostile store would plant it.
  renameSync(path.join(storeDir, journalFileName(repoB)), path.join(storeDir, journalFileName(repoA)));
  await expectRefusal(store.load(repoA), ERROR_CODES.ROOT_NOT_REQUESTED);
  assert.equal(await store.load(repoB), null);
});

test("a record whose root was replaced on disk is refused (root identity drift)", async () => {
  const fixture = await setup({ name: "root-swapped" });
  await fixture.store.create(fixture.record());
  // Replace the repository directory with a fresh one at the same path: same name, new identity.
  const parked = path.join(fixture.caseDir, "parked-repo");
  renameSync(fixture.repo, parked);
  mkdirSync(fixture.repo);
  await expectRefusal(fixture.store.load(fixture.repo), ERROR_CODES.ROOT_IDENTITY_MISMATCH, (error) => {
    assert.match(error.message, /may have been replaced/);
  });
});

test("a record with a root that is not allowlisted is refused by the schema validator", async () => {
  const fixture = await setup({ name: "unlisted-root" });
  const outside = freshDir("outside-root");
  await expectRefusal(
    fixture.store.create(
      fixture.record({
        rootReal: outside,
        rootIdentity: await realIdentity(outside),
        stagePath: path.join(outside, `.dsh-wiki.staging-${JOB_A}`),
        livePath: path.join(outside, ".dsh-wiki"),
        backupPath: path.join(outside, `.dsh-wiki.bak-${JOB_A}`),
      }),
    ),
    ERROR_CODES.RECORD_INVALID,
    (error) => {
      assert.equal(error.detail.journalCode, "root-not-allowed");
    },
  );
});

test("a multiply-linked journal file is refused (hardlink on the real filesystem)", async (t) => {
  const fixture = await setup({ name: "hardlink" });
  await fixture.store.create(fixture.record());
  const second = path.join(fixture.storeDir, "second-name.json");
  try {
    linkSync(fixture.journalPath, second);
  } catch (error) {
    t.skip(`this platform/filesystem cannot create a hardlink (${error.code})`);
    return;
  }
  assert.equal(lstatSync(fixture.journalPath).nlink, 2);
  await expectRefusal(fixture.store.load(fixture.repo), ERROR_CODES.RECORD_UNREADABLE, (error) => {
    assert.match(error.message, /hard links/);
  });
  unlinkSync(second);
  assert.equal((await fixture.store.load(fixture.repo)).record.phase, "created");
});

test("a journal path that is not a regular file is refused", async () => {
  const fixture = await setup({ name: "journal-is-dir" });
  mkdirSync(fixture.journalPath);
  await expectRefusal(fixture.store.load(fixture.repo), ERROR_CODES.RECORD_UNREADABLE);
});

// ---------- 4. bounds ----------

test("an oversized journal file is refused without being decoded", async () => {
  const fixture = await setup({ name: "oversized", limits: { maxRecordBytes: 512 } });
  writeFileSync(fixture.journalPath, "x".repeat(600));
  await expectRefusal(fixture.store.load(fixture.repo), ERROR_CODES.RECORD_TOO_LARGE, (error) => {
    assert.match(error.message, /600 bytes/);
  });
});

test("a record that would exceed maxRecordBytes is refused before anything is written", async () => {
  const fixture = await setup({ name: "write-too-large", limits: { maxRecordBytes: 400 } });
  assert.ok(Buffer.byteLength(JSON.stringify(fixture.record())) > 400);
  await expectRefusal(fixture.store.create(fixture.record()), ERROR_CODES.RECORD_TOO_LARGE);
  assert.deepEqual(storeContents(fixture.storeDir), [], "a size refusal must not leave a lock or a temporary file behind");
});

test("reads are bounded: the store never asks for more than maxRecordBytes + 1 bytes", async () => {
  const limit = 4096;
  const readRequests = [];
  const { io } = instrument({
    open: async ({ args, next }) => {
      const handle = await next(...args);
      if (args[1] === "r") {
        return {
          stat: (options) => handle.stat(options),
          read: async (buffer, offset, length, position) => {
            readRequests.push({ length, bufferLength: buffer.length });
            return handle.read(buffer, offset, length, position);
          },
          write: (...writeArgs) => handle.write(...writeArgs),
          sync: () => handle.sync(),
          close: () => handle.close(),
        };
      }
      return handle;
    },
  });
  const fixture = await setup({ name: "bounded-read", limits: { maxRecordBytes: limit }, io });
  await fixture.store.create(fixture.record());
  await fixture.store.load(fixture.repo);
  assert.ok(readRequests.length > 0);
  for (const request of readRequests) {
    assert.ok(request.length <= limit + 1, `read length ${request.length} exceeds the bound`);
    assert.ok(request.bufferLength <= limit + 1, `buffer length ${request.bufferLength} exceeds the bound`);
  }
});

test("a journal file that grows while it is being read is refused as unstable", async () => {
  const fixture = await setup({ name: "grow-race" });
  await fixture.store.create(fixture.record());
  let grown = false;
  const { io } = instrument({
    open: async ({ args, next }) => {
      const handle = await next(...args);
      if (args[1] !== "r") return handle;
      return {
        stat: (options) => handle.stat(options),
        read: async (buffer, offset, length, position) => {
          // The file grows after its size was taken: exactly the extra byte becomes readable.
          if (!grown) {
            grown = true;
            appendFileSync(fixture.journalPath, "x");
          }
          return handle.read(buffer, offset, length, position);
        },
        write: (...writeArgs) => handle.write(...writeArgs),
        sync: () => handle.sync(),
        close: () => handle.close(),
      };
    },
  });
  const store = await openJournalStore({ storeDir: fixture.storeDir, allowedRoots: [fixture.repo], io });
  await expectRefusal(store.load(fixture.repo), ERROR_CODES.RECORD_UNSTABLE, (error) => {
    assert.match(error.message, /grew from/);
  });
});

// ---------- 5. create / advance happy path ----------

test("create() writes a canonical record that load() reads back identically", async () => {
  const fixture = await setup({ name: "roundtrip" });
  const created = await fixture.store.create(fixture.record());
  assertFrozenSnapshot(created.snapshot);
  assert.equal(created.snapshot.record.phase, "created");
  assert.equal(created.lock, "released");
  assert.equal(created.snapshot.durability === "file-flushed" || created.snapshot.durability === "directory-synced", true);
  if (isWin) {
    // Windows opens a directory handle but refuses fsync on it (EPERM), which the store must report
    // as "file-flushed" instead of claiming a directory sync it did not get.
    assert.equal(created.snapshot.durability, "file-flushed");
  }
  const onDisk = readFileSync(fixture.journalPath, "utf8");
  assert.equal(onDisk, JSON.stringify(created.snapshot.record), "the file must be exactly the canonical record");
  const loaded = await fixture.store.load(fixture.repo);
  assert.deepEqual(loaded.sha256, created.snapshot.sha256);
  assert.deepEqual(loaded.fileIdentity, created.snapshot.fileIdentity);
  assert.equal(loaded.durability, "unverified", "a record read from disk has no observed write durability");
  assert.deepEqual(storeContents(fixture.storeDir), [journalFileName(fixture.repo)], "no lock or temporary file may survive");
});

test("the full legal phase chain can be walked, and every step is visible to load()", async () => {
  const fixture = await setup({ name: "chain" });
  let current = (await fixture.store.create(fixture.record())).snapshot;
  const seen = [current.record.phase];
  for (const phase of ["worker-running", "worker-stopped", "validated", "live-moved", "published"]) {
    current = (await fixture.store.advance(current, fixture.recordFor(phase))).snapshot;
    seen.push(current.record.phase);
    const loaded = await fixture.store.load(fixture.repo);
    assert.equal(loaded.record.phase, phase);
    assert.equal(loaded.sha256, current.sha256);
    assert.deepEqual(loaded.fileIdentity, current.fileIdentity);
  }
  assert.deepEqual(seen, ["created", "worker-running", "worker-stopped", "validated", "live-moved", "published"]);
  assert.deepEqual(storeContents(fixture.storeDir), [journalFileName(fixture.repo)]);
});

test("the aborted and rolled-back terminal paths are both reachable", async () => {
  const abortedFixture = await setup({ name: "abort-path" });
  const created = (await abortedFixture.store.create(abortedFixture.record())).snapshot;
  const running = (await abortedFixture.store.advance(created, abortedFixture.recordFor("worker-running"))).snapshot;
  const aborted = (await abortedFixture.store.advance(running, abortedFixture.recordFor("aborted"))).snapshot;
  assert.equal(aborted.record.phase, "aborted");

  const rollbackFixture = await setup({ name: "rollback-path" });
  let snapshot = (await rollbackFixture.store.create(rollbackFixture.record())).snapshot;
  for (const phase of ["worker-running", "worker-stopped", "validated", "live-moved", "rolled-back"]) {
    snapshot = (await rollbackFixture.store.advance(snapshot, rollbackFixture.recordFor(phase))).snapshot;
  }
  assert.equal(snapshot.record.phase, "rolled-back");
  assert.equal(snapshot.record.snapshots.backup, null);
  assert.equal(snapshot.record.snapshots.live, rollbackFixture.liveIdentity);
});

test("an abort may drop the staging identity but never substitute one", async () => {
  const fixture = await setup({ name: "abort-null-stage" });
  const created = (await fixture.store.create(fixture.record())).snapshot;
  const aborted = (await fixture.store.advance(created, fixture.recordFor("aborted", { snapshots: { stage: null, live: fixture.liveIdentity, backup: null } }))).snapshot;
  assert.equal(aborted.record.snapshots.stage, null);
});

// ---------- 6. create refusals ----------

test("create() refuses a second record for the same root", async () => {
  const fixture = await setup({ name: "create-twice" });
  const first = await fixture.store.create(fixture.record());
  await expectRefusal(fixture.store.create(fixture.record()), ERROR_CODES.RECORD_EXISTS);
  const stillThere = await fixture.store.load(fixture.repo);
  assert.equal(stillThere.sha256, first.snapshot.sha256, "the refused create must not have changed the record");
});

test("create() refuses a record that is not in phase created", async () => {
  const fixture = await setup({ name: "create-wrong-phase" });
  await expectRefusal(fixture.store.create(fixture.recordFor("validated")), ERROR_CODES.INVALID_TRANSITION);
  assert.deepEqual(storeContents(fixture.storeDir), []);
});

test("create() refuses an invalid record and leaves the store untouched", async () => {
  const fixture = await setup({ name: "create-invalid" });
  await expectRefusal(fixture.store.create({ ...fixture.record(), jobId: "NOT-A-JOB" }), ERROR_CODES.RECORD_INVALID);
  await expectRefusal(fixture.store.create({ ...fixture.record(), extra: "x" }), ERROR_CODES.RECORD_INVALID);
  await expectRefusal(fixture.store.create(null), ERROR_CODES.RECORD_INVALID);
  assert.deepEqual(storeContents(fixture.storeDir), []);
});

// ---------- 7. compare-and-swap and stale snapshots ----------

test("advance() refuses a snapshot that is no longer the current record", async () => {
  const fixture = await setup({ name: "cas" });
  const created = (await fixture.store.create(fixture.record())).snapshot;
  const advanced = (await fixture.store.advance(created, fixture.recordFor("worker-running"))).snapshot;
  // The old snapshot is now stale: the file holds the worker-running record.
  await expectRefusal(fixture.store.advance(created, fixture.recordFor("worker-running")), ERROR_CODES.STALE_SNAPSHOT, (error) => {
    assert.match(error.message, /nothing was written, so the on-disk record is unchanged/);
  });
  const loaded = await fixture.store.load(fixture.repo);
  assert.equal(loaded.record.phase, "worker-running");
  assert.equal(loaded.sha256, advanced.sha256, "a refused advance must not touch the record");
});

test("advance() refuses a snapshot belonging to another store instance", async () => {
  const fixture = await setup({ name: "cross-store" });
  const snapshot = (await fixture.store.create(fixture.record())).snapshot;
  const secondStore = await openJournalStore({ storeDir: fixture.storeDir, allowedRoots: [fixture.repo] });
  await expectRefusal(secondStore.advance(snapshot, fixture.recordFor("worker-running")), ERROR_CODES.SNAPSHOT_NOT_OWNED, (error) => {
    assert.match(error.message, /THIS store/);
  });
});

test("advance() refuses clones, spreads and JSON round trips of a real snapshot", async () => {
  const fixture = await setup({ name: "forged-snapshot" });
  const snapshot = (await fixture.store.create(fixture.record())).snapshot;
  const forged = [
    { ...snapshot },
    { ...snapshot, record: { ...snapshot.record } },
    JSON.parse(JSON.stringify(snapshot)),
    { record: snapshot.record, sha256: snapshot.sha256, fileIdentity: { ...snapshot.fileIdentity }, durability: "directory-synced" },
  ];
  for (const candidate of forged) {
    await expectRefusal(fixture.store.advance(candidate, fixture.recordFor("worker-running")), ERROR_CODES.SNAPSHOT_NOT_OWNED);
  }
  await expectRefusal(fixture.store.advance(null, fixture.recordFor("worker-running")), ERROR_CODES.SNAPSHOT_NOT_OWNED);
  await expectRefusal(fixture.store.advance("snapshot", fixture.recordFor("worker-running")), ERROR_CODES.SNAPSHOT_NOT_OWNED);
  assert.equal((await fixture.store.load(fixture.repo)).record.phase, "created");
});

test("advance() refuses when the record file has been removed underneath the snapshot", async () => {
  const fixture = await setup({ name: "record-deleted" });
  const snapshot = (await fixture.store.create(fixture.record())).snapshot;
  unlinkSync(fixture.journalPath);
  await expectRefusal(fixture.store.advance(snapshot, fixture.recordFor("worker-running")), ERROR_CODES.RECORD_MISSING);
  assert.equal(await fixture.store.load(fixture.repo), null);
});

test("advance() detects a journal file swapped for an identical-content copy (identity CAS)", async () => {
  const fixture = await setup({ name: "identity-cas" });
  const snapshot = (await fixture.store.create(fixture.record())).snapshot;
  const text = readFileSync(fixture.journalPath, "utf8");
  // Same bytes, different inode: only the dev/ino half of the CAS can catch this.
  unlinkSync(fixture.journalPath);
  writeFileSync(fixture.journalPath, text);
  const reloaded = await fixture.store.load(fixture.repo);
  assert.equal(reloaded.sha256, snapshot.sha256, "the content hash is identical by construction");
  await expectRefusal(fixture.store.advance(snapshot, fixture.recordFor("worker-running")), ERROR_CODES.STALE_SNAPSHOT, (error) => {
    assert.match(error.message, /different file/);
  });
});

// ---------- 8. phase steps, carryover, immutable fields, host pin ----------

test("every illegal phase step is refused and nothing is written", async () => {
  const fixture = await setup({ name: "illegal-steps" });
  const created = (await fixture.store.create(fixture.record())).snapshot;
  for (const phase of ["worker-stopped", "validated", "live-moved", "published", "rolled-back", "created"]) {
    await expectRefusal(fixture.store.advance(created, fixture.recordFor(phase)), ERROR_CODES.INVALID_TRANSITION);
  }
  let snapshot = (await fixture.store.advance(created, fixture.recordFor("worker-running"))).snapshot;
  for (const phase of ["created", "validated", "live-moved", "published", "rolled-back"]) {
    await expectRefusal(fixture.store.advance(snapshot, fixture.recordFor(phase)), ERROR_CODES.INVALID_TRANSITION);
  }
  snapshot = (await fixture.store.advance(snapshot, fixture.recordFor("worker-stopped"))).snapshot;
  for (const phase of ["worker-running", "live-moved", "published", "rolled-back"]) {
    await expectRefusal(fixture.store.advance(snapshot, fixture.recordFor(phase)), ERROR_CODES.INVALID_TRANSITION);
  }
  snapshot = (await fixture.store.advance(snapshot, fixture.recordFor("validated"))).snapshot;
  for (const phase of ["published", "rolled-back", "worker-stopped"]) {
    await expectRefusal(fixture.store.advance(snapshot, fixture.recordFor(phase)), ERROR_CODES.INVALID_TRANSITION);
  }
  snapshot = (await fixture.store.advance(snapshot, fixture.recordFor("live-moved"))).snapshot;
  for (const phase of ["worker-running", "validated", "aborted"]) {
    await expectRefusal(fixture.store.advance(snapshot, fixture.recordFor(phase)), ERROR_CODES.INVALID_TRANSITION);
  }
  assert.equal((await fixture.store.load(fixture.repo)).record.phase, "live-moved");
});

test("terminal phases have no successor at all", async () => {
  const fixture = await setup({ name: "terminals" });
  const publishedFixtureChain = ["worker-running", "worker-stopped", "validated", "live-moved", "published"];
  let snapshot = (await fixture.store.create(fixture.record())).snapshot;
  for (const phase of publishedFixtureChain) snapshot = (await fixture.store.advance(snapshot, fixture.recordFor(phase))).snapshot;
  assert.deepEqual(PHASE_STEPS.published, []);
  assert.deepEqual(PHASE_STEPS["rolled-back"], []);
  assert.deepEqual(PHASE_STEPS.aborted, []);
  assert.deepEqual([...TERMINAL_PHASES], ["published", "rolled-back", "aborted"]);
  for (const phase of ["aborted", "rolled-back", "worker-running", "created"]) {
    await expectRefusal(fixture.store.advance(snapshot, fixture.recordFor(phase)), ERROR_CODES.INVALID_TRANSITION);
  }
  assert.equal((await fixture.store.load(fixture.repo)).record.phase, "published");
});

test("carryover refuses an invented or dropped staging identity", async () => {
  const fixture = await setup({ name: "carryover-stage" });
  const created = (await fixture.store.create(fixture.record())).snapshot;
  const running = (await fixture.store.advance(created, fixture.recordFor("worker-running"))).snapshot;
  await expectRefusal(
    fixture.store.advance(running, fixture.recordFor("worker-stopped", { snapshots: { stage: SPARE_A, live: fixture.liveIdentity, backup: null } })),
    ERROR_CODES.INVALID_CARRYOVER,
    (error) => {
      assert.match(error.message, /staging identity/);
    },
  );
  await expectRefusal(
    fixture.store.advance(running, fixture.recordFor("worker-stopped", { snapshots: { stage: null, live: fixture.liveIdentity, backup: null } })),
    ERROR_CODES.RECORD_INVALID,
  );
});

test("carryover refuses a changed live identity, a premature backup identity and a wrong publish mapping", async () => {
  const fixture = await setup({ name: "carryover-live" });
  const created = (await fixture.store.create(fixture.record())).snapshot;
  await expectRefusal(
    fixture.store.advance(created, fixture.recordFor("worker-running", { snapshots: { stage: fixture.stageIdentity, live: SPARE_A, backup: null } })),
    ERROR_CODES.INVALID_CARRYOVER,
    (error) => {
      assert.match(error.message, /live identity/);
    },
  );
  const running = (await fixture.store.advance(created, fixture.recordFor("worker-running"))).snapshot;
  let snapshot = running;
  for (const phase of ["worker-stopped", "validated"]) snapshot = (await fixture.store.advance(snapshot, fixture.recordFor(phase))).snapshot;
  // live-moved must record the live path ABSENT and the prior live identity as the backup.
  await expectRefusal(
    fixture.store.advance(snapshot, fixture.recordFor("live-moved", { snapshots: { stage: fixture.stageIdentity, live: null, backup: null } })),
    ERROR_CODES.INVALID_CARRYOVER,
    (error) => {
      assert.match(error.message, /ABSENT|backup identity/);
    },
  );
  const moved = (await fixture.store.advance(snapshot, fixture.recordFor("live-moved"))).snapshot;
  // published must bind the CANDIDATE (the staged identity) as live, not the previous one.
  await expectRefusal(
    fixture.store.advance(moved, fixture.recordFor("published", { snapshots: { stage: null, live: fixture.liveIdentity, backup: fixture.liveIdentity } })),
    ERROR_CODES.INVALID_CARRYOVER,
    (error) => {
      assert.match(error.message, /candidate identity/);
    },
  );
  const published = (await fixture.store.advance(moved, fixture.recordFor("published"))).snapshot;
  assert.equal(published.record.snapshots.live, fixture.stageIdentity);
  assert.equal(published.record.snapshots.backup, fixture.liveIdentity);
});

test("carryover refuses a rollback that invents the restored identity", async () => {
  const fixture = await setup({ name: "carryover-rollback" });
  let snapshot = (await fixture.store.create(fixture.record())).snapshot;
  for (const phase of ["worker-running", "worker-stopped", "validated", "live-moved"]) {
    snapshot = (await fixture.store.advance(snapshot, fixture.recordFor(phase))).snapshot;
  }
  await expectRefusal(
    fixture.store.advance(snapshot, fixture.recordFor("rolled-back", { snapshots: { stage: fixture.stageIdentity, live: SPARE_B, backup: null } })),
    ERROR_CODES.INVALID_CARRYOVER,
    (error) => {
      assert.match(error.message, /restore exactly the identity that was live/);
    },
  );
});

test("immutable fields may not change during a transaction", async () => {
  const fixture = await setup({ name: "immutable" });
  const created = (await fixture.store.create(fixture.record())).snapshot;
  const cases = [
    { promptSha256: "c".repeat(64) },
    { protocolSha256: "d".repeat(64) },
    { workerSessionId: "session-99999999" },
    {
      jobId: JOB_B,
      stagePath: path.join(fixture.repo, `.dsh-wiki.staging-${JOB_B}`),
      backupPath: path.join(fixture.repo, `.dsh-wiki.bak-${JOB_B}`),
    },
    { hostInstanceId: OTHER_HOST_ID },
    { rootIdentity: SPARE_A },
  ];
  for (const overrides of cases) {
    await expectRefusal(fixture.store.advance(created, fixture.recordFor("worker-running", overrides)), ERROR_CODES.IMMUTABLE_FIELD_CHANGED);
  }
  assert.equal((await fixture.store.load(fixture.repo)).record.phase, "created");
});

test("a host pin on the store refuses records pinned to another instance", async () => {
  const fixture = await setup({ name: "host-pin", hostInstanceId: HOST_ID });
  await expectRefusal(fixture.store.create(fixture.record({ hostInstanceId: OTHER_HOST_ID })), ERROR_CODES.HOST_PIN_MISMATCH);
  const created = (await fixture.store.create(fixture.record())).snapshot;
  // The immutable-field rule fires before the pin on advance; both refuse a foreign instance.
  await expectRefusal(fixture.store.advance(created, fixture.recordFor("worker-running", { hostInstanceId: OTHER_HOST_ID })), ERROR_CODES.IMMUTABLE_FIELD_CHANGED);
  // Without a store-level pin a record may carry any valid token, but the pin still cannot change mid
  // transaction (that is the immutable-field rule, asserted above).
  const unpinned = await setup({ name: "no-host-pin" });
  const plain = (await unpinned.store.create(unpinned.record({ hostInstanceId: OTHER_HOST_ID }))).snapshot;
  assert.equal(plain.record.hostInstanceId, OTHER_HOST_ID);
});

// ---------- 9. replaceTerminal ----------

async function toPublished(fixture) {
  let snapshot = (await fixture.store.create(fixture.record())).snapshot;
  for (const phase of ["worker-running", "worker-stopped", "validated", "live-moved", "published"]) {
    snapshot = (await fixture.store.advance(snapshot, fixture.recordFor(phase))).snapshot;
  }
  return snapshot;
}

test("replaceTerminal starts a new job only from a terminal record, and admits cleanup is unproven", async () => {
  const fixture = await setup({ name: "replace-ok" });
  const published = await toPublished(fixture);
  const nextRecord = fixture.record({
    jobId: JOB_B,
    stagePath: path.join(fixture.repo, `.dsh-wiki.staging-${JOB_B}`),
    backupPath: path.join(fixture.repo, `.dsh-wiki.bak-${JOB_B}`),
    snapshots: { stage: null, live: fixture.stageIdentity, backup: null },
  });
  const replaced = await fixture.store.replaceTerminal(published, nextRecord);
  assert.equal(replaced.snapshot.record.jobId, JOB_B);
  assert.equal(replaced.snapshot.record.phase, "created");
  assert.equal(replaced.replacement.priorJobId, JOB_A);
  assert.equal(replaced.replacement.priorPhase, "published");
  assert.equal(replaced.replacement.cleanupProven, false, "replacing a record must never claim the old artifacts were cleaned");
  assert.deepEqual(
    replaced.replacement.retained.map((entry) => entry.kind),
    ["backup"],
    "the replaced PUBLISHED record still has a bound backup, and the store says so instead of pretending",
  );
  const loaded = await fixture.store.load(fixture.repo);
  assert.equal(loaded.record.jobId, JOB_B);
  assert.deepEqual(storeContents(fixture.storeDir), [journalFileName(fixture.repo)]);
});

test("replaceTerminal reports the retained staging of a rolled-back record", async () => {
  const fixture = await setup({ name: "replace-retained-stage" });
  let snapshot = (await fixture.store.create(fixture.record())).snapshot;
  for (const phase of ["worker-running", "worker-stopped", "validated", "live-moved", "rolled-back"]) {
    snapshot = (await fixture.store.advance(snapshot, fixture.recordFor(phase))).snapshot;
  }
  const nextRecord = fixture.record({
    jobId: JOB_B,
    stagePath: path.join(fixture.repo, `.dsh-wiki.staging-${JOB_B}`),
    backupPath: path.join(fixture.repo, `.dsh-wiki.bak-${JOB_B}`),
    snapshots: { stage: null, live: fixture.liveIdentity, backup: null },
  });
  const replaced = await fixture.store.replaceTerminal(snapshot, nextRecord);
  assert.deepEqual(replaced.replacement.retained.map((entry) => entry.kind), ["staging"]);
  assert.equal(replaced.replacement.retained[0].path, fixture.stagePath);
});

test("replaceTerminal refuses a non-terminal record, the same job, and a wrong live carryover", async () => {
  const fixture = await setup({ name: "replace-refusals" });
  const created = (await fixture.store.create(fixture.record())).snapshot;
  await expectRefusal(fixture.store.replaceTerminal(created, fixture.record({ jobId: JOB_B })), ERROR_CODES.INVALID_TRANSITION, (error) => {
    assert.match(error.message, /TERMINAL record/);
  });

  const f = await setup({ name: "replace-refusals-2" });
  const published = await toPublished(f);
  await expectRefusal(f.store.replaceTerminal(published, f.record({ jobId: JOB_A, snapshots: { stage: null, live: f.stageIdentity, backup: null } })), ERROR_CODES.INVALID_TRANSITION, (error) => {
    assert.match(error.message, /DIFFERENT transaction/);
  });
  await expectRefusal(
    f.store.replaceTerminal(published, f.record({ jobId: JOB_B, stagePath: f.stagePath.replace(JOB_A, JOB_B), backupPath: f.backupPath.replace(JOB_A, JOB_B), phase: "validated", snapshots: { stage: f.stageIdentity, live: f.stageIdentity, backup: null } })),
    ERROR_CODES.INVALID_TRANSITION,
  );
  await expectRefusal(
    f.store.replaceTerminal(published, f.record({ jobId: JOB_B, stagePath: f.stagePath.replace(JOB_A, JOB_B), backupPath: f.backupPath.replace(JOB_A, JOB_B), snapshots: { stage: null, live: null, backup: null } })),
    ERROR_CODES.INVALID_CARRYOVER,
    (error) => {
      assert.match(error.message, /live identity the replaced record left behind/);
    },
  );
  assert.equal((await f.store.load(f.repo)).record.jobId, JOB_A);
});

test("replaceTerminal uses the same CAS, so a stale terminal snapshot writes nothing", async () => {
  const fixture = await setup({ name: "replace-cas" });
  const published = await toPublished(fixture);
  // Someone else already replaced the record.
  const otherRecord = fixture.record({
    jobId: JOB_B,
    stagePath: path.join(fixture.repo, `.dsh-wiki.staging-${JOB_B}`),
    backupPath: path.join(fixture.repo, `.dsh-wiki.bak-${JOB_B}`),
    snapshots: { stage: null, live: fixture.stageIdentity, backup: null },
  });
  const winner = await fixture.store.replaceTerminal(published, otherRecord);
  await expectRefusal(
    fixture.store.replaceTerminal(
      published,
      fixture.record({
        jobId: "aa11bb22cc33dd44",
        stagePath: path.join(fixture.repo, ".dsh-wiki.staging-aa11bb22cc33dd44"),
        backupPath: path.join(fixture.repo, ".dsh-wiki.bak-aa11bb22cc33dd44"),
        snapshots: { stage: null, live: fixture.stageIdentity, backup: null },
      }),
    ),
    ERROR_CODES.STALE_SNAPSHOT,
  );
  assert.equal((await fixture.store.load(fixture.repo)).sha256, winner.snapshot.sha256);
});

// ---------- 10. write faults, one per step ----------

test("a lock that already exists refuses the write and is never broken automatically", async () => {
  const fixture = await setup({ name: "locked" });
  const lockPath = path.join(fixture.storeDir, `${journalFileName(fixture.repo).replace(/\.journal\.json$/, "")}.lock`);
  mkdirSync(lockPath);
  await expectRefusal(fixture.store.create(fixture.record()), ERROR_CODES.STORE_LOCKED, (error) => {
    assert.match(error.message, /never breaks a lock automatically/);
  });
  assert.ok(existsSync(lockPath), "the store must not remove a lock it cannot prove it owns");
  assert.equal(existsSync(fixture.journalPath), false);
});

test("a temporary-file open failure writes nothing and leaves no lock behind", async () => {
  const { io } = instrument({
    open: async ({ args, next }) => {
      if (args[0].includes(".tmp-")) throw fsError("ENOSPC");
      return next(...args);
    },
  });
  const fixture = await setup({ name: "temp-open-fail", io });
  await expectRefusal(fixture.store.create(fixture.record()), ERROR_CODES.WRITE_FAILED, (error) => {
    assert.equal(error.committed, false);
    assert.match(error.message, /previous record is unchanged/);
  });
  assert.deepEqual(storeContents(fixture.storeDir), []);
});

test("a temporary write / sync / close failure writes nothing and removes the temporary file", async () => {
  for (const stage of ["write", "sync", "close"]) {
    const { io } = instrument({
      open: async ({ args, next }) => {
        const handle = await next(...args);
        if (args[1] === "wx") return wrapHandle(handle, { [stage]: fsError(stage === "sync" ? "EIO" : "ENOSPC") });
        return handle;
      },
    });
    const fixture = await setup({ name: `temp-${stage}-fail`, io });
    await expectRefusal(fixture.store.create(fixture.record()), ERROR_CODES.WRITE_FAILED, (error) => {
      assert.equal(error.committed, false);
      assert.equal(error.detail.tempCleanup, "removed", `a temporary file this store created must be removed after a ${stage} failure`);
    });
    assert.deepEqual(storeContents(fixture.storeDir), [], `a ${stage} failure must leave nothing behind`);
  }
});

test("a rename failure writes nothing, keeps the previous record and removes the temporary file", async () => {
  let armed = false;
  const { io } = instrument({
    rename: async ({ args, next }) => {
      if (armed) throw fsError("EBUSY");
      return next(...args);
    },
  });
  const fixture = await setup({ name: "rename-fail", io });
  const created = await fixture.store.create(fixture.record());
  armed = true;
  const before = readFileSync(fixture.journalPath, "utf8");
  await expectRefusal(fixture.store.advance(created.snapshot, fixture.recordFor("worker-running")), ERROR_CODES.WRITE_FAILED, (error) => {
    assert.equal(error.committed, false, "a failed rename committed nothing");
    assert.equal(error.detail.tempCleanup, "removed");
    assert.match(error.message, /previous record is unchanged/);
  });
  assert.equal(readFileSync(fixture.journalPath, "utf8"), before, "the previous record must be byte-identical");
  assert.deepEqual(storeContents(fixture.storeDir), [journalFileName(fixture.repo)]);
});

test("an unsupported directory-sync code is reported as file-flushed, not as a failure", async () => {
  for (const code of ["EPERM", "EINVAL", "ENOTSUP", "EBADF"]) {
    const storeDirRef = { path: null };
    const { io } = instrument({
      open: async ({ args, next }) => {
        const handle = await next(...args);
        if (storeDirRef.path !== null && args[0] === storeDirRef.path) return wrapHandle(handle, { sync: fsError(code) });
        return handle;
      },
    });
    const caseDir = freshDir(`dirsync-${code.toLowerCase()}`);
    const repo = path.join(caseDir, "repo");
    mkdirSync(repo);
    const storeDir = path.join(caseDir, "store");
    mkdirSync(storeDir);
    storeDirRef.path = storeDir;
    const store = await openJournalStore({ storeDir, allowedRoots: [repo], io });
    const created = await store.create({
      version: 1,
      jobId: JOB_A,
      hostInstanceId: HOST_ID,
      rootReal: repo,
      rootIdentity: await realIdentity(repo),
      stagePath: path.join(repo, `.dsh-wiki.staging-${JOB_A}`),
      livePath: path.join(repo, ".dsh-wiki"),
      backupPath: path.join(repo, `.dsh-wiki.bak-${JOB_A}`),
      workerSessionId: SESSION_ID,
      protocolSha256: PROTOCOL_HASH,
      promptSha256: PROMPT_HASH,
      phase: "created",
      snapshots: { stage: null, live: null, backup: null },
    });
    assert.equal(created.snapshot.durability, "file-flushed", `${code} must be recognized as "cannot sync a directory"`);
  }
});

test("an unrecognized directory-sync failure is reported as an UNCERTAIN commit, never as a clean failure", async () => {
  let storeDirRef = null;
  const { io } = instrument({
    open: async ({ args, next }) => {
      const handle = await next(...args);
      if (storeDirRef !== null && args[0] === storeDirRef) return wrapHandle(handle, { sync: fsError("EIO") });
      return handle;
    },
  });
  const fixture = await setup({ name: "dirsync-eio", io });
  storeDirRef = fixture.storeDir;
  await expectRefusal(fixture.store.create(fixture.record()), ERROR_CODES.COMMIT_UNCERTAIN, (error) => {
    assert.equal(error.committed, true);
    assert.match(error.message, /committed state is UNCERTAIN/i);
    assert.match(error.message, /does NOT claim the previous record is still in place/);
  });
  // ...and the record really is on disk: the caller must re-read instead of assuming either state.
  const loaded = await fixture.store.load(fixture.repo);
  assert.notEqual(loaded, null);
  assert.equal(loaded.record.phase, "created");
});

test("a readback mismatch after the rename is reported as an UNCERTAIN commit", async () => {
  let armed = false;
  const { io } = instrument({
    rename: async ({ args, next }) => {
      const result = await next(...args);
      if (armed) {
        // Another writer wins the race immediately after our rename: the bytes at the journal path are
        // no longer the bytes that were renamed there.
        writeFileSync(args[1], `${readFileSync(args[1], "utf8")} `);
      }
      return result;
    },
  });
  const fixture = await setup({ name: "readback-mismatch", io });
  armed = true;
  await expectRefusal(fixture.store.create(fixture.record()), ERROR_CODES.COMMIT_UNCERTAIN, (error) => {
    assert.equal(error.committed, true);
    assert.match(error.message, /UNCERTAIN/);
  });
});

test("a post-rename identity swap is detected by the readback identity check", async () => {
  const { io } = instrument({
    rename: async ({ args, next }) => {
      const result = await next(...args);
      if (args[0].includes(".tmp-")) {
        // Replace the file that was just renamed with a DIFFERENT file holding the SAME bytes: only
        // the dev/ino comparison can tell them apart.
        const text = readFileSync(args[1], "utf8");
        unlinkSync(args[1]);
        writeFileSync(args[1], text);
      }
      return result;
    },
  });
  const fixture = await setup({ name: "postrename-swap", io });
  await expectRefusal(fixture.store.create(fixture.record()), ERROR_CODES.COMMIT_UNCERTAIN, (error) => {
    assert.equal(error.committed, true);
    assert.match(error.message, /identity swap/);
  });
});

test("a temporary file swapped for another file before the rename is detected", async () => {
  const { io } = instrument({
    rename: async ({ args, next }) => {
      const [src, dest] = args;
      // Swap the temporary file for a different file holding the same bytes, then rename as usual.
      const text = readFileSync(src, "utf8");
      unlinkSync(src);
      writeFileSync(src, text);
      return next(src, dest);
    },
  });
  const fixture = await setup({ name: "temp-swap", io });
  await expectRefusal(fixture.store.create(fixture.record()), ERROR_CODES.COMMIT_UNCERTAIN, (error) => {
    assert.equal(error.committed, true);
    assert.match(error.message, /identity swap/);
  });
  const loaded = await fixture.store.load(fixture.repo);
  assert.notEqual(loaded, null, "the record really did land: the store refuses to guess, and the caller must re-read");
});

test("a lock that cannot be proven ours is retained and reported, not deleted", async () => {
  const { io } = instrument({
    rmdir: async () => {
      throw fsError("EPERM");
    },
  });
  const fixture = await setup({ name: "lock-retained", io });
  let committed;
  await expectRefusal(fixture.store.create(fixture.record()), ERROR_CODES.LOCK_RELEASE_UNVERIFIED, (error) => {
    assert.equal(error.committed, true);
    assert.ok(error.snapshot !== undefined, "the committed snapshot must be handed back so the caller keeps its authority");
    assert.equal(error.snapshot.record.phase, "created");
    assert.match(error.message, /RETAINED/);
    committed = error.snapshot;
  });
  const lockPath = path.join(fixture.storeDir, `${journalFileName(fixture.repo).replace(/\.journal\.json$/, "")}.lock`);
  assert.ok(existsSync(lockPath), "the lock must still be there");
  // The retained lock now blocks every further write for this root: that is the documented
  // fail-closed state, and the store must not "fix" it by deleting a directory it cannot prove is
  // still its own.
  await expectRefusal(fixture.store.advance(committed, fixture.recordFor("worker-running")), ERROR_CODES.STORE_LOCKED);
});

test("a store lock whose identity changed is retained instead of removed", async () => {
  const lockPathRef = { path: null };
  let seen = 0;
  const { io } = instrument({
    lstat: async ({ args, next }) => {
      const stats = await next(...args);
      if (lockPathRef.path !== null && args[0] === lockPathRef.path) {
        seen += 1;
        // The first look is the store capturing ownership; the second is the release check, where a
        // different identity proves someone swapped the lock directory.
        if (seen === 2) {
          return { dev: 1n, ino: 1n, nlink: 1n, isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false };
        }
      }
      return stats;
    },
  });
  const fixture = await setup({ name: "lock-identity", io });
  lockPathRef.path = path.join(fixture.storeDir, `${journalFileName(fixture.repo).replace(/\.journal\.json$/, "")}.lock`);
  await expectRefusal(fixture.store.create(fixture.record()), ERROR_CODES.LOCK_RELEASE_UNVERIFIED, (error) => {
    assert.equal(error.detail.lockRelease, "retained-ambiguous");
    assert.equal(error.committed, true);
  });
  assert.ok(existsSync(lockPathRef.path), "an identity that does not match must never authorize a removal");
});

test("a failed create reports the lock release outcome on the error", async () => {
  let armRename = false;
  const { io } = instrument({
    rename: async ({ args, next }) => {
      if (armRename) throw fsError("EIO");
      return next(...args);
    },
  });
  const fixture = await setup({ name: "lock-release-on-error", io });
  const created = await fixture.store.create(fixture.record());
  armRename = true;
  await expectRefusal(fixture.store.advance(created.snapshot, fixture.recordFor("worker-running")), ERROR_CODES.WRITE_FAILED, (error) => {
    assert.equal(error.lockRelease, "removed", "the lock this store created must still be released on failure");
  });
});

// ---------- 11. no discovery, and hostile files are left alone ----------

test("the store only ever touches its own derived paths and never enumerates", async () => {
  const { io, calls } = instrument();
  const fixture = await setup({ name: "no-discovery", io });
  const created = await fixture.store.create(fixture.record());
  await fixture.store.load(fixture.repo);
  await fixture.store.advance(created.snapshot, fixture.recordFor("worker-running"));

  const lockPath = path.join(fixture.storeDir, `${journalFileName(fixture.repo).replace(/\.journal\.json$/, "")}.lock`);
  for (const call of calls) {
    const targets = call.name === "rename" ? call.args : [call.args[0]];
    for (const target of targets) {
      assert.ok(
        fixture.storeDir.toLowerCase().startsWith(target.toLowerCase()) || // ancestor walk by fs-contain
        target === fixture.storeDir || target === fixture.repo || target === fixture.journalPath || target === lockPath || /\.tmp-[0-9a-f]{16}$/.test(target),
        `unexpected path handed to io.${call.name}: ${target}`,
      );
    }
  }
  assert.equal(calls.some((call) => ["readdir", "opendir"].includes(call.name)), false, "there is no listing seam at all");
});

test("hostile name-adjacent files are never read, adopted or deleted", async () => {
  const fixture = await setup({ name: "hostile-neighbours" });
  const created = await fixture.store.create(fixture.record());
  const strangers = [
    path.join(fixture.storeDir, "evil.journal.json"),
    path.join(fixture.storeDir, "0000.tmp-deadbeefdeadbeef"),
    path.join(fixture.storeDir, "notes.txt"),
  ];
  for (const stranger of strangers) writeFileSync(stranger, "do not touch me");
  await fixture.store.load(fixture.repo);
  const advanced = await fixture.store.advance(created.snapshot, fixture.recordFor("worker-running"));
  assert.equal(advanced.snapshot.record.phase, "worker-running");
  for (const stranger of strangers) {
    assert.equal(readFileSync(stranger, "utf8"), "do not touch me", `${stranger} must be left byte-identical`);
  }
});

// ---------- 12. store identity re-verification ----------

test("every operation re-verifies the store directory identity", async () => {
  const fixture = await setup({ name: "store-swapped" });
  const created = await fixture.store.create(fixture.record());
  const parked = path.join(fixture.caseDir, "parked-store");
  renameSync(fixture.storeDir, parked);
  mkdirSync(fixture.storeDir);
  await expectRefusal(fixture.store.load(fixture.repo), ERROR_CODES.STORE_IDENTITY_CHANGED);
  await expectRefusal(fixture.store.advance(created.snapshot, fixture.recordFor("worker-running")), ERROR_CODES.STORE_IDENTITY_CHANGED);
  // Nothing was written into the substituted directory.
  assert.deepEqual(storeContents(fixture.storeDir), []);
});

// ---------- 13. concurrency and serialization ----------

test("concurrent advances on one root are serialized: exactly one wins", async () => {
  const fixture = await setup({ name: "queue" });
  const created = (await fixture.store.create(fixture.record())).snapshot;
  const results = await Promise.allSettled([
    fixture.store.advance(created, fixture.recordFor("worker-running")),
    fixture.store.advance(created, fixture.recordFor("aborted", { snapshots: { stage: null, live: fixture.liveIdentity, backup: null } })),
    fixture.store.advance(created, fixture.recordFor("worker-running")),
  ]);
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");
  assert.equal(fulfilled.length, 1, "only one of the racing advances may commit");
  assert.equal(rejected.length, 2);
  for (const failure of rejected) assert.equal(failure.reason.code, ERROR_CODES.STALE_SNAPSHOT);
  const loaded = await fixture.store.load(fixture.repo);
  assert.equal(loaded.record.phase, fulfilled[0].value.snapshot.record.phase);
});

test("two roots share one store directory without blocking each other", async () => {
  const caseDir = freshDir("multi-root");
  const storeDir = path.join(caseDir, "store");
  mkdirSync(storeDir);
  const repoA = path.join(caseDir, "repoA");
  const repoB = path.join(caseDir, "repoB");
  mkdirSync(repoA);
  mkdirSync(repoB);
  const store = await openJournalStore({ storeDir, allowedRoots: [repoA, repoB] });
  const recordFor = async (repo, job) => ({
    version: 1,
    jobId: job,
    hostInstanceId: HOST_ID,
    rootReal: repo,
    rootIdentity: await realIdentity(repo),
    stagePath: path.join(repo, `.dsh-wiki.staging-${job}`),
    livePath: path.join(repo, ".dsh-wiki"),
    backupPath: path.join(repo, `.dsh-wiki.bak-${job}`),
    workerSessionId: SESSION_ID,
    protocolSha256: PROTOCOL_HASH,
    promptSha256: PROMPT_HASH,
    phase: "created",
    snapshots: { stage: null, live: null, backup: null },
  });
  const [a, b] = await Promise.all([store.create(await recordFor(repoA, JOB_A)), store.create(await recordFor(repoB, JOB_B))]);
  assert.equal(a.snapshot.record.rootReal, repoA);
  assert.equal(b.snapshot.record.rootReal, repoB);
  assert.deepEqual(storeContents(storeDir), [journalFileName(repoA), journalFileName(repoB)].sort());
});

// ---------- 14. planRecovery composition, and no stale composition ----------

test("records handed out by the store are branded, so planRecovery accepts them and clone forgery does not", async () => {
  const fixture = await setup({ name: "planner-brand" });
  await fixture.store.create(fixture.record());
  const loaded = await fixture.store.load(fixture.repo);
  const plan = planRecovery(loaded.record, observations(fixture, { stage: { state: "absent" } }));
  assert.equal(plan.phase, "created");
  assert.equal(plan.decision, "no-op");
  assert.throws(
    () => planRecovery({ ...loaded.record }, observations(fixture)),
    (error) => error.code === "record-not-validated",
    "a clone is not branded: the store never launders authority",
  );
});

test("every stored phase composes into the decision the planner expects for that phase", async () => {
  const expectations = [
    ["created", "no-op"],
    ["worker-running", "manual"],
    ["worker-stopped", "manual"],
    ["validated", "manual"],
    ["live-moved", "restore-backup"],
    ["published", "cleanup"],
  ];
  const fixture = await setup({ name: "planner-phases" });
  let snapshot = (await fixture.store.create(fixture.record())).snapshot;
  for (const [phase, expected] of expectations) {
    if (phase !== "created") snapshot = (await fixture.store.advance(snapshot, fixture.recordFor(phase))).snapshot;
    const loaded = await fixture.store.load(fixture.repo);
    const observationsForPhase = {
      // live-moved: the live path is empty and the backup holds the previously live identity.
      ...observations(fixture),
      stage: phase === "created" || phase === "published" ? { state: "absent" } : { state: "present", identity: fixture.stageIdentity },
      live: phase === "live-moved" ? { state: "absent" } : { state: "present", identity: phase === "published" ? fixture.stageIdentity : fixture.liveIdentity },
      backup: phase === "live-moved" || phase === "published" ? { state: "present", identity: fixture.liveIdentity } : { state: "absent" },
    };
    const plan = planRecovery(loaded.record, observationsForPhase);
    assert.equal(plan.phase, phase);
    assert.equal(plan.decision, expected, `phase ${phase} planned as ${plan.decision} (${plan.code})`);
  }
});

test("a refused advance cannot leak a stale phase into the next plan", async () => {
  const fixture = await setup({ name: "stale-plan" });
  const published = await toPublished(fixture);
  const loaded = await fixture.store.load(fixture.repo);
  // A second, stale writer tries to advance from the ORIGINAL snapshot towards aborted.
  const abortedFixture = await setup({ name: "stale-plan-other" });
  assert.notEqual(abortedFixture.repo, fixture.repo);
  await expectRefusal(fixture.store.advance(published, fixture.recordFor("aborted")), ERROR_CODES.INVALID_TRANSITION);
  const afterRefusal = await fixture.store.load(fixture.repo);
  assert.equal(afterRefusal.record.phase, "published");
  assert.equal(afterRefusal.sha256, loaded.sha256);
  const plan = planRecovery(afterRefusal.record, {
    ...observations(fixture),
    stage: { state: "absent" },
    live: { state: "present", identity: fixture.stageIdentity },
    backup: { state: "present", identity: fixture.liveIdentity },
  });
  assert.equal(plan.phase, "published", "the plan describes the phase that is on disk, never the rejected next phase");
  assert.equal(plan.decision, "cleanup");
});

// ---------- 15. old/new visibility with a real open reader ----------

test("an open reader never sees a mixture; a rename blocked by it fails cleanly with nothing committed", async () => {
  const fixture = await setup({ name: "open-reader" });
  const created = await fixture.store.create(fixture.record());
  const reader = await open(fixture.journalPath, "r");
  let advanced = null;
  try {
    const before = await reader.readFile({ encoding: "utf8" });
    assert.equal(JSON.parse(before).phase, "created");
    try {
      advanced = await fixture.store.advance(created.snapshot, fixture.recordFor("worker-running"));
    } catch (error) {
      // Windows refuses to replace a file another handle has open (EPERM on rename). The store must
      // report that as a clean, uncommitted failure and keep the old record byte-identical.
      assert.ok(error instanceof JournalStoreError, String(error));
      assert.equal(error.code, ERROR_CODES.WRITE_FAILED);
      assert.equal(error.committed, false);
      assert.equal(error.detail.tempCleanup, "removed");
      assert.equal(readFileSync(fixture.journalPath, "utf8"), before);
      assert.deepEqual(storeContents(fixture.storeDir), [journalFileName(fixture.repo)]);
    }
    const again = await reader.readFile({ encoding: "utf8", flag: "r" }).catch(() => before);
    assert.ok(again === "" || again === before || JSON.parse(again).phase === "created", "the open handle never sees a partial record");
  } finally {
    await reader.close();
  }
  // Once the reader is gone the very same snapshot is still valid (CAS unchanged) and the step lands.
  const final = advanced ?? (await fixture.store.advance(created.snapshot, fixture.recordFor("worker-running")));
  assert.equal(final.snapshot.record.phase, "worker-running");
  assert.equal((await fixture.store.load(fixture.repo)).record.phase, "worker-running");
});

test("a concurrent reader observes either the whole previous or the whole next record, never a mixture", async () => {
  const fixture = await setup({ name: "visibility" });
  let snapshot = (await fixture.store.create(fixture.record())).snapshot;
  const observed = [];
  let done = false;

  const readLoop = (async () => {
    while (!done) {
      try {
        const text = readFileSync(fixture.journalPath, "utf8");
        if (text.length > 0) observed.push(text);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
  })();

  // On Windows a rename can fail with EPERM while a reader has the file open at that instant. The
  // store reports that as write-failed/committed:false (nothing changed), so the CALLER may retry with
  // the same, still-valid snapshot; the store itself never retries.
  const retrying = async (operation) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (!(error instanceof JournalStoreError) || error.code !== ERROR_CODES.WRITE_FAILED || error.committed !== false || attempt > 200) throw error;
      }
    }
  };
  let replaced;
  try {
    for (const phase of ["worker-running", "worker-stopped", "validated", "live-moved", "published"]) {
      const previous = snapshot;
      snapshot = (await retrying(() => fixture.store.advance(previous, fixture.recordFor(phase)))).snapshot;
    }
    replaced = await retrying(() => fixture.store.replaceTerminal(
      snapshot,
      fixture.record({
        jobId: JOB_B,
        stagePath: path.join(fixture.repo, `.dsh-wiki.staging-${JOB_B}`),
        backupPath: path.join(fixture.repo, `.dsh-wiki.bak-${JOB_B}`),
        snapshots: { stage: null, live: fixture.stageIdentity, backup: null },
      }),
    ));
  } finally {
    done = true;
    await readLoop;
  }

  assert.ok(observed.length > 0, "the reader must have observed something");
  const phases = new Set(["created", "worker-running", "worker-stopped", "validated", "live-moved", "published"]);
  for (const text of observed) {
    const parsed = JSON.parse(text); // throws if a partial record was ever visible
    assert.equal(parsed.version, 1);
    assert.ok(phases.has(parsed.phase), `unexpected phase ${parsed.phase}`);
    assert.equal(JSON.stringify(parsed), text, "every visible state must be a complete canonical record");
  }
  assert.equal(replaced.snapshot.record.jobId, JOB_B);
  assert.equal((await fixture.store.load(fixture.repo)).record.jobId, JOB_B);
});

// ---------- 16. defaults ----------

test("the documented defaults are the ones in force", async () => {
  assert.deepEqual({ ...DEFAULT_LIMITS }, { maxRecordBytes: 64 * 1024, maxPathLength: 4096 });
  const fixture = await setup({ name: "defaults" });
  assert.equal(fixture.store.storeDir, fixture.storeDir);
  assert.deepEqual([...fixture.store.allowedRoots], [fixture.repo]);
  assert.equal(fixture.store.hostInstanceId, null);
  assert.ok(Object.isFrozen(fixture.store), "the store object is frozen");
});

// ---------- 12. arbitrary rejection reasons (undefined/null/false/0/""/frozen/hostile) ----------

/** Reasons a hostile io may throw; `undefined` and the other falsy values must never read as "no error". */
const HOSTILE_GETTER_REASON = {
  get code() {
    throw new Error("hostile code getter must not escape");
  },
  get message() {
    throw new Error("hostile message getter must not escape");
  },
};
const REASONS = [
  ["undefined", undefined],
  ["null", null],
  ["false", false],
  ["zero", 0],
  ["empty string", ""],
  ["frozen object", Object.freeze({ code: "EIO" })],
  ["hostile getters", HOSTILE_GETTER_REASON],
];

function assertCauseKept(error, reason, label) {
  assert.ok(Object.hasOwn(error, "cause"), `${label}: the cause key must be kept even for a falsy reason`);
  assert.ok(Object.is(error.cause, reason), `${label}: the arbitrary reason must be preserved unchanged`);
}

test("a temporary write / sync / close failure with ANY thrown value is a failed write, never a success", async () => {
  for (const stage of ["write", "sync", "close"]) {
    for (const [name, reason] of REASONS) {
      const label = `${stage}:${name}`;
      const { io } = instrument({
        open: async ({ args, next }) => {
          const handle = await next(...args);
          if (args[1] === "wx") return wrapHandle(handle, { [stage]: reason });
          return handle;
        },
      });
      const fixture = await setup({ name: `reason-${stage}-${name.replace(/\W/g, "")}`, io });
      await expectRefusal(fixture.store.create(fixture.record()), ERROR_CODES.WRITE_FAILED, (error) => {
        assert.equal(error.committed, false, label);
        assertCauseKept(error, reason, label);
      });
      assert.equal(existsSync(fixture.journalPath), false, `${label}: nothing may be renamed into place`);
      assert.deepEqual(storeContents(fixture.storeDir), [], `${label}: no temp file or lock may remain`);
      assert.equal(await fixture.store.load(fixture.repo), null, `${label}: no success after a failed file sync`);
    }
  }
});

test("a temporary write / sync failure keeps a frozen thrown object unmutated", async () => {
  const frozen = Object.freeze({ code: "EIO" });
  const { io } = instrument({
    open: async ({ args, next }) => {
      const handle = await next(...args);
      return args[1] === "wx" ? wrapHandle(handle, { sync: frozen }) : handle;
    },
  });
  const fixture = await setup({ name: "reason-frozen-nomutate", io });
  await expectRefusal(fixture.store.create(fixture.record()), ERROR_CODES.WRITE_FAILED, (error) => {
    assert.ok(error.cause === frozen);
  });
  assert.deepEqual(Object.keys(frozen), ["code"], "a thrown object is never mutated");
});

test("a store directory sync that throws ANY value is never reported as directory-synced", async () => {
  for (const [name, reason] of REASONS) {
    const storeDirRef = { path: null };
    const { io } = instrument({
      open: async ({ args, next }) => {
        const handle = await next(...args);
        if (storeDirRef.path !== null && args[0] === storeDirRef.path) return wrapHandle(handle, { sync: reason });
        return handle;
      },
    });
    const fixture = await setup({ name: `dirsync-reason-${name.replace(/\W/g, "")}`, io });
    storeDirRef.path = fixture.storeDir;
    await expectRefusal(fixture.store.create(fixture.record()), ERROR_CODES.COMMIT_UNCERTAIN, (error) => {
      assert.equal(error.committed, true, name);
      assertCauseKept(error, reason, `dirsync:${name}`);
    });
    // The record really is on disk: the uncertain state is visible, never reported as a clean success.
    assert.notEqual(await fixture.store.load(fixture.repo), null);
  }
});

test("a readback close that throws ANY value is a typed commit-uncertain, not a silent success", async () => {
  for (const [name, reason] of REASONS) {
    let armed = false;
    const { io } = instrument({
      rename: async ({ args, next }) => {
        const result = await next(...args);
        armed = true;
        return result;
      },
      open: async ({ args, next }) => {
        const handle = await next(...args);
        if (armed && args[1] === "r" && args[0].endsWith(".journal.json")) return wrapHandle(handle, { close: reason });
        return handle;
      },
    });
    const fixture = await setup({ name: `read-close-${name.replace(/\W/g, "")}`, io });
    await expectRefusal(fixture.store.create(fixture.record()), ERROR_CODES.COMMIT_UNCERTAIN, (error) => {
      assert.equal(error.committed, true, name);
      assertCauseKept(error.cause, reason, `read close:${name}`);
    });
  }
});

test("a readback read / stat that throws ANY value is a typed commit-uncertain", async () => {
  for (const stage of ["read", "stat"]) {
    for (const [name, reason] of REASONS) {
      let armed = false;
      const { io } = instrument({
        rename: async ({ args, next }) => {
          const result = await next(...args);
          armed = true;
          return result;
        },
        open: async ({ args, next }) => {
          const handle = await next(...args);
          if (armed && args[1] === "r" && args[0].endsWith(".journal.json")) return wrapHandle(handle, { [stage]: reason });
          return handle;
        },
      });
      const fixture = await setup({ name: `read-${stage}-${name.replace(/\W/g, "")}`, io });
      await expectRefusal(fixture.store.create(fixture.record()), ERROR_CODES.COMMIT_UNCERTAIN, (error) => {
        assert.equal(error.committed, true, `${stage}:${name}`);
      });
    }
  }
});

test("a load whose handle close throws ANY value is refused, never returned as a record", async () => {
  for (const [name, reason] of REASONS) {
    let armed = false;
    const { io } = instrument({
      open: async ({ args, next }) => {
        const handle = await next(...args);
        if (armed && args[1] === "r" && args[0].endsWith(".journal.json")) return wrapHandle(handle, { close: reason });
        return handle;
      },
    });
    const fixture = await setup({ name: `load-close-${name.replace(/\W/g, "")}`, io });
    await fixture.store.create(fixture.record());
    armed = true;
    await expectRefusal(fixture.store.load(fixture.repo), ERROR_CODES.RECORD_UNREADABLE, (error) => {
      assertCauseKept(error, reason, `load close:${name}`);
    });
    // The close fault never skipped a failure either: a read failure still wins over the close.
  }
});

test("a lock release that throws ANY value is lock-release-unverified (committed) and keeps the lock", async () => {
  for (const [name, reason] of REASONS) {
    const { io } = instrument({
      rmdir: async () => {
        throw reason;
      },
    });
    const fixture = await setup({ name: `lock-rel-${name.replace(/\W/g, "")}`, io });
    await expectRefusal(fixture.store.create(fixture.record()), ERROR_CODES.LOCK_RELEASE_UNVERIFIED, (error) => {
      assert.equal(error.committed, true, name);
      assert.ok(error.snapshot !== undefined, name);
    });
  }
});

test("a locked task failing with ANY thrown value is wrapped and typed, and the lock is still released", async () => {
  for (const [name, reason] of REASONS) {
    let armRename = false;
    const { io } = instrument({
      rename: async ({ args, next }) => {
        if (armRename) throw reason;
        return next(...args);
      },
    });
    const fixture = await setup({ name: `rename-reason-${name.replace(/\W/g, "")}`, io });
    const created = await fixture.store.create(fixture.record());
    armRename = true;
    await expectRefusal(fixture.store.advance(created.snapshot, fixture.recordFor("worker-running")), ERROR_CODES.WRITE_FAILED, (error) => {
      assert.equal(error.committed, false, name);
      assertCauseKept(error, reason, `rename:${name}`);
      assert.equal(error.detail.tempCleanup, "removed", name);
      assert.equal(error.lockRelease, "removed", name);
    });
  }
});

test("a primary failure that is a null, a primitive, a frozen object or a Proxy is wrapped and never mutated", async () => {
  const frozen = Object.freeze({ code: "EIO" });
  const proxy = new Proxy({}, {
    get() {
      throw new Error("proxy get trap");
    },
    set() {
      throw new Error("proxy set trap");
    },
    defineProperty() {
      throw new Error("proxy defineProperty trap");
    },
    getPrototypeOf() {
      throw new Error("proxy getPrototypeOf trap");
    },
  });
  for (const [name, reason] of [["null", null], ["number", 7], ["string", "boom"], ["frozen", frozen], ["proxy", proxy]]) {
    let armed = false;
    const { io } = instrument({
      lstat: async ({ args, next }) => {
        if (armed && args[0].endsWith(".journal.json")) throw reason;
        return next(...args);
      },
    });
    const fixture = await setup({ name: `primary-${name}`, io });
    const created = await fixture.store.create(fixture.record());
    armed = true;
    let caught;
    try {
      await fixture.store.advance(created.snapshot, fixture.recordFor("worker-running"));
    } catch (error) {
      caught = error;
    }
    assert.ok(isStoreError(caught), `${name}: must surface a typed JournalStoreError, got ${String(caught)}`);
    assert.equal(caught.detail?.lockRelease ?? caught.lockRelease, "removed", `${name}: the lock must be released and the outcome reported`);
  }
  assert.deepEqual(Object.keys(frozen), ["code"], "a frozen thrown object is never mutated");
});

test("a store option getter is never invoked, and a throwing getter or Proxy is a typed refusal", async () => {
  const caseDir = freshDir("opt-getter");
  const storeDir = path.join(caseDir, "store");
  const repo = path.join(caseDir, "repo");
  mkdirSync(storeDir);
  mkdirSync(repo);
  for (const [name, reason] of REASONS) {
    let invoked = 0;
    const options = {
      allowedRoots: [repo],
      get storeDir() {
        invoked += 1;
        throw reason;
      },
    };
    await expectRefusal(openJournalStore(options), ERROR_CODES.INVALID_OPTIONS);
    assert.equal(invoked, 0, `${name}: the storeDir getter must never be invoked`);
  }
  for (const key of ["allowedRoots", "hostInstanceId", "io", "limits"]) {
    let invoked = 0;
    const options = { storeDir, allowedRoots: [repo] };
    Object.defineProperty(options, key, {
      enumerable: true,
      get() {
        invoked += 1;
        throw undefined;
      },
    });
    await assert.rejects(openJournalStore(options), (error) => {
      assert.ok(isStoreError(error), `${key}: must be typed, got ${String(error)}`);
      return true;
    });
    assert.equal(invoked, 0, `${key}: getter must never be invoked`);
  }
  // Reflective traps that throw `undefined` are typed too (a malicious Proxy may still run its own trap code).
  const proxies = [
    new Proxy({}, { ownKeys() { throw undefined; } }),
    new Proxy({ storeDir, allowedRoots: [repo] }, { getOwnPropertyDescriptor() { throw undefined; } }),
  ];
  for (const proxy of proxies) {
    await assert.rejects(openJournalStore(proxy), (error) => {
      assert.ok(isStoreError(error), `proxy: must be typed, got ${String(error)}`);
      assert.equal(error.code, ERROR_CODES.INVALID_OPTIONS);
      return true;
    });
  }
  // io / limits accessors are refused as typed, not invoked.
  let ioInvoked = 0;
  const io = {};
  Object.defineProperty(io, "rename", { enumerable: true, get() { ioInvoked += 1; return rename; } });
  await expectRefusal(openJournalStore({ storeDir, allowedRoots: [repo], io }), ERROR_CODES.INVALID_IO);
  const limits = {};
  Object.defineProperty(limits, "maxRecordBytes", { enumerable: true, get() { ioInvoked += 1; return 1024; } });
  await expectRefusal(openJournalStore({ storeDir, allowedRoots: [repo], limits }), ERROR_CODES.INVALID_LIMIT);
  assert.equal(ioInvoked, 0);
});

test("a validator-side throw of an arbitrary value is a typed record-invalid refusal", async () => {
  const fixture = await setup({ name: "validator-hostile" });
  const hostile = new Proxy({}, { get() { throw undefined; }, ownKeys() { throw undefined; }, getOwnPropertyDescriptor() { throw undefined; } });
  await assert.rejects(fixture.store.create(hostile), (error) => {
    assert.ok(isStoreError(error), `must be typed, got ${String(error)}`);
    return true;
  });
});
// ---------- hostile lstat result on the lock entry (getter that throws) ----------

const HOSTILE_STATS = [
  ["isSymbolicLink getter throws Error", (real) => ({ dev: real.dev, ino: real.ino, nlink: real.nlink, isDirectory: () => true, isFile: () => false, get isSymbolicLink() { throw new Error("cleanup getter threw"); } })],
  ["isSymbolicLink getter throws undefined", (real) => ({ dev: real.dev, ino: real.ino, nlink: real.nlink, isDirectory: () => true, isFile: () => false, get isSymbolicLink() { throw undefined; } })],
  ["isDirectory getter throws", (real) => ({ dev: real.dev, ino: real.ino, nlink: real.nlink, isSymbolicLink: () => false, isFile: () => false, get isDirectory() { throw new Error("cleanup getter threw"); } })],
  ["dev data getter throws", (real) => ({ ino: real.ino, nlink: real.nlink, isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false, get dev() { throw new Error("cleanup getter threw"); } })],
  ["ino data getter throws undefined", (real) => ({ dev: real.dev, nlink: real.nlink, isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false, get ino() { throw undefined; } })],
];

function lockPathFor(fixture) {
  return path.join(fixture.storeDir, `${journalFileName(fixture.repo).replace(/\.journal\.json$/, "")}.lock`);
}

test("a lock lstat result with a throwing getter on the FIRST look is a typed write-failed (committed false) and the lock is retained", async () => {
  for (const [name, make] of HOSTILE_STATS) {
    const ref = { path: null };
    let seen = 0;
    const { io } = instrument({
      lstat: async ({ args, next }) => {
        const stats = await next(...args);
        if (ref.path !== null && args[0] === ref.path) {
          seen += 1;
          if (seen === 1) return make(stats);
        }
        return stats;
      },
    });
    const fixture = await setup({ name: `lock-first-hostile-${name.replace(/\W/g, "")}`, io });
    ref.path = lockPathFor(fixture);
    try {
      await expectRefusal(fixture.store.create(fixture.record()), ERROR_CODES.WRITE_FAILED, (error) => {
        assert.equal(error.committed, false, name);
        assert.equal(error.detail.lockRelease, "retained-ambiguous", name);
        assert.ok(!String(error.message).includes("cleanup getter threw"), `${name}: no raw error text may leak`);
      });
      assert.ok(existsSync(ref.path), `${name}: the ambiguous lock must be retained`);
      assert.ok(!existsSync(fixture.journalPath), `${name}: nothing may be written`);
    } finally {
      rmSync(ref.path, { recursive: true, force: true }); // operator-style cleanup, test only
    }
  }
});

test("a lock lstat result with a throwing getter on the SECOND (cleanup) look is lock-release-unverified (committed) with a branded snapshot", async () => {
  for (const [name, make] of HOSTILE_STATS) {
    const ref = { path: null };
    let seen = 0;
    const { io } = instrument({
      lstat: async ({ args, next }) => {
        const stats = await next(...args);
        if (ref.path !== null && args[0] === ref.path) {
          seen += 1;
          if (seen === 2) return make(stats);
        }
        return stats;
      },
    });
    const fixture = await setup({ name: `lock-second-hostile-${name.replace(/\W/g, "")}`, io });
    ref.path = lockPathFor(fixture);
    let committed;
    try {
      await expectRefusal(fixture.store.create(fixture.record()), ERROR_CODES.LOCK_RELEASE_UNVERIFIED, (error) => {
        assert.equal(error.committed, true, name);
        assert.equal(error.detail.lockRelease, "retained-ambiguous", name);
        assert.ok(error.snapshot !== undefined, `${name}: the committed snapshot must be handed back`);
        assert.equal(error.snapshot.record.phase, "created", name);
        assert.ok(!String(error.message).includes("cleanup getter threw"), `${name}: no raw error text may leak`);
        committed = error.snapshot;
      });
      assert.ok(existsSync(fixture.journalPath), `${name}: the record is on disk`);
      assert.ok(existsSync(ref.path), `${name}: the lock must be retained`);
      await expectRefusal(fixture.store.advance(committed, fixture.recordFor("worker-running")), ERROR_CODES.STORE_LOCKED);
      // Operator removes the lock by hand; the snapshot must then be accepted (it is branded by this store).
      rmSync(ref.path, { recursive: true, force: true });
      const advanced = await fixture.store.advance(committed, fixture.recordFor("worker-running"));
      assert.equal(advanced.snapshot.record.phase, "worker-running", name);
    } finally {
      rmSync(ref.path, { recursive: true, force: true }); // operator-style cleanup, test only
    }
  }
});
