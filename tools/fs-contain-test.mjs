// dsh-wiki — offline adversarial tests for lib/fs-contain.js.
//
// Drives the dormant containment primitives directly: no DSH Host, no network, no live wiki. Real
// temporary fixtures are used, including Windows junctions and hardlinks where the platform allows
// them. Every denial is checked for its typed code and for the absence of fixture mutation.
//
// Run with:
//   node --test plugins/dsh-wiki/tools/fs-contain-test.mjs
import assert from "node:assert/strict";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { lstat, opendir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { pathToFileURL } from "node:url";

const here = import.meta.dirname;
const moduleUrl = pathToFileURL(path.join(here, "..", "lib", "fs-contain.js")).href;
const {
  DEFAULT_LIMITS,
  ERROR_CODES,
  FsContainError,
  assertCanonicalDir,
  identityOf,
  verifySame,
  scanTree,
  guardedRename,
} = await import(moduleUrl);

const isWin = process.platform === "win32";
const realpathNative = (target) =>
  typeof realpathSync.native === "function" ? realpathSync.native(target) : realpathSync(target);

const samePathTest = (a, b) => {
  const normalize = (value) => {
    const resolved = path.normalize(value);
    const root = path.parse(resolved).root;
    const trimmed = resolved.length > root.length ? resolved.replace(/[\\/]+$/, "") : resolved;
    return isWin ? trimmed.toLowerCase() : trimmed;
  };
  return normalize(a) === normalize(b);
};

let base;
let fixtureCounter = 0;

before(() => {
  base = realpathNative(mkdtempSync(path.join(tmpdir(), "dsh-wiki-fs-contain-")));
});

after(() => {
  rmSync(base, { recursive: true, force: true });
});

function fixture(name) {
  fixtureCounter += 1;
  const directory = path.join(base, `${String(fixtureCounter).padStart(2, "0")}-${name}`);
  mkdirSync(directory, { recursive: true });
  return directory;
}

function makeDir(parent, name) {
  const directory = path.join(parent, name);
  mkdirSync(directory);
  return directory;
}

function makeFile(parent, name, content = "x") {
  const file = path.join(parent, name);
  writeFileSync(file, content);
  return file;
}

function makeDirLink(linkPath, targetPath) {
  try {
    symlinkSync(targetPath, linkPath, isWin ? "junction" : "dir");
    return true;
  } catch {
    return false;
  }
}

function snapshot(root) {
  const output = [];
  const walk = (directory, prefix) => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const relative = prefix.length === 0 ? name : `${prefix}/${name}`;
      const stats = lstatSync(absolute);
      if (stats.isSymbolicLink()) {
        let target = null;
        try {
          target = readlinkSync(absolute);
        } catch {
          target = null;
        }
        output.push({ path: relative, kind: "link", target });
      } else if (stats.isDirectory()) {
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

async function assertCode(fn, code, label) {
  let error;
  try {
    await fn();
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, `${label}: expected ${code}, but the call succeeded`);
  assert.ok(
    error instanceof FsContainError,
    `${label}: expected FsContainError, got ${error?.name ?? typeof error}: ${error?.message ?? error}`,
  );
  assert.equal(error.code, code, `${label}: expected ${code}, got ${error.code} (${error.message})`);
  return error;
}

/**
 * A scripted streaming directory handle. `state.pulled` counts names actually yielded and
 * `state.closed` counts close() calls, so a test can prove the scan stops early and never leaks the
 * handle. `options.failAt` makes the (0-based) pull throw an `EIO` Error instead of yielding;
 * `options.rejectNextAt`/`options.rejectNextValue` make the pull reject with an arbitrary value
 * (found by `Object.hasOwn`, so `undefined` is a deliberate rejection rather than "absent"), and
 * `options.rejectCloseValue` makes close() reject with that arbitrary value.
 */
function scriptedListing(values, options = {}) {
  const state = { pulled: 0, closed: 0, returns: 0 };
  const handle = {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next() {
          if (options.failAt === index) {
            const error = new Error("listing failed");
            error.code = "EIO";
            throw error;
          }
          if (Object.hasOwn(options, "rejectNextAt") && options.rejectNextAt === index) {
            throw options.rejectNextValue;
          }
          if (index >= values.length) return { done: true, value: undefined };
          const value = values[index];
          index += 1;
          state.pulled += 1;
          return { done: false, value };
        },
        async return() {
          state.returns += 1;
          return { done: true, value: undefined };
        },
      };
    },
    async close() {
      state.closed += 1;
      if (options.failClose) {
        const error = new Error("close failed");
        error.code = "EIO";
        throw error;
      }
      if (Object.hasOwn(options, "rejectCloseValue")) throw options.rejectCloseValue;
    },
  };
  return { handle, state };
}

/** Wrap real `opendir` handles to count names pulled and how many handles are open at once. */
function countingOpendir(counter) {
  return async (target) => {
    const handle = await opendir(target);
    counter.opened += 1;
    counter.open += 1;
    counter.maxOpen = Math.max(counter.maxOpen, counter.open);
    const inner = handle[Symbol.asyncIterator]();
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      async next() {
        const result = await inner.next();
        if (!result.done) counter.pulled += 1;
        return result;
      },
      async close() {
        counter.closed += 1;
        if (counter.open > 0) counter.open -= 1;
        try {
          await handle.close();
        } catch (error) {
          // Node's Dir is already closed once its iterator was fully consumed.
          if (error?.code !== "ERR_DIR_CLOSED") throw error;
        }
      },
    };
  };
}

async function renameExpectations(src, srcParent, destParent) {
  return {
    src: await identityOf(src),
    srcParent: (await assertCanonicalDir(srcParent)).identity,
    destParent: (await assertCanonicalDir(destParent)).identity,
  };
}

// ---------- assertCanonicalDir ----------

test("assertCanonicalDir accepts a real directory and returns a serializable identity", async () => {
  const directory = fixture("canonical");
  const nested = path.join(directory, "a", "b");
  mkdirSync(nested, { recursive: true });

  const result = await assertCanonicalDir(`${nested}${path.sep}`);
  assert.equal(result.path, realpathNative(nested));
  assert.equal(result.root, path.parse(result.path).root);
  assert.equal(result.identity.kind, "dir");
  assert.match(result.identity.dev, /^(0|[1-9][0-9]*)$/);
  assert.match(result.identity.ino, /^(0|[1-9][0-9]*)$/);
  assert.match(result.identity.nlink, /^(0|[1-9][0-9]*)$/);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);

  const root = path.parse(nested).root;
  const rootResult = await assertCanonicalDir(root);
  assert.equal(rootResult.path, realpathNative(root));
  assert.equal(rootResult.identity.kind, "dir");
});

test("assertCanonicalDir accepts Windows case variants and returns on-disk casing", { skip: !isWin }, async () => {
  const directory = fixture("case");
  const result = await assertCanonicalDir(directory.toUpperCase());
  assert.equal(result.path, realpathNative(directory));
});

test("assertCanonicalDir rejects malformed path shapes before filesystem access", async () => {
  const directory = fixture("shape");
  const separator = path.sep;

  await assertCode(
    () => assertCanonicalDir("relative/path"),
    ERROR_CODES.PATH_NOT_ABSOLUTE,
    "relative path",
  );
  await assertCode(
    () => assertCanonicalDir(`${directory}${separator}..${separator}escape`),
    ERROR_CODES.MALFORMED_PATH,
    "traversal",
  );
  await assertCode(
    () => assertCanonicalDir(`${directory}${separator}.${separator}child`),
    ERROR_CODES.MALFORMED_PATH,
    "dot segment",
  );
  await assertCode(
    () => assertCanonicalDir(`${directory}\u0000x`),
    ERROR_CODES.MALFORMED_PATH,
    "NUL",
  );
  await assertCode(
    () => assertCanonicalDir(`${directory}${separator}${"x".repeat(DEFAULT_LIMITS.maxPathLength)}`),
    ERROR_CODES.MALFORMED_PATH,
    "overlong",
  );
  await assertCode(
    () => assertCanonicalDir(`${directory}${separator}a\u0001b`),
    ERROR_CODES.MALFORMED_PATH,
    "control character",
  );

  if (isWin) {
    await assertCode(
      () => assertCanonicalDir("\\\\server\\share"),
      ERROR_CODES.MALFORMED_PATH,
      "UNC",
    );
    await assertCode(
      () => assertCanonicalDir(`\\\\?\\${directory}`),
      ERROR_CODES.MALFORMED_PATH,
      "device path",
    );
    await assertCode(
      () => assertCanonicalDir(`\\\\.\\pipe\\dsh-wiki`),
      ERROR_CODES.MALFORMED_PATH,
      "device namespace",
    );
    await assertCode(
      () => assertCanonicalDir(`${directory}${separator}name:stream`),
      ERROR_CODES.MALFORMED_PATH,
      "ADS",
    );
    for (const name of ["CON", "NUL", "COM1", "LPT9", "CONIN$", "CONOUT$"]) {
      await assertCode(
        () => assertCanonicalDir(`${directory}${separator}${name}`),
        ERROR_CODES.MALFORMED_PATH,
        `reserved device name ${name}`,
      );
    }
    await assertCode(
      () => assertCanonicalDir(`${directory}${separator}name.`),
      ERROR_CODES.MALFORMED_PATH,
      "trailing dot",
    );
    await assertCode(
      () => assertCanonicalDir(`${directory}${separator}name `),
      ERROR_CODES.MALFORMED_PATH,
      "trailing space",
    );
    for (const character of ["<", ">", '"', "|", "?", "*"]) {
      await assertCode(
        () => assertCanonicalDir(`${directory}${separator}a${character}b`),
        ERROR_CODES.MALFORMED_PATH,
        `reserved character ${character}`,
      );
    }
    await assertCode(
      () => assertCanonicalDir(`\\foo`),
      ERROR_CODES.PATH_NOT_ABSOLUTE,
      "root-relative without drive",
    );
  } else {
    await assertCode(
      () => assertCanonicalDir("//server/share"),
      ERROR_CODES.MALFORMED_PATH,
      "UNC-like POSIX path",
    );
  }
});

test("assertCanonicalDir rejects missing, file, non-directory ancestor and linked targets", async (t) => {
  const directory = fixture("targets");
  await assertCode(
    () => assertCanonicalDir(path.join(directory, "missing")),
    ERROR_CODES.PATH_NOT_FOUND,
    "missing directory",
  );

  const filePath = makeFile(directory, "file.txt");
  await assertCode(
    () => assertCanonicalDir(filePath),
    ERROR_CODES.PATH_NOT_DIRECTORY,
    "file target",
  );
  await assertCode(
    () => assertCanonicalDir(path.join(filePath, "child")),
    ERROR_CODES.ANCESTOR_NOT_DIRECTORY,
    "file ancestor",
  );

  const outside = makeDir(directory, "outside");
  makeFile(outside, "inside.txt", "outside");
  const link = path.join(directory, "link");
  if (!makeDirLink(link, outside)) {
    t.skip("directory links are not supported on this filesystem");
    return;
  }
  const before = snapshot(directory);
  await assertCode(
    () => assertCanonicalDir(link),
    ERROR_CODES.PATH_LINK,
    "link target",
  );
  await assertCode(
    () => assertCanonicalDir(path.join(link, "inside.txt")),
    ERROR_CODES.ANCESTOR_LINK,
    "link ancestor",
  );
  assert.deepEqual(snapshot(directory), before);
});

// ---------- identityOf / verifySame ----------

test("identityOf normalizes bigint dev/ino/nlink into serializable strings", async () => {
  const directory = fixture("identity");
  const first = makeFile(directory, "first.txt", "first");
  const second = makeFile(directory, "second.txt", "second");

  const firstId = await identityOf(first);
  const secondId = await identityOf(second);
  assert.equal(firstId.kind, "file");
  assert.equal(firstId.nlink, "1");
  assert.match(firstId.dev, /^(0|[1-9][0-9]*)$/);
  assert.match(firstId.ino, /^(0|[1-9][0-9]*)$/);
  assert.deepEqual(await identityOf(first), firstId);
  assert.notDeepEqual(firstId, secondId);
  assert.deepEqual(JSON.parse(JSON.stringify(firstId)), firstId);
  assert.deepEqual(await verifySame(first, firstId), firstId);
  assert.deepEqual(
    await verifySame(first, {
      dev: BigInt(firstId.dev),
      ino: BigInt(firstId.ino),
      kind: firstId.kind,
    }),
    firstId,
  );

  const directoryId = await identityOf(directory);
  assert.equal(directoryId.kind, "dir");
  await assertCode(
    () => identityOf(path.join(directory, "missing.txt")),
    ERROR_CODES.PATH_NOT_FOUND,
    "identity of missing target",
  );
});

test("identityOf accepts injected bigint stats and rejects links", async (t) => {
  const targetPath = isWin ? "C:\\fake\\file" : "/fake/file";
  const rootPath = path.parse(targetPath).root;
  const parentPath = path.dirname(targetPath);
  const directoryStats = {
    dev: 10n,
    ino: 20n,
    nlink: 1n,
    isSymbolicLink: () => false,
    isDirectory: () => true,
    isFile: () => false,
  };
  const fileStats = {
    dev: 10n,
    ino: 30n,
    nlink: 2n,
    isSymbolicLink: () => false,
    isDirectory: () => false,
    isFile: () => true,
  };
  const io = {
    lstat: async (target) =>
      samePathTest(target, rootPath) || samePathTest(target, parentPath) ? directoryStats : fileStats,
    realpath: async (target) => target,
  };
  const identity = await identityOf(targetPath, { io });
  assert.deepEqual(identity, { dev: "10", ino: "30", kind: "file", nlink: "2" });

  const directory = fixture("identity-link");
  const target = makeDir(directory, "target");
  const link = path.join(directory, "link");
  if (!makeDirLink(link, target)) {
    t.skip("directory links are not supported on this filesystem");
    return;
  }
  const before = snapshot(directory);
  await assertCode(
    () => identityOf(link),
    ERROR_CODES.PATH_LINK,
    "identity of link",
  );
  assert.deepEqual(snapshot(directory), before);
});

test("verifySame rejects identity drift, kind drift, missing targets and invalid expectations", async () => {
  const directory = fixture("verify");
  const filePath = makeFile(directory, "file.txt", "content");
  const identity = await identityOf(filePath);
  const changedInode = (BigInt(identity.ino) + 1n).toString();

  await assertCode(
    () => verifySame(filePath, { ...identity, ino: changedInode }),
    ERROR_CODES.IDENTITY_MISMATCH,
    "inode drift",
  );
  await assertCode(
    () => verifySame(filePath, { ...identity, kind: "dir" }),
    ERROR_CODES.KIND_MISMATCH,
    "kind drift",
  );
  await assertCode(
    () => verifySame(path.join(directory, "missing.txt"), identity),
    ERROR_CODES.PATH_NOT_FOUND,
    "missing target",
  );
  await assertCode(
    () => verifySame(filePath, { dev: identity.dev, ino: identity.ino }),
    ERROR_CODES.IDENTITY_INVALID,
    "missing kind",
  );
  await assertCode(
    () => verifySame(filePath, { dev: identity.dev, ino: identity.ino, kind: "link" }),
    ERROR_CODES.IDENTITY_INVALID,
    "link kind",
  );

  const before = snapshot(directory);
  assert.deepEqual(snapshot(directory), before);
});

test("verifySame rejects a link even when the expected identity is its target", async (t) => {
  const directory = fixture("verify-link");
  const target = makeDir(directory, "target");
  const link = path.join(directory, "link");
  if (!makeDirLink(link, target)) {
    t.skip("directory links are not supported on this filesystem");
    return;
  }
  const targetId = await identityOf(target);
  await assertCode(
    () => verifySame(link, targetId),
    ERROR_CODES.PATH_LINK,
    "verify link",
  );
});

// ---------- scanTree ----------

test("scanTree returns a deterministic sorted inventory without mutating the tree", async () => {
  const root = fixture("scan-ok");
  makeFile(root, "a.txt", "A");
  const sub = makeDir(root, "sub");
  makeFile(sub, "b.md", "B");
  makeDir(root, "empty");

  const before = snapshot(root);
  const first = await scanTree(root);
  const second = await scanTree(root);

  assert.deepEqual(second, first);
  assert.equal(first.root, realpathNative(root));
  assert.equal(first.rootIdentity.kind, "dir");
  assert.deepEqual(first.rootIdentity, await identityOf(root));
  assert.equal(first.entryCount, 4);
  assert.equal(first.fileCount, 2);
  assert.equal(first.dirCount, 2);
  assert.deepEqual(
    first.entries.map((entry) => entry.path),
    ["a.txt", "empty", "sub", "sub/b.md"],
  );
  assert.deepEqual(
    first.entries.map((entry) => entry.kind),
    ["file", "dir", "dir", "file"],
  );
  assert.ok(first.entries.every((entry) => /^(0|[1-9][0-9]*)$/.test(entry.identity.ino)));
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first);
  assert.deepEqual(snapshot(root), before);
});

test("scanTree rejects symlink/junction entries and linked roots", async (t) => {
  const root = fixture("scan-link");
  const outside = makeDir(root, "outside");
  makeFile(outside, "secret.txt", "secret");
  const link = path.join(root, "link");
  if (!makeDirLink(link, outside)) {
    t.skip("directory links are not supported on this filesystem");
    return;
  }
  const before = snapshot(root);
  await assertCode(
    () => scanTree(root),
    ERROR_CODES.SCAN_LINK,
    "scan link entry",
  );
  await assertCode(
    () => scanTree(link),
    ERROR_CODES.PATH_LINK,
    "scan link root",
  );
  assert.deepEqual(snapshot(root), before);
});

test("scanTree rejects hardlinked regular files", async (t) => {
  const root = fixture("scan-hardlink");
  const original = makeFile(root, "a.txt", "A");
  const hard = path.join(root, "b.txt");
  try {
    linkSync(original, hard);
  } catch {
    t.skip("hardlinks are not supported on this filesystem");
    return;
  }
  const before = snapshot(root);
  await assertCode(
    () => scanTree(root),
    ERROR_CODES.SCAN_HARDLINK,
    "scan hardlink",
  );
  assert.deepEqual(snapshot(root), before);
});

test("scanTree fails closed on non-regular entries and every read error", async () => {
  const root = fixture("scan-errors");
  const regular = makeFile(root, "regular.txt", "R");
  const special = makeFile(root, "special.bin", "S");

  const specialStats = {
    dev: 1n,
    ino: 99n,
    nlink: 1n,
    isSymbolicLink: () => false,
    isDirectory: () => false,
    isFile: () => false,
  };
  const specialIo = {
    lstat: async (target) => (samePathTest(target, special) ? specialStats : lstat(target, { bigint: true })),
  };
  await assertCode(
    () => scanTree(root, { io: specialIo }),
    ERROR_CODES.SCAN_NONREGULAR,
    "scan non-regular",
  );

  const before = snapshot(root);
  const deniedLstat = {
    lstat: async (target) => {
      if (samePathTest(target, regular)) {
        const error = new Error("denied");
        error.code = "EACCES";
        throw error;
      }
      return lstat(target, { bigint: true });
    },
  };
  await assertCode(
    () => scanTree(root, { io: deniedLstat }),
    ERROR_CODES.SCAN_UNREADABLE,
    "scan lstat error",
  );

  const deniedListing = {
    opendir: async (target) => {
      if (samePathTest(target, root)) {
        const error = new Error("denied");
        error.code = "EACCES";
        throw error;
      }
      return opendir(target);
    },
  };
  await assertCode(
    () => scanTree(root, { io: deniedListing }),
    ERROR_CODES.SCAN_UNREADABLE,
    "scan listing error",
  );

  const malformedEntryName = {
    opendir: async (target) =>
      samePathTest(target, root) ? scriptedListing(["bad\nname"]).handle : opendir(target),
  };
  await assertCode(
    () => scanTree(root, { io: malformedEntryName }),
    ERROR_CODES.SCAN_UNREADABLE,
    "scan malformed entry name",
  );

  const redirectedRealpath = {
    realpath: async (target) =>
      samePathTest(target, regular) ? `${target}-redirected` : realpathNative(target),
  };
  await assertCode(
    () => scanTree(root, { io: redirectedRealpath }),
    ERROR_CODES.SCAN_NOT_CANONICAL,
    "scan redirected entry",
  );

  const deniedRealpath = {
    realpath: async (target) => {
      if (samePathTest(target, regular)) {
        const error = new Error("denied");
        error.code = "EACCES";
        throw error;
      }
      return realpathNative(target);
    },
  };
  await assertCode(
    () => scanTree(root, { io: deniedRealpath }),
    ERROR_CODES.SCAN_UNREADABLE,
    "scan realpath error",
  );
  assert.deepEqual(snapshot(root), before);
});

test("scanTree enforces entry and depth bounds fail-closed", async () => {
  const root = fixture("scan-bounds");
  makeFile(root, "a.txt");
  makeFile(root, "b.txt");
  makeFile(root, "c.txt");
  await assertCode(
    () => scanTree(root, { limits: { maxScanEntries: 2 } }),
    ERROR_CODES.SCAN_LIMIT,
    "entry bound",
  );

  const nested = fixture("scan-depth");
  const sub = makeDir(nested, "sub");
  const deep = makeDir(sub, "deep");
  makeFile(deep, "f.txt");
  await assertCode(
    () => scanTree(nested, { limits: { maxScanDepth: 1 } }),
    ERROR_CODES.SCAN_LIMIT,
    "depth bound",
  );

  const longRoot = fixture("scan-long");
  const longName = "x".repeat(DEFAULT_LIMITS.maxPathLength);
  const longEntry = {
    opendir: async (target) =>
      samePathTest(target, longRoot) ? scriptedListing([longName]).handle : opendir(target),
  };
  await assertCode(
    () => scanTree(longRoot, { io: longEntry }),
    ERROR_CODES.SCAN_LIMIT,
    "entry path bound",
  );
});

// ---------- scanTree streaming ----------

test("scanTree streams listings and stops as soon as the entry bound is exceeded", async () => {
  const root = fixture("scan-stream");
  makeFile(root, "real.txt");
  // 10000 scripted names: a full listing would be 10000 pulls, everything above 2 is unbounded work.
  const synthetic = Array.from({ length: 10000 }, (_, index) => `entry-${index}.txt`);
  const listing = scriptedListing(synthetic);
  let nextIno = 100n;
  const syntheticStats = (ino) => ({
    dev: 2n,
    ino,
    nlink: 1n,
    isSymbolicLink: () => false,
    isDirectory: () => false,
    isFile: () => true,
  });
  const io = {
    lstat: async (target) => {
      // Only direct children of the scan root are synthetic; ancestors must stay real directories.
      if (samePathTest(target, root) || !samePathTest(path.dirname(target), root)) {
        return lstat(target, { bigint: true });
      }
      const ino = nextIno;
      nextIno += 1n;
      return syntheticStats(ino);
    },
    realpath: async (target) => target,
    opendir: async (target) => (samePathTest(target, root) ? listing.handle : opendir(target)),
  };

  await assertCode(
    () => scanTree(root, { io, limits: { maxScanEntries: 1 } }),
    ERROR_CODES.SCAN_LIMIT,
    "streamed entry bound",
  );
  assert.ok(
    listing.state.pulled < synthetic.length,
    `a bounded scan must not consume the whole listing (pulled ${listing.state.pulled}/${synthetic.length})`,
  );
  assert.ok(
    listing.state.pulled <= 2,
    `maxScanEntries 1 must read at most 2 names (pulled ${listing.state.pulled})`,
  );
  assert.equal(listing.state.closed, 1, "the listing handle must be closed after the bound refusal");
});

test("scanTree closes the listing handle on iterator, entry and close failures", async () => {
  const root = fixture("scan-stream-errors");
  makeFile(root, "a.txt", "A");
  makeFile(root, "b.txt", "B");
  makeFile(root, "c.txt", "C");
  const scripted = (values, options) => {
    const listing = scriptedListing(values, options);
    return { io: { opendir: async (target) => (samePathTest(target, root) ? listing.handle : opendir(target)) }, listing };
  };

  const failedPull = scripted(["a.txt"], { failAt: 0 });
  await assertCode(
    () => scanTree(root, { io: failedPull.io }),
    ERROR_CODES.SCAN_UNREADABLE,
    "iterator throws",
  );
  assert.equal(failedPull.listing.state.closed, 1, "handle opened before an iterator error must be closed");

  const malformedName = scripted([42]);
  await assertCode(
    () => scanTree(root, { io: malformedName.io }),
    ERROR_CODES.SCAN_UNREADABLE,
    "unexpected entry value",
  );
  assert.equal(malformedName.listing.state.closed, 1, "handle must be closed after an unexpected entry");

  const malformedDirent = scripted([{ name: 7 }]);
  await assertCode(
    () => scanTree(root, { io: malformedDirent.io }),
    ERROR_CODES.SCAN_UNREADABLE,
    "unexpected dirent name",
  );
  assert.equal(malformedDirent.listing.state.closed, 1, "handle must be closed after an unexpected dirent");

  const failedClose = scripted(["a.txt", "b.txt"], { failClose: true });
  await assertCode(
    () => scanTree(root, { io: failedClose.io }),
    ERROR_CODES.SCAN_UNREADABLE,
    "close failure on an otherwise complete listing",
  );
  assert.equal(failedClose.listing.state.closed, 1, "a failing close is still attempted exactly once");

  const boundWithFailedClose = scripted(["a.txt", "b.txt", "c.txt"], { failClose: true });
  await assertCode(
    () => scanTree(root, { io: boundWithFailedClose.io, limits: { maxScanEntries: 1 } }),
    ERROR_CODES.SCAN_LIMIT,
    "close failure must not mask the primary refusal",
  );
  assert.equal(boundWithFailedClose.listing.state.closed, 1, "the refusal path still closes the handle");

  let closedOnlyHandle = 0;
  const closeOnlyHandle = {
    opendir: async (target) =>
      samePathTest(target, root) ? { close: async () => { closedOnlyHandle += 1; } } : opendir(target),
  };
  await assertCode(
    () => scanTree(root, { io: closeOnlyHandle }),
    ERROR_CODES.SCAN_UNREADABLE,
    "handle without an async iterator",
  );
  assert.equal(closedOnlyHandle, 1, "a malformed handle that exposes close() is still closed");
});

test("scanTree refuses arbitrary iterator and close rejection values, including undefined", async () => {
  const root = fixture("scan-reject-values");
  makeFile(root, "a.txt", "A");
  makeFile(root, "b.txt", "B");
  const scripted = (values, options) => {
    const listing = scriptedListing(values, options);
    return {
      io: { opendir: async (target) => (samePathTest(target, root) ? listing.handle : opendir(target)) },
      listing,
    };
  };

  // `undefined` is a legitimate rejection value. Treating it as the "nothing failed" sentinel (the
  // old `let primary;` shape) turned an iterator rejection into an ACCEPTED, truncated inventory.
  for (const value of [undefined, null, false, 0, ""]) {
    const label = `next rejects ${typeof value} ${JSON.stringify(value)}`;
    const failing = scripted(["a.txt"], { rejectNextAt: 1, rejectNextValue: value });
    const error = await assertCode(
      () => scanTree(root, { io: failing.io }),
      ERROR_CODES.SCAN_UNREADABLE,
      `${label}: a partially listed tree must be refused, never accepted`,
    );
    assert.equal(
      error.cause,
      value,
      `${label}: the arbitrary rejection value must be preserved as the refusal cause`,
    );
    assert.equal(failing.listing.state.closed, 1, `${label}: the handle must still be closed`);
  }

  for (const value of [undefined, null, false, 0, ""]) {
    const label = `close rejects ${typeof value} ${JSON.stringify(value)}`;
    const failing = scripted(["a.txt"], { rejectCloseValue: value });
    const error = await assertCode(
      () => scanTree(root, { io: failing.io }),
      ERROR_CODES.SCAN_UNREADABLE,
      `${label}: a fully listed tree whose close fails must be refused`,
    );
    assert.equal(
      error.cause,
      value,
      `${label}: the arbitrary rejection value must be preserved as the refusal cause`,
    );
    assert.equal(failing.listing.state.closed, 1, `${label}: the failing close is still attempted once`);
  }

  // The exact old acceptance path: an empty listing whose very first pull rejects with undefined
  // used to be reported as a successful empty inventory.
  const emptyListingRejects = scripted([], { rejectNextAt: 0, rejectNextValue: undefined });
  await assertCode(
    () => scanTree(root, { io: emptyListingRejects.io }),
    ERROR_CODES.SCAN_UNREADABLE,
    "first pull rejecting undefined must not be accepted as an empty inventory",
  );
  assert.equal(emptyListingRejects.listing.state.closed, 1, "the handle is closed after the refusal");

  // A prior typed refusal is preserved: a close rejecting with undefined must not mask SCAN_LIMIT
  // or downgrade it to acceptance / SCAN_UNREADABLE.
  const boundWithUndefinedClose = scripted(["a.txt", "b.txt"], { rejectCloseValue: undefined });
  await assertCode(
    () => scanTree(root, { io: boundWithUndefinedClose.io, limits: { maxScanEntries: 1 } }),
    ERROR_CODES.SCAN_LIMIT,
    "undefined close rejection must not mask the primary SCAN_LIMIT refusal",
  );
  assert.equal(boundWithUndefinedClose.listing.state.closed, 1, "the refusal path still closes the handle");
  assert.ok(
    boundWithUndefinedClose.listing.state.pulled <= 2,
    `the bounded scan must still stream (pulled ${boundWithUndefinedClose.listing.state.pulled})`,
  );
});

test("scanTree streams a real large fixture and keeps at most one directory handle open", async () => {
  const root = fixture("scan-large");
  const total = 400;
  for (let index = 0; index < total; index += 1) {
    makeFile(root, `file-${String(index).padStart(4, "0")}.txt`, "x");
  }
  const sub = makeDir(root, "sub");
  makeFile(sub, "nested.txt", "nested");

  const counter = { opened: 0, pulled: 0, closed: 0, open: 0, maxOpen: 0 };
  const io = { opendir: countingOpendir(counter) };

  await assertCode(
    () => scanTree(root, { io, limits: { maxScanEntries: 5 } }),
    ERROR_CODES.SCAN_LIMIT,
    "large fixture entry bound",
  );
  assert.ok(counter.pulled <= 6, `maxScanEntries 5 must read at most 6 names (pulled ${counter.pulled})`);
  assert.ok(counter.pulled < total, `bounded scan must not read the whole ${total}-entry listing`);
  assert.equal(counter.closed, 1, "the streamed handle must be closed after the bound refusal");
  assert.equal(counter.open, 0, "no directory handle may stay open after a refusal");

  Object.assign(counter, { opened: 0, pulled: 0, closed: 0, open: 0, maxOpen: 0 });
  const scan = await scanTree(root, { io });
  assert.equal(scan.entryCount, total + 2);
  assert.equal(scan.fileCount, total + 1);
  assert.equal(scan.dirCount, 1);
  const expected = [
    ...Array.from({ length: total }, (_, index) => `file-${String(index).padStart(4, "0")}.txt`),
    "sub",
    "sub/nested.txt",
  ].sort();
  assert.deepEqual(scan.entries.map((entry) => entry.path), expected);
  assert.equal(counter.open, 0, "no directory handle may stay open after a complete scan");
  assert.equal(counter.closed, counter.opened, "every opened handle must be closed");
  assert.ok(counter.maxOpen <= 1, `at most one directory handle may be open (max ${counter.maxOpen})`);
  assert.equal(counter.pulled, total + 2, "a complete scan visits every entry exactly once");
});

test("scanTree rejects non-streaming listings instead of scanning an array", async () => {
  const root = fixture("scan-seam");
  makeFile(root, "a.txt");

  const arrayListing = {
    opendir: async (target) => (samePathTest(target, root) ? ["a.txt", "b.txt"] : opendir(target)),
  };
  await assertCode(
    () => scanTree(root, { io: arrayListing }),
    ERROR_CODES.SCAN_UNREADABLE,
    "array listing",
  );

  const handleWithoutClose = {
    opendir: async (target) =>
      samePathTest(target, root)
        ? {
            [Symbol.asyncIterator]() {
              return this;
            },
            async next() {
              return { done: true, value: undefined };
            },
          }
        : opendir(target),
  };
  await assertCode(
    () => scanTree(root, { io: handleWithoutClose }),
    ERROR_CODES.SCAN_UNREADABLE,
    "handle without close",
  );

  await assertCode(
    () => scanTree(root, { io: { readdir: async () => ["a.txt"] } }),
    ERROR_CODES.INVALID_OPTION,
    "array-returning readdir seam is rejected",
  );

  // The array-returning seam is rejected before any listing is touched: the root listing still
  // goes through the streaming default.
  const scan = await scanTree(root);
  assert.deepEqual(scan.entries.map((entry) => entry.path), ["a.txt"]);
});

test("scanTree closes the streamed handle when an entry is refused", async (t) => {
  const root = fixture("scan-stream-link");
  makeFile(root, "a.txt");
  const outside = makeDir(root, "outside");
  const link = path.join(root, "link");
  if (!makeDirLink(link, outside)) {
    t.skip("directory links are not supported on this filesystem");
    return;
  }
  const counter = { opened: 0, pulled: 0, closed: 0, open: 0, maxOpen: 0 };
  await assertCode(
    () => scanTree(root, { io: { opendir: countingOpendir(counter) } }),
    ERROR_CODES.SCAN_LINK,
    "entry refusal closes its handle",
  );
  assert.equal(counter.open, 0, "the handle must be closed after the entry refusal");
  assert.equal(counter.closed, counter.opened, "every opened handle must be closed");
});

// ---------- guardedRename ----------

test("guardedRename renames a file after binding source and parent identities", async () => {
  const root = fixture("rename-file");
  const source = makeFile(root, "src.txt", "payload");
  const destinationParent = makeDir(root, "dest");
  const destination = path.join(destinationParent, "dst.txt");
  const canonicalSource = realpathNative(source);
  const expect = await renameExpectations(source, root, destinationParent);

  const result = await guardedRename(source, destination, { expect });
  assert.equal(existsSync(source), false);
  assert.equal(readFileSync(destination, "utf8"), "payload");
  assert.equal(result.src, canonicalSource);
  assert.ok(samePathTest(result.dest, destination));
  assert.deepEqual(result.srcIdentity, expect.src);
  assert.deepEqual(result.srcParentIdentity, expect.srcParent);
  assert.deepEqual(result.destParentIdentity, expect.destParent);
});

test("guardedRename renames a directory after binding identities", async () => {
  const root = fixture("rename-dir");
  const source = makeDir(root, "old");
  makeFile(source, "child.txt", "child");
  const destination = path.join(root, "new");
  const expect = await renameExpectations(source, root, root);

  await guardedRename(source, destination, { expect });
  assert.equal(existsSync(source), false);
  assert.equal(readFileSync(path.join(destination, "child.txt"), "utf8"), "child");
});

test("guardedRename denies destination existence, identity drift and kind drift without mutation", async () => {
  const root = fixture("rename-deny");
  const source = makeFile(root, "src.txt", "source");
  const destinationParent = makeDir(root, "dest");
  const existing = makeFile(destinationParent, "existing.txt", "keep");
  const free = path.join(destinationParent, "free.txt");
  const expect = await renameExpectations(source, root, destinationParent);
  const before = snapshot(root);

  await assertCode(
    () => guardedRename(source, existing, { expect }),
    ERROR_CODES.RENAME_DESTINATION_EXISTS,
    "destination exists",
  );
  await assertCode(
    () =>
      guardedRename(source, free, {
        expect: {
          ...expect,
          src: { ...expect.src, ino: (BigInt(expect.src.ino) + 1n).toString() },
        },
      }),
    ERROR_CODES.IDENTITY_MISMATCH,
    "source identity drift",
  );
  await assertCode(
    () =>
      guardedRename(source, free, {
        expect: {
          ...expect,
          srcParent: { ...expect.srcParent, ino: (BigInt(expect.srcParent.ino) + 1n).toString() },
        },
      }),
    ERROR_CODES.IDENTITY_MISMATCH,
    "source parent identity drift",
  );
  await assertCode(
    () =>
      guardedRename(source, free, {
        expect: {
          ...expect,
          destParent: { ...expect.destParent, ino: (BigInt(expect.destParent.ino) + 1n).toString() },
        },
      }),
    ERROR_CODES.IDENTITY_MISMATCH,
    "destination parent identity drift",
  );
  await assertCode(
    () =>
      guardedRename(source, free, {
        expect: { ...expect, src: { ...expect.src, kind: "dir" } },
      }),
    ERROR_CODES.KIND_MISMATCH,
    "source kind drift",
  );

  assert.deepEqual(snapshot(root), before);
  assert.equal(readFileSync(source, "utf8"), "source");
  assert.equal(readFileSync(existing, "utf8"), "keep");
  assert.equal(existsSync(free), false);
});

test("guardedRename rejects roots, same path, destination inside source and linked parents", async (t) => {
  const root = fixture("rename-shape");
  const source = makeFile(root, "src.txt", "source");
  const destinationParent = makeDir(root, "dest");
  const expect = await renameExpectations(source, root, destinationParent);
  const destination = path.join(destinationParent, "dst.txt");
  const filesystemRoot = path.parse(root).root;

  const tree = makeDir(root, "tree");
  const child = makeDir(tree, "child");
  const insideDestination = path.join(child, "new.txt");
  const treeExpect = {
    src: await identityOf(tree),
    srcParent: expect.srcParent,
    destParent: (await assertCanonicalDir(child)).identity,
  };

  const outside = makeDir(root, "outside");
  makeFile(outside, "src.txt", "outside");
  const linkedParent = path.join(root, "linked-parent");
  const linkedSource = path.join(linkedParent, "src.txt");
  if (!makeDirLink(linkedParent, outside)) {
    t.skip("directory links are not supported on this filesystem");
    return;
  }
  const realSourceId = await identityOf(path.join(outside, "src.txt"));
  const linkedParentId = (await assertCanonicalDir(outside)).identity;

  const linkedDestinationParent = path.join(root, "linked-dest");
  if (!makeDirLink(linkedDestinationParent, destinationParent)) {
    t.skip("directory links are not supported on this filesystem");
    return;
  }

  const nested = makeDir(outside, "nested");
  makeFile(nested, "src.txt", "nested");
  const before = snapshot(root);

  await assertCode(
    () => guardedRename(source, source, { expect }),
    ERROR_CODES.RENAME_SAME_PATH,
    "same path",
  );
  await assertCode(
    () => guardedRename(filesystemRoot, destination, { expect }),
    ERROR_CODES.RENAME_SOURCE_ROOT,
    "source root",
  );
  await assertCode(
    () => guardedRename(source, filesystemRoot, { expect }),
    ERROR_CODES.RENAME_DESTINATION_ROOT,
    "destination root",
  );
  await assertCode(
    () => guardedRename(tree, insideDestination, { expect: treeExpect }),
    ERROR_CODES.RENAME_DESTINATION_INSIDE_SOURCE,
    "destination inside source",
  );
  if (isWin) {
    await assertCode(
      () =>
        guardedRename(tree, path.join(root, "TREE", "child", "new.txt"), {
          expect: treeExpect,
        }),
      ERROR_CODES.RENAME_DESTINATION_INSIDE_SOURCE,
      "case-insensitive destination inside source",
    );
  }
  await assertCode(
    () =>
      guardedRename(linkedSource, destination, {
        expect: { src: realSourceId, srcParent: linkedParentId, destParent: expect.destParent },
      }),
    ERROR_CODES.PATH_LINK,
    "linked source parent",
  );
  await assertCode(
    () =>
      guardedRename(source, path.join(linkedDestinationParent, "new.txt"), { expect }),
    ERROR_CODES.PATH_LINK,
    "linked destination parent",
  );
  await assertCode(
    () =>
      guardedRename(path.join(linkedParent, "nested", "src.txt"), destination, {
        expect: { src: realSourceId, srcParent: linkedParentId, destParent: expect.destParent },
      }),
    ERROR_CODES.ANCESTOR_LINK,
    "linked source ancestor",
  );
  await assertCode(
    () =>
      guardedRename(linkedParent, path.join(destinationParent, "linked-copy"), {
        expect: { src: linkedParentId, srcParent: expect.srcParent, destParent: expect.destParent },
      }),
    ERROR_CODES.PATH_LINK,
    "linked source",
  );

  assert.deepEqual(snapshot(root), before);
  assert.equal(existsSync(destination), false);
});

test("guardedRename fails closed on missing source, hardlinked source and rename error", async (t) => {
  const root = fixture("rename-errors");
  const destinationParent = makeDir(root, "dest");
  const rootId = (await assertCanonicalDir(root)).identity;
  const destinationParentId = (await assertCanonicalDir(destinationParent)).identity;

  await assertCode(
    () =>
      guardedRename(path.join(root, "missing.txt"), path.join(destinationParent, "missing.txt"), {
        expect: {
          src: { dev: "1", ino: "1", kind: "file" },
          srcParent: rootId,
          destParent: destinationParentId,
        },
      }),
    ERROR_CODES.PATH_NOT_FOUND,
    "missing source",
  );

  const original = makeFile(root, "original.txt", "original");
  const hard = path.join(root, "hard.txt");
  try {
    linkSync(original, hard);
  } catch {
    t.skip("hardlinks are not supported on this filesystem");
    return;
  }
  const hardId = await identityOf(hard);
  const before = snapshot(root);
  await assertCode(
    () =>
      guardedRename(hard, path.join(destinationParent, "hard.txt"), {
        expect: { src: hardId, srcParent: rootId, destParent: destinationParentId },
      }),
    ERROR_CODES.RENAME_SOURCE_HARDLINK,
    "hardlinked source",
  );
  assert.deepEqual(snapshot(root), before);

  const source = makeFile(root, "source.txt", "source");
  const sourceId = await identityOf(source);
  const beforeParents = snapshot(root);

  await assertCode(
    () =>
      guardedRename(source, path.join(destinationParent, "kind.txt"), {
        expect: {
          src: { ...sourceId, kind: "other" },
          srcParent: rootId,
          destParent: destinationParentId,
        },
      }),
    ERROR_CODES.RENAME_SOURCE_NOT_REGULAR,
    "source kind not regular",
  );
  await assertCode(
    () =>
      guardedRename(path.join(root, "missing-parent", "src.txt"), destinationParent, {
        expect: { src: sourceId, srcParent: rootId, destParent: destinationParentId },
      }),
    ERROR_CODES.PATH_NOT_FOUND,
    "missing source parent",
  );
  await assertCode(
    () =>
      guardedRename(source, path.join(root, "missing-parent", "dst.txt"), {
        expect: { src: sourceId, srcParent: rootId, destParent: destinationParentId },
      }),
    ERROR_CODES.PATH_NOT_FOUND,
    "missing destination parent",
  );
  await assertCode(
    () =>
      guardedRename(source, destinationParent, {
        expect: { src: sourceId, srcParent: rootId, destParent: rootId },
      }),
    ERROR_CODES.RENAME_DESTINATION_EXISTS,
    "destination is a directory",
  );

  const unreadableDestination = path.join(destinationParent, "unreadable.txt");
  const deniedDestinationLstat = {
    lstat: async (target) => {
      if (samePathTest(target, unreadableDestination)) {
        const error = new Error("denied");
        error.code = "EACCES";
        throw error;
      }
      return lstat(target, { bigint: true });
    },
  };
  await assertCode(
    () =>
      guardedRename(source, unreadableDestination, {
        expect: { src: sourceId, srcParent: rootId, destParent: destinationParentId },
        io: deniedDestinationLstat,
      }),
    ERROR_CODES.RENAME_DESTINATION_UNREADABLE,
    "unreadable destination",
  );
  assert.deepEqual(snapshot(root), beforeParents);

  const deniedRename = {
    rename: async () => {
      const error = new Error("denied");
      error.code = "EACCES";
      throw error;
    },
  };
  await assertCode(
    () =>
      guardedRename(source, path.join(destinationParent, "source.txt"), {
        expect: { src: sourceId, srcParent: rootId, destParent: destinationParentId },
        io: deniedRename,
      }),
    ERROR_CODES.RENAME_FAILED,
    "rename error",
  );
  assert.equal(existsSync(source), true);
  assert.equal(existsSync(path.join(destinationParent, "source.txt")), false);
});

test("guardedRename rejects an ancestor replaced after identities were bound", async (t) => {
  const root = fixture("swap-natural");
  const outer = makeDir(root, "outer");
  const inner = makeDir(outer, "inner");
  const source = makeFile(inner, "src.txt", "payload");
  const destinationParent = makeDir(root, "dest");
  const destination = path.join(destinationParent, "dst.txt");
  const expect = await renameExpectations(source, inner, destinationParent);

  const outside = makeDir(root, "outside");
  const outsideInner = makeDir(outside, "inner");
  makeFile(outsideInner, "src.txt", "attacker");
  const moved = path.join(root, "outer-real");
  renameSync(outer, moved);
  if (!makeDirLink(outer, outside)) {
    t.skip("directory links are not supported on this filesystem");
    return;
  }

  await assertCode(
    () => guardedRename(path.join(outer, "inner", "src.txt"), destination, { expect }),
    ERROR_CODES.ANCESTOR_LINK,
    "ancestor replaced after binding",
  );
  assert.equal(existsSync(destination), false);
  assert.equal(readFileSync(path.join(moved, "inner", "src.txt"), "utf8"), "payload");
});

test("guardedRename revalidates an ancestor swapped during verification", async (t) => {
  const root = fixture("swap-hook");
  const outer = makeDir(root, "outer");
  const inner = makeDir(outer, "inner");
  const source = makeFile(inner, "src.txt", "payload");
  const destinationParent = makeDir(root, "dest");
  const destination = path.join(destinationParent, "dst.txt");
  const expect = await renameExpectations(source, inner, destinationParent);

  const outside = makeDir(root, "outside");
  const outsideInner = makeDir(outside, "inner");
  makeFile(outsideInner, "src.txt", "attacker");
  const moved = path.join(root, "outer-real");
  let swapped = false;
  let outerLstats = 0;
  const io = {
    lstat: async (target) => {
      const stats = await lstat(target, { bigint: true });
      if (samePathTest(target, outer)) {
        outerLstats += 1;
        if (outerLstats === 2 && !swapped) {
          swapped = true;
          renameSync(outer, moved);
          if (!makeDirLink(outer, outside)) throw new Error("cannot create test link");
        }
      }
      return stats;
    },
  };
  const probeLink = path.join(root, "probe-link");
  if (!makeDirLink(probeLink, outside)) {
    t.skip("directory links are not supported on this filesystem");
    return;
  }
  unlinkSync(probeLink);

  await assertCode(
    () => guardedRename(source, destination, { expect, io }),
    ERROR_CODES.PATH_NOT_CANONICAL,
    "ancestor swapped during verification",
  );
  assert.equal(existsSync(destination), false);
  assert.equal(readFileSync(path.join(moved, "inner", "src.txt"), "utf8"), "payload");
});

test("primitives reject unknown options, limits and invalid expectations", async () => {
  const root = fixture("options");
  const filePath = makeFile(root, "file.txt");

  await assertCode(
    () => assertCanonicalDir(root, { bogus: true }),
    ERROR_CODES.INVALID_OPTION,
    "unknown option",
  );
  await assertCode(
    () => assertCanonicalDir(root, { limits: { maxScanEntries: 0 } }),
    ERROR_CODES.INVALID_LIMIT,
    "zero limit",
  );
  await assertCode(
    () => assertCanonicalDir(root, { limits: { bogus: 1 } }),
    ERROR_CODES.INVALID_LIMIT,
    "unknown limit",
  );
  await assertCode(
    () => identityOf(root, { io: { bogus: () => {} } }),
    ERROR_CODES.INVALID_OPTION,
    "unknown io function",
  );
  await assertCode(
    () => verifySame(filePath, { dev: "1", ino: "1" }),
    ERROR_CODES.IDENTITY_INVALID,
    "missing kind",
  );
  await assertCode(
    () => verifySame(filePath, { dev: "1", ino: "1", kind: "link" }),
    ERROR_CODES.IDENTITY_INVALID,
    "link kind",
  );
  await assertCode(
    () =>
      guardedRename(filePath, path.join(root, "renamed.txt"), {
        expect: {
          src: { dev: "1", ino: "1", kind: "file" },
          srcParent: { dev: "1", ino: "1", kind: "dir" },
        },
      }),
    ERROR_CODES.INVALID_OPTION,
    "missing destination parent expectation",
  );
  await assertCode(
    () =>
      guardedRename(filePath, path.join(root, "renamed.txt"), {
        expect: {
          src: { dev: "1", ino: "1", kind: "file" },
          srcParent: { dev: "1", ino: "1", kind: "dir" },
          destParent: { dev: "1", ino: "1", kind: "dir" },
          extra: { dev: "1", ino: "1", kind: "dir" },
        },
      }),
    ERROR_CODES.INVALID_OPTION,
    "unknown expectation key",
  );
});
