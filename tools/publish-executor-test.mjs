// dsh-wiki publish-executor / reconcile tests (spec 007, T018/T020 follow-up): real temp fixtures.
//
// Covers: observePath three-state observation (never listing), the symbolic-action executor
// (restore-backup / remove-backup / remove-staging), zero effects for manual/quarantine/no-op,
// forged `.bak-` directories never touched, Windows junction planted at the backup path, hardlinked
// content inside a cleanup target, record-lag crash windows at every phase boundary, the provenance
// gate (a forged-but-consistent plan and a record the store did not issue are refused BEFORE any
// effect), restore expectations bound to the record, and the GET-free reconcile entry (journal-only,
// no filename/mtime discovery).
// Run: node --test tools/publish-executor-test.mjs
import assert from "node:assert/strict";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";

const here = import.meta.dirname;
const lib = (name) => import(pathToFileURL(path.join(here, "..", "lib", name)).href);
const { executeRecoveryPlan, identityJson, observePath, removeVerifiedTree, ExecutorError } = await lib("publish-executor.js");
const { openJournalStore } = await lib("journal-store.js");
const { createJobManager } = await lib("jobs.js");
const { identityOf } = await lib("fs-contain.js");

const isWin = process.platform === "win32";
const realpathNative = (target) => (typeof realpathSync.native === "function" ? realpathSync.native(target) : realpathSync(target));

let base;
let counter = 0;
before(() => { base = realpathNative(mkdtempSync(path.join(tmpdir(), "dsh-wiki-exec-"))); });
after(() => { rmSync(base, { recursive: true, force: true }); });

const JOB = "0123456789abcdef";
const HOST = "host-exec-000123";
const SESSION = "dsh-wiki-0123456789abcdef";
const PROTOCOL_HASH = "a".repeat(64);
const PROMPT_HASH = "b".repeat(64);

function freshDir(name) {
  counter += 1;
  const directory = path.join(base, `${String(counter).padStart(2, "0")}-${name}`);
  mkdirSync(directory);
  return realpathNative(directory);
}

const identityOfPath = identityOf;

/**
 * One transaction fixture: repo + store + the record's own three paths. `staging` holds the candidate,
 * `live` the published wiki. Identities are captured when the record is written, exactly like the
 * manager does, so every later disk mutation is a genuine crash simulation.
 */
async function fixture(name, { withLive = true, withStage = true } = {}) {
  const caseDir = freshDir(name);
  const repo = path.join(caseDir, "repo");
  mkdirSync(repo);
  const storeDir = path.join(caseDir, "store");
  mkdirSync(storeDir);
  const livePath = path.join(repo, ".dsh-wiki");
  const stagePath = path.join(repo, `.dsh-wiki.staging-${JOB}`);
  const backupPath = path.join(repo, `.dsh-wiki.bak-${JOB}`);
  if (withLive) {
    mkdirSync(path.join(livePath, "site"), { recursive: true });
    writeFileSync(path.join(livePath, "wiki.json"), JSON.stringify({ schema: "repo-wiki-local/1", language: "en", pages: [{ id: "old" }] }));
    writeFileSync(path.join(livePath, "site", "index.html"), "<!DOCTYPE html><html><main>old</main></html>");
  }
  if (withStage) {
    mkdirSync(path.join(stagePath, "site"), { recursive: true });
    writeFileSync(path.join(stagePath, "wiki.json"), JSON.stringify({ schema: "repo-wiki-local/1", language: "en", pages: [{ id: "new" }] }));
    writeFileSync(path.join(stagePath, "site", "index.html"), "<!DOCTYPE html><html><main>new</main></html>");
  }
  // The ordinary store is pinned to the instance that writes the records (exactly the production wiring:
  // index.js openJobStore passes jobState.hostInstanceId). A restart scenario opens a SECOND, unpinned
  // store over the same storeDir — see the "restart" tests below.
  const store = await openJournalStore({ storeDir, allowedRoots: [repo], hostInstanceId: HOST });
  const rootIdentity = await identityOfPath(repo);
  const liveIdentity = withLive ? await identityOfPath(livePath) : null;
  const stageIdentity = withStage ? await identityOfPath(stagePath) : null;
  const record = (phase, snapshots) => ({
    version: 1,
    jobId: JOB,
    hostInstanceId: HOST,
    rootReal: repo,
    rootIdentity: identityJson(rootIdentity),
    stagePath,
    livePath,
    backupPath,
    workerSessionId: SESSION,
    protocolSha256: PROTOCOL_HASH,
    promptSha256: PROMPT_HASH,
    phase,
    snapshots,
  });
  const S = (stage, live, backup) => ({
    stage: stage === null ? null : identityJson(stage),
    live: live === null ? null : identityJson(live),
    backup: backup === null ? null : identityJson(backup),
  });
  return { caseDir, repo, storeDir, store, livePath, stagePath, backupPath, rootIdentity, liveIdentity, stageIdentity, record, S };
}

/** Walk the journal forward through the phases given, with the exact carryover the store enforces. */
async function advanceTo(fx, phases) {
  let snapshot = null;
  const live = fx.liveIdentity;
  const stage = fx.stageIdentity;
  for (const phase of phases) {
    const snapshots = {
      created: fx.S(null, live, null),
      "worker-running": fx.S(stage, live, null),
      "worker-stopped": fx.S(stage, live, null),
      validated: fx.S(stage, live, null),
      "live-moved": fx.S(stage, null, live),
      published: fx.S(null, stage, live),
      aborted: fx.S(stage, live, null),
      "rolled-back": fx.S(stage, live, null),
    }[phase];
    if (phase === "created") {
      ({ snapshot } = await fx.store.create(fx.record(phase, snapshots)));
    } else {
      ({ snapshot } = await fx.store.advance(snapshot, fx.record(phase, snapshots)));
    }
  }
  return snapshot;
}

const reconcileFor = (fx, options = {}) => createJobManager({ journalStore: fx.store, hostInstanceId: HOST, allowedRoots: [fx.repo], logger: { warn: () => {} }, ...options });
const STOPPED = { workerLiveness: () => ({ state: "stopped", proof: "process-exit" }) };

const listing = (directory) => (existsSync(directory) ? readdirSync(directory).sort() : []);

// ---------- 1. observePath: three states, no listing ----------

test("observePath: present/absent/unknown, and a junction is never reported present", async () => {
  const dir = freshDir("observe");
  const real = path.join(dir, "real");
  mkdirSync(real);
  const present = await observePath(real);
  assert.equal(present.state, "present");
  const identity = JSON.parse(present.identity);
  assert.equal(identity.kind, "dir");
  assert.match(identity.dev, /^\d+$/);
  assert.match(identity.ino, /^\d+$/);
  assert.equal((await observePath(path.join(dir, "missing"))).state, "absent");
  const file = path.join(dir, "file.txt");
  writeFileSync(file, "x");
  assert.equal((await observePath(file)).state, "unknown", "a regular file is not a directory observation");
  const link = path.join(dir, "link");
  try {
    symlinkSync(real, link, isWin ? "junction" : "dir");
  } catch {
    return; // host cannot create a directory link: the junction cases below will skip too
  }
  assert.equal((await observePath(link)).state, "unknown", "a junction/symlink is ambiguity, not a present directory");
  const nested = path.join(link, "nested");
  mkdirSync(nested);
  assert.equal((await observePath(nested)).state, "unknown", "an ancestor junction makes the observation unknown");
});

// ---------- 2. zero-effect decisions ----------

test("manual / quarantine / no-op plans have zero effects", async () => {
  const fx = await fixture("zero-effect", { withStage: false });
  await advanceTo(fx, ["created"]);
  const manager = reconcileFor(fx, STOPPED);
  const planned = await manager.reconcile(fx.repo);
  assert.equal(planned.status, "planned");
  assert.equal(planned.plan.decision, "no-op");
  const before = listing(fx.repo);
  const executed = await manager.reconcile(fx.repo, { execute: true });
  assert.equal(executed.effects ?? 0, 0);
  assert.deepEqual(listing(fx.repo), before);
  const queued = await executeRecoveryPlan(planned.plan, { store: fx.store, snapshot: (await fx.store.load(fx.repo)) });
  assert.deepEqual(queued, { executed: false, effects: 0, decision: "no-op", code: planned.plan.code });
});

// ---------- 3. worker liveness is unknown by default => quarantine ----------

test("reconcile without a trusted liveness proof quarantines every phase and touches nothing", async () => {
  const fx = await fixture("worker-unknown");
  await advanceTo(fx, ["created", "worker-running", "worker-stopped", "validated"]);
  await (await import("node:fs/promises")).rename(fx.livePath, fx.backupPath); // crash between renames
  const manager = reconcileFor(fx);
  const planned = await manager.reconcile(fx.repo);
  assert.equal(planned.plan.decision, "quarantine");
  assert.equal(planned.plan.code, "worker-liveness-unknown");
  assert.equal(planned.plan.actions.length, 0);
  const before = listing(fx.repo);
  const executed = await manager.reconcile(fx.repo, { execute: true });
  assert.ok((executed.effects ?? 0) === 0);
  assert.deepEqual(listing(fx.repo), before, "quarantine must not move the backup back or delete the stage");
  assert.equal(existsSync(fx.livePath), false);
});

// ---------- 4. every phase boundary is planned, never a wrong-direction action ----------

test("crash at each journal phase yields the documented plan and never a wrong-direction rename", async () => {
  // The trusted liveness provider is the only thing that lets a plan act; without it every phase
  // quarantines (covered separately above). Here it proves the process exited, so the phase rules
  // themselves are exercised.
  const cases = [
    { name: "created", withStage: false, phases: ["created"], disk: async () => {}, decision: "no-op", code: "pre-mutation" },
    { name: "worker-running", phases: ["created", "worker-running"], disk: async () => {}, decision: "manual", code: "transaction-incomplete" },
    { name: "worker-stopped", phases: ["created", "worker-running", "worker-stopped"], disk: async () => {}, decision: "manual", code: "transaction-incomplete" },
    { name: "validated", phases: ["created", "worker-running", "worker-stopped", "validated"], disk: async () => {}, decision: "manual", code: "publication-not-started" },
    { name: "between-renames", phases: ["created", "worker-running", "worker-stopped", "validated"], disk: async (fx) => { await (await import("node:fs/promises")).rename(fx.livePath, fx.backupPath); }, decision: "restore-backup", code: "crash-between-renames" },
    { name: "live-moved", phases: ["created", "worker-running", "worker-stopped", "validated", "live-moved"], disk: async (fx) => { await (await import("node:fs/promises")).rename(fx.livePath, fx.backupPath); }, decision: "restore-backup", code: "rollback-gap" },
    { name: "record-lags-promotion", phases: ["created", "worker-running", "worker-stopped", "validated", "live-moved"], disk: async (fx) => { const fs = await import("node:fs/promises"); await fs.rename(fx.livePath, fx.backupPath); await fs.rename(fx.stagePath, fx.livePath); }, decision: "manual", code: "staging-missing" },
    { name: "published", phases: ["created", "worker-running", "worker-stopped", "validated", "live-moved", "published"], disk: async (fx) => { const fs = await import("node:fs/promises"); await fs.rename(fx.livePath, fx.backupPath); await fs.rename(fx.stagePath, fx.livePath); }, decision: "cleanup", code: "stale-backup" },
  ];
  for (const entry of cases) {
    const fx = await fixture(`crash-${entry.name}`, { withStage: entry.withStage !== false });
    await advanceTo(fx, entry.phases);
    await entry.disk(fx);
    const manager = reconcileFor(fx, STOPPED);
    const planned = await manager.reconcile(fx.repo);
    assert.equal(planned.phase, entry.phases.at(-1), entry.name);
    assert.equal(planned.plan.decision, entry.decision, `${entry.name}: ${planned.plan.code}`);
    assert.equal(planned.plan.code, entry.code, entry.name);
    for (const action of planned.plan.actions) {
      if (action.action === "restore-backup") assert.equal(action.dest, fx.livePath, `${entry.name}: a restore may only target the bound live path`);
      if (action.action === "remove-backup") assert.equal(action.path, fx.backupPath, `${entry.name}: only the bound backup may be removed`);
      if (action.action === "remove-staging") assert.equal(action.path, fx.stagePath, `${entry.name}: only the bound staging may be removed`);
    }
    if (entry.decision !== "restore-backup" && entry.decision !== "cleanup") {
      assert.equal(planned.plan.actions.length, 0, `${entry.name} must not carry actions`);
      const before = listing(fx.repo);
      const executed = await manager.reconcile(fx.repo, { execute: true });
      assert.ok((executed.effects ?? 0) === 0, entry.name);
      assert.deepEqual(listing(fx.repo), before, entry.name);
    }
  }
});
// ---------- 5. restore-backup executes exactly once and advances the record ----------

test("restore-backup (crash between renames) restores the bound backup, records aborted, keeps the candidate", async () => {
  const fx = await fixture("restore-between");
  await advanceTo(fx, ["created", "worker-running", "worker-stopped", "validated"]);
  const fs = await import("node:fs/promises");
  await fs.rename(fx.livePath, fx.backupPath);
  const manager = createJobManager({
    journalStore: fx.store, hostInstanceId: HOST, allowedRoots: [fx.repo], logger: { warn: () => {} },
    workerLiveness: () => ({ state: "stopped", proof: "process-exit" }),
  });
  const planned = await manager.reconcile(fx.repo);
  assert.equal(planned.plan.decision, "restore-backup", planned.plan.code);
  assert.equal(planned.plan.code, "crash-between-renames");
  const executed = await manager.reconcile(fx.repo, { execute: true });
  assert.equal(executed.status, "planned");
  assert.equal(executed.executed, true);
  assert.equal(executed.advancedTo, "aborted");
  assert.equal(existsSync(fx.livePath), true, "the previously published wiki is live again");
  assert.equal(existsSync(fx.backupPath), false, "the backup became the live directory");
  assert.equal(existsSync(fx.stagePath), true, "the validated candidate is retained, never promoted");
  const after = await fx.store.load(fx.repo);
  assert.equal(after.record.phase, "aborted");
});

test("restore-backup at live-moved records rolled-back and keeps the staging candidate", async () => {
  const fx = await fixture("restore-live-moved");
  await advanceTo(fx, ["created", "worker-running", "worker-stopped", "validated", "live-moved"]);
  await (await import("node:fs/promises")).rename(fx.livePath, fx.backupPath);
  const manager = createJobManager({
    journalStore: fx.store, hostInstanceId: HOST, allowedRoots: [fx.repo], logger: { warn: () => {} },
    workerLiveness: () => ({ state: "stopped", proof: "process-exit" }),
  });
  const executed = await manager.reconcile(fx.repo, { execute: true });
  assert.equal(executed.executed, true, JSON.stringify(executed));
  assert.equal(executed.advancedTo, "rolled-back");
  assert.equal(existsSync(fx.livePath), true);
  assert.equal(existsSync(fx.stagePath), true);
  assert.equal((await fx.store.load(fx.repo)).record.phase, "rolled-back");
  // A second reconcile now plans only the staging cleanup — never another rename.
  const again = await manager.reconcile(fx.repo);
  assert.equal(again.plan.decision, "cleanup");
  assert.deepEqual(again.plan.actions.map((a) => a.action), ["remove-staging"]);
});

// ---------- 6. cleanup: bound backup removed, forged look-alike untouched ----------

test("published: the bound backup is removed by identity; a forged .bak- directory is never touched", async () => {
  const fx = await fixture("cleanup-published");
  await advanceTo(fx, ["created", "worker-running", "worker-stopped", "validated", "live-moved", "published"]);
  const fs = await import("node:fs/promises");
  await fs.rename(fx.livePath, fx.backupPath);
  await fs.rename(fx.stagePath, fx.livePath);
  const forged = path.join(fx.repo, ".dsh-wiki.bak-forged0000000000");
  mkdirSync(forged);
  writeFileSync(path.join(forged, "keep.txt"), "forged");
  const manager = createJobManager({
    journalStore: fx.store, hostInstanceId: HOST, allowedRoots: [fx.repo], logger: { warn: () => {} },
    workerLiveness: () => ({ state: "stopped", proof: "process-exit" }),
  });
  const planned = await manager.reconcile(fx.repo);
  assert.equal(planned.plan.decision, "cleanup");
  assert.equal(planned.plan.code, "stale-backup");
  const executed = await manager.reconcile(fx.repo, { execute: true });
  assert.equal(executed.executed, true);
  assert.equal(existsSync(fx.backupPath), false, "the bound backup is gone");
  assert.equal(existsSync(forged), true, "a forged prefix directory is never adopted or deleted");
  assert.equal(readFileSync(path.join(forged, "keep.txt"), "utf8"), "forged");
  assert.equal(existsSync(fx.livePath), true);
  const again = await manager.reconcile(fx.repo);
  assert.equal(again.plan.decision, "no-op");
  assert.equal(again.plan.code, "backup-already-removed");
});

test("aborted: the bound staging directory is removed by identity and the live wiki is untouched", async () => {
  const fx = await fixture("cleanup-aborted");
  await advanceTo(fx, ["created", "worker-running", "worker-stopped", "validated", "aborted"]);
  const manager = createJobManager({
    journalStore: fx.store, hostInstanceId: HOST, allowedRoots: [fx.repo], logger: { warn: () => {} },
    workerLiveness: () => ({ state: "stopped", proof: "process-exit" }),
  });
  const planned = await manager.reconcile(fx.repo);
  assert.equal(planned.plan.decision, "cleanup");
  assert.equal(planned.plan.code, "aborted-staging");
  const executed = await manager.reconcile(fx.repo, { execute: true });
  assert.equal(executed.executed, true);
  assert.equal(existsSync(fx.stagePath), false);
  assert.equal(existsSync(fx.livePath), true);
  assert.equal(readFileSync(path.join(fx.livePath, "wiki.json"), "utf8").includes("\"old\""), true);
});

// ---------- 7. junction planted at a bound path: refuse before any mutation ----------

test("a junction at the backup path is observed as unknown => manual, no cleanup, nothing touched", async () => {
  const fx = await fixture("junction-backup");
  await advanceTo(fx, ["created", "worker-running", "worker-stopped", "validated", "live-moved", "published"]);
  const fs = await import("node:fs/promises");
  await fs.rename(fx.livePath, fx.backupPath);
  await fs.rename(fx.stagePath, fx.livePath);
  // Replace the bound backup with a junction planted at the same path.
  const outside = freshDir("junction-outside");
  writeFileSync(path.join(outside, "secret.txt"), "outside");
  await fs.rm(fx.backupPath, { recursive: true, force: true });
  try {
    symlinkSync(outside, fx.backupPath, isWin ? "junction" : "dir");
  } catch {
    return; // no directory links on this host
  }
  const manager = createJobManager({
    journalStore: fx.store, hostInstanceId: HOST, allowedRoots: [fx.repo], logger: { warn: () => {} },
    workerLiveness: () => ({ state: "stopped", proof: "process-exit" }),
  });
  const planned = await manager.reconcile(fx.repo);
  assert.equal(planned.plan.decision, "manual");
  assert.equal(planned.plan.code, "artifact-observation-unknown");
  assert.equal(planned.plan.actions.length, 0);
  const executed = await manager.reconcile(fx.repo, { execute: true });
  assert.ok((executed.effects ?? 0) === 0);
  assert.equal(existsSync(path.join(outside, "secret.txt")), true);
  assert.equal(existsSync(fx.backupPath), true);
});

test("removeVerifiedTree refuses a hardlinked file inside the target and leaves it in place", async () => {
  const dir = freshDir("hardlink");
  const target = path.join(dir, "target");
  mkdirSync(target);
  writeFileSync(path.join(target, "a.txt"), "payload");
  let linked = true;
  try { linkSync(path.join(target, "a.txt"), path.join(target, "b.txt")); } catch { linked = false; }
  if (!linked) return; // hardlinks unsupported on this volume
  const identity = await identityOfPath(target);
  const parent = await identityOfPath(dir);
  await assert.rejects(() => removeVerifiedTree(target, identity, parent), (error) => error.code === "scan-hardlink");
  assert.equal(existsSync(path.join(target, "a.txt")), true);
  assert.equal(existsSync(target), true);
});

// ---------- 8. provenance: only a plan the planner issued and a record the store issued may act ----------

test("a forged but internally consistent restore plan is refused by provenance before any effect", async () => {
  const fx = await fixture("forged-consistent-restore");
  await advanceTo(fx, ["created", "worker-running", "worker-stopped", "validated"]);
  await (await import("node:fs/promises")).rename(fx.livePath, fx.backupPath); // live gap: a restore would rename
  const snapshot = await fx.store.load(fx.repo);
  const planned = await reconcileFor(fx, STOPPED).reconcile(fx.repo);
  assert.equal(planned.plan.decision, "restore-backup");
  assert.equal(planned.plan.code, "crash-between-renames");
  // A perfect forgery: right jobId, phase, decision, code, action paths and identities, so every check
  // that inspects the plan TEXT passes. Only provenance separates it from the planner's own result.
  const forged = JSON.parse(JSON.stringify(planned.plan));
  assert.deepEqual(forged, planned.plan, "the forgery is structurally identical to the planner's plan");
  await assert.rejects(
    () => executeRecoveryPlan(forged, { store: fx.store, snapshot }),
    (error) => error instanceof ExecutorError && error.code === "plan-not-trusted",
  );
  // The refusal must be before the effect, not in addition to it.
  assert.equal(existsSync(fx.livePath), false, "the forged plan renamed nothing into the live path");
  assert.equal(existsSync(fx.backupPath), true, "the bound backup is still exactly where it was");
  assert.equal((await fx.store.load(fx.repo)).record.phase, "validated", "the forged plan advanced no record");
});

test("a forged cleanup plan is refused before any effect (cleanup never reaches a record advance)", async () => {
  const fx = await fixture("forged-cleanup");
  await advanceTo(fx, ["created", "worker-running", "worker-stopped", "validated", "live-moved", "published"]);
  const fs = await import("node:fs/promises");
  await fs.rename(fx.livePath, fx.backupPath);
  await fs.rename(fx.stagePath, fx.livePath);
  const snapshot = await fx.store.load(fx.repo);
  const planned = await reconcileFor(fx, STOPPED).reconcile(fx.repo);
  assert.equal(planned.plan.decision, "cleanup");
  assert.equal(planned.plan.code, "stale-backup");
  const forged = JSON.parse(JSON.stringify(planned.plan));
  assert.deepEqual(forged, planned.plan, "the forgery is structurally identical to the planner's plan");
  await assert.rejects(
    () => executeRecoveryPlan(forged, { store: fx.store, snapshot }),
    (error) => error instanceof ExecutorError && error.code === "plan-not-trusted",
  );
  assert.equal(existsSync(fx.backupPath), true, "the bound backup tree still exists after the refusal");
  assert.equal(readFileSync(path.join(fx.backupPath, "wiki.json"), "utf8").includes("\"old\""), true);
  assert.equal((await fx.store.load(fx.repo)).record.phase, "published");
});

test("a record the trusted store did not issue is refused before any effect", async () => {
  const fx = await fixture("forged-record");
  await advanceTo(fx, ["created", "worker-running", "worker-stopped", "validated"]);
  await (await import("node:fs/promises")).rename(fx.livePath, fx.backupPath);
  const snapshot = await fx.store.load(fx.repo);
  const planned = await reconcileFor(fx, STOPPED).reconcile(fx.repo);
  assert.equal(planned.plan.decision, "restore-backup");
  // Same sha256, same file identity, same fields — but a rebuilt record object, not the one the store
  // issued, so it never passed the allowlist-validating read/write protocol.
  const forgedSnapshot = { ...snapshot, record: JSON.parse(JSON.stringify(snapshot.record)) };
  assert.deepEqual(forgedSnapshot.record, snapshot.record, "the forged record is structurally identical");
  await assert.rejects(
    () => executeRecoveryPlan(planned.plan, { store: fx.store, snapshot: forgedSnapshot }),
    (error) => error instanceof ExecutorError && error.code === "record-not-trusted",
  );
  assert.equal(existsSync(fx.livePath), false, "an unproven record authorized no rename");
  assert.equal(existsSync(fx.backupPath), true);
  assert.equal((await fx.store.load(fx.repo)).record.phase, "validated");
});

test("a genuine planner-issued restore plan still executes and advances the record (regression)", async () => {
  const fx = await fixture("genuine-restore");
  await advanceTo(fx, ["created", "worker-running", "worker-stopped", "validated"]);
  await (await import("node:fs/promises")).rename(fx.livePath, fx.backupPath);
  const snapshot = await fx.store.load(fx.repo);
  const planned = await reconcileFor(fx, STOPPED).reconcile(fx.repo);
  assert.equal(planned.plan.decision, "restore-backup");
  const executed = await executeRecoveryPlan(planned.plan, { store: fx.store, snapshot });
  assert.deepEqual(executed, {
    executed: true,
    effects: 1,
    decision: "restore-backup",
    code: "crash-between-renames",
    advancedTo: "aborted",
  });
  assert.equal(existsSync(fx.livePath), true, "the bound backup became the live directory");
  assert.equal(existsSync(fx.backupPath), false);
  assert.equal((await fx.store.load(fx.repo)).record.phase, "aborted");
});

test("restore refuses when the plan's expectation disagrees with the record's bound identity", async () => {
  const fx = await fixture("restore-expect-mismatch");
  await advanceTo(fx, ["created", "worker-running", "worker-stopped", "validated"]);
  await (await import("node:fs/promises")).rename(fx.livePath, fx.backupPath);
  const planned = await reconcileFor(fx, STOPPED).reconcile(fx.repo);
  assert.equal(planned.plan.decision, "restore-backup");
  // A second genuine store for the SAME repo and jobId whose `validated` record binds a different live
  // identity, so the planner's own expectation disagrees with the record it is handed.
  const decoyPath = path.join(fx.caseDir, "decoy");
  mkdirSync(decoyPath);
  const decoy = await identityOfPath(decoyPath);
  const storeDirB = path.join(fx.caseDir, "store-b");
  mkdirSync(storeDirB);
  const storeB = await openJournalStore({ storeDir: storeDirB, allowedRoots: [fx.repo], hostInstanceId: HOST });
  let snapshotB = null;
  for (const [phase, snapshots] of [
    ["created", fx.S(null, decoy, null)],
    ["worker-running", fx.S(decoy, decoy, null)],
    ["worker-stopped", fx.S(decoy, decoy, null)],
    ["validated", fx.S(decoy, decoy, null)],
  ]) {
    const next = fx.record(phase, snapshots);
    snapshotB = phase === "created" ? (await storeB.create(next)).snapshot : (await storeB.advance(snapshotB, next)).snapshot;
  }
  assert.equal(snapshotB.record.phase, "validated");
  assert.notEqual(snapshotB.record.snapshots.live, identityJson(fx.liveIdentity), "the second record binds another live identity");
  await assert.rejects(
    () => executeRecoveryPlan(planned.plan, { store: storeB, snapshot: snapshotB }),
    (error) => error instanceof ExecutorError && error.code === "identity-not-bound",
  );
  assert.equal(existsSync(fx.livePath), false, "no rename: the expectation is not the record's identity");
  assert.equal(existsSync(fx.backupPath), true);
  assert.equal((await storeB.load(fx.repo)).record.phase, "validated", "the refused plan advanced no record");
});

test("executeRecoveryPlan refuses a genuine plan whose action paths are not the supplied record's", async () => {
  const fx = await fixture("bind-other-record");
  await advanceTo(fx, ["created", "worker-running", "worker-stopped", "validated", "live-moved", "published"]);
  const fs = await import("node:fs/promises");
  await fs.rename(fx.livePath, fx.backupPath);
  await fs.rename(fx.stagePath, fx.livePath);
  const planned = await reconcileFor(fx, STOPPED).reconcile(fx.repo);
  assert.equal(planned.plan.decision, "cleanup");
  // A second repository with the same jobId: its record binds plausible paths, just not this plan's.
  const other = await fixture("bind-other-record-b");
  const otherSnapshot = await advanceTo(other, ["created", "worker-running", "worker-stopped", "validated", "live-moved", "published"]);
  await assert.rejects(
    () => executeRecoveryPlan(planned.plan, { store: other.store, snapshot: otherSnapshot }),
    (error) => error instanceof ExecutorError && error.code === "path-not-bound",
  );
  assert.equal(existsSync(fx.backupPath), true, "the plan's own repository is untouched");
  assert.equal(existsSync(other.livePath), true, "the other repository's live wiki is untouched");
  assert.equal((await other.store.load(other.repo)).record.phase, "published", "the other record advanced nothing");
});

// ---------- 9. reconcile: journal-only, unknown roots and absent records are inert ----------

test("reconcile is journal-only: no record => no-record, unknown root => refused, forged staging never touched", async () => {
  const fx = await fixture("reconcile-inert", { withLive: true, withStage: false });
  const strayStage = path.join(fx.repo, `.dsh-wiki.staging-${JOB}`);
  mkdirSync(strayStage);
  writeFileSync(path.join(strayStage, "stray.txt"), "stray");
  const forgedBackup = path.join(fx.repo, ".dsh-wiki.bak-deadbeefdeadbeef");
  mkdirSync(forgedBackup);
  const manager = reconcileFor(fx);
  const none = await manager.reconcile(fx.repo);
  assert.deepEqual(none, { status: "no-record", root: fx.repo });
  assert.equal(existsSync(path.join(strayStage, "stray.txt")), true);
  assert.equal(existsSync(forgedBackup), true);
  const outside = freshDir("reconcile-outside");
  const refused = await manager.reconcile(outside);
  assert.equal(refused.status, "refused");
  assert.equal(refused.code, "root-not-allowed");
});

const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  // Only line-start or whitespace-preceded `//`: "http://..." inside a string literal survives.
  .replace(/(^|\s)\/\/[^\n]*/gm, "$1");

test("reconcile is reachable only through the confirmed POST recovery-execute route; no GET route, no directory listing", () => {
  const indexSource = readFileSync(path.join(here, "..", "lib", "index.js"), "utf8");
  const jobsSource = readFileSync(path.join(here, "..", "lib", "jobs.js"), "utf8");
  const code = stripComments(indexSource);
  // 2026-11-10 T018 (owner-authorised) replaced "index.js never calls reconcile" with "exactly one
  // confirmed, same-origin POST call site": POST /api/jobs/recovery-execute is the only entry that may
  // run a recovery plan in-process, so the assertion narrows to that one call site instead of banning it.
  assert.equal((code.match(/reconcile\s*\(/g) ?? []).length, 1, "index.js calls reconcile exactly once");
  // 2026-11-10 T029: the single call now also carries the recovery-only store (unpinned) and the explicit
  // recovery:true authorization, because a restarted Host's pinned store can never match the record it
  // must restore. Nothing else may call reconcile.
  const call = /manager\.reconcile\s*\(\s*project\.root\s*,\s*\{\s*execute:\s*true\s*,\s*recovery:\s*true\s*,\s*store:\s*recoveryStore\s*\}\s*\)/.exec(code);
  assert.ok(call, "the only call is literally manager.reconcile(project.root, { execute: true, recovery: true, store: recoveryStore })");
  const declaration = code.indexOf("const handleRecoveryExecutePost = async (req, res) => {");
  assert.ok(declaration >= 0, "the recovery-execute handler is declared");
  // End marker: the handler's own closing `};` — the first two-space-indented one after the declaration
  // (every closer inside the body is indented deeper), i.e. the end of the arrow function.
  const end = code.indexOf("\n  };", declaration);
  assert.ok(end > declaration, "the handler body closes with a two-space `};`");
  const handlerText = code.slice(declaration, end);
  const callInHandler = handlerText.search(/manager\.reconcile\s*\(/);
  assert.ok(callInHandler > 0 && declaration + callInHandler === call.index, "the reconcile call lies inside handleRecoveryExecutePost");
  const confirmAt = handlerText.indexOf("RECOVERY_EXECUTE_CONFIRM");
  assert.ok(confirmAt >= 0 && confirmAt < callInHandler, "the literal confirm check precedes the reconcile call");
  const originAt = handlerText.indexOf("isSameOrigin(req)");
  assert.ok(originAt >= 0 && originAt < callInHandler, "the same-origin check precedes the reconcile call");
  // Dispatcher: the recovery-execute path is combined with `req.method === "POST"` (lines ~1732-1733).
  assert.match(code, /pathname === `\$\{ROUTE\}\/api\/jobs\/recovery-execute`[^;]*?req\.method === "POST"/, "recovery-execute is reachable for POST only");
  assert.equal((code.match(/handleRecoveryExecutePost\(req, res\)/g) ?? []).length, 1, "the handler is invoked exactly once (a declaration is not an invocation)");
  // 2026-11-09 wiring slice: index.js legitimately opens the journal store to construct the manager, but it
  // must never import the recovery executor and never run a transaction itself.
  assert.equal(/publish-executor/.test(indexSource), false, "index.js must not import the recovery executor");
  assert.equal(/\/api\/[a-z-]*reconcile/.test(indexSource + jobsSource), false, "no reconcile route");
  const reconcileBody = jobsSource.slice(jobsSource.indexOf("async reconcile(root"));
  const body = reconcileBody.slice(0, reconcileBody.indexOf("journalState()"));
  assert.equal(/readdir|opendir|existsSync|readdirSync/.test(body), false, "reconcile must never list a directory");
});

test("the manager reports its journal wiring state (journal is the only mode)", async () => {
  const fx = await fixture("wiring", { withStage: false });
  assert.equal(reconcileFor(fx).journalState().mode, "journal");
  assert.deepEqual(createJobManager({}).journalState(), { mode: "journal", missing: ["journalStore", "hostInstanceId", "allowedRoots"], fenced: [] });
  const partial = createJobManager({ journalStore: fx.store });
  assert.deepEqual(partial.journalState(), { mode: "journal", missing: ["hostInstanceId", "allowedRoots"], fenced: [] });
});

// ---------- 10. junctions planted in the staging/live paths ----------

test("a junction inside the staging tree makes the cleanup refuse and leaves the tree in place", async () => {
  const fx = await fixture("junction-in-stage");
  await advanceTo(fx, ["created", "worker-running", "worker-stopped", "validated", "aborted"]);
  const outside = freshDir("junction-in-stage-outside");
  writeFileSync(path.join(outside, "secret.txt"), "outside");
  try {
    symlinkSync(outside, path.join(fx.stagePath, "linked"), isWin ? "junction" : "dir");
  } catch {
    return; // no directory links on this host
  }
  const manager = createJobManager({
    journalStore: fx.store, hostInstanceId: HOST, allowedRoots: [fx.repo], logger: { warn: () => {} },
    workerLiveness: () => ({ state: "stopped", proof: "process-exit" }),
  });
  const planned = await manager.reconcile(fx.repo);
  assert.equal(planned.plan.decision, "cleanup");
  assert.deepEqual(planned.plan.actions.map((a) => a.action), ["remove-staging"]);
  const executed = await manager.reconcile(fx.repo, { execute: true });
  assert.equal(executed.status, "execute-failed");
  assert.equal(executed.code, "scan-link");
  assert.equal(existsSync(path.join(fx.stagePath, "linked")), true, "the linked tree is never followed or removed");
  assert.equal(existsSync(path.join(outside, "secret.txt")), true, "the link target is untouched");
  assert.equal(existsSync(fx.stagePath), true);
});

test("a junction at the live path is unknown => the published record plans no cleanup", async () => {
  const fx = await fixture("junction-live");
  await advanceTo(fx, ["created", "worker-running", "worker-stopped", "validated", "live-moved", "published"]);
  const fs = await import("node:fs/promises");
  await fs.rename(fx.livePath, fx.backupPath);
  await fs.rename(fx.stagePath, fx.livePath);
  const outside = freshDir("junction-live-outside");
  await fs.rm(fx.livePath, { recursive: true, force: true });
  try {
    symlinkSync(outside, fx.livePath, isWin ? "junction" : "dir");
  } catch {
    return; // no directory links on this host
  }
  const manager = createJobManager({
    journalStore: fx.store, hostInstanceId: HOST, allowedRoots: [fx.repo], logger: { warn: () => {} },
    workerLiveness: () => ({ state: "stopped", proof: "process-exit" }),
  });
  const planned = await manager.reconcile(fx.repo);
  assert.equal(planned.plan.decision, "manual");
  assert.equal(planned.plan.code, "artifact-observation-unknown");
  const executed = await manager.reconcile(fx.repo, { execute: true });
  assert.ok((executed.effects ?? 0) === 0);
  assert.equal(existsSync(fx.backupPath), true, "the bound backup is kept, not deleted on ambiguity");
  assert.equal(existsSync(fx.livePath), true);
});

// ---------- 11. host restart: an UNPINNED, explicitly recovery-authorized store restores the backup ----------
//
// The record was written by a PREVIOUS Host instance (HOST). makeHostInstanceId() mints a fresh token per
// apply, so after a restart the ordinary pinned store can never match that record and the executor would
// reject the restore before any rename. Recovery therefore runs through a second, unpinned store — which
// is only usable when the route declares recovery:true, and only reaches a rename when the planner
// accepts independent proof that the old worker's process exited.

const HOST_AFTER_RESTART = "host-exec-000999";
const unpinnedStore = (fx) => openJournalStore({ storeDir: fx.storeDir, allowedRoots: [fx.repo] });
const restartManager = (fx, store, liveness = STOPPED) => createJobManager({
  journalStore: store, hostInstanceId: HOST_AFTER_RESTART, allowedRoots: [fx.repo], logger: { warn: () => {} }, ...liveness,
});

test("restart: an unpinned store with recovery:true restores the bound backup and advances to aborted", async () => {
  const fx = await fixture("restart-restore-between");
  await advanceTo(fx, ["created", "worker-running", "worker-stopped", "validated"]);
  await (await import("node:fs/promises")).rename(fx.livePath, fx.backupPath); // crash between renames
  const store = await unpinnedStore(fx);
  const manager = restartManager(fx, store);
  const planned = await manager.reconcile(fx.repo, { execute: true, recovery: true, store });
  assert.equal(planned.status, "planned", JSON.stringify(planned));
  assert.equal(planned.plan.decision, "restore-backup");
  assert.equal(planned.plan.code, "crash-between-renames");
  assert.equal(planned.executed, true, JSON.stringify(planned));
  assert.equal(planned.effects, 1);
  assert.equal(planned.advancedTo, "aborted");
  // Directory contents after the rename, not just the return value.
  assert.deepEqual(listing(fx.repo), [".dsh-wiki", `.dsh-wiki.staging-${JOB}`].sort());
  assert.equal(existsSync(fx.backupPath), false, "the backup became the live directory");
  assert.equal(readFileSync(path.join(fx.livePath, "wiki.json"), "utf8").includes("\"old\""), true, "the previous published wiki is live again");
  assert.equal(existsSync(path.join(fx.livePath, "site", "index.html")), true);
  assert.equal(readFileSync(path.join(fx.stagePath, "wiki.json"), "utf8").includes("\"new\""), true, "the candidate stays staged, never promoted");
  assert.equal((await store.load(fx.repo)).record.phase, "aborted", "the journal advanced on the same store that planned it");
  // The ordinary pinned store is NOT the one that advanced it: a snapshot issued by one store is not
  // authority for another (that is why the whole execute path uses a single store instance).
  const reloaded = await store.load(fx.repo);
  await assert.rejects(
    async () => fx.store.advance(reloaded, { ...reloaded.record, phase: "created" }),
    (error) => error.code === "snapshot-not-owned",
  );
});

test("restart: an unpinned store with recovery:true records rolled-back at live-moved", async () => {
  const fx = await fixture("restart-restore-moved");
  await advanceTo(fx, ["created", "worker-running", "worker-stopped", "validated", "live-moved"]);
  await (await import("node:fs/promises")).rename(fx.livePath, fx.backupPath);
  const store = await unpinnedStore(fx);
  const manager = restartManager(fx, store);
  const executed = await manager.reconcile(fx.repo, { execute: true, recovery: true, store });
  assert.equal(executed.executed, true, JSON.stringify(executed));
  assert.equal(executed.advancedTo, "rolled-back");
  assert.deepEqual(listing(fx.repo), [".dsh-wiki", `.dsh-wiki.staging-${JOB}`].sort());
  assert.equal(existsSync(fx.backupPath), false);
  assert.equal(readFileSync(path.join(fx.livePath, "wiki.json"), "utf8").includes("\"old\""), true);
  assert.equal((await store.load(fx.repo)).record.phase, "rolled-back");
});

test("restart: a store pinned to a DIFFERENT host is still refused with host-pin-mismatch and changes nothing", async () => {
  const fx = await fixture("restart-pinned-other");
  await advanceTo(fx, ["created", "worker-running", "worker-stopped", "validated"]);
  await (await import("node:fs/promises")).rename(fx.livePath, fx.backupPath);
  // A store pinned to the CURRENT instance, over the same directory: the record still belongs to HOST.
  const pinnedOther = await openJournalStore({ storeDir: fx.storeDir, allowedRoots: [fx.repo], hostInstanceId: HOST_AFTER_RESTART });
  const manager = restartManager(fx, pinnedOther);
  const before = listing(fx.repo);
  const refused = await manager.reconcile(fx.repo, { execute: true, recovery: true, store: pinnedOther });
  assert.equal(refused.status, "execute-failed", JSON.stringify(refused));
  assert.equal(refused.code, "host-pin-mismatch");
  assert.equal(refused.executed, undefined);
  assert.deepEqual(listing(fx.repo), before, "no directory change: the live wiki stays in the backup path");
  assert.equal(existsSync(fx.livePath), false);
  assert.equal(existsSync(fx.backupPath), true);
  assert.equal((await pinnedOther.load(fx.repo)).record.phase, "validated", "nothing advanced");
});

test("restart: an unpinned store WITHOUT recovery:true is refused and changes nothing", async () => {
  const fx = await fixture("restart-unpinned-no-recovery");
  await advanceTo(fx, ["created", "worker-running", "worker-stopped", "validated"]);
  await (await import("node:fs/promises")).rename(fx.livePath, fx.backupPath);
  const store = await unpinnedStore(fx);
  const manager = restartManager(fx, store);
  const before = listing(fx.repo);
  const refused = await manager.reconcile(fx.repo, { execute: true, store });
  assert.equal(refused.status, "execute-failed", JSON.stringify(refused));
  assert.equal(refused.code, "recovery-not-declared");
  assert.deepEqual(listing(fx.repo), before, "an unpinned store is never usable by accidental wiring");
  assert.equal(existsSync(fx.livePath), false);
  assert.equal(existsSync(fx.backupPath), true);
  assert.equal((await store.load(fx.repo)).record.phase, "validated");
  // Same refusal through the executor directly: the authorization is the caller's explicit statement.
  const planned = await manager.reconcile(fx.repo);
  assert.equal(planned.plan.decision, "restore-backup");
  const snapshot = await store.load(fx.repo);
  await assert.rejects(
    () => executeRecoveryPlan(planned.plan, { store, snapshot }),
    (error) => error instanceof ExecutorError && error.code === "recovery-not-declared",
  );
  assert.deepEqual(listing(fx.repo), before);
  // ... and the same unpinned store DOES execute once the caller says so (no other difference).
  const allowed = await executeRecoveryPlan(planned.plan, { store, snapshot, recovery: true });
  assert.equal(allowed.executed, true);
  assert.equal(allowed.advancedTo, "aborted");
});

test("restart: alive / unknown / host-registry / no proof all plan zero actions and change nothing", async () => {
  for (const [label, liveness] of [
    ["alive", { workerLiveness: () => ({ state: "alive" }) }],
    ["unknown", { workerLiveness: () => ({ state: "unknown" }) }],
    ["host-registry", { workerLiveness: () => ({ state: "stopped", proof: "host-registry" }) }],
    ["worker-session-id", { workerLiveness: () => ({ state: "stopped", proof: "worker-session-id" }) }],
    ["no proof", { workerLiveness: () => ({ state: "stopped" }) }],
  ]) {
    const fx = await fixture(`restart-gate-${label.replace(/\s+/g, "-")}`);
    await advanceTo(fx, ["created", "worker-running", "worker-stopped", "validated"]);
    await (await import("node:fs/promises")).rename(fx.livePath, fx.backupPath);
    const store = await unpinnedStore(fx);
    const manager = restartManager(fx, store, liveness);
    const before = listing(fx.repo);
    const planned = await manager.reconcile(fx.repo);
    assert.equal(planned.plan.decision, "quarantine", label);
    assert.equal(planned.plan.actions.length, 0, `${label}: a quarantine plan carries no action`);
    const executed = await manager.reconcile(fx.repo, { execute: true, recovery: true, store });
    assert.equal(executed.executed, false, label);
    assert.equal(executed.effects, 0, label);
    assert.equal(executed.releaseReason, "no-action", label);
    assert.deepEqual(listing(fx.repo), before, `${label}: nothing renamed or deleted`);
    assert.equal(existsSync(fx.livePath), false, label);
    assert.equal(existsSync(fx.backupPath), true, label);
    assert.equal((await store.load(fx.repo)).record.phase, "validated", label);
  }
});

test("reconcile(root) and reconcile(root, { execute: false }) are unchanged by the recovery store wiring", async () => {
  const fx = await fixture("reconcile-defaults");
  await advanceTo(fx, ["created", "worker-running", "worker-stopped", "validated"]);
  await (await import("node:fs/promises")).rename(fx.livePath, fx.backupPath);
  const manager = reconcileFor(fx, STOPPED);
  const plain = await manager.reconcile(fx.repo);
  assert.equal(plain.status, "planned");
  assert.equal(plain.plan.decision, "restore-backup");
  assert.equal(plain.plan.code, "crash-between-renames");
  // A plan-only call is read-only whoever the caller is: an unpinned recovery store passed without
  // execute:true changes nothing, and the ordinary store keeps serving the read-only plan.
  const store = await unpinnedStore(fx);
  const withStore = await manager.reconcile(fx.repo, { execute: false, store });
  assert.equal(withStore.status, "planned");
  assert.equal(withStore.plan.decision, plain.plan.decision);
  assert.equal(withStore.plan.code, plain.plan.code);
  assert.equal(withStore.executed, undefined, "no execution happens without execute:true");
  assert.equal(existsSync(fx.livePath), false);
  assert.equal(existsSync(fx.backupPath), true);
  // The ordinary, pinned store still refuses a plan from a record it does not own... and a matching one
  // executes exactly as before (byte-identical pinned behaviour, covered by section 5 above).
  const other = await fixture("reconcile-defaults-other");
  await advanceTo(other, ["created", "worker-running", "worker-stopped", "validated"]);
  await (await import("node:fs/promises")).rename(other.livePath, other.backupPath);
  const foreign = await openJournalStore({ storeDir: other.storeDir, allowedRoots: [other.repo], hostInstanceId: "host-exec-different" });
  const foreignManager = restartManager(other, foreign);
  const refused = await foreignManager.reconcile(other.repo, { execute: true });
  assert.equal(refused.code, "host-pin-mismatch", JSON.stringify(refused));
});
