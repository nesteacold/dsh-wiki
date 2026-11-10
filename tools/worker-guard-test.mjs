// dsh-wiki worker guard — offline adversarial tests.
//
// Drives lib/worker-guard.js directly: no DSH Host, no network, real tmp fixtures on the local
// filesystem (including Windows junctions where the platform allows them). Run with:
//   node --test plugins/dsh-wiki/tools/worker-guard-test.mjs
//
// The point of these tests is the deny path: every fixture that must NOT be reachable is named
// explicitly, and the secret value is asserted absent from every decision object, so a regression
// that starts reading credential files fails loudly. All secrets below are fake local fixtures;
// no real credential file is touched.
import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { pathToFileURL } from "node:url";

const here = import.meta.dirname;
const guardUrl = pathToFileURL(path.join(here, "..", "lib", "worker-guard.js")).href;
const { ALLOWED_TOOLS, TOOL_GUARD_CONTRACT, createWorkerGuard, isSensitivePathName } = await import(guardUrl);

const SECRET = "sk-live-DO-NOT-LEAK-4f9a2c";
const SECRET_ENV = `API_KEY=${SECRET}\n`;
const WORKER = "worker-session-1";

let base;
let repo;
let staging;
let outside;
let guard;
let releaseWorker;

/**
 * The guard requires an injected synchronous effective-cwd resolver (it never reads
 * session.header.cwd). Every guard in this file activates with repo as the job directory, so the
 * default resolver returns repo; tests that probe resolver failures override it.
 */
const getEffectiveCwd = () => repo;
const createGuard = (options = {}) => createWorkerGuard({ getEffectiveCwd, ...options });

const realpathOf = (target) => (typeof realpathSync.native === "function" ? realpathSync.native(target) : realpathSync(target));

const call = (name, args, agentId = WORKER) => ({ name, arguments: args, agent: { id: agentId } });
const readCall = (filePath, agentId = WORKER) => call("read", { file_path: filePath }, agentId);
const writeCall = (filePath, content = "x") => call("write", { file_path: filePath, content });
const editCall = (filePath, oldString = "a", newString = "b") => call("edit", { file_path: filePath, old_string: oldString, new_string: newString });

async function decision(exec, g = guard) {
  return g.authorize(exec);
}

const assertAllow = async (exec, label) => {
  const verdict = await decision(exec);
  assert.equal(verdict.allow, true, `${label}: expected allow, got ${JSON.stringify(verdict)}`);
  return verdict;
};

const assertDeny = async (exec, code, label) => {
  const verdict = await decision(exec);
  assert.equal(verdict.allow, false, `${label}: expected deny, got allow`);
  assert.equal(verdict.code, code, `${label}: expected code ${code}, got ${verdict.code} (${verdict.reason ?? ""})`);
  assert.equal(typeof verdict.reason, "string", `${label}: denial must carry a reason`);
  assert.ok(!verdict.reason.includes(SECRET), `${label}: denial leaked secret material`);
  return verdict;
};

const makeJunction = (linkPath, targetPath) => {
  // Directory junctions work without developer mode / elevation on Windows.
  try {
    symlinkSync(targetPath, linkPath, "junction");
    return true;
  } catch {
    return false;
  }
};

before(() => {
  base = mkdtempSync(path.join(tmpdir(), "dsh-wiki-guard-"));
  repo = path.join(base, "repo");
  staging = path.join(repo, ".dsh-wiki.staging-test1");
  outside = path.join(base, "outside");

  mkdirSync(path.join(repo, "src"), { recursive: true });
  mkdirSync(path.join(repo, ".git"), { recursive: true });
  mkdirSync(path.join(staging, "pages"), { recursive: true });
  mkdirSync(path.join(staging, "cards"), { recursive: true });
  mkdirSync(outside, { recursive: true });

  writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(path.join(repo, "src", "notes.md"), "# notes\n");
  writeFileSync(path.join(repo, ".env"), SECRET_ENV);
  writeFileSync(path.join(repo, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n");
  writeFileSync(path.join(repo, "credentials.yaml"), `token: ${SECRET}\n`);
  writeFileSync(path.join(repo, "id_rsa"), `-----BEGIN PRIVATE KEY-----\n${SECRET}\n-----END PRIVATE KEY-----\n`);
  writeFileSync(path.join(outside, "secret.txt"), `outside ${SECRET}\n`);
  writeFileSync(path.join(outside, "payload.txt"), `payload ${SECRET}\n`);
  writeFileSync(path.join(staging, "pages", "overview.md"), "# Overview\n");

  guard = createGuard();
  releaseWorker = guard.activate(WORKER, { repoRoot: repo, stagingRoot: staging });
});

after(() => {
  try {
    guard?.dispose();
  } catch {
    /* ignore */
  }
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ---------------------------------------------------------------------------
// contract shape
// ---------------------------------------------------------------------------

test("contract: worker allowlist is exactly read/glob/grep/write/edit (skill removed)", () => {
  assert.deepEqual([...ALLOWED_TOOLS], ["read", "glob", "grep", "write", "edit"]);
  assert.equal(ALLOWED_TOOLS.includes("skill"), false, "skill must not be a worker tool");
  assert.equal(TOOL_GUARD_CONTRACT.signature, "(execution: Readonly<ToolExecution>) => string | undefined");
});

test("contract: a synchronous effective-cwd resolver is required at construction", () => {
  assert.throws(() => createWorkerGuard(), /getEffectiveCwd/);
  assert.throws(() => createWorkerGuard({}), /getEffectiveCwd/);
  assert.throws(() => createWorkerGuard({ getEffectiveCwd: null }), /getEffectiveCwd/);
  assert.doesNotThrow(() => createGuard());
  // An async function is still a function; its Promise is rejected per call (see the cwd tests).
  assert.doesNotThrow(() => createWorkerGuard({ getEffectiveCwd: async () => repo }));
});

test("contract: authorize is async and agrees with the synchronous engine", async () => {
  const exec = readCall("src/a.ts");
  const pending = guard.authorize(exec);
  assert.ok(pending instanceof Promise, "authorize must return a Promise");
  assert.deepEqual(await pending, guard.authorizeSync(exec));
});

test("contract: the sync engine agrees on the new argument, skill and cwd denials", async () => {
  const cases = [
    call("skill", { name: "dsh-wiki" }),
    call("read", { file_path: "src/a.ts", sandbox_permissions: "danger-full-access" }),
    call("write", { file_path: path.join(staging, "pages", "p.md"), content: "x", justification: "x" }),
    call("edit", { file_path: path.join(staging, "pages", "overview.md"), old_string: "", new_string: "x" }),
    call("glob", { pattern: "**/*.ts", follow_symlinks: true }),
    call("grep", { pattern: "export", path: "src", include: "../*.ts" }),
  ];
  for (const exec of cases) {
    assert.deepEqual(await guard.authorize(exec), guard.authorizeSync(exec), `parity drift for ${JSON.stringify(exec.arguments)}`);
  }
});

test("contract: inactive agents are untouched (not our worker)", async () => {
  const verdict = await decision(call("read", { file_path: path.join(outside, "secret.txt") }, "someone-else"));
  assert.equal(verdict.allow, true);
  assert.equal(verdict.code, "not-worker");
});

test("contract: a call without an agent is untouched", async () => {
  const verdict = await guard.authorize({ name: "read", arguments: { file_path: "/anything" } });
  assert.equal(verdict.allow, true);
  assert.equal(verdict.code, "not-worker");
});

// ---------------------------------------------------------------------------
// allowlist
// ---------------------------------------------------------------------------

test("allowlist: the five worker tools are allowed", async () => {
  await assertAllow(readCall("src/a.ts"), "read");
  await assertAllow(call("glob", { pattern: "**/*.ts" }), "glob");
  await assertAllow(call("grep", { pattern: "export", path: "src" }), "grep");
  await assertAllow(writeCall(path.join(staging, "pages", "p1.md")), "write page");
  await assertAllow(writeCall(path.join(staging, "cards", "c1.md")), "write card");
  await assertAllow(editCall(path.join(staging, "pages", "overview.md")), "edit page");
});

test("allowlist: skill is denied (instructions must be host-preseeded later)", async () => {
  await assertDeny(call("skill", { name: "dsh-wiki" }), "tool-not-allowed", "skill");
  await assertDeny(call("skill", {}), "tool-not-allowed", "skill empty args");
});

test("allowlist: shell, subagent, workflow, web, MCP, schedule, plugin, job tools are denied", async () => {
  const forbidden = ["bash", "shell", "run_code", "subagent", "subagent_codex", "workflow", "web_fetch", "web_search",
    "mcp__server__tool", "schedule_create", "schedule_list", "plugin_manager", "job_output", "job_kill", "read_file",
    "skill", "constructor", "__proto__", "toString"];
  for (const name of forbidden) {
    const verdict = await guard.authorize(call(name, {}));
    assert.equal(verdict.allow, false, `${name} must be denied`);
    assert.equal(verdict.code, "tool-not-allowed", `${name}: ${verdict.code}`);
  }
});

test("allowlist: a worker may not delegate (subagent tool) even with plausible arguments", async () => {
  await assertDeny(call("subagent", { prompt: "read /etc/passwd" }), "tool-not-allowed", "subagent");
  await assertDeny(call("workflow", { script: "return 1" }), "tool-not-allowed", "workflow");
});

// ---------------------------------------------------------------------------
// activation registry
// ---------------------------------------------------------------------------

test("registry: release stops enforcement and is idempotent; unknown ids are false", async () => {
  const local = createGuard();
  const release = local.activate("tmp-worker", { repoRoot: repo, stagingRoot: staging });
  assert.equal(local.isActive("tmp-worker"), true);
  assert.deepEqual(local.activeAgentIds(), ["tmp-worker"]);
  assert.equal((await local.authorize(readCall(path.join(outside, "secret.txt"), "tmp-worker"))).allow, false);
  assert.equal(release(), true);
  assert.equal(release(), false);
  assert.equal(local.release("tmp-worker"), false);
  assert.equal(local.isActive("tmp-worker"), false);
  assert.equal((await local.authorize(readCall(path.join(outside, "secret.txt"), "tmp-worker"))).allow, true);
});

test("registry: double activation throws and requires explicit release", () => {
  const local = createGuard();
  local.activate("dup", { repoRoot: repo, stagingRoot: staging });
  assert.throws(() => local.activate("dup", { repoRoot: repo, stagingRoot: staging }), /already has an active guard/);
  assert.equal(local.releaseAll(), 1);
});

test("registry: activation rejects invalid roots", () => {
  const local = createGuard();
  assert.throws(() => local.activate("a", { repoRoot: "relative/repo", stagingRoot: staging }), /must be absolute/);
  assert.throws(() => local.activate("a", { repoRoot: path.join(base, "missing"), stagingRoot: staging }), /does not exist/);
  assert.throws(() => local.activate("a", { repoRoot: repo, stagingRoot: repo }), /separate directory/);
  assert.throws(() => local.activate("a", { repoRoot: repo, stagingRoot: staging, cwd: outside }), /cwd must live inside/);
  assert.throws(() => local.activate("", { repoRoot: repo, stagingRoot: staging }), /agentId/);
});

test("registry: __proto__ as an agent id is data, not prototype pollution", async () => {
  const local = createGuard();
  const release = local.activate("__proto__", { repoRoot: repo, stagingRoot: staging });
  assert.equal(local.isActive("__proto__"), true);
  assert.equal(({}).repoReal, undefined);
  assert.equal(Object.prototype.repoReal, undefined);
  assert.equal((await local.authorize(readCall("src/a.ts", "__proto__"))).allow, true);
  assert.equal((await local.authorize(readCall(path.join(outside, "secret.txt"), "__proto__"))).allow, false);
  release();
});

// ---------------------------------------------------------------------------
// read scope
// ---------------------------------------------------------------------------

test("read: relative paths resolve against the worker cwd and are allowed", async () => {
  await assertAllow(readCall("src/a.ts"), "relative read");
  await assertAllow(readCall(path.join(repo, "src", "notes.md")), "absolute read");
  await assertAllow(readCall(path.join(staging, "pages", "overview.md")), "staging read");
});

test("read: outside the repository and staging is denied (absolute, %TEMP%, sibling root)", async () => {
  await assertDeny(readCall(path.join(outside, "secret.txt")), "path-outside-roots", "outside absolute");
  await assertDeny(readCall(path.join(base, "anything.txt")), "path-outside-roots", "temp base");
  await assertDeny(readCall("../../outside/secret.txt"), "path-traversal", "relative traversal");
});

test("read: credentials, .git and key material are denied by name", async () => {
  for (const target of [".env", ".git/config", "credentials.yaml", "id_rsa"]) {
    const verdict = await assertDeny(readCall(target), "path-sensitive", target);
    assert.ok(!JSON.stringify(verdict).includes(SECRET), `${target}: decision object leaked the secret`);
    assert.ok(!JSON.stringify(verdict).includes("BEGIN PRIVATE KEY"), `${target}: decision leaked key material`);
  }
  assert.equal(isSensitivePathName(".env.local"), true);
  assert.equal(isSensitivePathName("server.pem"), true);
  assert.equal(isSensitivePathName("notes.md"), false);
});

test("read: symlink/junction ancestors are rejected, including a link planted inside the repo", async (t) => {
  const link = path.join(repo, "link-out");
  if (!makeJunction(link, outside)) return t.skip("platform refused a junction");
  try {
    await assertDeny(readCall("link-out/payload.txt"), "path-symlink", "junction ancestor");
    await assertDeny(readCall(path.join(link, "payload.txt")), "path-symlink", "absolute junction ancestor");
  } finally {
    try { rmSync(link, { force: true }); } catch { /* ignore */ }
  }
});

test("read: symlink/junction targets are rejected (link itself named)", async (t) => {
  const link = path.join(repo, "link-file");
  if (!makeJunction(link, outside)) return t.skip("platform refused a junction");
  try {
    await assertDeny(readCall("link-file"), "path-symlink", "junction target");
  } finally {
    try { rmSync(link, { force: true }); } catch { /* ignore */ }
  }
});

test("read: malformed paths fail closed", async () => {
  await assertDeny(readCall("src/a.ts\u0000.png"), "path-traversal", "NUL byte");
  await assertDeny(call("read", {}), "args-invalid", "missing file_path");
  await assertDeny(call("read", { file_path: 42 }), "args-invalid", "non-string file_path");
  await assertDeny(call("read", null), "args-invalid", "null arguments");
  await assertDeny(call("read", ["src/a.ts"]), "args-invalid", "array arguments");
  await assertDeny(call("read", "src/a.ts"), "args-invalid", "string arguments");
});

// ---------------------------------------------------------------------------
// effective working directory (injected resolver, never session.header.cwd)
// ---------------------------------------------------------------------------

test("cwd: the resolver is authoritative and session.header.cwd is ignored", async () => {
  const exec = {
    name: "read",
    arguments: { file_path: "src/a.ts" },
    // The immutable creation header disagrees; the effective projection (resolver) is repo.
    agent: { id: WORKER, session: { header: { cwd: outside } } },
  };
  const verdict = await guard.authorize(exec);
  assert.equal(verdict.allow, true, JSON.stringify(verdict));
});

test("cwd: a mismatched effective directory is refused on every tool", async () => {
  const local = createWorkerGuard({ getEffectiveCwd: () => outside });
  const release = local.activate("cwd-worker", { repoRoot: repo, stagingRoot: staging });
  try {
    for (const exec of [readCall("src/a.ts", "cwd-worker"), call("glob", { pattern: "**/*.ts" }, "cwd-worker"), call("grep", { pattern: "export", path: "src" }, "cwd-worker"), call("write", { file_path: path.join(staging, "pages", "x.md"), content: "x" }, "cwd-worker")]) {
      const verdict = await local.authorize(exec);
      assert.equal(verdict.allow, false, `${exec.name}: expected deny`);
      assert.equal(verdict.code, "cwd-mismatch", `${exec.name}: ${verdict.code}`);
    }
  } finally {
    release();
  }
});

test("cwd: missing, non-string, relative and unresolvable values are refused", async () => {
  const cases = [
    ["missing", () => undefined, "cwd-missing"],
    ["null", () => null, "cwd-missing"],
    ["empty", () => "", "cwd-missing"],
    ["number", () => 42, "cwd-invalid"],
    ["relative", () => "repo/src", "cwd-invalid"],
    ["dangling", () => path.join(base, "does-not-exist"), "cwd-unavailable"],
    ["throwing", () => { throw new Error("resolver boom"); }, "cwd-unavailable"],
  ];
  for (const [label, resolver, code] of cases) {
    const local = createWorkerGuard({ getEffectiveCwd: resolver });
    const release = local.activate("cwd-case", { repoRoot: repo, stagingRoot: staging });
    try {
      const verdict = await local.authorize(readCall("src/a.ts", "cwd-case"));
      assert.equal(verdict.allow, false, `${label}: expected deny`);
      assert.equal(verdict.code, code, `${label}: expected ${code}, got ${verdict.code}`);
    } finally {
      release();
    }
  }
});

test("cwd: a resolver returning a Promise is refused (the guard cannot await)", async () => {
  const local = createWorkerGuard({ getEffectiveCwd: async () => repo });
  const release = local.activate("cwd-promise", { repoRoot: repo, stagingRoot: staging });
  try {
    const verdict = await local.authorize(readCall("src/a.ts", "cwd-promise"));
    assert.equal(verdict.allow, false);
    assert.equal(verdict.code, "cwd-not-synchronous");
  } finally {
    release();
  }
});

test("cwd: the resolver is not consulted for a non-worker session", async () => {
  const local = createWorkerGuard({ getEffectiveCwd: () => { throw new Error("must not run"); } });
  const verdict = await local.authorize(readCall(path.join(outside, "secret.txt"), "someone-else"));
  assert.equal(verdict.allow, true);
  assert.equal(verdict.code, "not-worker");
});

// ---------------------------------------------------------------------------
// write scope
// ---------------------------------------------------------------------------

test("write: pages/*.md and cards/*.md in staging are allowed", async () => {
  await assertAllow(writeCall(path.join(staging, "pages", "concepts.md")), "page");
  await assertAllow(writeCall(path.join(staging, "cards", "module.md")), "card");
  await assertAllow(editCall(path.join(staging, "cards", "module.md")), "edit card");
  await assertAllow(writeCall(path.join(".dsh-wiki.staging-test1", "pages", "relative.md")), "relative staging write");
});

test("write: host-owned files are denied with a specific reason", async () => {
  for (const name of ["wiki.json", "config.json", "generation-meta.json", "locales/en.json", "journal/2026.md"]) {
    const verdict = await assertDeny(writeCall(path.join(staging, name)), "write-host-owned", name);
    assert.match(verdict.reason, /host-owned/);
  }
});

test("write: only flat pages/cards .md files are writable", async () => {
  await assertDeny(writeCall(path.join(staging, "pages", "nested", "deep.md")), "write-not-allowed", "nested page");
  await assertDeny(writeCall(path.join(staging, "pages", "notes.txt")), "write-not-allowed", "non-md");
  await assertDeny(writeCall(path.join(staging, "pages", ".hidden.md")), "write-not-allowed", "dot file");
  await assertDeny(writeCall(path.join(staging, "other", "x.md")), "write-not-allowed", "wrong directory");
  await assertDeny(writeCall(path.join(staging, "pages")), "write-not-allowed", "directory itself");
});

test("write: outside staging, outside the repo, temp and traversal are denied", async () => {
  await assertDeny(writeCall(path.join(repo, "src", "owned.md")), "write-not-staging", "repo write");
  await assertDeny(writeCall(path.join(outside, "owned.md")), "path-outside-roots", "outside write");
  await assertDeny(writeCall(path.join(base, "owned.md")), "path-outside-roots", "temp write");
  await assertDeny(writeCall(`${staging}${path.sep}pages${path.sep}..${path.sep}wiki.json`), "path-traversal", "dotdot");
  await assertDeny(writeCall(`${staging}${path.sep}pages${path.sep}..${path.sep}..${path.sep}..${path.sep}owned.md`), "path-traversal", "deep traversal");
});

test("write: a junction inside pages cannot redirect the write outside staging", async (t) => {
  const link = path.join(staging, "pages", "escape");
  if (!makeJunction(link, outside)) return t.skip("platform refused a junction");
  try {
    await assertDeny(writeCall(path.join(link, "pwn.md")), "path-symlink", "junction inside pages");
  } finally {
    try { rmSync(link, { force: true }); } catch { /* ignore */ }
  }
});

test("write: a hardlinked existing target is denied", async (t) => {
  const target = path.join(staging, "pages", "hard.md");
  const outsideFile = path.join(outside, "hard-outside.md");
  writeFileSync(outsideFile, "outside\n");
  try {
    const { linkSync } = await import("node:fs");
    linkSync(outsideFile, target);
  } catch {
    return t.skip("hardlink creation not permitted on this volume");
  }
  try {
    await assertDeny(writeCall(target), "write-hardlink", "hardlink target");
  } finally {
    try { rmSync(target, { force: true }); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// strict per-tool argument contract (own keys + types reflect the real schemas)
// ---------------------------------------------------------------------------

test("arguments: read rejects escalation, unknown keys and invalid bounds", async () => {
  const target = path.join(staging, "pages", "bounds.md");
  await assertDeny(call("read", { file_path: "src/a.ts", sandbox_permissions: "danger-full-access" }), "args-invalid", "read sandbox_permissions");
  await assertDeny(call("read", { file_path: "src/a.ts", justification: "please" }), "args-invalid", "read justification");
  await assertDeny(call("read", { file_path: "src/a.ts", include: "*.ts" }), "args-invalid", "read include");
  for (const bad of [0, -1, 1.5, "2", true, null, NaN, Infinity]) {
    await assertDeny(call("read", { file_path: "src/a.ts", offset: bad }), "args-invalid", `offset ${String(bad)}`);
    await assertDeny(call("read", { file_path: "src/a.ts", limit: bad }), "args-invalid", `limit ${String(bad)}`);
  }
  await assertAllow(call("read", { file_path: "src/a.ts", offset: 1, limit: 10 }), "valid bounds");
  assert.equal((await guard.authorize(call("write", { file_path: target, content: "x", replace_all: true }))).code, "args-invalid", "write replace_all is not a write key");
});

test("arguments: write requires content and rejects escalation keys", async () => {
  const target = path.join(staging, "pages", "content.md");
  await assertDeny(call("write", { file_path: target }), "args-invalid", "missing content");
  await assertDeny(call("write", { file_path: target, content: 42 }), "args-invalid", "number content");
  await assertDeny(call("write", { file_path: target, content: null }), "args-invalid", "null content");
  await assertDeny(call("write", { file_path: target, content: "x", sandbox_permissions: "workspace-write" }), "args-invalid", "write sandbox_permissions");
  await assertDeny(call("write", { file_path: target, content: "x", justification: "please" }), "args-invalid", "write justification");
  await assertDeny(call("write", { file_path: target, content: "x", include: "*.md" }), "args-invalid", "write include");
  await assertAllow(call("write", { file_path: target, content: "" }), "empty content is a valid write");
});

test("arguments: edit requires typed old_string/new_string and a boolean replace_all", async () => {
  const target = path.join(staging, "pages", "overview.md");
  await assertDeny(call("edit", { file_path: target, new_string: "b" }), "args-invalid", "missing old_string");
  await assertDeny(call("edit", { file_path: target, old_string: "a" }), "args-invalid", "missing new_string");
  await assertDeny(call("edit", { file_path: target, old_string: "", new_string: "b" }), "args-invalid", "empty old_string");
  await assertDeny(call("edit", { file_path: target, old_string: "a", new_string: 42 }), "args-invalid", "number new_string");
  await assertDeny(call("edit", { file_path: target, old_string: "a", new_string: "b", replace_all: "yes" }), "args-invalid", "string replace_all");
  await assertDeny(call("edit", { file_path: target, old_string: "a", new_string: "b", sandbox_permissions: "danger-full-access" }), "args-invalid", "edit sandbox_permissions");
  await assertDeny(call("edit", { file_path: target, old_string: "a", new_string: "b", justification: "please" }), "args-invalid", "edit justification");
  await assertAllow(call("edit", { file_path: target, old_string: "a", new_string: "b", replace_all: true }), "boolean replace_all");
});

test("arguments: glob/grep reject unknown traversal options and mistyped keys", async () => {
  await assertDeny(call("glob", { pattern: "**/*.ts", follow_symlinks: true }), "args-invalid", "glob follow_symlinks");
  await assertDeny(call("glob", { pattern: "**/*.ts", include: "*.ts" }), "args-invalid", "glob include");
  await assertDeny(call("glob", { pattern: "**/*.ts", path: 42 }), "args-invalid", "glob path type");
  await assertDeny(call("grep", { pattern: "export", include: 42 }), "args-invalid", "grep include type");
  await assertDeny(call("grep", { pattern: "export", path: "src", offset: 2 }), "args-invalid", "grep offset");
  await assertDeny(call("grep", { pattern: "export", sandbox_permissions: "workspace-write" }), "args-invalid", "grep escalation");
});

// ---------------------------------------------------------------------------
// glob / grep constraints
// ---------------------------------------------------------------------------

test("glob: relative patterns inside the roots are allowed", async () => {
  await assertAllow(call("glob", { pattern: "**/*.ts" }), "default root");
  await assertAllow(call("glob", { pattern: "*.md", path: "src" }), "explicit dir");
  await assertAllow(call("glob", { pattern: "*.md", path: path.join(staging, "pages") }), "staging dir");
});

test("glob: absolute, ascending and credential patterns are denied", async () => {
  await assertDeny(call("glob", { pattern: path.join(repo, "*.ts") }), "path-traversal", "absolute pattern");
  await assertDeny(call("glob", { pattern: "../outside/*" }), "path-traversal", "ascending pattern");
  await assertDeny(call("glob", { pattern: "src/{..,x}/*.ts" }), "path-traversal", "brace ascent");
  await assertDeny(call("glob", { pattern: ".env*" }), "path-traversal", "secret pattern");
  await assertDeny(call("glob", { pattern: "*.ts", path: outside }), "path-outside-roots", "outside search root");
  await assertDeny(call("glob", { pattern: "*.ts", path: ".git" }), "path-sensitive", "git search root");
});

test("grep: a clean subdirectory is allowed", async () => {
  await assertAllow(call("grep", { pattern: "export", path: "src" }), "clean dir");
  await assertAllow(call("grep", { pattern: "Overview", path: path.join(staging, "pages") }), "staging dir");
});

test("grep: a search root containing a secret is denied (contents never read)", async () => {
  const verdict = await assertDeny(call("grep", { pattern: "API_KEY" }), "search-root-sensitive", "repo root scan");
  assert.ok(!verdict.reason.includes(SECRET), "grep denial leaked the secret");
  await assertDeny(call("grep", { pattern: ".", path: ".git" }), "path-sensitive", "git root");
  await assertDeny(call("grep", { pattern: ".", path: outside }), "path-outside-roots", "outside root");
});

test("grep: a secret planted in an otherwise clean subdirectory is detected", async () => {
  const planted = path.join(repo, "src", "deploy.key");
  writeFileSync(planted, SECRET);
  try {
    await assertDeny(call("grep", { pattern: "x", path: "src" }), "search-root-sensitive", "planted key");
  } finally {
    try { rmSync(planted, { force: true }); } catch { /* ignore */ }
  }
  await assertAllow(call("grep", { pattern: "export", path: "src" }), "clean again");
});

test("grep: node_modules is scanned too (no assumed skip; a positive include can reach it)", async () => {
  const tree = path.join(repo, "scan-deps");
  mkdirSync(path.join(tree, "node_modules", "pkg"), { recursive: true });
  writeFileSync(path.join(tree, "node_modules", "pkg", "index.js"), "export const x = 1;\n");
  try {
    await assertAllow(call("grep", { pattern: "export", path: "scan-deps", include: "**" }), "clean dependency tree");
    writeFileSync(path.join(tree, "node_modules", "pkg", "credentials.json"), `token: ${SECRET}\n`);
    await assertDeny(call("grep", { pattern: "export", path: "scan-deps" }), "search-root-sensitive", "secret under node_modules");
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});

test("grep: generated .dsh-wiki* trees are scanned too (no assumed skip)", async () => {
  const tree = path.join(repo, "scan-wiki");
  mkdirSync(path.join(tree, ".dsh-wiki", "pages"), { recursive: true });
  writeFileSync(path.join(tree, ".dsh-wiki", "pages", "overview.md"), "# Overview\n");
  try {
    await assertAllow(call("grep", { pattern: "Overview", path: "scan-wiki" }), "clean generated tree");
    writeFileSync(path.join(tree, ".dsh-wiki", "pages", "id_rsa"), `-----BEGIN PRIVATE KEY-----\n${SECRET}\n-----END PRIVATE KEY-----\n`);
    await assertDeny(call("grep", { pattern: "x", path: "scan-wiki" }), "search-root-sensitive", "secret under .dsh-wiki");
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});

test("grep: the include filter is validated and cannot widen reachability", async () => {
  await assertDeny(call("grep", { pattern: "export", path: "src", include: "../outside/*.ts" }), "path-traversal", "ascending include");
  await assertDeny(call("grep", { pattern: "export", path: "src", include: path.join(repo, "*.ts") }), "path-traversal", "absolute include");
  await assertDeny(call("grep", { pattern: "export", path: "src", include: ".env*" }), "path-traversal", "secret include");
  await assertDeny(call("grep", { pattern: "export", path: "src", include: "" }), "path-traversal", "empty include");
  await assertDeny(call("grep", { pattern: "export", path: "src", include: 42 }), "args-invalid", "non-string include");
  await assertAllow(call("grep", { pattern: "export", path: "src", include: "*.ts" }), "clean include");
});

test("grep: a symlink anywhere in the search tree fails closed", async (t) => {
  const tree = path.join(repo, "scan-link");
  mkdirSync(tree, { recursive: true });
  writeFileSync(path.join(tree, "ok.txt"), "ok\n");
  const link = path.join(tree, "escape");
  if (!makeJunction(link, outside)) return t.skip("platform refused a junction");
  try {
    const verdict = await assertDeny(call("grep", { pattern: "x", path: "scan-link" }), "search-root-unverified", "symlink in tree");
    assert.match(verdict.reason, /link/i);
  } finally {
    try { rmSync(link, { force: true }); } catch { /* ignore */ }
    rmSync(tree, { recursive: true, force: true });
  }
});

test("grep: any directory-listing failure fails closed (EACCES/EPERM/ENOTDIR/ENOENT)", async () => {
  const tree = path.join(repo, "unreadable");
  mkdirSync(tree, { recursive: true });
  writeFileSync(path.join(tree, "x.txt"), "x");
  try {
    for (const code of ["EACCES", "EPERM", "ENOTDIR", "ENOENT"]) {
      const io = {
        lstat: (target) => lstatSync(target),
        realpath: (target) => realpathOf(target),
        readdir: (target) => {
          if (path.basename(target) === "unreadable") throw Object.assign(new Error(`denied ${code}`), { code });
          return readdirSync(target, { withFileTypes: true });
        },
      };
      const local = createWorkerGuard({ getEffectiveCwd, io });
      const release = local.activate("unreadable-worker", { repoRoot: repo, stagingRoot: staging });
      try {
        const verdict = await local.authorize(call("grep", { pattern: "x", path: "unreadable" }, "unreadable-worker"));
        assert.equal(verdict.allow, false, `${code}: expected deny`);
        assert.equal(verdict.code, "search-root-unverified", `${code}: got ${verdict.code}`);
        assert.match(verdict.reason, new RegExp(code));
      } finally {
        release();
      }
    }
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});

test("grep: a missing search root (ENOENT on lstat) fails closed", async () => {
  await assertDeny(call("grep", { pattern: "x", path: "does-not-exist-anywhere" }), "search-root-unverified", "missing root");
});

test("grep: a bounded scan denies an unprovable root instead of allowing it", async () => {
  const tiny = path.join(repo, "tiny");
  const probe = createGuard({ limits: { maxSearchEntries: 2 } });
  const release = probe.activate("tiny-worker", { repoRoot: repo, stagingRoot: staging });
  mkdirSync(tiny, { recursive: true });
  for (let index = 0; index < 6; index++) writeFileSync(path.join(tiny, `f${index}.txt`), "x");
  try {
    const verdict = await probe.authorize(call("grep", { pattern: "x", path: "tiny" }, "tiny-worker"));
    assert.equal(verdict.allow, false);
    assert.equal(verdict.code, "search-root-unverified");
  } finally {
    release();
    rmSync(tiny, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// arguments, prototypes, roots
// ---------------------------------------------------------------------------

test("arguments: prototype-inherited fields never authorize a path", async () => {
  const inherited = Object.create({ file_path: "src/a.ts" });
  await assertDeny(call("read", inherited), "args-invalid", "inherited file_path");

  const poisoned = JSON.parse('{"__proto__":{"file_path":"' + path.join(outside, "secret.txt").replace(/\\/g, "\\\\") + '"}}');
  await assertDeny(call("read", poisoned), "args-invalid", "__proto__ payload");

  const own = { file_path: "src/a.ts", __proto__: { evil: true } };
  assert.equal(Object.hasOwn(own, "file_path"), true);
  await assertAllow(call("read", own), "own file_path with harmless __proto__ key");
});

test("roots: a replaced staging root fails closed on every later call", async () => {
  const local = createGuard();
  const stage = path.join(base, "mutable-staging");
  const moved = path.join(base, "mutable-staging-moved");
  mkdirSync(path.join(stage, "pages"), { recursive: true });
  writeFileSync(path.join(stage, "pages", "p.md"), "# p\n");
  const release = local.activate("mutable", { repoRoot: repo, stagingRoot: stage });
  try {
    assert.equal((await local.authorize(readCall(path.join(stage, "pages", "p.md"), "mutable"))).allow, true);
    // Swap the real staging dir for a junction pointing elsewhere.
    renameSync(stage, moved);
    if (!makeJunction(stage, outside)) return;
    const verdict = await local.authorize(readCall(path.join(stage, "pages", "p.md"), "mutable"));
    assert.equal(verdict.allow, false);
    assert.equal(verdict.code, "root-changed");
  } finally {
    release();
    try { rmSync(stage, { force: true }); } catch { /* junction */ }
    try { rmSync(moved, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test("roots: deleting the staging root denies instead of silently allowing", async () => {
  const local = createGuard();
  const stage = path.join(base, "gone-staging");
  mkdirSync(stage, { recursive: true });
  const release = local.activate("gone", { repoRoot: repo, stagingRoot: stage });
  try {
    rmSync(stage, { recursive: true, force: true });
    const verdict = await local.authorize(readCall("src/a.ts", "gone"));
    assert.equal(verdict.allow, false);
    assert.equal(verdict.code, "root-changed");
  } finally {
    release();
  }
});

// ---------------------------------------------------------------------------
// installation adapter (verified tools.guard semantics)
// ---------------------------------------------------------------------------

test("install: a pending result is not cached; a later real ctx still installs", () => {
  const local = createGuard();
  local.activate("late-worker", { repoRoot: repo, stagingRoot: staging });
  assert.equal(local.install({}).installed, false);
  const result = local.install({ tools: { guard() { return () => {}; } } });
  assert.equal(result.installed, true);
  assert.equal(result.integration, "tools.guard");
  local.dispose();
});

test("install: a throwing registration is reported, not raised", () => {
  const local = createGuard();
  const result = local.install({ tools: { guard() { throw new Error("no slots"); } } });
  assert.equal(result.installed, false);
  assert.equal(result.integration, "pending");
  assert.match(result.reason, /refused registration/);
});

test("install: missing ctx.tools.guard is reported as integration pending", () => {
  const local = createGuard();
  const result = local.install({});
  assert.equal(result.installed, false);
  assert.equal(result.integration, "pending");
  assert.match(result.reason, /no ctx\.tools\.guard/);
});

test("install: undefined/object/Promise/thenable disposers are never success", () => {
  const disposers = [
    ["undefined", () => undefined],
    ["null", () => null],
    ["object", () => ({ dispose() {} })],
    ["number", () => 42],
    ["Promise", () => Promise.resolve(() => {})],
    ["thenable function", () => Object.assign(() => {}, { then() {} })],
  ];
  for (const [label, guard] of disposers) {
    const local = createGuard();
    const result = local.install({ tools: { guard } });
    assert.equal(result.installed, false, `${label}: must not report success`);
    assert.equal(result.integration, "pending", `${label}: ${result.integration}`);
    assert.match(result.reason, /disposer/i, `${label}: ${result.reason}`);
    assert.equal(local.installState().installed, false, `${label}: installState must be false`);
  }
});

test("install: a function disposer is success and expose truthful active state", async () => {
  const local = createGuard();
  const release = local.activate("installed-worker", { repoRoot: repo, stagingRoot: staging });
  let captured = null;
  let disposed = false;
  const ctx = {
    tools: {
      guard(fn) {
        captured = fn;
        return () => { disposed = true; };
      },
    },
  };
  const result = local.install(ctx);
  assert.equal(result.installed, true);
  assert.equal(result.integration, "tools.guard");
  assert.equal(local.installState().installed, true);
  assert.equal(typeof captured, "function");

  // Allowed call: undefined (no denial).
  assert.equal(captured(readCall("src/a.ts", "installed-worker")), undefined);
  // Denied call: a reason string (ToolGuard's deny channel).
  const denied = captured(readCall(path.join(outside, "secret.txt"), "installed-worker"));
  assert.equal(typeof denied, "string");
  assert.match(denied, /outside the job roots/);
  assert.ok(!denied.includes(SECRET));
  // Other agents are untouched by a global guard.
  assert.equal(captured(readCall(path.join(outside, "secret.txt"), "another-agent")), undefined);

  const clean = result.dispose();
  assert.equal(disposed, true, "the Host disposer must be called");
  assert.equal(clean, true);
  assert.equal(local.installState().installed, false, "dispose must clear the cached state");
  assert.equal(result.dispose(), false, "a second dispose is a no-op");
  assert.equal(disposed, true);
  // After release the guard no longer applies to this worker.
  release();
  assert.equal(captured(readCall(path.join(outside, "secret.txt"), "installed-worker")), undefined);
  local.dispose();
});

test("install: reinstall after dispose registers a new guard", () => {
  const local = createGuard();
  let first = 0;
  let second = 0;
  const firstResult = local.install({ tools: { guard() { first += 1; return () => {}; } } });
  assert.equal(firstResult.installed, true);
  assert.equal(first, 1);
  firstResult.dispose();
  assert.equal(local.installState().installed, false);
  const secondResult = local.install({ tools: { guard() { second += 1; return () => {}; } } });
  assert.equal(secondResult.installed, true);
  assert.equal(second, 1, "reinstall must call ctx.tools.guard again");
  assert.notEqual(secondResult, firstResult);
  secondResult.dispose();
});

test("install: registry dispose removes the guard and clears active state", () => {
  const local = createGuard();
  local.activate("w", { repoRoot: repo, stagingRoot: staging });
  let disposed = false;
  local.install({ tools: { guard() { return () => { disposed = true; }; } } });
  assert.equal(local.installState().installed, true);
  local.dispose();
  assert.equal(disposed, true);
  assert.equal(local.installState().installed, false);
  assert.equal(local.activeAgentIds().length, 0);
});

test("install: probe failures fail closed for the worker but never throw", async () => {
  const fs = await import("node:fs");
  let failing = false;
  const flakyIo = {
    lstat: (target) => { if (failing) throw Object.assign(new Error("probe exploded"), { code: "EIO" }); return fs.lstatSync(target); },
    realpath: (target) => {
      if (failing) throw Object.assign(new Error("probe exploded"), { code: "EIO" });
      return (fs.realpathSync.native ?? fs.realpathSync)(target);
    },
    readdir: (target) => { if (failing) throw Object.assign(new Error("probe exploded"), { code: "EIO" }); return fs.readdirSync(target, { withFileTypes: true }); },
  };
  const local = createWorkerGuard({ getEffectiveCwd, io: flakyIo });
  const release = local.activate("flaky-worker", { repoRoot: repo, stagingRoot: staging });
  let captured = null;
  local.install({ tools: { guard(fn) { captured = fn; return () => {}; } } });
  try {
    assert.equal(captured(readCall("src/a.ts", "flaky-worker")), undefined);
    failing = true;
    const verdict = local.authorizeSync(readCall("src/a.ts", "flaky-worker"));
    assert.equal(verdict.allow, false, "a failing probe must deny, not allow");
    assert.equal(verdict.code, "root-changed");
    assert.equal(typeof captured(readCall("src/a.ts", "flaky-worker")), "string");
    assert.equal(captured(readCall("src/a.ts", "other-agent")), undefined, "other agents are never affected");
  } finally {
    release();
    local.dispose();
  }
});

test("install: an unreadable agent id is not attributed to the worker", () => {
  const local = createGuard();
  local.activate("getter-worker", { repoRoot: repo, stagingRoot: staging });
  let captured = null;
  local.install({ tools: { guard(fn) { captured = fn; return () => {}; } } });
  const hostile = { name: "read", arguments: { file_path: path.join(outside, "secret.txt") }, get agent() { throw new Error("hostile getter"); } };
  assert.equal(captured(hostile), undefined);
  local.dispose();
});

// ---------------------------------------------------------------------------
// no-content guarantee
// ---------------------------------------------------------------------------

test("secrets: no denial object ever contains fixture secret content", async () => {
  const targets = [
    readCall(".env"),
    readCall(".git/config"),
    readCall("credentials.yaml"),
    readCall("id_rsa"),
    writeCall(path.join(staging, "wiki.json")),
    call("grep", { pattern: "API_KEY" }),
    call("grep", { pattern: "export", path: "src", include: ".env*" }),
  ];
  for (const exec of targets) {
    const verdict = await guard.authorize(exec);
    assert.equal(verdict.allow, false);
    const serialized = JSON.stringify(verdict);
    assert.ok(!serialized.includes(SECRET), `decision leaked the secret for ${exec.name}`);
    assert.ok(!serialized.includes("BEGIN PRIVATE KEY"), `decision leaked key material for ${exec.name}`);
  }
});

test("fixtures stayed intact (guard is read-only)", () => {
  const repoNames = readdirSync(repo).sort();
  assert.ok(repoNames.includes(".env"), "the guard must not delete fixtures");
  assert.ok(repoNames.includes("credentials.yaml"));
});
