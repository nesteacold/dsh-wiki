// dsh-wiki — in-panel version check and safe self-update (spec 016), Host half.
//
// Every safety invariant in spec §4 gets a check that fails when the invariant is removed:
//
//   §4.1 update.enabled=false => zero outbound requests, status still answers
//   §4.2 a symlinked install is never written to (refused before ANY git call)
//   §4.3 a dirty worktree is never written to
//   §4.4 a different origin is never written to (including near-miss spellings)
//   §4.5 a version that is not strictly newer is never applied (the downgrade guard)
//   §4.6 no public payload carries a filesystem path / upstream error string / token
//   §4.7 the update never reloads or restarts the Host (it only reports reloadRequired)
//   §4.8 concurrent requests cannot run two updates
//
// Plus the three hardening findings that are not §4 properties of their own:
//
//   H1 git never inherits user / system / repository configuration (a `-c` prefix on EVERY call,
//      an empty global+system config file and an empty hooks directory, cleaned up afterwards)
//   H2 no module-root fallback: the installed package path is located under
//      <home>/profiles/<name>/node_modules/@dsh-ext/dsh-wiki (the measured layout) or the legacy
//      <home>/node_modules/@dsh-ext/dsh-wiki, and is accepted only when its realpath equals the module
//      root; an unresolved path is install-not-found, and the module root is never inspected or written
//      (only read for the display-only version)
//   H3 the install must BE its worktree's top level, not a directory inside an enclosing repository
//
// Nothing here touches the real network, the real repository or the real install: the service is
// built with injected seams (`fetchImpl`, `gitRunner`, `now`) and the routes are driven through a
// fake ctx with those seams substituted (the existing `__updateInternals` seam, the same pattern the
// plugin uses for its other testable internals).
//
// Run: node tools/update-test.mjs
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const here = import.meta.dirname;
const lib = (name) => import(pathToFileURL(path.join(here, "..", "lib", name)).href);
const update = await lib("update.js");
const plugin = await lib("index.js");

const {
  VERSION_URL, VERSION_HOST, EXPECTED_ORIGIN, MAX_VERSION_BODY_BYTES, CONFIRM_TOKEN,
  REASON_CODES, REASON_MESSAGES, REASON_HTTP,
  parseSemver, compareSemver, isNewerVersion, normalizeOrigin, isExpectedOrigin,
  createUpdateService,
} = update;

const FAILS = [];
let CHECKS = 0;
const check = (name, ok, detail = "") => {
  CHECKS += 1;
  console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : `  [${detail}]`));
  if (!ok) FAILS.push(name);
};

// ---------- H1: the git argv prefix every call must carry ----------
// `-c <name>=<value>` pairs, in order, before the subcommand. The hooks path is a fresh empty temp
// directory per call, so only its slot (and the `core.hooksPath=` shape) is fixed here.
const GIT_PREFIX = [
  ["credential.helper", ""],
  ["credential.interactive", "never"],
  ["core.hooksPath", null],
  ["core.fsmonitor", "false"],
  ["submodule.recurse", "false"],
  ["protocol.allow", "never"],
  ["protocol.https.allow", "always"],
];
const GIT_PREFIX_LENGTH = GIT_PREFIX.length * 2;
const HOOKS_FLAG = "core.hooksPath=";
/** The argv with the hardening prefix removed: what the service actually asked git to do. */
const gitArgs = (argv) => (Array.isArray(argv) ? argv.slice(GIT_PREFIX_LENGTH) : []);
/** The per-call empty hooks directory, read back from the call's own argv. */
const hooksPathOf = (argv) => String(argv?.[5] ?? "").slice(HOOKS_FLAG.length);
/** True when this argv carries exactly the contracted `-c` prefix, in order. */
const prefixMatches = (argv) => {
  if (!Array.isArray(argv) || argv.length < GIT_PREFIX_LENGTH) return false;
  for (let index = 0; index < GIT_PREFIX_LENGTH; index += 2) {
    if (argv[index] !== "-c") return false;
    const [name, expected] = GIT_PREFIX[index / 2];
    const value = argv[index + 1];
    if (expected === null) {
      if (typeof value !== "string" || !value.startsWith(HOOKS_FLAG)) return false;
      if (value.length === HOOKS_FLAG.length) return false;
    } else if (value !== `${name}=${expected}`) {
      return false;
    }
  }
  return true;
};

// ---------- fixtures: temp installs, fake git, fake fetch ----------

const ROOT = mkdtempSync(path.join(os.tmpdir(), "dsh-wiki-update-"));
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const HOST = "127.0.0.1:19390";
const FIXED_ISO = "2026-11-11T09:00:00.000Z";
const FIXED_NOW = () => new Date(FIXED_ISO);
let seq = 0;

/**
 * A temp install. `install` is a plain directory; `development-link` is a REAL reparse point (a
 * symlink, or a junction if this machine cannot create one — both are lstat-visible links and the
 * guard treats them identically; measured on this machine: isSymbolicLink() === true for both).
 */
const makeInstall = ({ version = "0.3.0", kind = "install" } = {}) => {
  const base = path.join(ROOT, `install-${++seq}`);
  mkdirSync(base, { recursive: true });
  if (kind === "development-link") {
    const realDir = path.join(base, "real");
    mkdirSync(realDir, { recursive: true });
    writeFileSync(path.join(realDir, "package.json"), JSON.stringify({ name: "@dsh-ext/dsh-wiki", version }));
    const dir = path.join(base, "link");
    let linkType = "symlink";
    try {
      symlinkSync(realDir, dir, "dir");
    } catch {
      symlinkSync(realDir, dir, "junction");
      linkType = "junction";
    }
    return { dir, realDir, version, linkType };
  }
  writeFileSync(path.join(base, "package.json"), JSON.stringify({ name: "@dsh-ext/dsh-wiki", version }));
  return { dir: base, realDir: base, version, linkType: null };
};

/** Write the local version as a checkout of `version` would. */
const writeVersion = (install, version) =>
  writeFileSync(path.join(install.dir, "package.json"), JSON.stringify({ name: "@dsh-ext/dsh-wiki", version }));

const writeProfilePackage = (dir) => writeFileSync(path.join(dir, "package.json"),
  JSON.stringify({ name: "@dsh-ext/dsh-wiki", version: "0.3.0" }));

/**
 * A profile home in the layout measured on this machine (2026-11-11): the install lives under
 * `<home>/profiles/<name>/node_modules/@dsh-ext/dsh-wiki` and `<home>/node_modules` does not exist.
 * `home` is the DSH data root; each profile carries its own `node_modules`.
 *
 * `moduleRoot` is the directory the ESM loader resolves the plugin to — what the resolver compares a
 * candidate's realpath against:
 *   "development-link" — the candidate is a real symlink/junction to a linked tree, and that tree IS
 *                        the module root (exactly this machine's install);
 *   "install"          — the candidate is a plain directory that is itself the module root;
 *   "absent"           — nothing is installed; `moduleRoot` is an unrelated real directory.
 */
const PROFILE_NAME = "desktop";
const makeProfile = (kind) => {
  const home = path.join(ROOT, `profile-${++seq}`);
  const scopeDir = path.join(home, "profiles", PROFILE_NAME, "node_modules", "@dsh-ext");
  mkdirSync(scopeDir, { recursive: true });
  const candidate = path.join(scopeDir, "dsh-wiki");
  if (kind === "development-link") {
    const realDir = path.join(home, "linked-dev-tree");
    mkdirSync(realDir, { recursive: true });
    writeProfilePackage(realDir);
    try {
      symlinkSync(realDir, candidate, "dir");
    } catch {
      symlinkSync(realDir, candidate, "junction");
    }
    return { home, candidate, realDir, moduleRoot: realDir };
  }
  if (kind === "install") {
    mkdirSync(candidate, { recursive: true });
    writeProfilePackage(candidate);
    return { home, candidate, moduleRoot: candidate };
  }
  const moduleRoot = path.join(home, "module-root");
  mkdirSync(moduleRoot, { recursive: true });
  writeProfilePackage(moduleRoot);
  return { home, candidate, moduleRoot };
};

/**
 * The legacy `<home>/node_modules/@dsh-ext/dsh-wiki` layout, kept as a backwards-compatible candidate
 * (a layout that installs the package directly into the data root).
 */
const makeLegacyProfile = (kind = "install") => {
  const home = path.join(ROOT, `legacy-profile-${++seq}`);
  const scopeDir = path.join(home, "node_modules", "@dsh-ext");
  mkdirSync(scopeDir, { recursive: true });
  const candidate = path.join(scopeDir, "dsh-wiki");
  if (kind === "development-link") {
    const realDir = path.join(home, "linked-dev-tree");
    mkdirSync(realDir, { recursive: true });
    writeProfilePackage(realDir);
    try {
      symlinkSync(realDir, candidate, "dir");
    } catch {
      symlinkSync(realDir, candidate, "junction");
    }
    return { home, candidate, realDir, moduleRoot: realDir };
  }
  mkdirSync(candidate, { recursive: true });
  writeProfilePackage(candidate);
  return { home, candidate, moduleRoot: candidate };
};

/**
 * Fake git: records every argv/options pair and answers exactly the operations lib/update.js performs.
 * `versions` maps a commit to the version that commit carries, so a checkout really moves the
 * postcondition — that is what makes the success and postcondition cases distinguishable.
 *
 * Every argv here is the FULL argv (hardening prefix included); dispatch happens on the part after it,
 * so a service that stops sending the prefix fails the H1 checks instead of silently still working.
 * `topLevel` defaults to null, meaning "answer with the cwd this call was made in" — i.e. the install
 * really is its worktree's top level, which is what H3 requires.
 */
const fakeGit = (overrides = {}) => {
  const state = {
    clean: true, workTree: true, statusOk: true,
    origin: `https://github.com/${EXPECTED_ORIGIN}.git`,
    head: HEAD_A, branchSha: HEAD_B, tags: {}, fetchOk: true, failCheckoutOf: null,
    topLevel: null, topLevelOk: true,
    delayMs: 0, install: null, versions: null,
    ...overrides,
  };
  const calls = [];
  let currentHead = state.head;
  const runner = async (argv, options) => {
    calls.push({ argv, options });
    if (state.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
    const [first, second, third] = gitArgs(argv);
    if (first === "rev-parse" && second === "--is-inside-work-tree") {
      return { ok: true, stdout: state.workTree ? "true\n" : "false\n", stderr: "" };
    }
    if (first === "rev-parse" && second === "--show-toplevel") {
      const value = state.topLevel === null ? options?.cwd : state.topLevel;
      if (!state.topLevelOk || typeof value !== "string" || value.length === 0) {
        return { ok: false, stdout: "", stderr: "" };
      }
      return { ok: true, stdout: `${value}\n`, stderr: "" };
    }
    if (first === "remote" && second === "get-url") {
      return state.origin === null
        ? { ok: false, stdout: "", stderr: "" }
        : { ok: true, stdout: `${state.origin}\n`, stderr: "" };
    }
    if (first === "status" && second === "--porcelain") {
      return { ok: state.statusOk, stdout: state.statusOk && state.clean ? "" : " M lib/index.js\n", stderr: "" };
    }
    if (first === "rev-parse" && second === "HEAD") return { ok: true, stdout: `${currentHead}\n`, stderr: "" };
    if (first === "fetch") return { ok: state.fetchOk, stdout: "", stderr: "" };
    if (first === "rev-parse" && second === "--verify") {
      // `git rev-parse --verify --quiet <ref>`: the ref is the fourth argument, not the third.
      const ref = gitArgs(argv)[3];
      if (Object.hasOwn(state.tags, ref)) return { ok: true, stdout: `${state.tags[ref]}\n`, stderr: "" };
      if (ref === "origin/main" && state.branchSha) return { ok: true, stdout: `${state.branchSha}\n`, stderr: "" };
      return { ok: false, stdout: "", stderr: "" };
    }
    if (first === "checkout" && second === "--detach") {
      // Only the named revision fails, so a restore checkout can still succeed (checkout-failed path).
      if (state.failCheckoutOf === third) return { ok: false, stdout: "", stderr: "" };
      currentHead = third;
      if (state.install && state.versions && Object.hasOwn(state.versions, third)) {
        writeVersion(state.install, state.versions[third]);
      }
      return { ok: true, stdout: "", stderr: "" };
    }
    return { ok: false, stdout: "", stderr: "" };
  };
  return { runner, calls, state, head: () => currentHead };
};

/** A clean install-and-publish pair: HEAD_B carries 0.4.0, HEAD_A carries the installed version. */
const installAndGit = (installedVersion = "0.3.0", publishedVersion = "0.4.0", overrides = {}) => {
  const install = makeInstall({ version: installedVersion });
  const git = fakeGit({
    install,
    versions: { [HEAD_A]: installedVersion, [HEAD_B]: publishedVersion },
    ...overrides,
  });
  return { install, git };
};

/** Fake fetch: one Response-like object; `body` is the raw text (already-encoded JSON). */
const fakeFetch = ({ status = 200, body = JSON.stringify({ version: "0.4.0" }), url = VERSION_URL } = {}) => {
  const calls = [];
  const impl = async (requestUrl, options) => {
    calls.push({ url: requestUrl, options });
    return { status, url, headers: { get: () => null }, text: async () => body };
  };
  impl.calls = calls;
  return impl;
};

/** A fetch implementation that must never be called; `calls` records every violation. */
const forbiddenFetch = () => {
  const impl = async (url, options) => {
    impl.calls.push({ url, options });
    throw new Error("the update service must not make any network request");
  };
  impl.calls = [];
  return impl;
};

/** A git runner that must never be called; `calls` records every violation. */
const forbiddenGit = () => {
  const runner = async (argv, options) => {
    runner.calls.push({ argv, options });
    throw new Error("the update service must not run git");
  };
  runner.calls = [];
  return runner;
};

const serviceFor = (install, { enabled = true, fetchImpl, gitRunner, now = FIXED_NOW } = {}) =>
  createUpdateService({
    pluginRoot: install.dir,
    // The installed package path is what the service inspects and writes; a bare `{ pluginRoot }` call
    // is the "not located" case and is exercised separately below (H2).
    installPath: install.dir,
    enabled, fetchImpl, gitRunner, now,
  });

/** A git runner that records every call and checks the H1 prefix/sandbox AT CALL TIME. */
const hooksStateOf = (hooksPath) => {
  if (hooksPath.length === 0 || !existsSync(hooksPath)) return { hooksExists: false, hooksEmpty: false };
  try {
    return { hooksExists: true, hooksEmpty: readdirSync(hooksPath).length === 0 };
  } catch {
    return { hooksExists: true, hooksEmpty: false };
  }
};
const hardenedGit = (base) => {
  const observations = [];
  const runner = async (argv, options) => {
    const hooksPath = hooksPathOf(argv);
    const configPath = String(options?.env?.GIT_CONFIG_GLOBAL ?? "");
    observations.push({
      argv,
      prefixOk: prefixMatches(argv),
      hooksPath,
      configPath,
      // Everything below is sampled while the child would be running, not after.
      ...hooksStateOf(hooksPath),
      configExists: configPath.length > 0 && existsSync(configPath),
      configEmpty: configPath.length > 0 && existsSync(configPath) && readFileSync(configPath, "utf8") === "",
      nosystem: options?.env?.GIT_CONFIG_NOSYSTEM,
      systemConfig: options?.env?.GIT_CONFIG_SYSTEM,
      cwd: options?.cwd,
    });
    return base.runner(argv, options);
  };
  return { ...base, runner, observations };
};

const gitLines = (calls) => calls.map((call) => gitArgs(call.argv).join(" "));
const hasGit = (calls, command) => gitLines(calls).some((line) => line === command);
const checkoutTargets = (calls) => calls
  .filter((call) => gitArgs(call.argv)[0] === "checkout" && gitArgs(call.argv)[1] === "--detach")
  .map((call) => gitArgs(call.argv)[2]);

/**
 * §4.6: no path may appear anywhere in a public payload. Strings (a raw HTTP body) are inspected as
 * they are — JSON.stringify of a string would add `\"` escapes that look like path separators.
 */
const noPathShape = (label, value, extraPaths = []) => {
  const texts = (Array.isArray(value) ? value : [value]).map((entry) => {
    if (typeof entry === "string") return entry;
    return JSON.stringify(entry);
  });
  const paths = [ROOT, ...extraPaths].filter((entry) => typeof entry === "string" && entry.length > 3);
  check(`${label}: payload has no "/" or "\\" and no directory path (§4.6)`,
    texts.every((text) => !/[\\/]/.test(text) && paths.every((entry) => !text.includes(entry))),
    texts.join(" | ").slice(0, 320));
};

// ---------- 1. pure semver ----------

const VALID = ["0.0.0", "0.3.0", "1.2.3", "10.20.30", "1.0.99"];
const INVALID = ["", "0.3", "0.3.0.0", "v0.3.0", "0.3.0-beta", "0.3.0+build", " 0.3.0", "0.3.0 ",
  "00.3.0", "0.03.0", "0.3.-1", "0.3.0-rc.1", "one.two.three", ".3.0", "0..0"];
check("parseSemver accepts strict X.Y.Z only",
  VALID.every((value) => parseSemver(value) !== null)
  && INVALID.every((value) => parseSemver(value) === null)
  && parseSemver(undefined) === null && parseSemver(3) === null && parseSemver(null) === null,
  JSON.stringify(INVALID.filter((value) => parseSemver(value) !== null)));
check("compareSemver orders numerically, not lexically",
  compareSemver("0.2.0", "0.3.0") === -1 && compareSemver("0.3.0", "0.3.0") === 0
  && compareSemver("0.10.0", "0.9.9") === 1 && compareSemver("1.0.0", "0.99.99") === 1);
check("compareSemver returns null (never 0) for an unparsable version",
  compareSemver("0.3", "0.3.0") === null && compareSemver(null, "0.3.0") === null);

// §4.5: the downgrade guard, as a pure predicate.
check("isNewerVersion is strict: equal and older are both refused",
  isNewerVersion("0.4.0", "0.3.0") === true
  && isNewerVersion("0.3.0", "0.3.0") === false
  && isNewerVersion("0.2.0", "0.3.0") === false
  && isNewerVersion("0.4.0", "not-a-version") === false);

// ---------- 2. origin normalisation (H4: HTTPS only) ----------

const ACCEPTED = [
  "https://github.com/nesteacold/dsh-wiki",
  "https://github.com/nesteacold/dsh-wiki.git",
  "https://github.com/nesteacold/dsh-wiki/",
  "https://github.com/nesteacold/dsh-wiki.git/",
  "https://GitHub.com/NesteaCold/DSH-Wiki.git",
];
check("every ordinary spelling of the expected remote normalises to the expected repository",
  ACCEPTED.every((value) => normalizeOrigin(value) === EXPECTED_ORIGIN),
  JSON.stringify(ACCEPTED.filter((value) => normalizeOrigin(value) !== EXPECTED_ORIGIN)));

// H4: only HTTPS is a spelling variant. Every other transport is refused outright (null, not just a
// different repository): the update path's integrity claim is HTTPS-to-the-pinned-host.
const NON_HTTPS_TRANSPORTS = [
  "git@github.com:nesteacold/dsh-wiki.git",
  "git@github.com:nesteacold/dsh-wiki",
  "ssh://git@github.com/nesteacold/dsh-wiki.git",
  "git://github.com/nesteacold/dsh-wiki.git",
  "http://github.com/nesteacold/dsh-wiki",
  "file:///C:/repo",
  "../dsh-wiki",
  "C:\\repo\\dsh-wiki",
];
check("only https:// is accepted: ssh, scp-like, git://, http, file and local paths all normalise to null (H4)",
  NON_HTTPS_TRANSPORTS.every((value) => normalizeOrigin(value) === null && isExpectedOrigin(value) === false),
  JSON.stringify(NON_HTTPS_TRANSPORTS.filter((value) => normalizeOrigin(value) !== null)));

// §4.4: near misses must NOT normalise onto the expected repository. A near miss is usually a
// DIFFERENT well-formed repository (e.g. `nesteacold/dsh-wiki-evil`), so the contract is
// `isExpectedOrigin === false` — not necessarily "unparsable".
const REJECTED = [
  "https://github.com/nesteacold/dsh-wiki-evil",
  "https://github.com/nesteacold/dsh-wiki-evil.git",
  "https://github.com/evil/nesteacold/dsh-wiki",
  "https://github.com/nesteacold/dsh-wiki/tree/main",
  "https://gitlab.com/nesteacold/dsh-wiki",
  "https://evil.example/github.com/nesteacold/dsh-wiki",
  "https://github.com.evil.example/nesteacold/dsh-wiki",
  "git@github.com:nesteacold/dsh-wiki-evil.git",
  "git@gitlab.com:nesteacold/dsh-wiki.git",
  "https://token@github.com/nesteacold/dsh-wiki",
  "https://user:secret@github.com/nesteacold/dsh-wiki",
  "git://github.com/nesteacold/dsh-wiki.git",
  "ssh://git@github.com/nesteacold/dsh-wiki.git",
  "http://github.com/nesteacold/dsh-wiki",
  "https://github.com:8443/nesteacold/dsh-wiki",
  "file:///C:/repo",
  "../dsh-wiki",
  "",
  null,
];
const rejectedRows = REJECTED.map((value) => ({ value, normalized: normalizeOrigin(value) }));
check("a foreign or near-miss origin is never the expected repository",
  rejectedRows.every((row) => isExpectedOrigin(row.value) === false
    && row.normalized !== EXPECTED_ORIGIN),
  JSON.stringify(rejectedRows.filter((row) => isExpectedOrigin(row.value) || row.normalized === EXPECTED_ORIGIN)));
check("a near-miss repository name stays a different repository (never collapses to the expected one)",
  rejectedRows.find((row) => row.value === "https://github.com/nesteacold/dsh-wiki-evil")?.normalized
    === "nesteacold/dsh-wiki-evil"
  && rejectedRows.find((row) => row.value === "https://github.com/evil/nesteacold/dsh-wiki")?.normalized === null);
check("the expected repository is the only origin that can pass the guard",
  [...ACCEPTED].every((value) => isExpectedOrigin(value) === true)
  && rejectedRows.every((row) => isExpectedOrigin(row.value) === false));

// ---------- 3. the closed reason vocabulary ----------

const SPEC_CODES = ["update-disabled", "update-in-progress", "install-not-found",
  "install-is-development-link", "install-not-git", "install-not-worktree-root",
  "install-origin-mismatch", "install-dirty", "latest-not-newer", "version-invalid", "network-unavailable",
  "fetch-failed", "checkout-failed", "postcondition-failed", "internal-error"];
check("REASON_CODES is exactly the closed §3.5 vocabulary (15 codes)",
  REASON_CODES.length === SPEC_CODES.length && SPEC_CODES.every((code) => REASON_CODES.includes(code)),
  JSON.stringify(REASON_CODES.filter((code) => !SPEC_CODES.includes(code))));
check("every reason code has a fixed sentence and no sentence is path-shaped (§4.6)",
  REASON_CODES.every((code) => typeof REASON_MESSAGES[code] === "string"
    && REASON_MESSAGES[code].length > 0 && REASON_MESSAGES[code].length <= 200
    && !/[\\/]/.test(REASON_MESSAGES[code])),
  JSON.stringify(REASON_CODES.filter((code) => !REASON_MESSAGES[code] || /[\\/]/.test(REASON_MESSAGES[code] ?? ""))));
check("REASON_HTTP maps every code; only internal-error is a 5xx",
  REASON_CODES.every((code) => Number.isInteger(REASON_HTTP[code]))
  && REASON_CODES.filter((code) => REASON_HTTP[code] >= 500).join(",") === "internal-error");
check("the network surface is pinned to one URL on the pinned host",
  VERSION_URL === `https://${VERSION_HOST}/nesteacold/dsh-wiki/main/package.json`
  && VERSION_URL.startsWith("https://") && MAX_VERSION_BODY_BYTES === 64 * 1024
  && CONFIRM_TOKEN === "install-update");

// ---------- 4. §4.1 — disabled means zero outbound requests ----------

const disabledInstall = makeInstall({ version: "0.3.0" });
const disabledFetch = forbiddenFetch();
const disabledGit = forbiddenGit();
const disabledService = serviceFor(disabledInstall, { enabled: false, fetchImpl: disabledFetch, gitRunner: disabledGit });
const disabledStatus = await disabledService.status();
check("disabled status: answers with enabled:false, latest:null, reason:update-disabled",
  disabledStatus.ok === true && disabledStatus.enabled === false && disabledStatus.latest === null
  && disabledStatus.reason === "update-disabled" && disabledStatus.canUpdate === false
  && disabledStatus.updateAvailable === false && disabledStatus.reloadRequired === false,
  JSON.stringify(disabledStatus));
check("disabled status: no network request and no git call at all (§4.1)",
  disabledFetch.calls.length === 0 && disabledGit.calls.length === 0,
  `fetch=${disabledFetch.calls.length} git=${disabledGit.calls.length}`);
const disabledApply = await disabledService.apply();
check("disabled apply: refuses update-disabled with the fixed sentence and no request",
  disabledApply.ok === false && disabledApply.code === "update-disabled"
  && disabledApply.error === REASON_MESSAGES["update-disabled"]
  && disabledFetch.calls.length === 0 && disabledGit.calls.length === 0,
  JSON.stringify(disabledApply));
check("disabled status: installed.version still comes from the local package.json",
  disabledStatus.installed.version === "0.3.0" && disabledStatus.installed.installKind === "install",
  JSON.stringify(disabledStatus.installed));

// ---------- 5. §4.2 — a symlinked install is refused before any git call ----------

const linkInstall = makeInstall({ version: "0.3.0", kind: "development-link" });
const linkFetch = forbiddenFetch();
const linkGit = forbiddenGit();
const linkService = serviceFor(linkInstall, { enabled: true, fetchImpl: linkFetch, gitRunner: linkGit });
const linkStatus = await linkService.status();
check(`symlinked install (${linkInstall.linkType}) reports installKind:development-link`,
  linkStatus.installed.installKind === "development-link", JSON.stringify(linkStatus.installed));
check("symlinked install: canUpdate false, reason install-is-development-link, no update available",
  linkStatus.canUpdate === false && linkStatus.reason === "install-is-development-link"
  && linkStatus.updateAvailable === false && linkStatus.latest === null, JSON.stringify(linkStatus));
check("symlinked install: the fake git runner is never invoked (§4.2)",
  linkGit.calls.length === 0, `git=${linkGit.calls.length}`);
const linkApply = await linkService.apply();
check("symlinked install: apply is refused with install-is-development-link and zero git calls",
  linkApply.ok === false && linkApply.code === "install-is-development-link"
  && linkGit.calls.length === 0 && linkFetch.calls.length === 0, JSON.stringify(linkApply));
check("a disabled symlinked install still reports update-disabled first (step 1 before step 3)",
  (await serviceFor(linkInstall, { enabled: false, fetchImpl: forbiddenFetch(), gitRunner: forbiddenGit() }).status())
    .reason === "update-disabled");
check("a development-link status payload carries no path (§4.6)",
  !JSON.stringify(linkStatus).includes(ROOT), JSON.stringify(linkStatus).slice(0, 200));

// Step 2 before step 3: the first call is suspended inside lstat, the second must see the latch.
const linkInFlightService = serviceFor(linkInstall, {
  enabled: true, fetchImpl: forbiddenFetch(), gitRunner: forbiddenGit(),
});
const [linkFirst, linkSecond] = await Promise.all([linkInFlightService.apply(), linkInFlightService.apply()]);
check("an in-flight update is reported before the install kind is inspected (step 2 before step 3)",
  [linkFirst.code, linkSecond.code].sort().join(",") === "install-is-development-link,update-in-progress",
  JSON.stringify([linkFirst.code, linkSecond.code]));

// ---------- 6. §3.4 precedence, first failure wins ----------

const cleanInstall = makeInstall({ version: "0.3.0" });

// 4 before 5/6/7/8:
const notGit = fakeGit({ workTree: false });
const notGitStatus = await serviceFor(cleanInstall, { fetchImpl: fakeFetch(), gitRunner: notGit.runner }).status();
check("install-not-git is reported before any origin read or status check",
  notGitStatus.reason === "install-not-git"
  && !hasGit(notGit.calls, "remote get-url origin")
  && !hasGit(notGit.calls, "status --porcelain"), JSON.stringify(notGitStatus.reason));

// 5 before 6: a dirty foreign repository is an origin mismatch, not a dirty tree.
const foreignDirty = fakeGit({ origin: "https://github.com/evil/dsh-wiki.git", clean: false });
const foreignDirtyStatus = await serviceFor(cleanInstall, {
  fetchImpl: fakeFetch(), gitRunner: foreignDirty.runner }).status();
check("install-origin-mismatch wins over install-dirty (step 5 before step 6)",
  foreignDirtyStatus.reason === "install-origin-mismatch"
  && !hasGit(foreignDirty.calls, "status --porcelain"), JSON.stringify(foreignDirtyStatus.reason));

// 6 before 7/8: a dirty tree with an OLDER published version reports the dirty tree, and no request.
const dirtyFetch = fakeFetch({ body: JSON.stringify({ version: "0.2.0" }) });
const dirtyGit = fakeGit({ clean: false });
const dirtyStatus = await serviceFor(cleanInstall, { fetchImpl: dirtyFetch, gitRunner: dirtyGit.runner }).status();
check("a dirty tree refuses with install-dirty before the published version is even read (6 before 7/8)",
  dirtyStatus.reason === "install-dirty" && dirtyStatus.canUpdate === false
  && dirtyFetch.calls.length === 0 && !hasGit(dirtyGit.calls, "fetch --tags --prune origin"),
  JSON.stringify({ reason: dirtyStatus.reason, fetch: dirtyFetch.calls.length }));
const dirtyApply = await serviceFor(cleanInstall, { fetchImpl: dirtyFetch, gitRunner: dirtyGit.runner }).apply();
check("a dirty tree can never be written to (§4.3): no fetch, no checkout",
  dirtyApply.ok === false && dirtyApply.code === "install-dirty"
  && checkoutTargets(dirtyGit.calls).length === 0
  && !hasGit(dirtyGit.calls, "fetch --tags --prune origin"), JSON.stringify(dirtyApply));

// ---------- 6b. H3 — the install must BE the worktree's top level ----------
//
// The finding: `rev-parse --is-inside-work-tree` is true for any depth, so a checkout living inside a
// parent repository could act on that enclosing repository. The install path and the reported top level
// are compared by realpath; a mismatch is refused before any origin read, fetch or checkout.

const nestedDir = path.join(ROOT, `enclosing-repo-${++seq}`);
mkdirSync(nestedDir, { recursive: true });
const nestedGit = fakeGit({ topLevel: nestedDir });
const nestedFetch = forbiddenFetch();
const nestedStatus = await serviceFor(cleanInstall, {
  fetchImpl: nestedFetch, gitRunner: nestedGit.runner }).status();
check("H3: a different reported worktree top level is install-not-worktree-root",
  nestedStatus.reason === "install-not-worktree-root" && nestedStatus.canUpdate === false
  && nestedStatus.installed?.installKind === "install", JSON.stringify(nestedStatus));
check("H3: the mismatch is decided before the origin is read, before status and before any request",
  !hasGit(nestedGit.calls, "remote get-url origin") && !hasGit(nestedGit.calls, "status --porcelain")
  && nestedFetch.calls.length === 0, JSON.stringify(gitLines(nestedGit.calls)));

const nestedApply = await serviceFor(cleanInstall, {
  fetchImpl: forbiddenFetch(), gitRunner: fakeGit({ topLevel: nestedDir }).runner }).apply();
check("H3: apply refuses install-not-worktree-root with no fetch and no checkout",
  nestedApply.ok === false && nestedApply.code === "install-not-worktree-root"
  && nestedApply.status === 409 && nestedApply.error === REASON_MESSAGES["install-not-worktree-root"]
  && nestedApply.restored === undefined, JSON.stringify(nestedApply));

const nestedApplyGit = fakeGit({ topLevel: nestedDir });
const nestedApplyResult = await serviceFor(cleanInstall, {
  fetchImpl: forbiddenFetch(), gitRunner: nestedApplyGit.runner }).apply();
check("H3: a refused nested install never runs fetch or checkout",
  nestedApplyResult.code === "install-not-worktree-root"
  && !hasGit(nestedApplyGit.calls, "fetch --tags --prune origin")
  && checkoutTargets(nestedApplyGit.calls).length === 0, JSON.stringify(gitLines(nestedApplyGit.calls)));

// An unanswerable top level (git fails, or prints nothing) fails closed, never "assume it matches".
const noTopLevelGit = fakeGit({ topLevelOk: false });
const noTopLevelStatus = await serviceFor(cleanInstall, {
  fetchImpl: forbiddenFetch(), gitRunner: noTopLevelGit.runner }).status();
check("H3: an unanswerable top level fails closed with install-not-worktree-root",
  noTopLevelStatus.reason === "install-not-worktree-root", JSON.stringify(noTopLevelStatus.reason));
const emptyTopLevelGit = fakeGit({ topLevel: "" });
check("H3: an empty top level answer fails closed too",
  (await serviceFor(cleanInstall, { fetchImpl: forbiddenFetch(), gitRunner: emptyTopLevelGit.runner }).status())
    .reason === "install-not-worktree-root");

// A matching top level expressed differently must still pass: git may answer with forward slashes and
// (on Windows) another letter case, and the install path may carry a trailing separator.
const spellingGit = fakeGit({
  topLevel: process.platform === "win32"
    ? cleanInstall.dir.replace(/\\/g, "/").toUpperCase()
    : `${cleanInstall.dir}${path.sep}`,
});
const spellingStatus = await serviceFor(cleanInstall, {
  fetchImpl: fakeFetch({ body: JSON.stringify({ version: "0.4.0" }) }), gitRunner: spellingGit.runner }).status();
check("H3: a matching top level is accepted across separators and Windows letter case",
  spellingStatus.reason === null && spellingStatus.canUpdate === true,
  JSON.stringify({ reason: spellingStatus.reason, topLevel: spellingGit.state.topLevel }));
check("H3: a trailing separator on the reported top level is still the same directory",
  (await serviceFor(cleanInstall, {
    fetchImpl: fakeFetch({ body: JSON.stringify({ version: "0.4.0" }) }),
    gitRunner: fakeGit({ topLevel: `${cleanInstall.dir}${path.sep}` }).runner,
  }).status()).canUpdate === true);

// ---------- 7. §4.4 — a foreign origin can never be written to ----------

const foreignOrigins = [
  "https://github.com/nesteacold/dsh-wiki-evil.git",
  "https://github.com/evil/nesteacold/dsh-wiki",
  "https://gitlab.com/nesteacold/dsh-wiki.git",
  "git@github.com:nesteacold/dsh-wiki-evil.git",
];
const foreignRows = [];
for (const origin of foreignOrigins) {
  const { install } = installAndGit();
  const git = fakeGit({ origin });
  const fetch = fakeFetch({ body: JSON.stringify({ version: "0.4.0" }) });
  const result = await serviceFor(install, { fetchImpl: fetch, gitRunner: git.runner }).apply();
  foreignRows.push({ origin, code: result.code, checkouts: checkoutTargets(git.calls).length,
    fetch: fetch.calls.length });
}
check("a foreign origin is install-origin-mismatch and is never checked out or even checked (§4.4)",
  foreignRows.every((row) => row.code === "install-origin-mismatch" && row.checkouts === 0 && row.fetch === 0),
  JSON.stringify(foreignRows));
const noOrigin = fakeGit({ origin: null });
check("an install with no origin remote is install-origin-mismatch",
  (await serviceFor(cleanInstall, { fetchImpl: fakeFetch(), gitRunner: noOrigin.runner }).status()).reason
    === "install-origin-mismatch");

// ---------- 8. §4.5 — the downgrade guard ----------

const equalFetch = fakeFetch({ body: JSON.stringify({ version: "0.3.0" }) });
const equalGit = fakeGit();
const equalResult = await serviceFor(cleanInstall, { fetchImpl: equalFetch, gitRunner: equalGit.runner }).apply();
const equalStatus = await serviceFor(cleanInstall, {
  fetchImpl: fakeFetch({ body: JSON.stringify({ version: "0.3.0" }) }), gitRunner: fakeGit().runner }).status();
check("an equal published version refuses with latest-not-newer",
  equalResult.ok === false && equalResult.code === "latest-not-newer"
  && equalStatus.reason === "latest-not-newer" && equalStatus.updateAvailable === false,
  JSON.stringify({ apply: equalResult.code, status: equalStatus.reason }));
check("the equal-version refusal still reads the published version (step 7 before 8) and never checks out",
  equalFetch.calls.length === 1 && checkoutTargets(equalGit.calls).length === 0,
  `fetch=${equalFetch.calls.length}`);

// The state of this machine today: published 0.2.0, dev tree 0.3.0 => the downgrade is refused.
const olderFetch = fakeFetch({ body: JSON.stringify({ version: "0.2.0" }) });
const olderGit = fakeGit();
const olderResult = await serviceFor(cleanInstall, { fetchImpl: olderFetch, gitRunner: olderGit.runner }).apply();
const olderStatus = await serviceFor(cleanInstall, {
  fetchImpl: fakeFetch({ body: JSON.stringify({ version: "0.2.0" }) }), gitRunner: fakeGit().runner }).status();
check("an older published version refuses with latest-not-newer (today's 0.3.0 vs 0.2.0 state)",
  olderResult.ok === false && olderResult.code === "latest-not-newer"
  && olderStatus.reason === "latest-not-newer" && olderStatus.updateAvailable === false
  && checkoutTargets(olderGit.calls).length === 0,
  JSON.stringify({ apply: olderResult.code, status: olderStatus.reason }));

// ---------- 9. the happy path, and what it reports ----------

const success = installAndGit("0.3.0", "0.4.0");
const successFetch = fakeFetch({ body: JSON.stringify({ version: "0.4.0" }) });
const successStatus = await serviceFor(success.install, {
  fetchImpl: fakeFetch({ body: JSON.stringify({ version: "0.4.0" }) }), gitRunner: fakeGit().runner }).status();
const successResult = await serviceFor(success.install, {
  fetchImpl: successFetch, gitRunner: success.git.runner }).apply();
check("a newer published version is applied and reports from/to/reloadRequired",
  successResult.ok === true && successResult.applied === true && successResult.from === "0.3.0"
  && successResult.to === "0.4.0" && successResult.reloadRequired === true, JSON.stringify(successResult));
check("the update never reloads or restarts anything: the result only reports reloadRequired (§4.7)",
  Object.keys(successResult).sort().join(",") === "applied,from,ok,reloadRequired,to",
  JSON.stringify(Object.keys(successResult)));
check("status: latest carries the pinned source and the injected clock, canUpdate is true",
  successStatus.latest?.version === "0.4.0" && successStatus.latest?.source === VERSION_HOST
  && successStatus.latest?.checkedAt === FIXED_ISO
  && successStatus.updateAvailable === true && successStatus.canUpdate === true
  && successStatus.reason === null, JSON.stringify(successStatus));
check("apply performs the contracted sequence and leaves HEAD at the resolved target",
  hasGit(success.git.calls, "fetch --tags --prune origin")
  && hasGit(success.git.calls, "rev-parse --verify --quiet origin/main")
  && hasGit(success.git.calls, `checkout --detach ${HEAD_B}`)
  && success.git.head() === HEAD_B, JSON.stringify(gitLines(success.git.calls)));

// §7: a published tag is preferred over the branch, so the release commit need not be the branch tip.
const HEAD_C = "c".repeat(40);
const taggedInstall = makeInstall({ version: "0.3.0" });
const taggedGit = fakeGit({
  install: taggedInstall,
  versions: { [HEAD_A]: "0.3.0", [HEAD_B]: "0.4.0", [HEAD_C]: "0.4.0" },
  tags: { "refs/tags/v0.4.0": HEAD_C },
  branchSha: HEAD_B,
});
const taggedResult = await serviceFor(taggedInstall, {
  fetchImpl: fakeFetch({ body: JSON.stringify({ version: "0.4.0" }) }), gitRunner: taggedGit.runner }).apply();
check("a matching tag is preferred over the branch (§7)",
  taggedResult.ok === true && taggedGit.head() === HEAD_C
  && hasGit(taggedGit.calls, "rev-parse --verify --quiet refs/tags/v0.4.0")
  && !hasGit(taggedGit.calls, "rev-parse --verify --quiet refs/tags/0.4.0")
  && !hasGit(taggedGit.calls, "rev-parse --verify --quiet origin/main"),
  JSON.stringify(gitLines(taggedGit.calls)));
check("a successful apply leaves the installed version on disk equal to the published one",
  readInstalledOnDisk(taggedInstall) === "0.4.0", readInstalledOnDisk(taggedInstall));

/** The version a real install would now report, read from the fixture. */
function readInstalledOnDisk(install) {
  try {
    return JSON.parse(readFileSync(path.join(install.dir, "package.json"), "utf8")).version;
  } catch {
    return "unreadable";
  }
}

// ---------- 10. postcondition failures report the restore ----------

// A checkout that "succeeds" but leaves the old version on disk must be caught by the postcondition.
const stale = makeInstall({ version: "0.3.0" });
const staleGit = fakeGit();
const postconditionResult = await serviceFor(stale, {
  fetchImpl: fakeFetch({ body: JSON.stringify({ version: "0.4.0" }) }), gitRunner: staleGit.runner }).apply();
check("a checkout that does not produce the published version is postcondition-failed",
  postconditionResult.ok === false && postconditionResult.code === "postcondition-failed"
  && postconditionResult.error === REASON_MESSAGES["postcondition-failed"], JSON.stringify(postconditionResult));
check("the restore attempt is reported and targets the previous revision",
  postconditionResult.restored === true
  && JSON.stringify(checkoutTargets(staleGit.calls)) === JSON.stringify([HEAD_B, HEAD_A])
  && gitLines(staleGit.calls).at(-1) === `checkout --detach ${HEAD_A}`,
  JSON.stringify({ restored: postconditionResult.restored, checkouts: checkoutTargets(staleGit.calls) }));

const failedCheckout = await serviceFor(makeInstall({ version: "0.3.0" }), {
  fetchImpl: fakeFetch({ body: JSON.stringify({ version: "0.4.0" }) }),
  gitRunner: fakeGit({ failCheckoutOf: HEAD_B }).runner }).apply();
check("a failed checkout is checkout-failed and still reports whether the tree was restored",
  failedCheckout.ok === false && failedCheckout.code === "checkout-failed"
  && failedCheckout.restored === true, JSON.stringify(failedCheckout));

const failedFetchGit = fakeGit({ fetchOk: false });
check("a failed git fetch is fetch-failed and never checks out",
  (await serviceFor(makeInstall({ version: "0.3.0" }), {
    fetchImpl: fakeFetch({ body: JSON.stringify({ version: "0.4.0" }) }),
    gitRunner: failedFetchGit.runner,
  }).apply()).code === "fetch-failed" && checkoutTargets(failedFetchGit.calls).length === 0);

// ---------- 10b. §3.2 — reloadRequired is remembered by the service instance ----------
//
// The flag must live in the instance and must not be recomputed from the last check: after an applied
// update, a later status() (the panel closed and reopened, or any fresh fetch) has to keep reading as
// "not live yet". Only a re-created service — the plugin being cycled — clears it, which is why the
// fresh-instance case below is the contract, not an accident.

const reloadPair = installAndGit("0.3.0", "0.4.0");
const reloadFetch = fakeFetch({ body: JSON.stringify({ version: "0.4.0" }) });
const reloadService = serviceFor(reloadPair.install, {
  fetchImpl: reloadFetch, gitRunner: reloadPair.git.runner });
const reloadBefore = await reloadService.status();
check("status reports reloadRequired false before any update is applied (§3.2)",
  reloadBefore.reloadRequired === false && reloadBefore.canUpdate === true, JSON.stringify(reloadBefore));

const reloadApplied = await reloadService.apply();
const reloadAfter = await reloadService.status();
check("a successful apply makes the same instance report reloadRequired true in status (§3.2)",
  reloadApplied.ok === true && reloadApplied.reloadRequired === true && reloadAfter.reloadRequired === true,
  JSON.stringify({ applied: reloadApplied, status: reloadAfter }));

// The second status() runs its own preflight against the now-updated tree: it finds nothing newer to
// do (the install is at 0.4.0), yet reloadRequired must still be true — that is what "remembered, not
// recomputed from the last check" means.
const reloadLatest = await reloadService.status();
check("reloadRequired survives a later status() call: it is remembered, not derived from that check",
  reloadAfter.reloadRequired === true && reloadLatest.reloadRequired === true
  && reloadLatest.canUpdate === false && reloadLatest.reason === "latest-not-newer",
  JSON.stringify(reloadLatest));

// §3.2/§3.3: a new service instance is the plugin being re-created, so the hint is gone.
const reloadFresh = await serviceFor(reloadPair.install, {
  fetchImpl: fakeFetch({ body: JSON.stringify({ version: "0.4.0" }) }), gitRunner: fakeGit().runner }).status();
check("a freshly constructed service reports reloadRequired false again (plugin-reload semantics)",
  reloadFresh.reloadRequired === false, JSON.stringify(reloadFresh));

// A refusal leaves the tree exactly as it was, so there is nothing to reload.
const refusalService = serviceFor(makeInstall({ version: "0.3.0" }), {
  fetchImpl: fakeFetch({ body: JSON.stringify({ version: "0.4.0" }) }), gitRunner: fakeGit({ clean: false }).runner });
const refusalApply = await refusalService.apply();
const refusalStatus = await refusalService.status();
check("a refused apply leaves reloadRequired false (in the refusal and in the later status)",
  refusalApply.ok === false && refusalApply.code === "install-dirty"
  && refusalApply.reloadRequired !== true && refusalStatus.reloadRequired === false,
  JSON.stringify({ apply: refusalApply, status: refusalStatus.reloadRequired }));

// A postcondition failure whose restore succeeded put the tree back: nothing is pending either.
const restoreService = serviceFor(makeInstall({ version: "0.3.0" }), {
  fetchImpl: fakeFetch({ body: JSON.stringify({ version: "0.4.0" }) }), gitRunner: fakeGit().runner });
const restoreApply = await restoreService.apply();
const restoreStatus = await restoreService.status();
check("a postcondition-failed run whose restore succeeded leaves reloadRequired false",
  restoreApply.code === "postcondition-failed" && restoreApply.restored === true
  && restoreApply.reloadRequired !== true && restoreStatus.reloadRequired === false,
  JSON.stringify({ apply: restoreApply, status: restoreStatus.reloadRequired }));

// H6: the checkout SUCCEEDED, so the tree has moved; if the restore then also fails, HEAD is not where
// the caller last saw it. Reporting "unchanged" would be a lie, so reloadPending is set even though the
// apply was refused. The fake checks out HEAD_B (which does not carry 0.4.0, so the postcondition fails)
// and refuses the restore to HEAD_A.
const movedInstall = makeInstall({ version: "0.3.0" });
const movedGit = fakeGit({ failCheckoutOf: HEAD_A });
const movedService = serviceFor(movedInstall, {
  fetchImpl: fakeFetch({ body: JSON.stringify({ version: "0.4.0" }) }), gitRunner: movedGit.runner });
const movedApply = await movedService.apply();
const movedStatus = await movedService.status();
check("H6: a postcondition failure whose restore FAILED moves the tree and reports restored:false",
  movedApply.ok === false && movedApply.code === "postcondition-failed"
  && movedApply.restored === false && movedGit.head() === HEAD_B
  && JSON.stringify(checkoutTargets(movedGit.calls)) === JSON.stringify([HEAD_B, HEAD_A]),
  JSON.stringify({ apply: movedApply, head: movedGit.head(), checkouts: checkoutTargets(movedGit.calls) }));
check("H6: that failed restore sets reloadPending, so a later status does not read as unchanged",
  movedStatus.reloadRequired === true, JSON.stringify({ reloadRequired: movedStatus.reloadRequired }));

// `refusal()` in lib/update.js is the only refusal shape, shared by the service and the route, so
// asserting it here covers both surfaces: the field is either absent or false, never truthy.
const refusalPayloads = [refusalApply, restoreApply, disabledApply, linkApply];
check("reloadRequired never appears as a truthy value in a refusal payload (§3.2/§3.3)",
  refusalPayloads.every((payload) => payload.reloadRequired !== true)
  && refusalPayloads.every((payload) => !/"reloadRequired"\s*:\s*true/.test(JSON.stringify(payload))),
  JSON.stringify(refusalPayloads));

// ---------- 11. §3.4.7 — version parsing and network failures ----------

const badVersionRows = [];
for (const version of ["0.4", "0.4.0-beta", "v0.4.0", "", 4, null]) {
  badVersionRows.push({
    version: String(version),
    reason: (await serviceFor(makeInstall({ version: "0.3.0" }), {
      fetchImpl: fakeFetch({ body: JSON.stringify({ version }) }), gitRunner: fakeGit().runner }).status()).reason,
  });
}
check("a published version that is not strict X.Y.Z is version-invalid",
  badVersionRows.every((row) => row.reason === "version-invalid"), JSON.stringify(badVersionRows));
check("a published payload that is not JSON at all is version-invalid",
  (await serviceFor(makeInstall({ version: "0.3.0" }), {
    fetchImpl: fakeFetch({ body: "{ not json" }), gitRunner: fakeGit().runner,
  }).status()).reason === "version-invalid");
check("a published payload without a version field is version-invalid",
  (await serviceFor(makeInstall({ version: "0.3.0" }), {
    fetchImpl: fakeFetch({ body: JSON.stringify({ name: "@dsh-ext/dsh-wiki" }) }), gitRunner: fakeGit().runner,
  }).status()).reason === "version-invalid");

const nonOkStatus = await serviceFor(makeInstall({ version: "0.3.0" }), {
  fetchImpl: fakeFetch({ status: 500, body: JSON.stringify({ version: "9.9.9" }) }),
  gitRunner: fakeGit().runner }).status();
check("a non-200 response is network-unavailable and never becomes a version",
  nonOkStatus.reason === "network-unavailable" && nonOkStatus.latest === null
  && nonOkStatus.updateAvailable === false, JSON.stringify(nonOkStatus));
check("a redirect status is refused instead of followed (never treated as a 200)",
  (await serviceFor(makeInstall({ version: "0.3.0" }), {
    fetchImpl: fakeFetch({ status: 302, body: "" }), gitRunner: fakeGit().runner,
  }).status()).reason === "network-unavailable");
check("a response that resolved to another origin is refused even if the fetch followed it",
  (await serviceFor(makeInstall({ version: "0.3.0" }), {
    fetchImpl: fakeFetch({ url: "https://evil.example/package.json" }), gitRunner: fakeGit().runner,
  }).status()).reason === "network-unavailable");

check("a body over 64 KiB is refused as network-unavailable (the cap is bytes read, not declared)",
  (await serviceFor(makeInstall({ version: "0.3.0" }), {
    fetchImpl: fakeFetch({ body: "x".repeat(MAX_VERSION_BODY_BYTES + 1) }), gitRunner: fakeGit().runner,
  }).status()).reason === "network-unavailable");
let textRead = false;
const declaredHuge = async () => ({
  status: 200,
  url: VERSION_URL,
  headers: { get: () => String(MAX_VERSION_BODY_BYTES + 1) },
  text: async () => { textRead = true; return JSON.stringify({ version: "0.4.0" }); },
});
check("an oversized declared length is refused before the body is read (a lying header cannot force a read)",
  (await serviceFor(makeInstall({ version: "0.3.0" }), {
    fetchImpl: declaredHuge, gitRunner: fakeGit().runner,
  }).status()).reason === "network-unavailable" && textRead === false);

// ---------- 11b. H5 — the 64 KiB cap is enforced WHILE streaming ----------
//
// The finding: `response.text()` buffered the whole body before the cap was applied, so an oversized
// (or endless) response was read into memory first. These fakes expose a `body` reader and count every
// pull, so "refused at the cap" is distinguishable from "refused after reading everything".

/** A Response-like object with a chunked `body`; `text()` exists only to prove it is not used. */
const streamFetch = ({ chunks, status = 200, url = VERSION_URL, failAt = null } = {}) => {
  const impl = async () => {
    let index = 0;
    return {
      status,
      url,
      headers: { get: () => null },
      body: {
        getReader: () => ({
          read: async () => {
            if (failAt !== null && index >= failAt) throw new Error("stream failed at C:\\secret\\token");
            if (index >= chunks.length) return { done: true, value: undefined };
            const value = chunks[index];
            index += 1;
            impl.pulls += 1;
            impl.pulledBytes += value.byteLength;
            return { done: false, value };
          },
          cancel: async () => { impl.cancelled += 1; },
        }),
      },
      text: async () => { impl.textCalls += 1; return ""; },
    };
  };
  impl.calls = [];
  impl.pulls = 0;
  impl.pulledBytes = 0;
  impl.cancelled = 0;
  impl.textCalls = 0;
  return impl;
};

const CHUNK = 16 * 1024;
const oversizedStream = streamFetch({ chunks: Array.from({ length: 8 }, () => Buffer.alloc(CHUNK, 0x78)) });
const oversizedStreamStatus = await serviceFor(makeInstall({ version: "0.3.0" }), {
  fetchImpl: oversizedStream, gitRunner: fakeGit().runner }).status();
check("H5: a streaming body over the cap is network-unavailable",
  oversizedStreamStatus.reason === "network-unavailable" && oversizedStreamStatus.latest === null,
  JSON.stringify({ reason: oversizedStreamStatus.reason, pulled: oversizedStream.pulledBytes }));
check("H5: the oversize is detected at the cap — the reader is cancelled, not drained (128 KiB offered)",
  oversizedStream.cancelled >= 1
  && oversizedStream.pulledBytes <= MAX_VERSION_BODY_BYTES + CHUNK
  && oversizedStream.pulls <= Math.ceil(MAX_VERSION_BODY_BYTES / CHUNK) + 1
  && oversizedStream.textCalls === 0,
  JSON.stringify({ pulls: oversizedStream.pulls, pulled: oversizedStream.pulledBytes,
    cancelled: oversizedStream.cancelled, textCalls: oversizedStream.textCalls }));

/** A JSON document padded to exactly `size` bytes. */
const paddedBody = (size) => {
  const shell = JSON.stringify({ version: "0.4.0", pad: "" });
  return JSON.stringify({ version: "0.4.0", pad: "x".repeat(size - Buffer.byteLength(shell)) });
};
const exactBody = paddedBody(MAX_VERSION_BODY_BYTES);
check("H5: a body of exactly 64 KiB is accepted (the cap is inclusive)",
  Buffer.byteLength(exactBody) === MAX_VERSION_BODY_BYTES
  && (await serviceFor(makeInstall({ version: "0.3.0" }), {
    fetchImpl: streamFetch({ chunks: [Buffer.from(exactBody)] }), gitRunner: fakeGit().runner,
  }).status()).canUpdate === true, String(Buffer.byteLength(exactBody)));

const overBody = paddedBody(MAX_VERSION_BODY_BYTES + 1);
const overStream = streamFetch({ chunks: [Buffer.from(overBody.slice(0, CHUNK)), Buffer.from(overBody.slice(CHUNK))] });
check("H5: 64 KiB + 1 byte is refused even when it arrives in two chunks",
  (await serviceFor(makeInstall({ version: "0.3.0" }), {
    fetchImpl: overStream, gitRunner: fakeGit().runner }).status()).reason === "network-unavailable"
  && overStream.cancelled >= 1, JSON.stringify({ pulled: overStream.pulledBytes }));

const brokenStream = streamFetch({ chunks: [Buffer.from(JSON.stringify({ version: "0.4.0" }))], failAt: 0 });
const brokenStreamStatus = await serviceFor(makeInstall({ version: "0.3.0" }), {
  fetchImpl: brokenStream, gitRunner: fakeGit().runner }).status();
check("H5: a stream that errors mid-read is network-unavailable with no upstream text (§4.6)",
  brokenStreamStatus.reason === "network-unavailable"
  && !JSON.stringify(brokenStreamStatus).includes("secret")
  && !JSON.stringify(brokenStreamStatus).includes("stream failed"),
  JSON.stringify(brokenStreamStatus));

const throwingFetch = async () => { throw new Error("ECONNREFUSED 203.0.113.9:443 at C:\\secret\\token"); };
const thrownStatus = await serviceFor(makeInstall({ version: "0.3.0" }), {
  fetchImpl: throwingFetch, gitRunner: fakeGit().runner }).status();
check("a thrown fetch error is network-unavailable with no upstream text in the payload (§4.6)",
  thrownStatus.reason === "network-unavailable"
  && !JSON.stringify(thrownStatus).includes("ECONNREFUSED")
  && !JSON.stringify(thrownStatus).includes("secret"), JSON.stringify(thrownStatus));

// internal-error is the fail-closed fallback: a seam that throws must become a closed code, never an
// escaped exception and never an exception message in the payload.
const brokenClock = () => { throw new Error("clock failed at C:\\secret\\path"); };
const brokenStatus = await serviceFor(makeInstall({ version: "0.3.0" }), {
  fetchImpl: fakeFetch({ body: JSON.stringify({ version: "0.4.0" }) }),
  gitRunner: fakeGit().runner, now: brokenClock }).status();
check("a throwing seam is internal-error in status, with no exception text in the payload",
  brokenStatus.ok === true && brokenStatus.reason === "internal-error"
  && brokenStatus.canUpdate === false && !JSON.stringify(brokenStatus).includes("secret"),
  JSON.stringify(brokenStatus));
const brokenApply = await serviceFor(makeInstall({ version: "0.3.0" }), {
  fetchImpl: fakeFetch({ body: JSON.stringify({ version: "0.4.0" }) }),
  gitRunner: fakeGit().runner, now: brokenClock }).apply();
check("a throwing seam is internal-error (500) in apply, with the fixed sentence",
  brokenApply.ok === false && brokenApply.code === "internal-error" && brokenApply.status === 500
  && brokenApply.error === REASON_MESSAGES["internal-error"], JSON.stringify(brokenApply));

// ---------- 12. the network and git surfaces are exactly as contracted ----------

const surface = installAndGit("0.3.0", "0.4.0");
const surfaceFetch = fakeFetch({ body: JSON.stringify({ version: "0.4.0" }) });
process.env.DSH_WIKI_FAKE_TOKEN = "tok-should-never-be-forwarded";
await serviceFor(surface.install, { fetchImpl: surfaceFetch, gitRunner: surface.git.runner }).apply();
delete process.env.DSH_WIKI_FAKE_TOKEN;
const onlyCall = surfaceFetch.calls[0] ?? {};
const sentHeaderNames = Object.keys(onlyCall.options?.headers ?? {}).map((key) => key.toLowerCase());
check("exactly one request, to the pinned URL, with no credentials and no redirect following",
  surfaceFetch.calls.length === 1 && onlyCall.url === VERSION_URL
  && onlyCall.options?.redirect === "manual" && onlyCall.options?.signal !== undefined
  && onlyCall.options?.credentials === "omit"
  && !sentHeaderNames.includes("authorization") && !sentHeaderNames.includes("cookie"),
  JSON.stringify(surfaceFetch.calls.map((call) => ({ url: call.url, redirect: call.options?.redirect }))));
check("every git call is an argv array with the install as cwd, a timeout and GIT_TERMINAL_PROMPT=0",
  surface.git.calls.length > 0
  && surface.git.calls.every((call) => Array.isArray(call.argv)
    && call.argv.every((argument) => typeof argument === "string")
    && call.options?.cwd === surface.install.dir
    && call.options?.env?.GIT_TERMINAL_PROMPT === "0"
    && Number.isInteger(call.options?.timeoutMs) && call.options.timeoutMs > 0),
  JSON.stringify(surface.git.calls.map((call) => call.argv)));
check("no git call is a shell string and no ambient token is forwarded to the child",
  surface.git.calls.every((call) => call.options?.shell === undefined)
  && surface.git.calls.every((call) => {
    const env = call.options?.env ?? {};
    return !Object.keys(env).some((key) => /token|secret|password|authorization|credential/i.test(key))
      && env.DSH_WIKI_FAKE_TOKEN === undefined;
  }),
  JSON.stringify(surface.git.calls[0]?.options?.env));
check("the git operations are exactly the contracted argv arrays",
  ["rev-parse --is-inside-work-tree", "rev-parse --show-toplevel", "remote get-url origin", "status --porcelain",
    "rev-parse HEAD", "fetch --tags --prune origin", "rev-parse --verify --quiet refs/tags/v0.4.0",
    "rev-parse --verify --quiet refs/tags/0.4.0", "rev-parse --verify --quiet origin/main",
    `checkout --detach ${HEAD_B}`].every((command) => hasGit(surface.git.calls, command)),
  JSON.stringify(gitLines(surface.git.calls)));

// ---------- 12b. H1 — git must not inherit user, system or repository configuration ----------
//
// The finding: every git call inherited HOME/USERPROFILE, so git read `~/.gitconfig` (credential
// helpers, `url.*.insteadOf`, `core.sshCommand`) and the checkout's own `.git/config` and
// `.git/hooks/*` — a self-update could therefore run a hook shipped by the repository it is updating.
// The checks below sample the H1 sandbox INSIDE the fake runner (i.e. exactly while the child would be
// running) and again after the call returned (the `finally` cleanup).

const hardened = installAndGit("0.3.0", "0.4.0");
const hardenedRunner = hardenedGit(hardened.git);
const hardenedFetch = fakeFetch({ body: JSON.stringify({ version: "0.4.0" }) });
const hardenedResult = await serviceFor(hardened.install, {
  fetchImpl: hardenedFetch, gitRunner: hardenedRunner.runner }).apply();
const seen = hardenedRunner.observations;

check("H1: every git invocation carries the exact -c prefix, before the subcommand",
  hardenedResult.ok === true && seen.length > 0 && seen.every((row) => row.prefixOk)
  && hardened.git.calls.every((call) => prefixMatches(call.argv)),
  JSON.stringify(seen.filter((row) => !row.prefixOk).map((row) => row.argv)));
const expectedGitPrefix = (hooksPath) => [
  "-c", "credential.helper=",
  "-c", "credential.interactive=never",
  "-c", `core.hooksPath=${hooksPath}`,
  "-c", "core.fsmonitor=false",
  "-c", "submodule.recurse=false",
  "-c", "protocol.allow=never",
  "-c", "protocol.https.allow=always",
];
check("H1: the prefix is exactly the seven contracted -c settings, in order",
  seen.length > 0 && seen.every((row) => row.argv.slice(0, GIT_PREFIX_LENGTH).join("\u0000")
    === expectedGitPrefix(row.hooksPath).join("\u0000")),
  JSON.stringify(seen[0]?.argv.slice(0, GIT_PREFIX_LENGTH)));
check("H1: GIT_CONFIG_NOSYSTEM=1 and an empty GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM are in every child env",
  seen.every((row) => row.nosystem === "1" && row.configPath.length > 0
    && row.systemConfig === row.configPath && row.configExists && row.configEmpty),
  JSON.stringify({ nosystem: seen[0]?.nosystem, global: seen[0]?.configPath,
    system: seen[0]?.systemConfig, empty: seen[0]?.configEmpty }));

// The hooks path must be a real, EMPTY directory at call time: an empty `core.hooksPath` target would
// make git fall back to reading `<repo>/.git/hooks` (config.h: an empty value is treated as unset), so
// "exists and is empty" is the property that makes hook execution impossible.
check("H1: the core.hooksPath target exists and is empty at call time (never the install's .git/hooks)",
  seen.every((row) => row.hooksExists && row.hooksEmpty)
  && seen.every((row) => {
    const hooksReal = path.resolve(row.hooksPath);
    const repoHooks = path.resolve(hardened.install.dir, ".git", "hooks");
    const compare = (value) => (process.platform === "win32" ? value.toLowerCase() : value);
    return compare(hooksReal) !== compare(repoHooks)
      && !compare(hooksReal).startsWith(compare(path.resolve(hardened.install.dir)) + path.sep);
  }),
  JSON.stringify(seen.map((row) => ({ hooks: row.hooksPath, exists: row.hooksExists, empty: row.hooksEmpty }))));
check("H1: the hooks dir and the config file live outside the install, under os.tmpdir()",
  seen.every((row) => {
    const inTemp = (value) => {
      const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(value));
      return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
    };
    return inTemp(row.hooksPath) && inTemp(row.configPath);
  }),
  JSON.stringify(seen.map((row) => ({ hooks: row.hooksPath, config: row.configPath }))));

// `finally` cleanup: nothing created for a call outlives it.
check("H1: every per-call hooks dir and config file is removed afterwards (finally cleanup)",
  seen.length > 0
  && seen.every((row) => !existsSync(row.hooksPath) && !existsSync(row.configPath)
    && !existsSync(path.dirname(row.hooksPath))),
  JSON.stringify(seen.filter((row) => existsSync(row.hooksPath) || existsSync(row.configPath))
    .map((row) => row.hooksPath)));

// The prefix is behaviour-neutral except for the settings it pins: the very same operations still run.
check("H1: hardening does not change which operations run (the prefix is stripped by git, not by us)",
  seen.every((row) => gitArgs(row.argv).length > 0)
  && hasGit(hardened.git.calls, "fetch --tags --prune origin")
  && hardened.git.head() === HEAD_B,
  JSON.stringify(gitLines(hardened.git.calls)));

// ---------- 13. routes: the HTTP surface (fake ctx, injected seams) ----------

const makeCtx = (profileContext) => {
  const registered = { skills: [], commands: [], routes: [] };
  const warnings = [];
  const ctx = {
    effect: (fn) => fn(),
    get: (key) => ctx[key],
    on: () => () => {},
    skills: { register: (skill) => { registered.skills.push(skill); return () => {}; } },
    commands: { register: (command) => { registered.commands.push(command); return () => {}; } },
    webServer: { port: 19390, register: (route) => { registered.routes.push(route); return () => {}; } },
    logger: { warn: (message) => warnings.push(String(message)) },
  };
  // spec 016 §3.2: the plugin reads `ctx.get("profileContext").home` to locate the installed package
  // path. Omitting it is the "profile home unavailable" case.
  if (profileContext !== undefined) ctx.profileContext = profileContext;
  return { ctx, registered, warnings };
};

/**
 * Installs the plugin with the real update service but fixture seams. The factory still receives the
 * plugin's own options (`pluginRoot`/`enabled`); only the fixture path and the fakes are substituted,
 * so the route, the preflight and the projection under test are the production code paths.
 */
const routesFor = ({
  enabled = false, install, profileHome, profileModuleRoot, fetchImpl, gitRunner, now = FIXED_NOW,
} = {}) => {
  const seam = plugin.__updateInternals;
  const realFactory = seam.createUpdateService;
  const realResolve = seam.resolveInstallPath;
  const constructed = [];
  const counts = { status: 0, apply: 0 };
  // No fixture can be the plugin's own module root (`import.meta.url` points at this checkout), so a
  // profile fixture pins the root the resolver compares against — still calling the production
  // resolver with the `home` the plugin itself read from profileContext.home. Without a pin the
  // production call site runs unchanged (that is what the "own module root" case below asserts).
  seam.resolveInstallPath = profileModuleRoot === undefined
    ? realResolve
    : (home) => realResolve(home, profileModuleRoot);
  seam.createUpdateService = (options) => {
    // Recorded before any fixture substitution: `installPath`/`pluginRoot` here are what the plugin
    // itself resolved from `profileHome`, which is what the fallback cases assert.
    constructed.push(options);
    const service = realFactory({
      ...options,
      // A fixture install replaces both the module root and the resolved install path. For a profile
      // home without the package path they are the same value anyway (the fallback under test).
      ...(install ? { pluginRoot: install.dir, installPath: install.dir } : {}),
      fetchImpl, gitRunner, now,
    });
    return {
      enabled: service.enabled,
      status: () => { counts.status += 1; return service.status(); },
      apply: () => { counts.apply += 1; return service.apply(); },
    };
  };
  const { ctx, registered, warnings } = makeCtx(profileHome === undefined ? undefined : { home: profileHome });
  try {
    plugin.apply(ctx, { wikiRoots: [], update: { enabled } });
  } finally {
    seam.createUpdateService = realFactory;
    seam.resolveInstallPath = realResolve;
  }
  const route = registered.routes.find((candidate) => candidate?.path === "/dsh-wiki");
  return { handler: route?.handler, constructed, counts, warnings };
};

const resOf = () => {
  const res = { status: 0, headers: null, body: "" };
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
  res.end = (chunk) => { res.body = chunk ?? ""; };
  res.once = () => {};
  return res;
};
const parsed = (res) => {
  let json = null;
  try { json = JSON.parse(res.body); } catch { /* not JSON */ }
  return { status: res.status, json, body: res.body, headers: res.headers };
};
const httpGet = async (handler, url) => {
  const res = resOf();
  await handler({ method: "GET", headers: { host: HOST }, url }, res);
  return parsed(res);
};
const httpPost = async (handler, url, payload, overrides = {}) => {
  const text = payload === undefined ? "" : typeof payload === "string" ? payload : JSON.stringify(payload);
  const req = {
    method: "POST",
    url,
    headers: {
      host: HOST,
      origin: `http://${HOST}`,
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(text)),
      ...overrides,
    },
  };
  req[Symbol.asyncIterator] = async function* () { if (text) yield Buffer.from(text, "utf8"); };
  const res = resOf();
  await handler(req, res);
  return parsed(res);
};

// 13a. §4.1 through the real route: disabled answers 200 and makes no request.
const disabledRouteFetch = forbiddenFetch();
const disabledRouteGit = forbiddenGit();
const disabledRoutes = routesFor({ enabled: false, install: makeInstall({ version: "0.3.0" }),
  fetchImpl: disabledRouteFetch, gitRunner: disabledRouteGit });
const disabledHttp = await httpGet(disabledRoutes.handler, "/dsh-wiki/api/update/status");
const disabledHttpAgain = await httpGet(disabledRoutes.handler, "/dsh-wiki/api/update/status");
check("route: GET /api/update/status answers the exact §3.2 disabled projection",
  disabledHttp.status === 200 && disabledHttp.json?.ok === true && disabledHttp.json?.enabled === false
  && disabledHttp.json?.latest === null && disabledHttp.json?.reason === "update-disabled"
  && disabledHttp.json?.updateAvailable === false && disabledHttp.json?.canUpdate === false
  && disabledHttp.json?.reloadRequired === false
  && disabledHttp.json?.installed?.version === "0.3.0"
  && disabledHttp.json?.installed?.installKind === "install", JSON.stringify(disabledHttp.json));
check("route: the disabled status path makes no network request and no git call (§4.1)",
  disabledHttpAgain.status === 200 && disabledRoutes.counts.status === 2
  && disabledRouteFetch.calls.length === 0 && disabledRouteGit.calls.length === 0,
  JSON.stringify({ fetch: disabledRouteFetch.calls.length, git: disabledRouteGit.calls.length }));
check("route: the service is constructed disabled, so no request can happen",
  disabledRoutes.constructed.length === 1 && disabledRoutes.constructed[0].enabled === false);

// 13b. §4.6 through the real route: no path anywhere, both install kinds.
const installRoutes = routesFor({ enabled: true, install: makeInstall({ version: "0.3.0" }),
  fetchImpl: fakeFetch({ body: JSON.stringify({ version: "0.4.0" }) }), gitRunner: fakeGit().runner });
const installHttp = await httpGet(installRoutes.handler, "/dsh-wiki/api/update/status");
check("route: status for a real-directory install projects install/available/canUpdate",
  installHttp.status === 200 && installHttp.json?.installed?.installKind === "install"
  && installHttp.json?.latest?.version === "0.4.0" && installHttp.json?.latest?.source === VERSION_HOST
  && installHttp.json?.updateAvailable === true && installHttp.json?.canUpdate === true
  && installHttp.json?.reason === null, JSON.stringify(installHttp.json));
noPathShape("route: install status", installHttp.json, [installRoutes.constructed[0]?.pluginRoot]);

const linkRouteFetch = forbiddenFetch();
const linkRouteGit = forbiddenGit();
const linkRoutes = routesFor({ enabled: true, install: makeInstall({ version: "0.3.0", kind: "development-link" }),
  fetchImpl: linkRouteFetch, gitRunner: linkRouteGit });
const linkHttp = await httpGet(linkRoutes.handler, "/dsh-wiki/api/update/status");
check("route: status for a symlinked install reports development-link and refuses the update",
  linkHttp.status === 200 && linkHttp.json?.installed?.installKind === "development-link"
  && linkHttp.json?.canUpdate === false && linkHttp.json?.reason === "install-is-development-link"
  && linkHttp.json?.latest === null, JSON.stringify(linkHttp.json));
noPathShape("route: development-link status", linkHttp.json, [linkRoutes.constructed[0]?.pluginRoot]);
check("route: the development-link status path never runs git or the network (§4.2)",
  linkRouteGit.calls.length === 0 && linkRouteFetch.calls.length === 0,
  JSON.stringify({ git: linkRouteGit.calls.length, fetch: linkRouteFetch.calls.length }));
check("route: a query parameter cannot open a project gate or change the answer",
  JSON.stringify((await httpGet(linkRoutes.handler,
    "/dsh-wiki/api/update/status?root=C%3A%5CWindows%5Csecret")).json) === JSON.stringify(linkHttp.json));

// 13c. the confirm token: absent/wrong => refused and the service is never invoked.
const tokenRoutes = routesFor({ enabled: true, install: makeInstall({ version: "0.3.0" }),
  fetchImpl: fakeFetch(), gitRunner: fakeGit().runner });
const noConfirm = await httpPost(tokenRoutes.handler, "/dsh-wiki/api/update", {});
const wrongConfirm = await httpPost(tokenRoutes.handler, "/dsh-wiki/api/update", { confirm: "install" });
const arrayConfirm = await httpPost(tokenRoutes.handler, "/dsh-wiki/api/update", { confirm: ["install-update"] });
check("route: a missing confirm token is 400 confirmation-required",
  noConfirm.status === 400 && noConfirm.json?.code === "confirmation-required"
  && typeof noConfirm.json?.error === "string", JSON.stringify(noConfirm.json));
check("route: a wrong or non-string confirm token is 400 confirmation-required",
  wrongConfirm.status === 400 && wrongConfirm.json?.code === "confirmation-required"
  && arrayConfirm.status === 400 && arrayConfirm.json?.code === "confirmation-required",
  JSON.stringify([wrongConfirm.json?.code, arrayConfirm.json?.code]));
check("route: a refused token never invokes the service (no network, no git, no disk)",
  tokenRoutes.counts.apply === 0, JSON.stringify(tokenRoutes.counts));

// 13d. the existing HTTP fences are unchanged on the write path.
const crossOrigin = await httpPost(tokenRoutes.handler, "/dsh-wiki/api/update",
  { confirm: CONFIRM_TOKEN }, { origin: "http://evil.example" });
const plainText = await httpPost(tokenRoutes.handler, "/dsh-wiki/api/update",
  { confirm: CONFIRM_TOKEN }, { "content-type": "text/plain" });
const unknownField = await httpPost(tokenRoutes.handler, "/dsh-wiki/api/update",
  { confirm: CONFIRM_TOKEN, root: "C:\\secret" });
const getOnPostRoute = await httpGet(tokenRoutes.handler, "/dsh-wiki/api/update");
check("route: a cross-origin POST is 403 cross-origin and never reaches the service",
  crossOrigin.status === 403 && crossOrigin.json?.code === "cross-origin" && tokenRoutes.counts.apply === 0,
  JSON.stringify(crossOrigin.json));
check("route: a non-JSON content-type is 415 and never reaches the service",
  plainText.status === 415 && plainText.json?.code === "content-type" && tokenRoutes.counts.apply === 0,
  JSON.stringify(plainText.json));
check("route: an unknown body field is 400 and its value is not reflected back",
  unknownField.status === 400 && unknownField.json?.code === "unsupported-field"
  && !unknownField.body.includes("secret"), JSON.stringify(unknownField.json));
check("route: GET on the write route is 405",
  getOnPostRoute.status === 405, JSON.stringify(getOnPostRoute.json));

// 13e. the happy path through the route.
const applyPair = installAndGit("0.3.0", "0.4.0");
const applyRoutes = routesFor({ enabled: true, install: applyPair.install,
  fetchImpl: fakeFetch({ body: JSON.stringify({ version: "0.4.0" }) }), gitRunner: applyPair.git.runner });
const applyHttp = await httpPost(applyRoutes.handler, "/dsh-wiki/api/update", { confirm: CONFIRM_TOKEN });
check("route: a confirmed update answers 200 with from/to and reloadRequired (§3.3)",
  applyHttp.status === 200 && applyHttp.json?.ok === true && applyHttp.json?.applied === true
  && applyHttp.json?.from === "0.3.0" && applyHttp.json?.to === "0.4.0"
  && applyHttp.json?.reloadRequired === true, JSON.stringify(applyHttp.json));
noPathShape("route: update success", applyHttp.json);
check("route: the successful update resolves and checks out exactly one revision",
  applyPair.git.head() === HEAD_B && checkoutTargets(applyPair.git.calls).length === 1,
  JSON.stringify(gitLines(applyPair.git.calls)));

// 13f. §4.8 through the route: two concurrent POSTs run exactly one update.
const racePair = installAndGit("0.3.0", "0.4.0", { delayMs: 20 });
const raceRoutes = routesFor({ enabled: true, install: racePair.install,
  fetchImpl: fakeFetch({ body: JSON.stringify({ version: "0.4.0" }) }), gitRunner: racePair.git.runner });
const raceResponses = await Promise.all([
  httpPost(raceRoutes.handler, "/dsh-wiki/api/update", { confirm: CONFIRM_TOKEN }),
  httpPost(raceRoutes.handler, "/dsh-wiki/api/update", { confirm: CONFIRM_TOKEN }),
]);
const raceCodes = raceResponses
  .map((response) => (response.status === 200 ? "applied" : response.json?.code)).sort();
check("two concurrent POSTs: exactly one update runs, the other gets update-in-progress (§4.8)",
  raceCodes.join(",") === "applied,update-in-progress", JSON.stringify(raceCodes));
check("the single-flight loser performed no checkout (one update, one revision change)",
  checkoutTargets(racePair.git.calls).length === 1, JSON.stringify(gitLines(racePair.git.calls)));

// 13g. refusals through the route: fixed sentence + closed code, never a path, never a checkout.
const enclosingDir = path.join(ROOT, `route-enclosing-${++seq}`);
mkdirSync(enclosingDir, { recursive: true });
const refusalCases = [
  { label: "dirty install", git: fakeGit({ clean: false }), published: "0.4.0", code: "install-dirty" },
  { label: "downgrade", git: fakeGit(), published: "0.2.0", code: "latest-not-newer" },
  { label: "equal version", git: fakeGit(), published: "0.3.0", code: "latest-not-newer" },
  { label: "foreign origin", git: fakeGit({ origin: "https://github.com/evil/dsh-wiki.git" }),
    published: "0.4.0", code: "install-origin-mismatch" },
  { label: "not a worktree", git: fakeGit({ workTree: false }), published: "0.4.0", code: "install-not-git" },
  { label: "inside an enclosing repository", git: fakeGit({ topLevel: enclosingDir }),
    published: "0.4.0", code: "install-not-worktree-root" },
  { label: "invalid published version", git: fakeGit(), published: "0.4", code: "version-invalid" },
];
const refusalRows = [];
for (const row of refusalCases) {
  const routes = routesFor({ enabled: true, install: makeInstall({ version: "0.3.0" }),
    fetchImpl: fakeFetch({ body: JSON.stringify({ version: row.published }) }), gitRunner: row.git.runner });
  const response = await httpPost(routes.handler, "/dsh-wiki/api/update", { confirm: CONFIRM_TOKEN });
  refusalRows.push({ label: row.label, expected: row.code, body: response.body,
    status: response.status, code: response.json?.code, error: response.json?.error,
    checkouts: checkoutTargets(row.git.calls).length });
}
check("route: every preflight refusal is 409 with its closed code and its fixed sentence",
  refusalRows.every((row) => row.status === 409 && row.code === row.expected && row.error === REASON_MESSAGES[row.code]),
  JSON.stringify(refusalRows.map((row) => ({ label: row.label, want: row.expected, got: row.code }))));
check("route: no refusal checks out a revision",
  refusalRows.every((row) => row.checkouts === 0), JSON.stringify(refusalRows.map((row) => row.checkouts)));
noPathShape("route: refusal bodies", refusalRows.map((row) => row.body));

// A postcondition failure through the route must report the restore, and leak nothing.
const restoreRoutes = routesFor({ enabled: true, install: makeInstall({ version: "0.3.0" }),
  fetchImpl: fakeFetch({ body: JSON.stringify({ version: "0.4.0" }) }), gitRunner: fakeGit().runner });
const restoreHttp = await httpPost(restoreRoutes.handler, "/dsh-wiki/api/update", { confirm: CONFIRM_TOKEN });
check("route: postcondition failure answers 409, reports restored:true and the fixed sentence (§4.6)",
  restoreHttp.status === 409 && restoreHttp.json?.code === "postcondition-failed"
  && restoreHttp.json?.restored === true
  && restoreHttp.json?.error === REASON_MESSAGES["postcondition-failed"], JSON.stringify(restoreHttp.json));
noPathShape("route: postcondition refusal", restoreHttp.json);

// ---------- 13h. §3.2 — which path is inspected is the profile-installed package path ----------
//
// Node's ESM loader resolves module URLs to their realpath, so the plugin cannot see the profile link
// from its own module root (`path.resolve(libDir, "..")` is the development tree). The measured layout
// on this machine is `<data root>/profiles/<name>/node_modules/@dsh-ext/dsh-wiki` — there is no
// `<data root>/node_modules`. These cases drive the real plugin.apply with a profileContext.home and
// assert the resolved install path, the refusal it produces, and that no public payload carries a path.

const linkedProfile = makeProfile("development-link");
const linkedGit = forbiddenGit();
const linkedFetch = forbiddenFetch();
const linkedWeb = routesFor({ enabled: true, profileHome: linkedProfile.home,
  profileModuleRoot: linkedProfile.moduleRoot, fetchImpl: linkedFetch, gitRunner: linkedGit });
const linkedHttp = await httpGet(linkedWeb.handler, "/dsh-wiki/api/update/status");
check("profile-linked symlink: the installed package path is inspected, not the module root (§3.2)",
  linkedWeb.constructed.length === 1
  && linkedWeb.constructed[0].installPath === linkedProfile.candidate
  && linkedWeb.constructed[0].pluginRoot !== linkedProfile.candidate,
  JSON.stringify({ installPath: linkedWeb.constructed[0]?.installPath,
    pluginRoot: linkedWeb.constructed[0]?.pluginRoot, candidate: linkedProfile.candidate }));
check("profile-linked symlink: status reports installKind development-link and reads through the link",
  linkedHttp.status === 200 && linkedHttp.json?.installed?.installKind === "development-link"
  && linkedHttp.json?.installed?.version === "0.3.0", JSON.stringify(linkedHttp.json?.installed));
check("profile-linked symlink: enabled:true refuses install-is-development-link with zero git/network (§4.2)",
  linkedHttp.json?.canUpdate === false && linkedHttp.json?.reason === "install-is-development-link"
  && linkedHttp.json?.latest === null && linkedGit.calls.length === 0 && linkedFetch.calls.length === 0,
  JSON.stringify({ reason: linkedHttp.json?.reason, git: linkedGit.calls.length, fetch: linkedFetch.calls.length }));

const linkedDisabledWeb = routesFor({ enabled: false, profileHome: linkedProfile.home,
  profileModuleRoot: linkedProfile.moduleRoot, fetchImpl: forbiddenFetch(), gitRunner: forbiddenGit() });
const linkedDisabledHttp = await httpGet(linkedDisabledWeb.handler, "/dsh-wiki/api/update/status");
check("profile-linked symlink: update-disabled still wins over install-is-development-link (step 1 before 3)",
  linkedDisabledHttp.status === 200 && linkedDisabledHttp.json?.reason === "update-disabled"
  && linkedDisabledHttp.json?.canUpdate === false
  && linkedDisabledHttp.json?.installed?.installKind === "development-link",
  JSON.stringify(linkedDisabledHttp.json));

const dirProfile = makeProfile("install");
const dirGit = fakeGit();
const dirWeb = routesFor({ enabled: true, profileHome: dirProfile.home,
  profileModuleRoot: dirProfile.moduleRoot,
  fetchImpl: fakeFetch({ body: JSON.stringify({ version: "0.4.0" }) }), gitRunner: dirGit.runner });
const dirHttp = await httpGet(dirWeb.handler, "/dsh-wiki/api/update/status");
check("profile-linked real directory: installKind install and the normal preflight continues",
  dirWeb.constructed[0]?.installPath === dirProfile.candidate
  && dirHttp.status === 200 && dirHttp.json?.installed?.installKind === "install"
  && dirHttp.json?.installed?.version === "0.3.0" && dirHttp.json?.latest?.version === "0.4.0"
  && dirHttp.json?.canUpdate === true && dirHttp.json?.reason === null, JSON.stringify(dirHttp.json));
check("profile-linked real directory: every git call runs with the installed package path as cwd",
  dirGit.calls.length > 0 && dirGit.calls.every((call) => call.options?.cwd === dirProfile.candidate),
  JSON.stringify(dirGit.calls.map((call) => call.options?.cwd)));

const legacyProfile = makeLegacyProfile("install");
const legacyGit = fakeGit();
const legacyWeb = routesFor({ enabled: true, profileHome: legacyProfile.home,
  profileModuleRoot: legacyProfile.moduleRoot,
  fetchImpl: fakeFetch({ body: JSON.stringify({ version: "0.4.0" }) }), gitRunner: legacyGit.runner });
const legacyHttp = await httpGet(legacyWeb.handler, "/dsh-wiki/api/update/status");
check("legacy layout <home>/node_modules/@dsh-ext/dsh-wiki: still resolved and inspected (backwards-compatible)",
  legacyWeb.constructed[0]?.installPath === legacyProfile.candidate
  && legacyHttp.json?.installed?.installKind === "install"
  && legacyHttp.json?.installed?.version === "0.3.0",
  JSON.stringify({ installPath: legacyWeb.constructed[0]?.installPath, installed: legacyHttp.json?.installed }));

// This machine's actual install: <data root>/profiles/desktop/node_modules/@dsh-ext/dsh-wiki is a link
// to the development tree this test lives in. No fixture seam here, so the production call site must
// pass its own module root for the resolver to match — and §3.4.3 must then refuse it as a link.
const ownRoot = path.resolve(here, "..");
const ownHome = path.join(ROOT, `own-home-${++seq}`);
const ownCandidate = path.join(ownHome, "profiles", PROFILE_NAME, "node_modules", "@dsh-ext", "dsh-wiki");
mkdirSync(path.dirname(ownCandidate), { recursive: true });
try {
  symlinkSync(ownRoot, ownCandidate, "dir");
} catch {
  symlinkSync(ownRoot, ownCandidate, "junction");
}
const ownGit = forbiddenGit();
const ownFetch = forbiddenFetch();
const ownWeb = routesFor({ enabled: true, profileHome: ownHome, fetchImpl: ownFetch, gitRunner: ownGit });
const ownHttp = await httpGet(ownWeb.handler, "/dsh-wiki/api/update/status");
const ownVersion = JSON.parse(readFileSync(path.join(ownRoot, "package.json"), "utf8")).version;
check("real layout: apply finds this repo's own profile link under <home>/profiles/desktop/... and refuses it as development-link",
  ownWeb.constructed[0]?.installPath === ownCandidate
  && ownHttp.status === 200 && ownHttp.json?.installed?.installKind === "development-link"
  && ownHttp.json?.installed?.version === ownVersion
  && ownHttp.json?.reason === "install-is-development-link"
  && ownGit.calls.length === 0 && ownFetch.calls.length === 0,
  JSON.stringify({ installPath: ownWeb.constructed[0]?.installPath, installed: ownHttp.json?.installed,
    reason: ownHttp.json?.reason, git: ownGit.calls.length, fetch: ownFetch.calls.length }));

const absentProfile = makeProfile("absent");
const absentGit = forbiddenGit();
const absentFetch = forbiddenFetch();
const absentWeb = routesFor({ enabled: true, profileHome: absentProfile.home,
  profileModuleRoot: absentProfile.moduleRoot, fetchImpl: absentFetch, gitRunner: absentGit });
const absentHttp = await httpGet(absentWeb.handler, "/dsh-wiki/api/update/status");
check("H2: absent installed package path resolves to null — never to the module root",
  absentWeb.constructed.length === 1
  && absentWeb.constructed[0].installPath === null
  && typeof absentWeb.constructed[0].pluginRoot === "string"
  && absentWeb.constructed[0].pluginRoot !== absentProfile.candidate,
  JSON.stringify({ installPath: absentWeb.constructed[0]?.installPath,
    pluginRoot: absentWeb.constructed[0]?.pluginRoot, candidate: absentProfile.candidate }));
check("H2: absent path => installKind unknown + install-not-found, zero git and zero network",
  absentHttp.status === 200 && absentHttp.json?.installed?.installKind === "unknown"
  && absentHttp.json?.reason === "install-not-found" && absentHttp.json?.canUpdate === false
  && absentHttp.json?.latest === null
  && absentGit.calls.length === 0 && absentFetch.calls.length === 0,
  JSON.stringify({ payload: absentHttp.json, git: absentGit.calls.length, fetch: absentFetch.calls.length }));

// The module root is NOT inspected as a write target: it is a real directory (`lstat` would say
// "install"), yet the reported kind stays "unknown" and git is never run in it. Its package.json is
// still read — display-only — so the panel can show a version.
const absentModuleRoot = absentWeb.constructed[0]?.pluginRoot;
const absentModuleVersion = (() => {
  try { return JSON.parse(readFileSync(path.join(absentModuleRoot, "package.json"), "utf8")).version; } catch { return null; }
})();
check("H2: the module root keeps supplying the display-only installed.version from a read-only read",
  absentHttp.json?.installed?.version === absentModuleVersion
  && absentModuleVersion !== null, JSON.stringify({ reported: absentHttp.json?.installed?.version, module: absentModuleVersion }));
const absentApply = await httpPost(absentWeb.handler, "/dsh-wiki/api/update", { confirm: CONFIRM_TOKEN });
check("H2: apply with no resolved install path is 409 install-not-found and still runs no git",
  absentApply.status === 409 && absentApply.json?.code === "install-not-found"
  && absentApply.json?.error === REASON_MESSAGES["install-not-found"]
  && absentGit.calls.length === 0 && absentFetch.calls.length === 0, JSON.stringify(absentApply.json));

// No profileContext at all, and a relative home: both are unusable homes and fail closed the same way.
const noHomeGit = forbiddenGit();
const noHomeFetch = forbiddenFetch();
const noHomeWeb = routesFor({ enabled: true, fetchImpl: noHomeFetch, gitRunner: noHomeGit });
const noHomeHttp = await httpGet(noHomeWeb.handler, "/dsh-wiki/api/update/status");
const relativeHomeWeb = routesFor({ enabled: true, profileHome: "relative/profile/home",
  fetchImpl: forbiddenFetch(), gitRunner: forbiddenGit() });
const relativeHomeHttp = await httpGet(relativeHomeWeb.handler, "/dsh-wiki/api/update/status");
check("H2: no profileContext / a relative home both resolve to null and refuse install-not-found",
  noHomeWeb.constructed[0]?.installPath === null && relativeHomeWeb.constructed[0]?.installPath === null
  && noHomeHttp.status === 200 && noHomeHttp.json?.reason === "install-not-found"
  && noHomeHttp.json?.installed?.installKind === "unknown"
  && relativeHomeHttp.json?.reason === "install-not-found"
  && noHomeGit.calls.length === 0 && noHomeFetch.calls.length === 0,
  JSON.stringify({ noHome: noHomeHttp.json, relative: relativeHomeHttp.json,
    home: relativeHomeWeb.constructed[0]?.pluginRoot }));

noPathShape("§3.2 profile cases", [linkedHttp.json, linkedDisabledHttp.json, dirHttp.json,
  legacyHttp.json, ownHttp.json, absentHttp.json, absentApply.json, noHomeHttp.json, relativeHomeHttp.json],
[linkedProfile.home, dirProfile.home, legacyProfile.home, ownHome, absentProfile.home,
  linkedProfile.candidate, dirProfile.candidate, legacyProfile.candidate, ownCandidate, absentProfile.candidate]);

// ---------- 13h-bis. resolveInstallPath(home, moduleRoot, deps) on virtual filesystems ----------
//
// lstat/readdir/realpath are injected, so every layout below is plain data: no real symlink, no real
// profile tree, and each failing case names the one behaviour it removes.

const resolveInstallPath = plugin.__updateInternals.resolveInstallPath;
const VHOME = path.join(ROOT, "virtual-home");           // absolute; never touched on disk
const VPROFILES = path.join(VHOME, "profiles");
const vProfile = (name) => path.join(VPROFILES, name, "node_modules", "@dsh-ext", "dsh-wiki");
const vLegacy = path.join(VHOME, "node_modules", "@dsh-ext", "dsh-wiki");
const VDEV = path.join(VHOME, "dev-tree");               // the module-root fixture
const enoent = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });

/**
 * A fake fs for resolveInstallPath: `present` = paths lstat succeeds for; `entries` = the readdir answer
 * per directory; `real` = the realpath answer per path (defaults to the path itself); `fail` = paths or
 * directories whose call throws.
 */
const fakeResolveFs = ({ present = [], entries = {}, real = {}, fail = {} } = {}) => ({
  lstat: (target) => {
    if ((fail.lstat ?? []).includes(target) || !present.includes(target)) throw enoent();
    return { isSymbolicLink: () => false };
  },
  readdir: (dir) => {
    if ((fail.readdir ?? []).includes(dir) || !(dir in entries)) throw enoent();
    return entries[dir];
  },
  realpath: (target) => {
    if ((fail.realpath ?? []).includes(target)) throw enoent();
    return real[target] ?? target;
  },
});
const vDesktop = vProfile(PROFILE_NAME);

// (1) The real layout: a plain-directory install under profiles/<name>/node_modules/...
const plainLayout = fakeResolveFs({ present: [vDesktop], entries: { [VPROFILES]: [PROFILE_NAME] } });
check("resolveInstallPath: a plain-directory install under <home>/profiles/<name>/node_modules/@dsh-ext/dsh-wiki resolves to that path",
  resolveInstallPath(VHOME, vDesktop, plainLayout) === vDesktop,
  String(resolveInstallPath(VHOME, vDesktop, plainLayout)));

// (2) The same layout through a symlink: the LINK path must be returned (not its target), otherwise
// inspectInstallKind would see a plain directory and §3.4.3 would stop refusing it.
const linkedLayout = fakeResolveFs({ present: [vDesktop], entries: { [VPROFILES]: [PROFILE_NAME] },
  real: { [vDesktop]: VDEV } });
check("resolveInstallPath: a symlinked install resolves to the LINK path, not the target (§3.4.3 can then refuse it)",
  resolveInstallPath(VHOME, VDEV, linkedLayout) === vDesktop,
  String(resolveInstallPath(VHOME, VDEV, linkedLayout)));

// (3) Backwards-compatible candidate: <home>/node_modules/@dsh-ext/dsh-wiki (readdir has no profiles
// entry here, so this also proves a failing profiles readdir is caught, not thrown).
const legacyLayout = fakeResolveFs({ present: [vLegacy] });
check("resolveInstallPath: the legacy <home>/node_modules/@dsh-ext/dsh-wiki layout still resolves",
  resolveInstallPath(VHOME, vLegacy, legacyLayout) === vLegacy,
  String(resolveInstallPath(VHOME, vLegacy, legacyLayout)));

// (4) Nothing anywhere: null, never the module root.
const absentLayout = fakeResolveFs({ present: [] });
check("resolveInstallPath: absent everywhere => null (never the module root)",
  resolveInstallPath(VHOME, VDEV, absentLayout) === null,
  String(resolveInstallPath(VHOME, VDEV, absentLayout)));

// (5) A throwing profiles readdir is "no profiles", not an exception.
const noProfilesLayout = fakeResolveFs({ present: [], fail: { readdir: [VPROFILES] } });
let noProfilesResult = "threw";
try { noProfilesResult = resolveInstallPath(VHOME, VDEV, noProfilesLayout); } catch { /* stays "threw" */ }
check("resolveInstallPath: a throwing profiles readdir => null and no throw",
  noProfilesResult === null, String(noProfilesResult));

// (6) A same-named package that is not this module (realpath differs) is not our install.
const foreignLayout = fakeResolveFs({ present: [vDesktop], entries: { [VPROFILES]: [PROFILE_NAME] },
  real: { [vDesktop]: path.join(VHOME, "someone-elses-tree") } });
check("resolveInstallPath: a candidate whose realpath is not the module root is not our install => null",
  resolveInstallPath(VHOME, VDEV, foreignLayout) === null,
  String(resolveInstallPath(VHOME, VDEV, foreignLayout)));

// (7) Two profiles both linking the same module tree: deterministic sorted first, readdir-order independent.
const vProfileA = vProfile("aaa");
const vProfileB = vProfile("bbb");
const twoMatches = (order) => fakeResolveFs({ present: [vProfileA, vProfileB],
  entries: { [VPROFILES]: order }, real: { [vProfileA]: VDEV, [vProfileB]: VDEV } });
const firstOrder = resolveInstallPath(VHOME, VDEV, twoMatches(["bbb", "aaa"]));
const secondOrder = resolveInstallPath(VHOME, VDEV, twoMatches(["aaa", "bbb"]));
check("resolveInstallPath: two matching profiles pick the sorted first, stable across readdir order",
  firstOrder === vProfileA && secondOrder === vProfileA, JSON.stringify({ firstOrder, secondOrder }));

// (8) Unusable homes: missing, empty, relative, non-string.
const unusableHomes = [undefined, null, "", "relative/path", "relative/dir", 42];
check("resolveInstallPath: a missing/empty/relative/non-string home resolves to null",
  unusableHomes.every((home) => resolveInstallPath(home, VDEV, plainLayout) === null),
  JSON.stringify(unusableHomes.map((home) => String(resolveInstallPath(home, VDEV, plainLayout)))));

// (9) A module root that cannot be realpath'd proves nothing: null.
const unusableRootLayout = fakeResolveFs({ present: [vDesktop], entries: { [VPROFILES]: [PROFILE_NAME] },
  fail: { realpath: [VDEV] } });
check("resolveInstallPath: a module root whose realpath throws => null",
  resolveInstallPath(VHOME, VDEV, unusableRootLayout) === null
  && resolveInstallPath(VHOME, undefined, plainLayout) === null
  && resolveInstallPath(VHOME, "", plainLayout) === null,
  JSON.stringify({ throwing: resolveInstallPath(VHOME, VDEV, unusableRootLayout),
    undefined_: resolveInstallPath(VHOME, undefined, plainLayout),
    empty: resolveInstallPath(VHOME, "", plainLayout) }));

// (10) The real fixtures through the real fs, without any injection: the same two answers.
check("H2: resolveInstallPath returns the installed package path or null on real fixtures (no module-root fallback)",
  resolveInstallPath(dirProfile.home, dirProfile.moduleRoot) === dirProfile.candidate
  && resolveInstallPath(linkedProfile.home, linkedProfile.moduleRoot) === linkedProfile.candidate
  && resolveInstallPath(legacyProfile.home, legacyProfile.moduleRoot) === legacyProfile.candidate
  && resolveInstallPath(absentProfile.home, absentProfile.moduleRoot) === null
  && resolveInstallPath(undefined, undefined) === null
  && resolveInstallPath(null, null) === null
  && resolveInstallPath("", "") === null
  && resolveInstallPath("relative/profile/home", dirProfile.moduleRoot) === null
  && resolveInstallPath(42, 42) === null,
  JSON.stringify({ dir: resolveInstallPath(dirProfile.home, dirProfile.moduleRoot),
    linked: resolveInstallPath(linkedProfile.home, linkedProfile.moduleRoot),
    absent: resolveInstallPath(absentProfile.home, absentProfile.moduleRoot) }));

// ---------- 13i. H2 at the service level: a bare `{ pluginRoot }` is not an install ----------
//
// The regression this guards: `pluginRoot` is the development tree, which `lstat`s as a real directory.
// If the service used it as a fallback install path, the §4.2 link guard would be bypassed and the dev
// tree would become the write target.
const moduleRootInstall = makeInstall({ version: "0.3.0" });
const bareGit = forbiddenGit();
const bareFetch = forbiddenFetch();
const bareService = createUpdateService({
  pluginRoot: moduleRootInstall.dir, enabled: true, fetchImpl: bareFetch, gitRunner: bareGit, now: FIXED_NOW,
});
const bareStatus = await bareService.status();
check("H2: a service built with only pluginRoot reports installKind unknown, not install",
  bareStatus.installed?.installKind === "unknown" && bareStatus.installed?.version === "0.3.0"
  && bareStatus.reason === "install-not-found" && bareStatus.canUpdate === false,
  JSON.stringify(bareStatus));
check("H2: that service runs no git and makes no request (the module root is not a write target)",
  bareGit.calls.length === 0 && bareFetch.calls.length === 0,
  `git=${bareGit.calls.length} fetch=${bareFetch.calls.length}`);
const bareApply = await bareService.apply();
check("H2: apply refuses install-not-found (409, fixed sentence) and does not touch the module root",
  bareApply.ok === false && bareApply.code === "install-not-found" && bareApply.status === 409
  && bareApply.error === REASON_MESSAGES["install-not-found"]
  && bareGit.calls.length === 0 && bareFetch.calls.length === 0
  && JSON.parse(readFileSync(path.join(moduleRootInstall.dir, "package.json"), "utf8")).version === "0.3.0",
  JSON.stringify(bareApply));

// ---------- 14. config validation (the same style as config.jobs) ----------

const configOf = (rawUpdate) => {
  const seam = plugin.__updateInternals;
  const realFactory = seam.createUpdateService;
  const seen = [];
  seam.createUpdateService = (options) => { seen.push(options); return realFactory({ ...options, pluginRoot: ROOT }); };
  const { ctx } = makeCtx();
  try {
    plugin.apply(ctx, { wikiRoots: [], update: rawUpdate });
    return { ok: true, seen };
  } catch (error) {
    return { ok: false, message: String(error?.message ?? error), type: error?.constructor?.name };
  } finally {
    seam.createUpdateService = realFactory;
  }
};
check("config.update defaults to disabled when absent", configOf(undefined).seen?.[0]?.enabled === false);
check("config.update.enabled accepts a boolean and is passed through",
  configOf({ enabled: true }).seen?.[0]?.enabled === true
  && configOf({ enabled: false }).seen?.[0]?.enabled === false);
const badType = configOf({ enabled: "yes" });
check("config.update.enabled must be a boolean (TypeError, the config.jobs phrasing pattern)",
  badType.ok === false && badType.type === "TypeError"
  && badType.message === "dsh-wiki: config.update.enabled must be a boolean", badType.message);
const badObject = configOf("nope");
check("config.update must be an object (TypeError)",
  badObject.ok === false && badObject.type === "TypeError"
  && badObject.message === "dsh-wiki: config.update must be an object", badObject.message);
const unknownKey = configOf({ enabled: true, repository: "evil/dsh-wiki" });
check("an unknown key under config.update is rejected (the surface is fixed on purpose)",
  unknownKey.ok === false && unknownKey.type === "TypeError"
  && unknownKey.message.includes('unsupported key "repository"'), unknownKey.message);

// ---------- done ----------

try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* best effort */ }

console.log(FAILS.length ? `\nFAILED (${FAILS.length} of ${CHECKS} checks)` : `\nPASS ${CHECKS} checks`);
process.exit(FAILS.length ? 1 : 0);
