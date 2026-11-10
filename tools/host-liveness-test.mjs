// dsh-wiki host epoch — offline verdict tests (spec 007 / T028 slice 1).
//
// Drives lib/host-liveness.js directly against real temporary directories: no DSH Host, no network.
// Every fixture directory is registered on creation and removed after the run (including when a
// test fails), per the T026 temp-leak rule. Run with:
//   node --test --test-concurrency=1 plugins/dsh-wiki/tools/host-liveness-test.mjs
//
// Each verdict path asserts the EXACT verdict and reason, because the whole point of the module is
// that "unknown" is never silently downgraded to "dead". The tests that need a live pid use this
// process, so the Windows start-time query has to return a value on the machine running them.
//
// Records are PER HOST INSTANCE: `<dir>/<hostInstanceId>.json`. A verdict is therefore always asked
// for one specific owner (`proveEpochFor({ dir, hostInstanceId })`), and the recovery-safety tests at
// the end pin the defect that made a per-instance model necessary: one instance's death (or missing
// record) must never be reported as another instance's death.
//
// The identity anchor is OS start ticks (`procStartTicks`), never the wall-clock `procStart`; the
// fixtures below query this process's real ticks so a record can carry a genuinely matching anchor
// (alive) or a deliberately different one (pid-reused). `procStart` only appears as debug noise.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { pathToFileURL } from "node:url";

const here = import.meta.dirname;
const moduleUrl = pathToFileURL(path.join(here, "..", "lib", "host-liveness.js")).href;
const { REASON, VERDICT, acquireHostEpoch, hostEpochFileName, proveEpochFor } = await import(moduleUrl);

const TEMP_DIRS = [];
const tempDir = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dsh-wiki-host-epoch-"));
  TEMP_DIRS.push(dir);
  return dir;
};

after(() => {
  for (const dir of TEMP_DIRS.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort: a locked fixture must not fail the run */
    }
  }
});

const INSTANCE = "dsh-wiki.fixture-live";
const OTHER_INSTANCE = "dsh-wiki.fixture-other";

const epochPath = (dir, hostInstanceId = INSTANCE) => path.join(dir, hostEpochFileName(hostInstanceId));
const readRecord = (dir, hostInstanceId = INSTANCE) => JSON.parse(readFileSync(epochPath(dir, hostInstanceId), "utf8"));
const writeRecord = (dir, record, hostInstanceId = record?.hostInstanceId ?? INSTANCE) =>
  writeFileSync(epochPath(dir, hostInstanceId), `${JSON.stringify(record, null, 2)}\n`, "utf8");

/** Files this module may leave in a record directory, sorted for stable deepEqual comparisons. */
const recordFiles = (dir) => readdirSync(dir).sort();

/**
 * This process's OS start ticks, asked of the OS directly — the same source the module uses, so a
 * fixture can carry an anchor that really does (or really does not) identify this pid. Null only
 * when the machine cannot answer; callers that depend on the anchor assert on it explicitly instead
 * of letting the suite quietly exercise the anchor-missing path.
 */
function queryOwnTicks() {
  if (process.platform !== "win32") return null;
  try {
    const text = execFileSync(
      "powershell",
      ["-NoProfile", "-Command", `(Get-Process -Id ${process.pid}).StartTime.ToUniversalTime().Ticks`],
      { encoding: "utf8", windowsHide: true, timeout: 10_000 },
    ).trim();
    return /^\d+$/.test(text) ? text : null;
  } catch {
    return null;
  }
}

const LIVE_TICKS = queryOwnTicks();
const liveTicks = () => {
  assert.equal(typeof LIVE_TICKS, "string", "this machine must answer the OS start-time query");
  return LIVE_TICKS;
};
/** A tick string that is `deltaMs` away from this process's real start — a different process. */
const ticksOffset = (deltaMs) => (BigInt(liveTicks()) + BigInt(deltaMs) * 10_000n).toString();

/** A record that claims an epoch for this very process — the only way to be provably "alive". */
function liveRecord(overrides = {}) {
  return {
    epochId: "fixture-epoch-live",
    hostInstanceId: INSTANCE,
    pid: process.pid,
    procStart: Math.round(Date.now() - process.uptime() * 1000),
    procStartTicks: LIVE_TICKS,
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// (a) no record for that instance — absent is NOT death
// ---------------------------------------------------------------------------

test("prove: no record for an instance is unknown/epoch-unknown, never dead", async () => {
  const dir = tempDir();
  const proof = await proveEpochFor({ dir, hostInstanceId: INSTANCE });

  // Absence proves nothing about any process: every host instance that never opened this store has
  // no record either. This replaced the old dead/no-previous-epoch verdict.
  assert.equal(proof.verdict, VERDICT.UNKNOWN);
  assert.equal(proof.reason, REASON.EPOCH_UNKNOWN);
  assert.equal(proof.previous, null);
  assert.notEqual(proof.verdict, VERDICT.DEAD, "an absent record must never be reported as dead");
  assert.deepEqual(recordFiles(dir), [], "proving must not create a record");
});

test("prove: an empty directory is not treated as an unreadable epoch", async () => {
  const dir = tempDir();
  // The fixture directory exists but holds no record: that is a missing epoch, not an unknown one.
  assert.equal(recordFiles(dir).length, 0);
  const proof = await proveEpochFor({ dir, hostInstanceId: INSTANCE });
  assert.equal(proof.verdict, VERDICT.UNKNOWN);
  assert.equal(proof.reason, REASON.EPOCH_UNKNOWN);
});

// ---------------------------------------------------------------------------
// (b) refuse to clobber the instance's own record
// ---------------------------------------------------------------------------

test("acquire: a second acquire for the same instance without takeover is refused and leaves the record untouched", async () => {
  const dir = tempDir();

  const first = await acquireHostEpoch({ dir, hostInstanceId: INSTANCE });
  assert.equal(typeof first.release, "function");
  assert.equal(first.hostInstanceId, INSTANCE);
  const firstRecord = readRecord(dir);
  assert.equal(firstRecord.epochId, first.epochId);
  assert.equal(firstRecord.pid, process.pid);

  const second = await acquireHostEpoch({ dir, hostInstanceId: INSTANCE });
  assert.equal(second.refused, true);
  assert.equal(second.previous.verdict, VERDICT.ALIVE);
  assert.equal(second.previous.reason, REASON.PROCESS_MATCHES);
  assert.equal(second.previous.previous.epochId, first.epochId);
  assert.equal(second.previous.previous.pid, process.pid);

  // The refusal must not have written anything: same epochId, one file, no temp litter.
  assert.equal(readRecord(dir).epochId, first.epochId);
  assert.deepEqual(recordFiles(dir), [hostEpochFileName(INSTANCE)]);

  assert.equal(await first.release(), true);
  assert.deepEqual(recordFiles(dir), []);
});

test("acquire: release removes the record so the same instance afterwards proves unknown/epoch-unknown", async () => {
  const dir = tempDir();
  const epoch = await acquireHostEpoch({ dir, hostInstanceId: INSTANCE });
  assert.equal(await epoch.release(), true);

  const proof = await proveEpochFor({ dir, hostInstanceId: INSTANCE });
  assert.equal(proof.verdict, VERDICT.UNKNOWN);
  assert.equal(proof.reason, REASON.EPOCH_UNKNOWN);
});

test("acquire: release is a no-op for a record another epoch of the same instance took over", async () => {
  const dir = tempDir();
  const first = await acquireHostEpoch({ dir, hostInstanceId: INSTANCE });
  const second = await acquireHostEpoch({ dir, hostInstanceId: INSTANCE, takeover: true });

  assert.equal(second.refused, undefined);
  assert.notEqual(second.epochId, first.epochId);
  assert.equal(readRecord(dir).epochId, second.epochId);

  assert.equal(await first.release(), false, "the superseded epoch must not delete the new epoch");
  assert.equal(readRecord(dir).epochId, second.epochId);

  assert.equal(await second.release(), true);
  assert.equal(await second.release(), false, "release is idempotent");
});

test("acquire: only an explicit boolean takeover overrides a live own record", async () => {
  const dir = tempDir();
  const first = await acquireHostEpoch({ dir, hostInstanceId: INSTANCE });

  // Truthy-but-not-true is not consent: a caller cannot take over by accident.
  for (const takeover of ["yes", 1, {}, "true", null]) {
    const attempt = await acquireHostEpoch({ dir, hostInstanceId: INSTANCE, takeover });
    assert.equal(attempt.refused, true, `takeover=${JSON.stringify(takeover)} must not take over`);
    assert.equal(attempt.previous.verdict, VERDICT.ALIVE);
  }
  assert.equal(readRecord(dir).epochId, first.epochId);

  const taken = await acquireHostEpoch({ dir, hostInstanceId: INSTANCE, takeover: true });
  assert.equal(taken.refused, undefined);
  assert.notEqual(taken.epochId, first.epochId);
  await first.release();
  await taken.release();
});

// ---------------------------------------------------------------------------
// (c) pid-reused
// ---------------------------------------------------------------------------

test("prove: a live pid with different OS start ticks is dead/pid-reused", async () => {
  const dir = tempDir();
  // One hour away from this process's real start: same pid, different process identity. The
  // wall-clock `procStart` is left untouched, so this cannot be decided by the debug field.
  const recycledTicks = ticksOffset(-3_600_000);
  writeRecord(dir, liveRecord({ procStartTicks: recycledTicks }));

  const proof = await proveEpochFor({ dir, hostInstanceId: INSTANCE });
  assert.equal(proof.verdict, VERDICT.DEAD);
  assert.equal(proof.reason, REASON.PID_REUSED);
  assert.equal(proof.previous.pid, process.pid);
  assert.equal(proof.previous.procStartTicks, recycledTicks);
  assert.equal(proof.previous.hostInstanceId, INSTANCE);
});

test("acquire: a dead pid-reused own record is replaced without takeover", async () => {
  const dir = tempDir();
  writeRecord(dir, liveRecord({ epochId: "recycled", procStartTicks: ticksOffset(-3_600_000) }));

  const epoch = await acquireHostEpoch({ dir, hostInstanceId: INSTANCE });
  assert.equal(epoch.refused, undefined);
  assert.notEqual(epoch.epochId, "recycled");
  assert.equal(readRecord(dir).epochId, epoch.epochId);
  await epoch.release();
});

// ---------------------------------------------------------------------------
// (d) process-gone
// ---------------------------------------------------------------------------

test("prove: an impossible pid is dead/process-gone", async () => {
  const dir = tempDir();
  // 2^31-1 is outside the range a Windows pid can occupy, so kill(pid, 0) fails with ESRCH.
  // Existence is clock-independent, so the anchor on this record plays no part in the verdict.
  const impossible = 2147483647;
  writeRecord(dir, liveRecord({ pid: impossible, procStartTicks: liveTicks() }));

  const proof = await proveEpochFor({ dir, hostInstanceId: INSTANCE });
  assert.equal(proof.verdict, VERDICT.DEAD);
  assert.equal(proof.reason, REASON.PROCESS_GONE);
  assert.equal(proof.previous.pid, impossible);
});

test("acquire: a process-gone own record is overwritten without takeover", async () => {
  const dir = tempDir();
  writeRecord(dir, liveRecord({ epochId: "gone", pid: 2147483647 }));

  const epoch = await acquireHostEpoch({ dir, hostInstanceId: INSTANCE });
  assert.equal(epoch.refused, undefined);
  assert.equal(readRecord(dir).epochId, epoch.epochId);
  await epoch.release();
});

// ---------------------------------------------------------------------------
// (e) corrupt / invalid records are unknown, never dead
// ---------------------------------------------------------------------------

test("prove: a corrupt record file is unknown/corrupt-record and is not called dead", async () => {
  const dir = tempDir();
  writeFileSync(epochPath(dir), "{ this is not json", "utf8");

  const proof = await proveEpochFor({ dir, hostInstanceId: INSTANCE });
  assert.equal(proof.verdict, VERDICT.UNKNOWN);
  assert.equal(proof.reason, REASON.CORRUPT_RECORD);
  assert.equal(proof.previous, null);
  assert.notEqual(proof.verdict, VERDICT.DEAD, "an unproven record must never be reported as dead");
});

test("acquire: an unknown own record is refused, and takeover is the only way past it", async () => {
  const dir = tempDir();
  writeFileSync(epochPath(dir), "not json at all", "utf8");

  const refused = await acquireHostEpoch({ dir, hostInstanceId: INSTANCE });
  assert.equal(refused.refused, true);
  assert.equal(refused.previous.verdict, VERDICT.UNKNOWN);
  assert.equal(refused.previous.reason, REASON.CORRUPT_RECORD);
  assert.equal(readFileSync(epochPath(dir), "utf8"), "not json at all", "refusal must not touch the record");

  const taken = await acquireHostEpoch({ dir, hostInstanceId: INSTANCE, takeover: true });
  assert.equal(taken.refused, undefined);
  assert.equal(readRecord(dir).epochId, taken.epochId);

  // With a real record in place the same process now proves alive, so the query did return a value.
  const proof = await proveEpochFor({ dir, hostInstanceId: INSTANCE });
  assert.equal(proof.verdict, VERDICT.ALIVE);
  assert.equal(proof.reason, REASON.PROCESS_MATCHES);

  await taken.release();
});

test("prove: JSON that lacks a usable identity is unknown/invalid-record", async () => {
  const dir = tempDir();
  const exactTicks = liveTicks();
  for (const record of [
    {},
    { epochId: "x" },
    liveRecord({ pid: "1234" }),
    liveRecord({ pid: 0 }),
    liveRecord({ pid: -1 }),
    liveRecord({ procStart: "12345" }),
    liveRecord({ procStart: 0 }),
    liveRecord({ epochId: "" }),
    liveRecord({ hostInstanceId: "" }),
    liveRecord({ hostInstanceId: "not a token" }),
    // A record that names a DIFFERENT instance is not this instance's proof, even though it sits at
    // this instance's file name; trusting it by file position would let one file prove another host.
    liveRecord({ hostInstanceId: OTHER_INSTANCE }),
    // The anchor must be a decimal STRING above 2^53: a JSON number has lost precision, prose is not
    // a tick count, and a pre-1970 value cannot be this host. All three are unusable, not "dead".
    liveRecord({ procStartTicks: Number(exactTicks) }),
    liveRecord({ procStartTicks: "not-ticks" }),
    liveRecord({ procStartTicks: "" }),
    liveRecord({ procStartTicks: "1" }),
    [1, 2, 3],
    null,
  ]) {
    // Always at the INSTANCE file name, whatever the record claims inside.
    writeRecord(dir, record, INSTANCE);
    const proof = await proveEpochFor({ dir, hostInstanceId: INSTANCE });
    assert.equal(proof.verdict, VERDICT.UNKNOWN, `record ${JSON.stringify(record)}`);
    assert.equal(proof.reason, REASON.INVALID_RECORD, `record ${JSON.stringify(record)}`);
    assert.equal(proof.previous, null);
  }
});

// ---------------------------------------------------------------------------
// record shape and alive path
// ---------------------------------------------------------------------------

test("acquire: the written record carries exactly the documented fields", async () => {
  const dir = tempDir();
  const epoch = await acquireHostEpoch({ dir, hostInstanceId: INSTANCE });

  const record = readRecord(dir);
  assert.match(epoch.epochId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(Object.keys(record).sort(),
    ["epochId", "hostInstanceId", "pid", "procStart", "procStartTicks", "startedAt"]);
  assert.equal(record.epochId, epoch.epochId);
  assert.equal(record.hostInstanceId, INSTANCE, "the record must name the instance that owns it");
  assert.equal(record.pid, process.pid);
  assert.equal(record.pid, epoch.pid);
  assert.ok(Number.isSafeInteger(record.procStart) && record.procStart > 0);
  assert.equal(record.procStart, epoch.procStart);
  assert.ok(Number.isFinite(Date.parse(record.startedAt)), "startedAt must be an ISO timestamp");
  // Derived creation time: it must sit near this process's actual start, not at "now".
  assert.ok(Math.abs(record.procStart - (Date.now() - process.uptime() * 1000)) < 60_000);
  assert.ok(record.procStart < Date.now());
  // The anchor is the OS start time as an exact decimal string, and it equals what acquire reported.
  assert.equal(typeof record.procStartTicks, "string");
  assert.equal(record.procStartTicks, epoch.procStartTicks);
  assert.equal(record.procStartTicks, liveTicks(), "the record must carry this process's real OS start ticks");
  // One durable file per instance, no leftover temporary file from the temp-file + rename write.
  assert.deepEqual(recordFiles(dir), [hostEpochFileName(INSTANCE)]);

  await epoch.release();
});

test("prove: the running host proves alive/process-matches (the OS start-time query returned a value)", async () => {
  const dir = tempDir();
  const epoch = await acquireHostEpoch({ dir, hostInstanceId: INSTANCE });

  const proof = await proveEpochFor({ dir, hostInstanceId: INSTANCE });
  assert.equal(proof.verdict, VERDICT.ALIVE, `expected a live verdict, got ${JSON.stringify(proof)}`);
  assert.equal(proof.reason, REASON.PROCESS_MATCHES);
  assert.equal(proof.previous.epochId, epoch.epochId);
  assert.equal(proof.previous.hostInstanceId, INSTANCE);
  assert.equal(proof.previous.pid, process.pid);
  assert.equal(proof.previous.procStart, epoch.procStart);
  assert.equal(proof.previous.procStartTicks, epoch.procStartTicks);

  await epoch.release();
});

// ---------------------------------------------------------------------------
// (f) OS-tick anchor: the identity verdict has no wall-clock input
// ---------------------------------------------------------------------------

test("prove: stored OS ticks that match the live pid are alive/process-matches", async () => {
  const dir = tempDir();
  const epoch = await acquireHostEpoch({ dir, hostInstanceId: INSTANCE });
  const ticks = liveTicks();
  assert.equal(epoch.procStartTicks, ticks);

  // The wall-clock procStart is wrong on purpose (a stepped clock, as far as anyone could tell), so
  // an alive verdict can only have come from comparing OS ticks with OS ticks.
  writeRecord(dir, {
    epochId: "ticks-match",
    hostInstanceId: INSTANCE,
    pid: process.pid,
    procStart: 1,
    procStartTicks: ticks,
    startedAt: "2000-01-01T00:00:00.000Z",
  });

  const proof = await proveEpochFor({ dir, hostInstanceId: INSTANCE });
  assert.equal(proof.verdict, VERDICT.ALIVE);
  assert.equal(proof.reason, REASON.PROCESS_MATCHES);
  assert.equal(proof.previous.epochId, "ticks-match");
  assert.equal(proof.previous.procStartTicks, ticks);
  assert.equal(proof.previous.procStart, 1, "the debug wall-clock field is reported as stored, not used");
});

test("prove: stored OS ticks that do not match the live pid are dead/pid-reused", async () => {
  const dir = tempDir();
  // The other direction from the wall-clock test above: ticks an hour AFTER this process started.
  const futureTicks = ticksOffset(3_600_000);
  writeRecord(dir, liveRecord({ procStartTicks: futureTicks }));

  const proof = await proveEpochFor({ dir, hostInstanceId: INSTANCE });
  assert.equal(proof.verdict, VERDICT.DEAD);
  assert.equal(proof.reason, REASON.PID_REUSED);
  assert.equal(proof.previous.procStartTicks, futureTicks);
});

test("prove: a record with procStartTicks null and a live pid is unknown/anchor-missing, never dead", async () => {
  const dir = tempDir();
  // What acquire stores when the OS query fails: no anchor, so a live pid cannot be identified.
  writeRecord(dir, liveRecord({ procStartTicks: null }));

  const proof = await proveEpochFor({ dir, hostInstanceId: INSTANCE });
  assert.equal(proof.verdict, VERDICT.UNKNOWN);
  assert.equal(proof.reason, REASON.ANCHOR_MISSING);
  assert.notEqual(proof.verdict, VERDICT.DEAD, "an unverifiable live pid must never be reported as dead");
  assert.equal(proof.previous.pid, process.pid);
  assert.equal(proof.previous.procStartTicks, null);

  // An unverifiable own record still refuses acquisition without an explicit takeover.
  const attempt = await acquireHostEpoch({ dir, hostInstanceId: INSTANCE });
  assert.equal(attempt.refused, true);
  assert.equal(attempt.previous.reason, REASON.ANCHOR_MISSING);
});

test("prove: a record with no anchor and a gone pid is dead/process-gone (existence is clock-independent)", async () => {
  const dir = tempDir();
  // The pid probe runs BEFORE the anchor check: a pid that does not exist is definitively gone, and
  // establishing that needs no clock. This is what lets a record written before ticks existed
  // unblock the next host instead of forcing an explicit takeover.
  writeRecord(dir, liveRecord({ pid: 2147483647, procStartTicks: null }));

  const proof = await proveEpochFor({ dir, hostInstanceId: INSTANCE });
  assert.equal(proof.verdict, VERDICT.DEAD);
  assert.equal(proof.reason, REASON.PROCESS_GONE);
  assert.equal(proof.previous.pid, 2147483647);
  assert.equal(proof.previous.procStartTicks, null);

  // A previous host proven dead needs no takeover: the epoch is acquired in one call.
  const epoch = await acquireHostEpoch({ dir, hostInstanceId: INSTANCE });
  assert.equal(epoch.refused, undefined, `acquisition must not be refused: ${JSON.stringify(epoch)}`);
  assert.notEqual(epoch.epochId, "fixture-epoch-live");
  assert.equal(readRecord(dir).epochId, epoch.epochId);
  await epoch.release();
});

test("prove: a legacy record with only wall-clock procStart is unknown live, dead gone", async () => {
  const dir = tempDir();
  const legacy = {
    epochId: "legacy",
    hostInstanceId: INSTANCE,
    pid: process.pid,
    procStart: Math.round(Date.now() - process.uptime() * 1000),
    startedAt: new Date().toISOString(),
  };
  assert.equal("procStartTicks" in legacy, false);
  // Even though this wall-clock value happens to describe the right process, it is not an anchor:
  // the module must not fall back to comparing it (that fallback is the defect being removed).
  writeRecord(dir, legacy);

  const proof = await proveEpochFor({ dir, hostInstanceId: INSTANCE });
  assert.equal(proof.verdict, VERDICT.UNKNOWN);
  assert.equal(proof.reason, REASON.ANCHOR_MISSING);
  assert.equal(proof.previous.epochId, "legacy");
  assert.equal(proof.previous.procStartTicks, null);

  const attempt = await acquireHostEpoch({ dir, hostInstanceId: INSTANCE });
  assert.equal(attempt.refused, true);
  assert.equal(attempt.previous.verdict, VERDICT.UNKNOWN);

  // The same legacy shape with a pid that is provably gone: the missing anchor decides identity
  // only, so the record is dead and the next host acquires without a takeover.
  writeRecord(dir, { ...legacy, pid: 2147483647 });
  const gone = await proveEpochFor({ dir, hostInstanceId: INSTANCE });
  assert.equal(gone.verdict, VERDICT.DEAD);
  assert.equal(gone.reason, REASON.PROCESS_GONE);
  assert.equal(gone.previous.epochId, "legacy");

  const epoch = await acquireHostEpoch({ dir, hostInstanceId: INSTANCE });
  assert.equal(epoch.refused, undefined, `acquisition must not be refused: ${JSON.stringify(epoch)}`);
  assert.equal(readRecord(dir).epochId, epoch.epochId);
  await epoch.release();
});

test("record: procStartTicks is an exact decimal string and survives a JSON round-trip unchanged", async () => {
  const dir = tempDir();
  const epoch = await acquireHostEpoch({ dir, hostInstanceId: INSTANCE });
  const text = readFileSync(epochPath(dir), "utf8");
  const parsed = JSON.parse(text);

  // .NET ticks are ~6.39e17 in 2026 (18 digits) and exceed Number.MAX_SAFE_INTEGER, so as a JSON
  // number the value would be rounded on the way out or back in.
  assert.equal(typeof parsed.procStartTicks, "string");
  assert.match(parsed.procStartTicks, /^\d{18}$/);
  assert.ok(BigInt(parsed.procStartTicks) > BigInt(Number.MAX_SAFE_INTEGER));
  assert.ok(text.includes(`"procStartTicks": "${parsed.procStartTicks}"`), "the file must hold the exact digits");
  assert.equal(parsed.procStartTicks, epoch.procStartTicks);
  assert.equal(JSON.parse(JSON.stringify(parsed)).procStartTicks, parsed.procStartTicks);

  // A value whose tail a double cannot represent: as a JSON number those digits would be rounded
  // away, so a string anchor is what keeps the comparison exact.
  const unrepresentable = "639000000000000123";
  assert.notEqual(String(Number(unrepresentable)), unrepresentable);
  writeRecord(dir, liveRecord({ epochId: "exact-ticks", procStartTicks: unrepresentable }));
  assert.equal(readRecord(dir).procStartTicks, unrepresentable);
});

test("contract: acquire and prove reject a missing dir, a missing instance, or an unsafe instance token", async () => {
  await assert.rejects(acquireHostEpoch(), /dir/);
  await assert.rejects(acquireHostEpoch({ dir: "" }), /dir/);
  await assert.rejects(acquireHostEpoch({ dir: 42 }), /dir/);
  await assert.rejects(proveEpochFor(), /dir/);
  await assert.rejects(proveEpochFor({ dir: "" }), /dir/);

  // The instance token becomes a FILE NAME, so a token that is not one safe path segment must be
  // rejected instead of being sanitized into some other path.
  await assert.rejects(proveEpochFor({ dir: tempDir() }), /hostInstanceId/);
  await assert.rejects(acquireHostEpoch({ dir: tempDir() }), /hostInstanceId/);
  for (const bad of ["", "..", "../escape", "a/b", "a\\b", ".hidden", "-x", 42, null, {}]) {
    await assert.rejects(proveEpochFor({ dir: tempDir(), hostInstanceId: bad }), /hostInstanceId/,
      `hostInstanceId=${JSON.stringify(bad)}`);
  }
});

// ---------------------------------------------------------------------------
// (g) RECOVERY SAFETY — the proof belongs to ONE record owner
// ---------------------------------------------------------------------------

test("regression: an absent record for an unknown instance is unknown/epoch-unknown, never dead", async () => {
  const dir = tempDir();
  // Another instance has a live record here; that is not evidence about THIS instance either.
  writeRecord(dir, liveRecord());

  const proof = await proveEpochFor({ dir, hostInstanceId: "dsh-wiki.instance-without-a-record" });
  assert.equal(proof.verdict, VERDICT.UNKNOWN);
  assert.equal(proof.reason, REASON.EPOCH_UNKNOWN);
  assert.equal(proof.previous, null);
  assert.notEqual(proof.verdict, VERDICT.DEAD, "no record for an instance is not proof that it died");
  // And the existing record was not touched by asking.
  assert.deepEqual(recordFiles(dir), [hostEpochFileName(INSTANCE)]);
});

test("regression: a dead record for instance A does NOT make instance B stopped (the exact defect)", async () => {
  const dir = tempDir();
  // A's record proves A's process gone. Under the old wiring this single dead verdict was applied to
  // every foreign journal record, so B - which has no record at all - would have been reported
  // stopped. Death of A says nothing about B.
  writeRecord(dir, liveRecord({ hostInstanceId: "dsh-wiki.instance-a", pid: 2147483647, epochId: "epoch-a" }));

  const a = await proveEpochFor({ dir, hostInstanceId: "dsh-wiki.instance-a" });
  assert.equal(a.verdict, VERDICT.DEAD);
  assert.equal(a.reason, REASON.PROCESS_GONE);

  const b = await proveEpochFor({ dir, hostInstanceId: "dsh-wiki.instance-b" });
  assert.equal(b.verdict, VERDICT.UNKNOWN, `A's death must not be attributed to B: ${JSON.stringify(b)}`);
  assert.equal(b.reason, REASON.EPOCH_UNKNOWN);
  assert.notEqual(b.verdict, VERDICT.DEAD);
});

test("regression: A dead and B alive are reported independently from the same directory", async () => {
  const dir = tempDir();
  writeRecord(dir, liveRecord({ hostInstanceId: "dsh-wiki.instance-a", pid: 2147483647, epochId: "epoch-a" }));
  writeRecord(dir, liveRecord({ hostInstanceId: "dsh-wiki.instance-b", epochId: "epoch-b" }));

  const a = await proveEpochFor({ dir, hostInstanceId: "dsh-wiki.instance-a" });
  const b = await proveEpochFor({ dir, hostInstanceId: "dsh-wiki.instance-b" });

  assert.equal(a.verdict, VERDICT.DEAD);
  assert.equal(a.reason, REASON.PROCESS_GONE);
  assert.equal(a.previous.epochId, "epoch-a");
  assert.equal(b.verdict, VERDICT.ALIVE);
  assert.equal(b.reason, REASON.PROCESS_MATCHES);
  assert.equal(b.previous.epochId, "epoch-b");
  // Proving A again must not have changed anything: the verdicts are per record, not cached.
  assert.equal((await proveEpochFor({ dir, hostInstanceId: "dsh-wiki.instance-a" })).verdict, VERDICT.DEAD);
  assert.equal((await proveEpochFor({ dir, hostInstanceId: "dsh-wiki.instance-b" })).verdict, VERDICT.ALIVE);
});

test("records: two instances' records coexist without clobbering each other", async () => {
  const dir = tempDir();
  const instanceA = "dsh-wiki.instance-a";
  const instanceB = "dsh-wiki.instance-b";

  const a = await acquireHostEpoch({ dir, hostInstanceId: instanceA });
  // B acquires while A's record is live: different file, so this must NOT be refused.
  const b = await acquireHostEpoch({ dir, hostInstanceId: instanceB, takeover: false });
  assert.equal(b.refused, undefined, `a second instance must not be blocked by another instance's record: ${JSON.stringify(b)}`);
  assert.notEqual(a.epochId, b.epochId);

  assert.deepEqual(recordFiles(dir), [hostEpochFileName(instanceA), hostEpochFileName(instanceB)].sort());
  assert.equal(readRecord(dir, instanceA).hostInstanceId, instanceA);
  assert.equal(readRecord(dir, instanceB).hostInstanceId, instanceB);
  assert.equal(readRecord(dir, instanceA).epochId, a.epochId);
  assert.equal(readRecord(dir, instanceB).epochId, b.epochId);

  // Releasing A leaves B's record untouched and provable.
  assert.equal(await a.release(), true);
  assert.deepEqual(recordFiles(dir), [hostEpochFileName(instanceB)]);
  assert.equal((await proveEpochFor({ dir, hostInstanceId: instanceA })).verdict, VERDICT.UNKNOWN);
  const bProof = await proveEpochFor({ dir, hostInstanceId: instanceB });
  assert.equal(bProof.verdict, VERDICT.ALIVE);
  assert.equal(bProof.previous.epochId, b.epochId);

  assert.equal(await b.release(), true);
});
