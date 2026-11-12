// dsh-wiki jobs.js worker-contract tests (spec 007, DORMANT module): node:test + mocks only.
// Covers setup order, setup-failure => failed with zero followup, identity-shadow deny, guard/activation
// lifetime tied to handle.dispose(), hanging dispose => quarantine, prompt content, assemble-before-build,
// Host-written generation-meta, and the context-leak tripwire. The second half covers the journaled
// publication transaction (T018): REQUIRED WRITE ORDER, store-error fail-closed, abort/replace paths,
// and reconcile. The security-order block also pins the job-side read path: handle-bound reads, protected
// entries that must be contained single-link files, and probes where only ENOENT means "absent".
// The last block covers the failure diagnostic: one bounded local file per terminal failure, never an
// HTTP projection (success and user cancel write nothing; an unwritable path only warns).
// Run: node tools/jobs-worker-test.mjs
import assert from "node:assert/strict";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { pathToFileURL } from "node:url";

// ---------- read-path probe ----------
// jobs.js binds node:fs/promises when it is imported, so the wrappers are installed BEFORE that import:
// every open/lstat/copyFile the plugin performs is then observable. A test installs at most one hook for
// its own case and resets it in `finally`; a test that asserts "never opened"/"never read" also runs a
// positive control, so those assertions cannot pass vacuously.
const probe = { events: [], recordHandles: true, onOpen: null, onHandle: null, onCopyFile: null, onLstat: null };
const resetProbe = () => {
  probe.events.length = 0;
  probe.recordHandles = true;
  probe.onOpen = null;
  probe.onHandle = null;
  probe.onCopyFile = null;
  probe.onLstat = null;
};
const probeFs = createRequire(import.meta.url)("node:fs/promises");
const realFsp = { open: probeFs.open, lstat: probeFs.lstat, copyFile: probeFs.copyFile };
probeFs.open = async (target, ...rest) => {
  const opened = String(target);
  probe.events.push({ op: "open", path: opened });
  if (probe.onOpen) await probe.onOpen(opened);
  const handle = await realFsp.open.call(probeFs, target, ...rest);
  // 记录句柄自己的身份：读穿 junction 时路径仍是树内路径，只有句柄 dev/ino 能证明读到的是哪个文件。
  if (probe.recordHandles) {
    try {
      const stats = await handle.stat({ bigint: true });
      probe.events.push({ op: "handle", path: opened, dev: String(stats.dev), ino: String(stats.ino) });
    } catch { /* 记录失败不改变作业的判断，路径事件仍保留 */ }
  }
  return (probe.onHandle ? probe.onHandle(opened, handle) : null) ?? handle;
};
probeFs.lstat = async (target, ...rest) => {
  const inspected = String(target);
  probe.events.push({ op: "lstat", path: inspected });
  if (probe.onLstat) await probe.onLstat(inspected);
  return realFsp.lstat.call(probeFs, target, ...rest);
};
probeFs.copyFile = async (source, destination, ...rest) => {
  const copied = String(source);
  probe.events.push({ op: "copyFile", path: copied, destination: String(destination) });
  if (probe.onCopyFile) await probe.onCopyFile(copied, String(destination));
  return realFsp.copyFile.call(probeFs, source, destination, ...rest);
};

const here = import.meta.dirname;
const lib = (name) => import(pathToFileURL(path.join(here, "..", "lib", name)).href);
const {
  createJobManager, startGuardedWorker, WORKER_PRESET_DEFINITION, WORKER_TOOL_NAMES, findContextLeak, CONTEXT_LEAK_SOURCE_KINDS,
  PUBLIC_ERROR_MESSAGES, publicError, publicJobView, normalizeCatalog, evaluateContentGate, countWords,
  CITATION_UNCITED_MAX_ABSOLUTE, CITATION_UNCITED_MAX_SHARE,
} = await lib("jobs.js");
const { buildWorkerPrompt } = await lib("worker-protocol.js");
const { createWorkerGuard } = await lib("worker-guard.js");
const { journalFileName, openJournalStore } = await lib("journal-store.js");
const { identityOf } = await lib("fs-contain.js");
const { identityJson } = await lib("publish-executor.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every fixture directory is registered on creation and removed from one place. node:test runs `after`
// on a failing assertion too; the exit handler covers a throw before the hook is reached.
const TEMP_DIRS = [];
const tempDir = (prefix) => {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  TEMP_DIRS.push(dir);
  return dir;
};
const cleanupTempDirs = () => {
  for (const dir of TEMP_DIRS.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort: a locked junction must not fail the run */ }
  }
};
after(cleanupTempDirs);
process.on("exit", cleanupTempDirs);
const EFFECTIVE = {
  language: "en", granularity: "theme", pages: { min: 6, max: 40 }, tree: { maxChildren: 8, maxDepth: 4 },
  wordsPerPage: [400, 900], diagrams: "minimal", citations: "strict", skeleton: { knownIssues: true },
};
const FIVE = ["read", "glob", "grep", "write", "edit"];
// journal 依赖是强制的：每个 manager 都拿一个真 store，并钉在同一个 host 实例上。
const JOURNAL_HOST = "host-journal-test-01";

/** Fake Host: agents.create runs setup against a fake agentCtx; records every call in `log`. */
function makeHost(opts = {}) {
  const log = [];
  const state = { followups: [], handles: [], guards: [], released: [], activations: [], executables: {} };
  // preset 服务按已安装 registry 的形状建模：mount 返回 { id } 或抛错；composedPreset 报告该
  // agentCtx 真正组合的 preset（缺了它 jobs.js 无法证明绑定，start() 会 503）。
  const compositions = new Map();
  const agentPresets = {
    mount: async (ctx, id) => {
      log.push(`mount:${id}`);
      if (opts.mountThrows) throw new Error("mount boom");
      if (opts.mountResult !== undefined) return typeof opts.mountResult === "function" ? opts.mountResult(ctx, id) : opts.mountResult;
      compositions.set(ctx, id);
      return { id };
    },
    composedPreset: (ctx) => {
      log.push("composedPreset");
      if (typeof opts.composedPreset === "function") return opts.composedPreset(ctx);
      if (opts.composedPreset !== undefined) return opts.composedPreset;
      return compositions.get(ctx);
    },
  };
  const workerGuard = {
    activate: (id, a) => {
      log.push("activate"); state.activations.push({ id, ...a });
      let live = true;
      return () => { if (live) { live = false; state.released.push(id); log.push("release"); } };
    },
    authorizeSync: (exec) => (exec.name === "deny-me" ? { allow: false, reason: "denied by authorizeSync" } : { allow: true }),
  };
  const agents = {
    create: async (options) => {
      log.push("create");
      state.createOptions = options;
      const sessionId = options.sessionId;
      const effects = [];
      const events = [];
      const agent = {
        id: sessionId, status: "idle", selected: null, events,
        session: { id: sessionId, snapshotEvents: () => events },
        model: { select: (s) => { log.push("select"); agent.selected = s; } },
        followup: (m) => { log.push("followup"); state.followups.push(m); agent.status = "running"; opts.onFollowup?.(agent, m, state); },
        cancel: (c) => { log.push("cancel"); agent.cancelCause = c; if (!opts.ignoreCancel && agent.status === "running") { agent.status = "idle"; events.push({ type: "turn/end", seq: events.length + 1, data: { turn: 1, reason: { kind: "aborted", reason: { kind: "user" } } } }); } },
      };
      const tools = {
        restrict: (f) => { log.push("restrict"); if (opts.restrictThrows) throw new Error("restrict boom"); state.restrict = f; return () => {}; },
        definitions: () => { log.push("definitions"); return (opts.extraTool ? [...FIVE, "bash"] : FIVE).map((name) => ({ name })); },
        executable: (name) => { log.push(`executable:${name}`); return state.executables[name] ??= { name, id: Symbol(name) }; },
        guard: (fn) => { log.push("guard"); state.guards.push(fn); return opts.guardNotFunction ? undefined : () => { log.push("guard-dispose"); }; },
      };
      const agentCtx = { tools, effect: (fn) => { const d = fn(); effects.push(d); log.push("effect"); return d; } };
      try {
        await options.setup(agentCtx, agent);
      } catch (error) {
        for (const d of effects.reverse()) if (typeof d === "function") d();
        throw error;
      }
      const handle = {
        agent,
        dispose: async () => {
          log.push("dispose-start");
          // 选项可以是布尔值，也可以是 (agent) => boolean：混合用例需要“只有一个 worker 停不下来”。
          const hangs = typeof opts.disposeHangs === "function" ? opts.disposeHangs(agent) : opts.disposeHangs;
          const throws = typeof opts.disposeThrows === "function" ? opts.disposeThrows(agent) : opts.disposeThrows;
          if (hangs) await new Promise(() => {});
          if (throws) throw new Error("dispose boom");
          if (opts.disposeDelayMs) await sleep(opts.disposeDelayMs);
          for (const d of effects.reverse()) if (typeof d === "function") d();
          agent.status = "idle";
          log.push("dispose-end");
        },
      };
      state.handles.push(handle);
      return handle;
    },
  };
  return { log, state, deps: { agents, agentPresets, workerGuard, workingDirectory: { get: () => "x" }, presetId: "dsh-wiki-worker" } };
}

/** A repo + manager with an injected fake builder so ordering of Host steps is observable.
 *  journal 依赖是强制的：每个 manager 都在 repo 之外的临时目录上打开真 store，allowedRoots 只含该 repo。 */
async function makeManager(host, extra = {}) {
  const root = tempDir("dsh-wiki-wk-");
  const canonicalRoot = realpathSync(root);
  // 额外的 allowlist 根（同一个 manager 上的第二个仓库，用于“混合”卸载用例）。
  const extraRoots = (extra.allowedRoots ?? []).map((value) => realpathSync(value));
  const storeDir = realpathSync(tempDir("dsh-wiki-wk-store-"));
  const store = await openJournalStore({ storeDir, allowedRoots: [canonicalRoot, ...extraRoots], hostInstanceId: JOURNAL_HOST });
  const builderCalls = [];
  const runBuilder = async (job, args) => {
    builderCalls.push(args[0]);
    host.log.push(`builder:${args[0]}`);
    if (extra.builderFail === args[0]) return { ok: false, code: 1, output: "boom", stdout: "" };
    if (args[0] === "resolve-config") return { ok: true, code: 0, output: "", stdout: JSON.stringify(EFFECTIVE) };
    if (args[0] === "assemble") {
      writeFileSync(path.join(job.stageDir, "wiki.json"), JSON.stringify({ schema: "repo-wiki-local/1", repoId: job.root, language: "en", pages: [{ id: "p" }] }));
    }
    return { ok: true, code: 0, output: "", stdout: "" };
  };
  const manager = createJobManager({
    ...host.deps, runBuilder, buildWorkerPrompt, builderPath: "unused",
    pollMs: 10, idleGraceMs: 150, disposeTimeoutMs: 150, jobTimeoutMs: 5000,
    getSourceCommit: async () => "a".repeat(40),
    journalStore: store, hostInstanceId: JOURNAL_HOST, allowedRoots: [canonicalRoot, ...extraRoots],
    ...(typeof extra.options === "function" ? extra.options(root) : extra.options),
  });
  return { root, manager, builderCalls, store, canonicalRoot };
}

const finish = async (manager, root, timeout = 8000) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = manager.view(root);
    if (!v.active && v.last) return v.last;
    if (v.active?.blocked && v.last) return v.last;
    if (Date.now() > deadline) throw new Error(`job did not finish: ${JSON.stringify(v)}`);
    await sleep(15);
  }
};
const completeTurn = (agent, state, writePages = true) => setTimeout(() => {
  if (writePages) {
    // The prompt line is "Staging wiki directory (absolute): "<json path>"" (capital S). A miss must
    // never degrade to the literal "undefined" (that is a relative path and wrote pages/p.md into the
    // package directory); resolve the job's real stageDir or fail loudly.
    const prompt = state.followups.at(-1)?.content?.[0]?.text ?? "";
    const stage = /Staging wiki directory \(absolute\): "(.+?)"/.exec(prompt)?.[1];
    if (typeof stage !== "string") throw new Error(`completeTurn: the worker prompt names no staging directory: ${JSON.stringify(prompt.slice(0, 200))}`);
    const dir = JSON.parse(`"${stage}"`);
    if (!path.isAbsolute(dir)) throw new Error(`completeTurn: the staging directory is not absolute: ${JSON.stringify(dir)}`);
    // A job that already released its staging has nothing to receive pages; never recreate the tree.
    if (existsSync(dir)) {
      mkdirSync(path.join(dir, "pages"), { recursive: true });
      writeFileSync(path.join(dir, "pages", "p.md"), "---\nid: \"p\"\n---\n# P\n");
    }
  }
  agent.events.push({ type: "turn/end", seq: agent.events.length + 1, data: { turn: 1, reason: { kind: "completed" } } });
  agent.status = "idle";
}, 5);
const startJob = (manager, root) => manager.start({ root, action: "generate", model: { provider: "mock", model: "m1" } });
const startTranslate = (manager, root, targetLang = "vi") => manager.start({ root, action: "translate", targetLang, model: { provider: "mock", model: "m1" } });
const stagingOf = (root) => readdirSync(root).filter((n) => n.startsWith(".dsh-wiki.staging-"));
// Directory junctions work without developer mode / elevation on Windows; a plain dir symlink elsewhere.
const makeDirLink = (target, link) => {
  try { symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir"); return true; } catch { return false; }
};
/** The staging directory the worker prompt names (same extraction completeTurn uses). */
const stageDirFrom = (state) => {
  const prompt = state.followups.at(-1)?.content?.[0]?.text ?? "";
  const stage = /Staging wiki directory \(absolute\): "(.+?)"/.exec(prompt)?.[1];
  if (typeof stage !== "string") throw new Error("stageDirFrom: the worker prompt names no staging directory");
  return JSON.parse(`"${stage}"`);
};
/** An existing live `.dsh-wiki` that declares the canonical en wiki (a generate job accepts and updates it). */
const makeLiveWiki = (root, title = "Old Wiki") => {
  const live = path.join(root, ".dsh-wiki");
  mkdirSync(live, { recursive: true });
  writeFileSync(path.join(live, "wiki.json"), JSON.stringify({
    schema: "repo-wiki-local/1", repoId: root, language: "en", title, pages: [{ id: "old-p" }],
  }));
  return live;
};
const liveTitleOf = (live) => JSON.parse(readFileSync(path.join(live, "wiki.json"), "utf8")).title;

test("setup order: mount → restrict → definitions → executable pins → activate → guard → model select", async () => {
  const host = makeHost({ onFollowup: (a, _m, s) => completeTurn(a, s) });
  const { root, manager } = await makeManager(host);
  startJob(manager, root);
  const last = await finish(manager, root);
  assert.equal(last.phase, "done", JSON.stringify(last.error));
  const order = host.log.filter((e) => ["create", "mount:dsh-wiki-worker", "restrict", "definitions", "activate", "guard", "select", "followup"].includes(e) || e.startsWith("executable:"));
  assert.deepEqual(order.slice(0, 3), ["create", "mount:dsh-wiki-worker", "restrict"]);
  const idx = (e) => host.log.indexOf(e);
  assert.ok(idx("restrict") < idx("definitions") && idx("definitions") < idx("executable:read"));
  assert.ok(idx("executable:edit") < idx("activate") && idx("activate") < idx("guard") && idx("guard") < idx("select") && idx("select") < idx("followup"));
  assert.deepEqual(host.state.restrict, { allow: FIVE });
  assert.deepEqual(host.state.createOptions.agentOptions, { provider: "mock", model: "m1" });
  assert.deepEqual(host.state.createOptions.meta, { cwd: path.resolve(root), agentPreset: "dsh-wiki-worker" });
  assert.equal(typeof host.state.createOptions.signal?.aborted, "boolean");
  assert.equal(host.state.activations[0].cwd, path.resolve(root));
});

for (const [label, hostOpts, code] of [
  ["restrict throws", { restrictThrows: true }, "worker-restrict-failed"],
  ["extra tool exposed", { extraTool: true }, "worker-tools-mismatch"],
  ["guard returns a non-function", { guardNotFunction: true }, "guard-install-failed"],
  ["preset mount throws", { mountThrows: true }, undefined],
]) {
  test(`setup failure (${label}) => job failed, zero followup, staging removed, activation released`, async () => {
    const host = makeHost(hostOpts);
    const { root, manager } = await makeManager(host);
    startJob(manager, root);
    const last = await finish(manager, root);
    assert.equal(last.phase, "failed");
    if (code) assert.equal(last.error.code, code);
    assert.equal(host.state.followups.length, 0);
    assert.equal(host.log.includes("followup"), false);
    assert.equal(stagingOf(root).length, 0);
    assert.equal(manager.isBusy(root), false);
    assert.equal(host.state.activations.length === host.state.released.length, true, "any activation made was released");
  });
}

// preset 绑定：mount 的结果必须真的是固定 id，且必须能用 composedPreset 证明它对这个 agent 生效。
// 任何“看起来失败”的形状（reviewer 实测的 mock mount {ok:false,...}）都必须在任何工具调用之前致命。
for (const [label, hostOpts, code] of [
  ["mount resolves ok:false + diagnostics", { mountResult: { ok: false, status: "failed", diagnostics: ["preset rejected"] } }, "preset-mount-failed"],
  ["mount resolves a broken preset", { mountResult: { id: "dsh-wiki-worker", broken: "activation failed" } }, "preset-mount-failed"],
  ["mount binds another preset", { mountResult: { id: "some-other-preset" } }, "preset-mount-failed"],
  ["mount result carries no identity", { mountResult: { status: "ok" } }, "preset-mount-failed"],
  ["composedPreset reports another preset", { composedPreset: () => "some-other-preset" }, "preset-mount-failed"],
  ["composedPreset reports nothing", { composedPreset: () => undefined }, "preset-mount-failed"],
]) {
  test(`preset binding (${label}) => job failed before any tool call, zero followup`, async () => {
    const host = makeHost(hostOpts);
    const { root, manager } = await makeManager(host);
    startJob(manager, root);
    const last = await finish(manager, root);
    assert.equal(last.phase, "failed");
    assert.equal(last.error.code, code);
    // 致命点在 tools.restrict 之前：没有任何工具被限制/枚举/固定，没有 guard、没有 activation、没有模型选择。
    for (const stage of ["restrict", "definitions", "guard", "select", "followup"]) {
      assert.equal(host.log.includes(stage), false, `${label}: ${stage} must not run`);
    }
    assert.equal(host.log.some((entry) => entry.startsWith("executable:")), false, `${label}: no executable may be pinned`);
    assert.equal(host.state.activations.length, 0);
    assert.equal(host.state.followups.length, 0);
    assert.equal(stagingOf(root).length, 0);
    assert.equal(manager.isBusy(root), false);
  });
}

test("preset verification: a manager without agentPresets.composedPreset refuses to start (503, no session)", async () => {
  const host = makeHost({ onFollowup: (a, _m, s) => completeTurn(a, s) });
  const { root, manager } = await makeManager(host, {
    options: { agentPresets: { mount: async () => ({ id: "dsh-wiki-worker" }) } },
  });
  const error = (() => { try { startJob(manager, root); return null; } catch (thrown) { return thrown; } })();
  assert.equal(error?.status, 503);
  assert.equal(error?.code, "services-unavailable");
  assert.match(String(error?.message), /agentPresets\.composedPreset/);
  assert.equal(manager.isBusy(root), false);
  assert.equal(host.log.includes("mount:dsh-wiki-worker"), false, "no mount without a verifier");
  assert.equal(stagingOf(root).length, 0);
});

test("preset identity: the manager refuses a presetId other than the fixed worker preset", async () => {
  const host = makeHost({ onFollowup: (a, _m, s) => completeTurn(a, s) });
  const { root, manager } = await makeManager(host, { options: { presetId: "some-other-preset" } });
  const error = (() => { try { startJob(manager, root); return null; } catch (thrown) { return thrown; } })();
  assert.equal(error?.status, 503);
  assert.equal(error?.code, "services-unavailable");
  assert.match(String(error?.message), /presetId/);
  assert.equal(manager.isBusy(root), false);
});

test("guard: pinned executable identity shadowed => denied; authorizeSync decisions pass through", async () => {
  const host = makeHost({ onFollowup: (a, _m, s) => completeTurn(a, s) });
  const { root, manager } = await makeManager(host);
  startJob(manager, root);
  await finish(manager, root);
  const guard = host.state.guards[0];
  const agentId = host.state.handles[0].agent.id;
  assert.equal(guard({ name: "read", agent: { id: agentId } }), undefined);
  assert.match(guard({ name: "deny-me", agent: { id: agentId } }), /denied by authorizeSync/);
  host.state.executables.write = { name: "write", id: Symbol("shadow") }; // shadowing registration
  assert.match(guard({ name: "write", agent: { id: agentId } }), /pinned executable/);
});

test("guard + activation stay alive until dispose resolves, even when manager.dispose runs first", async () => {
  const host = makeHost({ disposeDelayMs: 120 });
  const { root, manager } = await makeManager(host);
  startJob(manager, root);
  for (let i = 0; i < 200 && !host.state.handles.length; i++) await sleep(10);
  const disposing = manager.dispose();
  await sleep(40);
  assert.equal(host.state.released.length, 0, "activation must not be released while dispose is pending");
  assert.ok(host.log.includes("dispose-start") && !host.log.includes("dispose-end"));
  assert.equal(stagingOf(root).length, 1, "staging kept until dispose resolves");
  await disposing;
  assert.equal(host.state.released.length, 1);
  assert.ok(host.log.indexOf("release") > host.log.indexOf("dispose-start"));
  assert.equal(stagingOf(root).length, 0);
});

test("hanging dispose => quarantine: staging + fence kept, activation not released", async () => {
  const host = makeHost({ disposeHangs: true });
  const { root, manager } = await makeManager(host);
  startJob(manager, root);
  for (let i = 0; i < 200 && !host.state.handles.length; i++) await sleep(10);
  manager.cancel(root);
  const last = await finish(manager, root);
  assert.equal(last.error.code, "worker-not-stopped");
  assert.equal(last.blocked.reason, "worker-not-stopped");
  assert.equal(manager.isBusy(root), true);
  assert.equal(stagingOf(root).length, 1);
  assert.equal(host.state.released.length, 0);
  assert.throws(() => startJob(manager, root), (e) => e.code === "job-quarantined");
});

test("throwing dispose => quarantine (fence kept)", async () => {
  const host = makeHost({ disposeThrows: true });
  const { root, manager } = await makeManager(host);
  startJob(manager, root);
  for (let i = 0; i < 200 && !host.state.handles.length; i++) await sleep(10);
  manager.cancel(root);
  const last = await finish(manager, root);
  assert.equal(last.blocked?.reason, "worker-not-stopped");
  assert.equal(manager.isBusy(root), true);
});

test("manager.dispose disposes every handle", async () => {
  const host = makeHost();
  const a = await makeManager(host);
  const b = await makeManager(host);
  startJob(a.manager, a.root);
  startJob(b.manager, b.root);
  for (let i = 0; i < 300 && host.state.handles.length < 2; i++) await sleep(10);
  await Promise.all([a.manager.dispose(), b.manager.dispose()]);
  assert.equal(host.log.filter((e) => e === "dispose-end").length, 2);
});

test("prompt: no python/git execution instructions; hashes recorded; pinned model", async () => {
  const host = makeHost({ onFollowup: (a, _m, s) => completeTurn(a, s) });
  const { root, manager } = await makeManager(host);
  startJob(manager, root);
  const last = await finish(manager, root);
  const text = host.state.followups[0].content[0].text;
  assert.equal(/\bpython3?\s+\S|\bpy -3|\bgit\s+-C|rev-parse|resolve-config|--wiki\b|--repo\b|--language\b|`(?:python|git|node)\b/i.test(text), false, "no executable command text");
  assert.match(last.promptSha256, /^[0-9a-f]{64}$/);
  assert.match(last.protocolSha256, /^[0-9a-f]{64}$/);
  assert.equal(host.state.followups[0].source.kind, "user");
});

test("Host runs resolve-config before the session, assemble before build, then validate/build/selfcheck", async () => {
  const host = makeHost({ onFollowup: (a, _m, s) => completeTurn(a, s) });
  const { root, manager, builderCalls } = await makeManager(host);
  startJob(manager, root);
  const last = await finish(manager, root);
  assert.equal(last.phase, "done", JSON.stringify(last.error));
  assert.deepEqual(builderCalls, ["resolve-config", "assemble", "build", "selfcheck"]);
  assert.ok(host.log.indexOf("builder:resolve-config") < host.log.indexOf("create"));
  assert.ok(host.log.indexOf("dispose-end") < host.log.indexOf("builder:assemble"), "worker stopped before the Host touches the candidate");
  assert.ok(host.log.indexOf("builder:assemble") < host.log.indexOf("builder:build"));
});

test("Host writes generation-meta.json (sourceCommit, config, model, hashes) into the published wiki", async () => {
  const host = makeHost({ onFollowup: (a, _m, s) => completeTurn(a, s) });
  const { root, manager } = await makeManager(host);
  startJob(manager, root);
  const last = await finish(manager, root);
  assert.equal(last.published, true);
  const meta = JSON.parse(readFileSync(path.join(root, ".dsh-wiki", "generation-meta.json"), "utf8"));
  assert.equal(meta.sourceCommit, "a".repeat(40));
  assert.deepEqual(meta.resolved, EFFECTIVE);
  assert.deepEqual(meta.docModel, { provider: "mock", model: "m1" });
  assert.equal(meta.promptSha256, last.promptSha256);
  assert.equal(meta.protocolSha256, last.protocolSha256);
  assert.equal(meta.repoId, path.resolve(root));
});

test("assemble failure => job failed, old wiki untouched", async () => {
  const host = makeHost({ onFollowup: (a, _m, s) => completeTurn(a, s) });
  const { root, manager } = await makeManager(host, { builderFail: "assemble" });
  startJob(manager, root);
  const last = await finish(manager, root);
  assert.equal(last.error.code, "assemble-failed");
  assert.equal(existsSync(path.join(root, ".dsh-wiki")), false);
});

// ================= security ordering: reject before the Host phase, not only at the final scan =================
// The staged candidate is attacker-controlled content. A linked artifact, or a staging/root directory
// swapped after the worker stopped, must be refused BEFORE the Host assemble/content-gate/meta-write/
// validate/build/selfcheck/preserve phases read or write it — a final scan cannot undo an earlier read
// or write. These three tests assert the ORDERING (what did not run / was not written), not just the code.

test("security order: a link planted in staging is refused before the Host assembles, gates or writes", async (t) => {
  resetProbe();
  const outside = tempDir("dsh-wiki-linked-outside-");
  writeFileSync(path.join(outside, "secret.md"), "outside-secret");
  let linked = true;
  const gateCalls = [];
  const host = makeHost({
    onFollowup: (agent, _m, state) => {
      linked = makeDirLink(outside, path.join(stageDirFrom(state), "linked"));
      completeTurn(agent, state);
    },
  });
  const { root, manager, builderCalls, store } = await makeManager(host, {
    options: { contentGate: (wiki) => { gateCalls.push(wiki); return { ok: true }; } },
  });
  startJob(manager, root);
  const last = await finish(manager, root);
  if (!linked) return t.skip("this host cannot create a directory link");
  assert.equal(last.phase, "failed", JSON.stringify(last.error));
  assert.equal(last.error.code, "candidate-untrusted");
  // Ordering: nothing Host-side ever touched the candidate. No assemble, no content gate, no metadata.
  assert.deepEqual(builderCalls, ["resolve-config"], "assemble/build/selfcheck never ran");
  assert.equal(host.log.includes("builder:assemble"), false);
  assert.equal(gateCalls.length, 0, "the content gate never read the candidate");
  const stage = path.join(root, `.dsh-wiki.staging-${last.id}`);
  assert.equal(existsSync(path.join(stage, "wiki.json")), false, "assemble never wrote the candidate wiki.json");
  assert.equal(existsSync(path.join(stage, "generation-meta.json")), false, "no metadata was written");
  assert.equal((await store.load(root)).record.phase, "aborted", "the record never reached validated");
  assert.equal(existsSync(path.join(root, ".dsh-wiki")), false, "nothing was published");
  // “内容不变”证明不了没读过（读不改内容）：观察真正的读路径。读穿 junction 时路径仍是树内路径，
  // 所以既看路径（链接目标本身 / 暂存里的 linked/），也看每个被打开句柄的 dev/ino。
  const outsideTarget = path.join(outside, "secret.md");
  const outsideStats = statSync(outsideTarget, { bigint: true });
  const linkedDir = path.join(stage, "linked");
  const outsideReads = probe.events.filter((event) => {
    if (event.op === "handle") return event.dev === String(outsideStats.dev) && event.ino === String(outsideStats.ino);
    if (event.op !== "open") return false;
    const opened = path.resolve(event.path);
    return opened === path.resolve(outside) || opened.startsWith(`${path.resolve(outside)}${path.sep}`)
      || opened === linkedDir || opened.startsWith(`${linkedDir}${path.sep}`);
  });
  assert.deepEqual(outsideReads, [], "the outside file behind the link was never opened for reading");
  // 正对照：正常候选确实经过同一条观察路径（暂存的 wiki.json 被 open），否则“从未 open”就是空断言。
  const control = await makeManager(makeHost({ onFollowup: (a, _m, s) => completeTurn(a, s) }));
  startJob(control.manager, control.root);
  const controlLast = await finish(control.manager, control.root);
  assert.equal(controlLast.phase, "done", JSON.stringify(controlLast.error));
  assert.ok(
    probe.events.some((event) => event.op === "open" && event.path.includes(".dsh-wiki.staging-") && path.basename(event.path) === "wiki.json"),
    "positive control: the probe records the plugin's real candidate reads",
  );
});

test("security order: a staging directory swapped between Host phases is caught before the next phase", async () => {
  const gateCalls = [];
  const builderCalls = [];
  let assembleSwapped = false;
  const host = makeHost({ onFollowup: (a, _m, s) => completeTurn(a, s) });
  const { root, manager, store } = await makeManager(host, {
    options: () => ({
      contentGate: (wiki) => { gateCalls.push(wiki); return { ok: true }; },
      runBuilder: async (job, args) => {
        builderCalls.push(args[0]);
        if (args[0] === "resolve-config") return { ok: true, code: 0, output: "", stdout: JSON.stringify(EFFECTIVE) };
        if (args[0] === "assemble") {
          writeFileSync(path.join(job.stageDir, "wiki.json"), JSON.stringify({ schema: "repo-wiki-local/1", repoId: job.root, language: "en", pages: [{ id: "p" }] }));
          // Swap the journal-bound staging directory for a fresh directory at the same path.
          renameSync(job.stageDir, `${job.stageDir}.swapped`);
          mkdirSync(job.stageDir);
          assembleSwapped = true;
        }
        return { ok: true, code: 0, output: "", stdout: "" };
      },
    }),
  });
  startJob(manager, root);
  const last = await finish(manager, root);
  assert.equal(assembleSwapped, true, "the fixture really replaced the staging directory");
  assert.equal(last.phase, "failed", JSON.stringify(last.error));
  assert.equal(last.error.code, "candidate-untrusted");
  // The swap is detected by the identity re-check BEFORE the content gate reads anything.
  assert.deepEqual(builderCalls, ["resolve-config", "assemble"], "build/selfcheck never ran on the swapped stage");
  assert.equal(gateCalls.length, 0, "the content gate never read the swapped candidate");
  assert.equal(existsSync(path.join(root, `.dsh-wiki.staging-${last.id}`, "generation-meta.json")), false, "no metadata was written through the swapped stage");
  assert.equal((await store.load(root)).record.phase, "aborted");
});

test("security order: a repository root swapped after the worker stops is refused before assemble", async () => {
  const moved = tempDir("dsh-wiki-root-moved-");
  const host = makeHost({ onFollowup: (a, _m, s) => completeTurn(a, s) });
  const root = tempDir("dsh-wiki-wk-");
  // Swap the root deterministically: the journal has just committed "worker-stopped", so the very next
  // thing the Host could do is the assemble phase.
  const fixture = await journalFixture(root, {
    afterAdvance: async (next) => {
      if (next.phase !== "worker-stopped") return;
      renameSync(root, path.join(moved, "repo"));
      mkdirSync(root);
    },
  });
  const builderCalls = [];
  const manager = createJobManager({
    ...host.deps, buildWorkerPrompt, builderPath: "unused",
    runBuilder: async (job, args) => {
      builderCalls.push(args[0]);
      if (args[0] === "resolve-config") return { ok: true, code: 0, output: "", stdout: JSON.stringify(EFFECTIVE) };
      return { ok: true, code: 0, output: "", stdout: "" };
    },
    pollMs: 10, idleGraceMs: 150, disposeTimeoutMs: 150, jobTimeoutMs: 5000,
    getSourceCommit: async () => "a".repeat(40),
    ...fixture.managerOptions,
  });
  startJob(manager, root);
  const last = await finish(manager, root);
  assert.equal(last.phase, "failed", JSON.stringify(last.error));
  // Ordering: the swapped root is refused before assemble runs.
  assert.deepEqual(builderCalls, ["resolve-config"], "assemble never ran against the swapped root");
  assert.equal(host.log.includes("builder:assemble"), false);
  // Fail closed: the journal refuses to advance a record over a swapped root, so the fence stays raised
  // and the record remains at the last durable phase instead of being rewritten against the new directory.
  assert.equal(last.error.code, "journal-root-identity-mismatch");
  assert.equal(last.blocked?.journal, true, JSON.stringify(last.blocked));
  assert.equal(manager.isBusy(root), true, "the repository stays fenced");
  // The store refuses the swapped root too, so no record is ever advanced against the new directory.
  await assert.rejects(fixture.store.load(root), (error) => error?.code === "root-identity-mismatch");
});

test("security order: the normal path is unchanged (every phase runs once, then the candidate publishes)", async () => {
  const gateCalls = [];
  const host = makeHost({ onFollowup: (a, _m, s) => completeTurn(a, s) });
  const { root, manager, builderCalls, store } = await makeManager(host, {
    options: { contentGate: (wiki) => { gateCalls.push(wiki); return { ok: true }; } },
  });
  startJob(manager, root);
  const last = await finish(manager, root);
  assert.equal(last.phase, "done", JSON.stringify(last.error));
  assert.equal(last.published, true);
  assert.deepEqual(builderCalls, ["resolve-config", "assemble", "build", "selfcheck"]);
  assert.equal(gateCalls.length, 1, "the content gate still evaluates the assembled candidate exactly once");
  assert.equal(existsSync(path.join(root, ".dsh-wiki", "generation-meta.json")), true, "the metadata write still happens");
  assert.equal((await store.load(root)).record.phase, "published");
});

test("translation gate: the en path never invokes check-translation", async () => {
  // The gate is a Host-owned post-assemble step for non-canonical languages only. The injected
  // resolve-config answers with EFFECTIVE, so the job really runs the canonical en path; if that
  // language changed, this test would stop proving anything about "en".
  assert.equal(EFFECTIVE.language, "en", "fixture: the resolved language is the canonical en");
  const host = makeHost({ onFollowup: (a, _m, s) => completeTurn(a, s) });
  const { root, manager, builderCalls, store } = await makeManager(host);
  startJob(manager, root);
  const last = await finish(manager, root);
  assert.equal(last.phase, "done", JSON.stringify(last.error));
  assert.equal(last.published, true);
  assert.deepEqual(builderCalls, ["resolve-config", "assemble", "build", "selfcheck"]);
  assert.equal(builderCalls.includes("check-translation"), false, "the canonical en wiki is never re-checked");
  assert.equal(host.log.includes("builder:check-translation"), false);
  assert.equal((await store.load(root)).record.phase, "published");
});

// ================= translate jobs (T014a-rev): locale mirror → locales-init → worker → re-seed → assemble =================
// The worker's write scope is the locale mirror `locales/<lang>/` (byte-identical English copies of the
// canonical pages/cards); after it stops the Host re-seeds the canonical tree from the live wiki and
// assembles the units from the translated Markdown. The fake builder below reproduces only the Host-side
// contract (locales-init skeleton + meta, assemble from the mirror); the real builder is covered by
// jobs-harness-test.
// The gate needs the real checker path (it refuses an absent script as translation-gate-unavailable).
const BUILDER_PATH = path.join(here, "..", "scripts", "build_wiki_site.py");
const stubTranslationPrompt = async (options) => ({
  prompt: `# translation job\nStaging wiki directory (absolute): ${JSON.stringify(options.stageDir)}\n`,
  promptSha256: "b".repeat(64),
  protocolSha256: "c".repeat(64),
});
/** The meta locales-init writes: per-unit structural hashes of the canonical text. */
const translateMeta = (lang) => `${JSON.stringify({
  schema: "repo-wiki-translation-meta/1", sourceLang: "en", targetLang: lang,
  pages: { p1: { sourceContentHash: "d".repeat(64) } }, cards: {},
}, null, 2)}\n`;

/** Fake builder for translate jobs; `rewriteMeta` simulates an assemble that clobbers the meta file. */
function translateBuilder({ host = null, builderCalls = [], failAt = null, rewriteMeta = false } = {}) {
  return async (job, args) => {
    builderCalls.push(args);
    host?.log.push(`builder:${args[0]}`);
    if (failAt === args[0]) return { ok: false, code: 1, output: "boom", stdout: "" };
    if (args[0] === "resolve-config") return { ok: true, code: 0, output: "", stdout: JSON.stringify(EFFECTIVE) };
    if (args[0] === "locales-init") {
      const lang = args[args.indexOf("--lang") + 1];
      const dir = path.join(job.stageDir, "locales", lang);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "wiki.json"), JSON.stringify({ schema: "repo-wiki-local/1", repoId: job.root, language: lang, title: "Old Wiki", pages: [] }));
      writeFileSync(path.join(dir, "translation-meta.json"), translateMeta(lang));
      return { ok: true, code: 0, output: "", stdout: JSON.stringify({ ok: true }) };
    }
    if (args[0] === "assemble") {
      const wikiDir = args[args.indexOf("--wiki") + 1];
      const lang = args[args.indexOf("--language") + 1];
      const before = JSON.parse(readFileSync(path.join(wikiDir, "wiki.json"), "utf8"));
      const pages = readdirSync(path.join(wikiDir, "pages")).filter((name) => name.endsWith(".md")).sort().map((name) => {
        const text = readFileSync(path.join(wikiDir, "pages", name), "utf8");
        const id = /^id:\s*"?([^"\n]+)"?$/m.exec(text)?.[1] ?? name.replace(/\.md$/, "");
        return { id, parentId: null, order: 0, title: `title-${id}`, description: "", filePaths: [], markdown: text };
      });
      if (rewriteMeta) writeFileSync(path.join(wikiDir, "translation-meta.json"), translateMeta(`${lang}-rewritten`));
      writeFileSync(path.join(wikiDir, "wiki.json"), JSON.stringify({ ...before, language: lang, pages }));
      return { ok: true, code: 0, output: "", stdout: "" };
    }
    if (args[0] === "check-translation") return { ok: true, code: 0, output: "", stdout: JSON.stringify({ ok: true }) };
    return { ok: true, code: 0, output: "", stdout: "" };
  };
}

test("translate: seeds locales/<lang>/pages and cards with the canonical bytes and scopes the worker to it", async () => {
  const snapshot = {};
  const host = makeHost({
    onFollowup: (agent, _m, state) => {
      // The worker session is created only after both seeds: this is the state it starts from.
      const stage = stageDirFrom(state);
      snapshot.stage = stage;
      snapshot.mirrorPage = readFileSync(path.join(stage, "locales", "vi", "pages", "p1.md"));
      snapshot.mirrorCard = readFileSync(path.join(stage, "locales", "vi", "cards", "c1.md"));
      snapshot.stagePage = readFileSync(path.join(stage, "pages", "p1.md"));
      snapshot.stageWiki = readFileSync(path.join(stage, "wiki.json"));
      completeTurn(agent, state, false);
    },
  });
  const builderCalls = [];
  const { root, manager } = await makeManager(host, {
    options: () => ({ builderPath: BUILDER_PATH, buildTranslationPrompt: stubTranslationPrompt, runBuilder: translateBuilder({ host, builderCalls }) }),
  });
  const live = makeLiveWiki(root);
  mkdirSync(path.join(live, "pages"), { recursive: true });
  mkdirSync(path.join(live, "cards"), { recursive: true });
  writeFileSync(path.join(live, "pages", "p1.md"), "---\nid: \"p1\"\n---\n# P1\n\nSee `a/b.ts:3`.\n");
  writeFileSync(path.join(live, "cards", "c1.md"), "---\nid: \"c1\"\ntitle: C1\nkind: concept\n---\nOne line summary.\n");
  const PAGE = readFileSync(path.join(live, "pages", "p1.md"));
  const CARD = readFileSync(path.join(live, "cards", "c1.md"));
  const LIVE_WIKI = readFileSync(path.join(live, "wiki.json"));

  startTranslate(manager, root);
  const last = await finish(manager, root);
  assert.equal(last.phase, "done", JSON.stringify(last.error));
  assert.equal(snapshot.mirrorPage.equals(PAGE), true, "the mirror page is a byte-identical English copy of the canonical page");
  assert.equal(snapshot.mirrorCard.equals(CARD), true, "the mirror card is a byte-identical English copy of the canonical card");
  assert.equal(snapshot.stagePage.equals(PAGE), true, "the canonical page is still the live copy at worker start");
  assert.equal(snapshot.stageWiki.equals(LIVE_WIKI), true);
  // The guard's write scope is the mirror, not the staging root: with the real guard the worker cannot
  // write the canonical tree at all (the re-seed covers everything else).
  assert.equal(host.state.activations[0].stagingRoot, path.join(snapshot.stage, "locales", "vi"));
  const published = path.join(root, ".dsh-wiki");
  assert.equal(readFileSync(path.join(published, "locales", "vi", "pages", "p1.md")).equals(PAGE), true);
  assert.equal(readFileSync(path.join(published, "locales", "vi", "cards", "c1.md")).equals(CARD), true);
  assert.equal(readFileSync(path.join(published, "locales", "vi", "translation-meta.json"), "utf8"), translateMeta("vi"));
});

test("translate: runs locales-init, assembles the locale units from the Markdown, keeps the canonical and the meta", async () => {
  const host = makeHost({ onFollowup: (a, _m, s) => completeTurn(a, s, false) });
  const builderCalls = [];
  const promptArgs = [];
  const { root, manager, store } = await makeManager(host, {
    options: () => ({
      builderPath: BUILDER_PATH,
      buildTranslationPrompt: async (options) => {
        promptArgs.push(options);
        return {
          prompt: `# translation job\nStaging wiki directory (absolute): ${JSON.stringify(options.stageDir)}\nTarget language: ${JSON.stringify(options.targetLang)}\n`,
          promptSha256: "b".repeat(64),
          protocolSha256: "c".repeat(64),
        };
      },
      runBuilder: translateBuilder({ host, builderCalls }),
    }),
  });
  const live = makeLiveWiki(root);
  const WIKI_BYTES = readFileSync(path.join(live, "wiki.json"));
  mkdirSync(path.join(live, "pages"), { recursive: true });
  writeFileSync(path.join(live, "pages", "p1.md"), "---\nid: \"p1\"\n---\n# P1\n");
  const PAGE_BYTES = readFileSync(path.join(live, "pages", "p1.md"));
  const CONFIG = `${JSON.stringify({ profile: "compact" }, null, 2)}\n`;
  writeFileSync(path.join(live, "config.json"), CONFIG);
  const META = `${JSON.stringify({ schema: "repo-wiki-local/1", kind: "generation-meta", generatedAt: "2026-01-01T00:00:00.000Z", promptSha256: "a".repeat(64) }, null, 2)}\n`;
  writeFileSync(path.join(live, "generation-meta.json"), META);
  mkdirSync(path.join(live, "site"), { recursive: true });
  writeFileSync(path.join(live, "site", "index.html"), "<html></html>");
  mkdirSync(path.join(live, "locales", "ja"), { recursive: true });
  writeFileSync(path.join(live, "locales", "ja", "wiki.json"), JSON.stringify({ language: "ja", pages: [] }));

  startTranslate(manager, root);
  const last = await finish(manager, root);
  assert.equal(last.phase, "done", JSON.stringify(last.error));
  assert.equal(last.published, true);
  const stage = path.join(root, `.dsh-wiki.staging-${last.id}`);
  assert.deepEqual(builderCalls.map((args) => args[0]), ["resolve-config", "locales-init", "assemble", "build", "selfcheck", "check-translation"],
    "the locale units are assembled from the Markdown; no canonical assemble for a translate job");
  assert.deepEqual(builderCalls[1], ["locales-init", "--canonical", stage, "--lang", "vi", "--json"]);
  const assembleCall = builderCalls[2];
  assert.equal(assembleCall.includes("--wiki"), true);
  assert.equal(assembleCall[assembleCall.indexOf("--wiki") + 1], path.join(stage, "locales", "vi"),
    "assemble runs against the locale mirror, never against the staging tree");
  assert.equal(assembleCall[assembleCall.indexOf("--language") + 1], "vi");
  assert.equal(promptArgs.length, 1, "the worker received the translation prompt, not the generation prompt");
  assert.equal(promptArgs[0].jobId, last.id);
  assert.equal(promptArgs[0].root, path.resolve(root));
  assert.equal(promptArgs[0].stageDir, stage);
  assert.equal(promptArgs[0].targetLang, "vi");
  assert.deepEqual(promptArgs[0].config, EFFECTIVE, "the canonical source configuration is unchanged");
  assert.equal(host.state.followups[0].content[0].text.startsWith("# translation job"), true, "the worker received the translation prompt, not the generation prompt");
  assert.equal(host.state.followups[0].content[0].text.includes('Target language: "vi"'), true);
  assert.ok(host.log.indexOf("builder:locales-init") < host.log.indexOf("create"), "the units skeleton exists before the session starts");
  assert.ok(host.log.indexOf("dispose-end") < host.log.indexOf("builder:assemble"), "the worker is stopped before the locale units are assembled");
  assert.ok(host.log.indexOf("builder:assemble") < host.log.indexOf("builder:build"));
  const published = path.join(root, ".dsh-wiki");
  assert.equal(readFileSync(path.join(published, "wiki.json")).equals(WIKI_BYTES), true, "the canonical wiki.json is byte-identical");
  assert.equal(readFileSync(path.join(published, "pages", "p1.md")).equals(PAGE_BYTES), true, "the canonical pages are byte-identical");
  assert.equal(readFileSync(path.join(published, "config.json"), "utf8"), CONFIG, "config.json stays host-owned");
  assert.equal(readFileSync(path.join(published, "generation-meta.json"), "utf8"), META, "the canonical generation provenance is preserved, never rewritten");
  assert.equal(existsSync(path.join(published, "locales", "vi", "wiki.json")), true, "the assembled translated units are published");
  assert.equal(readFileSync(path.join(published, "locales", "vi", "translation-meta.json"), "utf8"), translateMeta("vi"),
    "the per-unit canonical hashes written by locales-init survive the assemble and the publish");
  assert.equal(existsSync(path.join(published, "locales", "ja", "wiki.json")), true, "other host-owned locales are carried over from live");
  assert.equal(existsSync(path.join(published, "site")), false, "site/ is never seeded, the build step owns it");
  assert.deepEqual(stagingOf(root), [], "staging is gone after the publish");
  assert.equal((await store.load(root)).record.phase, "published");
});

// The measured real run: the worker translated the canonical Markdown in place. The canonical output of a
// translate job is the published canonical by definition, so the Host copies it again after the worker
// stopped instead of trusting the model — the job proceeds and never publishes a modified canonical.
test("translate: a worker that translates the canonical pages and cards cannot publish them (canonical re-seed)", async () => {
  const host = makeHost({
    onFollowup: (agent, _m, state) => {
      const stage = stageDirFrom(state);
      writeFileSync(path.join(stage, "pages", "p1.md"), "---\nid: \"p1\"\n---\n# Trang da dich\n");
      writeFileSync(path.join(stage, "wiki.json"), JSON.stringify({
        schema: "repo-wiki-local/1", repoId: stage, language: "vi", title: "Wiki tieng Viet", pages: [{ id: "p1", title: "Trang" }],
      }));
      writeFileSync(path.join(stage, "locales", "vi", "pages", "p1.md"), "---\nid: \"p1\"\n---\n# Ban dich\n");
      completeTurn(agent, state, false);
    },
  });
  const builderCalls = [];
  const { root, manager, store } = await makeManager(host, {
    options: () => ({ builderPath: BUILDER_PATH, buildTranslationPrompt: stubTranslationPrompt, runBuilder: translateBuilder({ host, builderCalls }) }),
  });
  const live = makeLiveWiki(root);
  mkdirSync(path.join(live, "pages"), { recursive: true });
  writeFileSync(path.join(live, "pages", "p1.md"), "---\nid: \"p1\"\n---\n# P1 English\n");
  const PAGE = readFileSync(path.join(live, "pages", "p1.md"));
  const LIVE_WIKI = readFileSync(path.join(live, "wiki.json"));
  const TRANSLATED = Buffer.from("---\nid: \"p1\"\n---\n# Ban dich\n");

  startTranslate(manager, root);
  const last = await finish(manager, root);
  assert.equal(last.phase, "done", JSON.stringify(last.error));
  assert.equal(last.published, true);
  const published = path.join(root, ".dsh-wiki");
  assert.equal(readFileSync(path.join(published, "wiki.json")).equals(LIVE_WIKI), true,
    "the published canonical wiki.json is byte-identical to the live copy, whatever the worker wrote");
  assert.equal(readFileSync(path.join(published, "pages", "p1.md")).equals(PAGE), true,
    "the published canonical page is the English live copy, never the worker's translation");
  assert.equal(readFileSync(path.join(published, "locales", "vi", "pages", "p1.md")).equals(TRANSLATED), true,
    "the worker's translated Markdown is published under the locale mirror");
  const units = JSON.parse(readFileSync(path.join(published, "locales", "vi", "wiki.json"), "utf8"));
  assert.equal(units.language, "vi");
  assert.equal(units.pages.length, 1);
  assert.equal(units.pages[0].markdown.includes("Ban dich"), true, "the units are assembled from the translated Markdown");
  assert.ok(host.log.indexOf("dispose-end") < host.log.indexOf("builder:assemble"));
  assert.equal((await store.load(root)).record.phase, "published");
});

test("translate: an assemble that rewrites translation-meta.json fails closed and publishes nothing", async () => {
  const host = makeHost({ onFollowup: (a, _m, s) => completeTurn(a, s, false) });
  const builderCalls = [];
  const { root, manager, store } = await makeManager(host, {
    options: () => ({ builderPath: BUILDER_PATH, buildTranslationPrompt: stubTranslationPrompt, runBuilder: translateBuilder({ host, builderCalls, rewriteMeta: true }) }),
  });
  const live = makeLiveWiki(root);
  mkdirSync(path.join(live, "pages"), { recursive: true });
  writeFileSync(path.join(live, "pages", "p1.md"), "---\nid: \"p1\"\n---\n# P1\n");
  startTranslate(manager, root);
  const last = await finish(manager, root);
  assert.equal(last.phase, "failed", JSON.stringify(last.error));
  assert.equal(last.error.code, "assemble-failed");
  assert.equal(last.published, false);
  assert.equal(liveTitleOf(live), "Old Wiki", "nothing was published");
  assert.deepEqual(stagingOf(root), [], "the staging directory is removed");
  assert.equal((await store.load(root)).record.phase, "aborted");
});

test("translate: a canonical re-seed that cannot be proven fails with seed-untrusted and publishes nothing", async () => {
  const outside = tempDir("dsh-wiki-translate-reseed-hardlink-");
  const host = makeHost({
    onFollowup: (agent, _m, state) => {
      // The live wiki becomes unprovable (a hardlinked page) while the worker runs: the re-seed must
      // refuse instead of continuing with a canonical tree it cannot restore.
      linkSync(path.join(root, ".dsh-wiki", "pages", "p1.md"), path.join(outside, "page-hardlink.md"));
      completeTurn(agent, state, false);
    },
  });
  const builderCalls = [];
  const { root, manager, store } = await makeManager(host, {
    options: () => ({ builderPath: BUILDER_PATH, buildTranslationPrompt: stubTranslationPrompt, runBuilder: translateBuilder({ host, builderCalls }) }),
  });
  const live = makeLiveWiki(root);
  mkdirSync(path.join(live, "pages"), { recursive: true });
  writeFileSync(path.join(live, "pages", "p1.md"), "---\nid: \"p1\"\n---\n# P1\n");
  assert.equal(statSync(path.join(live, "pages", "p1.md")).nlink, 1, "fixture: the live page is a single-link file before the worker starts");
  startTranslate(manager, root);
  const last = await finish(manager, root);
  assert.equal(last.phase, "failed", JSON.stringify(last.error));
  assert.equal(last.error.code, "seed-untrusted");
  assert.equal(last.published, false);
  assert.equal(builderCalls.some((args) => args[0] === "assemble"), false, "no unit is assembled from a canonical tree that could not be re-seeded");
  assert.equal(liveTitleOf(live), "Old Wiki", "nothing was published");
  assert.equal(readFileSync(path.join(outside, "page-hardlink.md"), "utf8"), "---\nid: \"p1\"\n---\n# P1\n", "the outside hardlink is untouched");
  assert.deepEqual(stagingOf(root), [], "the staging directory is removed");
  assert.equal((await store.load(root)).record.phase, "aborted");
});

test("translate: a hardlinked live entry is refused before any copy (seed-untrusted)", async () => {
  const host = makeHost({ onFollowup: (a, _m, s) => completeTurn(a, s, false) });
  const { root, manager, store } = await makeManager(host, {
    options: { builderPath: BUILDER_PATH, buildTranslationPrompt: stubTranslationPrompt },
  });
  const live = makeLiveWiki(root);
  mkdirSync(path.join(live, "pages"), { recursive: true });
  writeFileSync(path.join(live, "pages", "p1.md"), "---\nid: \"p1\"\n---\n# P1\n");
  const outside = tempDir("dsh-wiki-translate-hardlink-");
  linkSync(path.join(live, "pages", "p1.md"), path.join(outside, "page-hardlink.md"));
  assert.equal(statSync(path.join(live, "pages", "p1.md")).nlink, 2, "fixture: the live page is really hardlinked");
  startTranslate(manager, root);
  const last = await finish(manager, root);
  assert.equal(last.phase, "failed", JSON.stringify(last.error));
  assert.equal(last.error.code, "seed-untrusted");
  assert.equal(last.published, false);
  assert.equal(existsSync(path.join(live, "locales")), false, "no translation units were created in the live wiki");
  assert.deepEqual(stagingOf(root), [], "the staging directory is removed");
  assert.equal((await store.load(root)).record.phase, "aborted");
});

test("translate: a linked live entry is refused before any copy (seed-untrusted)", async (t) => {
  const host = makeHost({ onFollowup: (a, _m, s) => completeTurn(a, s, false) });
  const { root, manager, store } = await makeManager(host, {
    options: { builderPath: BUILDER_PATH, buildTranslationPrompt: stubTranslationPrompt },
  });
  const live = makeLiveWiki(root);
  const outside = tempDir("dsh-wiki-translate-linked-outside-");
  writeFileSync(path.join(outside, "secret.md"), "outside-secret");
  if (!makeDirLink(outside, path.join(live, "linked"))) return t.skip("this host cannot create a directory link");
  startTranslate(manager, root);
  const last = await finish(manager, root);
  assert.equal(last.phase, "failed", JSON.stringify(last.error));
  assert.equal(last.error.code, "seed-untrusted");
  assert.equal(last.published, false);
  assert.equal(existsSync(path.join(live, "locales")), false, "no translation units were created in the live wiki");
  assert.deepEqual(stagingOf(root), [], "the staging directory is removed");
  assert.equal((await store.load(root)).record.phase, "aborted");
});

// ================= host-owned entries: containment, single link, fail-closed probes =================
// The live `.dsh-wiki` is attacker-controlled. A protected entry that cannot be proven a contained
// single-link regular file must be refused BEFORE it is copied: copyFile would turn a hardlink into a
// fresh single-link file, which the final staged-tree scan can no longer tell apart from a real copy.

test("protected entries: a hardlinked live file is refused before any copy", async () => {
  resetProbe();
  const host = makeHost({ onFollowup: (a, _m, s) => completeTurn(a, s) });
  const { root, manager } = await makeManager(host);
  const live = makeLiveWiki(root);
  const configPath = path.join(live, "config.json");
  const CONFIG = JSON.stringify({ profile: "compact" }, null, 2);
  writeFileSync(configPath, CONFIG);
  const outside = tempDir("dsh-wiki-hardlink-");
  const hardlink = path.join(outside, "config-hardlink.json");
  linkSync(configPath, hardlink);
  const copies = [];
  probe.onCopyFile = (source) => { copies.push(source); };
  try {
    assert.equal(statSync(configPath).nlink, 2, "fixture: the live entry is really hardlinked");
    startJob(manager, root);
    const last = await finish(manager, root);
    assert.equal(last.phase, "failed", JSON.stringify(last.error));
    assert.equal(last.error.code, "protected-hardlink");
    // 拒绝在任何复制之前：这个来源一次都没有被 copyFile 读过。
    assert.equal(copies.includes(configPath), false, "the hardlinked live entry was never copied");
    assert.equal(readFileSync(configPath, "utf8"), CONFIG, "the live entry is untouched");
    assert.equal(readFileSync(hardlink, "utf8"), CONFIG, "the outside hardlink is untouched");
    assert.equal(liveTitleOf(live), "Old Wiki", "nothing was published");
    assert.deepEqual(stagingOf(root), []);
    // 正对照：同一个观察器必须真的看到一次正常的宿主条目复制，否则上面的“从未复制”是空的。
    const control = await makeManager(makeHost({ onFollowup: (a, _m, s) => completeTurn(a, s) }));
    const controlLive = makeLiveWiki(control.root);
    writeFileSync(path.join(controlLive, "config.json"), CONFIG);
    copies.length = 0;
    startJob(control.manager, control.root);
    const controlLast = await finish(control.manager, control.root);
    assert.equal(controlLast.phase, "done", JSON.stringify(controlLast.error));
    assert.equal(copies.includes(path.join(controlLive, "config.json")), true,
      "positive control: a real protected-entry copy is observed");
  } finally {
    resetProbe();
  }
});

test("protected entries: a non-absence probe error fails closed instead of counting as absent", async () => {
  resetProbe();
  const host = makeHost({ onFollowup: (a, _m, s) => completeTurn(a, s) });
  const { root, manager } = await makeManager(host);
  const live = makeLiveWiki(root);
  const configPath = path.join(live, "config.json");
  writeFileSync(configPath, JSON.stringify({ profile: "compact" }));
  mkdirSync(path.join(live, "locales"), { recursive: true });
  writeFileSync(path.join(live, "locales", "en.json"), "{}");
  const probed = [];
  // EACCES 既不是 ENOENT（真缺席），也不代表条目不存在：把“看不清”当成“没有”会静默丢掉宿主条目。
  probe.onLstat = (target) => {
    if (target !== configPath) return;
    probed.push(target);
    const denied = new Error("probe denied by the fixture");
    denied.code = "EACCES";
    throw denied;
  };
  try {
    startJob(manager, root);
    const last = await finish(manager, root);
    assert.equal(last.phase, "failed", JSON.stringify(last.error));
    assert.equal(last.error.code, "live-untrusted");
    assert.deepEqual(probed, [configPath], "fixture: the injected probe error really fired");
    // fail closed：旧 wiki 与宿主条目都还在，候选没有发布。
    assert.equal(liveTitleOf(live), "Old Wiki", "the live wiki was not replaced");
    assert.equal(readFileSync(path.join(live, "locales", "en.json"), "utf8"), "{}");
    assert.deepEqual(stagingOf(root), []);
  } finally {
    resetProbe();
  }
});

test("read path: the proven identity is bound to the opened handle (a swap between proof and open is refused before any byte is read)", async () => {
  resetProbe();
  const gateCalls = [];
  const host = makeHost({ onFollowup: (a, _m, s) => completeTurn(a, s) });
  const { root, manager } = await makeManager(host, {
    options: { contentGate: (wiki) => { gateCalls.push(wiki); return { ok: true }; } },
  });
  const reads = [];
  let swapped = false;
  const isCandidateWiki = (target) => target.includes(".dsh-wiki.staging-") && path.basename(target) === "wiki.json";
  // 在“身份已证明”与“打开句柄”之间换掉候选 wiki.json：按路径 readFile 的旧实现会先读到新文件
  // 再被事后复核拒绝；句柄绑定则必须在读第一个字节之前就发现 dev/ino 不同。
  probe.onOpen = async (target) => {
    if (!isCandidateWiki(target) || swapped) return;
    swapped = true;
    renameSync(target, `${target}.proof-time`);
    writeFileSync(target, JSON.stringify({
      schema: "repo-wiki-local/1", repoId: root, language: "vi", pages: [{ id: "swapped-p" }],
    }));
  };
  probe.onHandle = (target, handle) => (isCandidateWiki(target)
    ? {
      stat: (options) => handle.stat(options),
      readFile: async (...args) => { reads.push(target); return handle.readFile(...args); },
      close: () => handle.close(),
    }
    : handle);
  try {
    startJob(manager, root);
    const last = await finish(manager, root);
    assert.equal(swapped, true, "fixture: the candidate was really swapped between proof and open");
    assert.equal(last.phase, "failed", JSON.stringify(last.error));
    assert.equal(last.error.code, "candidate-untrusted");
    assert.deepEqual(reads, [], "not a single byte was read from the opened handle");
    assert.equal(gateCalls.length, 0, "the swapped candidate never reached the content gate");
    assert.equal(existsSync(path.join(root, ".dsh-wiki")), false, "nothing was published");
    assert.deepEqual(stagingOf(root), []);
    // 正对照：正常候选时同一个句柄观察器必须真的看到一次读取，否则上面的 reads=[] 就是空断言。
    const control = await makeManager(makeHost({ onFollowup: (a, _m, s) => completeTurn(a, s) }));
    startJob(control.manager, control.root);
    const controlLast = await finish(control.manager, control.root);
    assert.equal(controlLast.phase, "done", JSON.stringify(controlLast.error));
    assert.ok(reads.length >= 1, "positive control: the handle read observer sees the real candidate read");
  } finally {
    resetProbe();
  }
});

test("context-leak tripwire: agent-instructions / skill-invocation / skill-catalog user messages fail the job", async () => {
  for (const kind of CONTEXT_LEAK_SOURCE_KINDS) {
    const host = makeHost({ onFollowup: (a) => setTimeout(() => a.events.push({ type: "user/message", seq: 1, data: { source: { kind } } }), 5) });
    const { root, manager } = await makeManager(host);
    startJob(manager, root);
    const last = await finish(manager, root);
    assert.equal(last.phase, "failed", kind);
    assert.equal(last.error.code, "context-leak", kind);
    assert.ok(host.log.includes("cancel"), kind);
    assert.equal(stagingOf(root).length, 0, kind);
  }
});

test("findContextLeak: clean session, user source ignored, unreadable session fails closed", () => {
  assert.equal(findContextLeak({ session: { snapshotEvents: () => [{ type: "user/message", data: { source: { kind: "user" } } }] } }), null);
  assert.equal(findContextLeak({ session: { snapshotEvents: () => { throw new Error("x"); } } }).kind, "unreadable");
  assert.equal(findContextLeak({}).kind, "unreadable");
});

test("WORKER_PRESET_DEFINITION: frozen, complete persona, no runtime context, tool-fs + tool-fs-search only", () => {
  const d = WORKER_PRESET_DEFINITION;
  assert.equal(Object.isFrozen(d) && Object.isFrozen(d.plugins) && Object.isFrozen(d.plugins[0].config), true);
  const persona = d.plugins.find((p) => p.name === "@deepseek-ai/dsh-persona");
  assert.equal(persona.config.complete, true);
  assert.equal(persona.config.includeRuntimeContext, false);
  assert.deepEqual(d.plugins.map((p) => p.id).sort(), ["persona", "tool-fs", "tool-fs-search"]);
  assert.deepEqual([...WORKER_TOOL_NAMES], FIVE);
});

test("startGuardedWorker with the real workerGuard: activation released only via handle.dispose", async () => {
  const host = makeHost();
  const root = tempDir("dsh-wiki-wg-");
  const stage = path.join(root, ".dsh-wiki.staging-abc");
  mkdirSync(stage);
  const guard = createWorkerGuard({ getEffectiveCwd: () => root });
  const handle = await startGuardedWorker({ ...host.deps, workerGuard: guard }, { sessionId: "s-1", root, stageDir: stage, model: { provider: "p", model: "m" } });
  assert.equal(guard.isActive("s-1"), true);
  await handle.dispose();
  assert.equal(guard.isActive("s-1"), false);
});

test("dormancy: jobs.js does not import DSH packages or worker-guard/protocol; index.js gate untouched by this module", () => {
  const src = readFileSync(path.join(here, "..", "lib", "jobs.js"), "utf8");
  assert.equal(/from\s+["']@deepseek-ai|from\s+["']\.\/worker-(guard|protocol)/.test(src), false);
  assert.equal(/guard\.install\(|\.install\(ctx|agentPresets\.register\(/.test(src.split("\n").filter((l) => !/^\s*\/\//.test(l) && !/^\s*\*/.test(l)).join("\n")), false);
});

// ---- startup supervision: create() may never settle; cancel/timeout/dispose must still be bounded ----
/** Host whose agents.create is controlled by the test: returns { deps, pending, signals, log }. */
function makePendingHost() {
  const host = makeHost();
  const ctl = { signals: [], resolvers: [], creates: 0 };
  const realCreate = host.deps.agents.create;
  host.deps = {
    ...host.deps,
    agents: {
      create: (options) => {
        ctl.creates++;
        ctl.signals.push(options.signal);
        return new Promise((resolve, reject) => {
          ctl.resolvers.push({
            // late success: run the real fake create (setup + activation) then hand back the handle
            resolve: () => realCreate(options).then(resolve, reject),
            reject: (e) => reject(e),
          });
        });
      },
    },
  };
  return { host, ctl };
}
const startupOpts = { options: { jobTimeoutMs: 40, disposeTimeoutMs: 40 } };
const waitFor = async (fn, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(10); } return false; };

test("startup: cancel while create pending aborts the signal, quarantines (startup-unsettled), keeps fence+staging, never followups", async () => {
  const { host, ctl } = makePendingHost();
  const { root, manager } = await makeManager(host, { options: { jobTimeoutMs: 5000, disposeTimeoutMs: 40 } });
  startJob(manager, root);
  assert.ok(await waitFor(() => ctl.creates === 1));
  assert.equal(ctl.signals[0].aborted, false);
  assert.equal(manager.cancel(root).canceled, true);
  assert.equal(ctl.signals[0].aborted, true);
  assert.ok(await waitFor(() => manager.view(root).active?.blocked));
  const v = manager.view(root).active;
  assert.equal(v.blocked.reason, "startup-unsettled");
  assert.equal(v.error.code, "startup-unsettled");
  assert.equal(manager.isBusy(root), true);
  assert.equal(stagingOf(root).length, 1);
  assert.equal(host.state.followups.length, 0);
  await manager.dispose();
});

test("startup: create that never settles hits the startup deadline, aborts, and stays quarantined", async () => {
  const { host, ctl } = makePendingHost();
  const { root, manager } = await makeManager(host, startupOpts);
  startJob(manager, root);
  assert.ok(await waitFor(() => manager.view(root).active?.blocked));
  assert.equal(ctl.signals[0].aborted, true);
  assert.equal(manager.view(root).active.blocked.reason, "startup-unsettled");
  assert.equal(manager.isBusy(root), true);
  assert.equal(stagingOf(root).length, 1);
  assert.equal(host.state.followups.length, 0);
  await sleep(150);
  assert.equal(manager.isBusy(root), true, "never released merely on timeout");
  assert.equal(stagingOf(root).length, 1);
});

test("startup: late resolve after cancel disposes the handle (once), no followup, releases only after dispose resolves", async () => {
  const { host, ctl } = makePendingHost();
  host.state.disposeGate = null;
  const { root, manager } = await makeManager(host, { options: { jobTimeoutMs: 5000, disposeTimeoutMs: 40 } });
  startJob(manager, root);
  assert.ok(await waitFor(() => ctl.creates === 1));
  manager.cancel(root);
  assert.ok(await waitFor(() => manager.view(root).active?.blocked));
  assert.equal(host.log.includes("dispose-start"), false);
  ctl.resolvers[0].resolve();
  assert.ok(await waitFor(() => !manager.isBusy(root)));
  assert.equal(host.log.filter((e) => e === "dispose-start").length, 1);
  assert.equal(host.log.filter((e) => e === "dispose-end").length, 1);
  assert.ok(host.log.indexOf("dispose-end") < host.log.indexOf("release") || host.log.includes("release"));
  assert.equal(host.state.followups.length, 0);
  assert.equal(stagingOf(root).length, 0);
  assert.equal(manager.view(root).last.phase, "canceled");
});

test("startup: late resolve whose dispose hangs keeps fence and staging until dispose resolves", async () => {
  const host = makeHost({ disposeDelayMs: 150 });
  const ctl = { creates: 0, resolvers: [] };
  const real = host.deps.agents.create;
  host.deps = { ...host.deps, agents: { create: (o) => { ctl.creates++; return new Promise((res, rej) => ctl.resolvers.push(() => real(o).then(res, rej))); } } };
  const { root, manager } = await makeManager(host, { options: { jobTimeoutMs: 5000, disposeTimeoutMs: 40 } });
  startJob(manager, root);
  assert.ok(await waitFor(() => ctl.creates === 1));
  manager.cancel(root);
  assert.ok(await waitFor(() => manager.view(root).active?.blocked));
  ctl.resolvers[0]();
  assert.ok(await waitFor(() => host.log.includes("dispose-start")));
  assert.equal(manager.isBusy(root), true, "fence held while dispose is in flight");
  assert.equal(stagingOf(root).length, 1);
  await sleep(60);
  assert.equal(manager.isBusy(root), true, "dispose outran the bounded wait: still quarantined (worker-not-stopped)");
  assert.equal(manager.view(root).active.blocked.reason, "worker-not-stopped");
  assert.equal(host.log.includes("release"), false);
  await sleep(150);
  manager.cancel(root); // operator retry once the worker is gone
  assert.ok(await waitFor(() => !manager.isBusy(root)));
  assert.ok(host.log.indexOf("dispose-end") !== -1 && host.log.indexOf("release") > host.log.indexOf("dispose-start"));
  assert.equal(host.state.followups.length, 0);
  assert.equal(stagingOf(root).length, 0);
});

test("startup: late reject after timeout releases the fence and staging", async () => {
  const { host, ctl } = makePendingHost();
  const { root, manager } = await makeManager(host, startupOpts);
  startJob(manager, root);
  assert.ok(await waitFor(() => manager.view(root).active?.blocked));
  ctl.resolvers[0].reject(new Error("create aborted"));
  assert.ok(await waitFor(() => !manager.isBusy(root)));
  assert.equal(stagingOf(root).length, 0);
  assert.equal(host.state.followups.length, 0);
});

test("startup: create rejecting promptly after cancel abort releases without quarantine", async () => {
  const { host, ctl } = makePendingHost();
  const { root, manager } = await makeManager(host, { options: { jobTimeoutMs: 5000, disposeTimeoutMs: 200 } });
  startJob(manager, root);
  assert.ok(await waitFor(() => ctl.creates === 1));
  ctl.signals[0].addEventListener("abort", () => ctl.resolvers[0].reject(new Error("aborted")));
  manager.cancel(root);
  assert.ok(await waitFor(() => !manager.isBusy(root)));
  assert.equal(stagingOf(root).length, 0);
  assert.equal(manager.view(root).last.phase, "canceled");
});

test("startup: manager.dispose aborts a pending create and keeps the fence while it is unsettled", async () => {
  const { host, ctl } = makePendingHost();
  const { root, manager } = await makeManager(host, { options: { jobTimeoutMs: 5000, disposeTimeoutMs: 40 } });
  startJob(manager, root);
  assert.ok(await waitFor(() => ctl.creates === 1));
  await manager.dispose();
  assert.equal(ctl.signals[0].aborted, true);
  assert.equal(manager.isBusy(root), true);
  assert.equal(stagingOf(root).length, 1);
  assert.equal(host.state.followups.length, 0);
});

// ================= journaled publication transaction (T018) =================
// 真 journal store（openJournalStore）+ 真临时目录；只替换模型/构建器。spy 记录每次 store 调用，
// 并在 store.advance 之前断言盘上状态，用来证明 REQUIRED WRITE ORDER。
// （JOURNAL_HOST 定义在文件顶部：makeManager 构造 manager 时也要用同一个 host 实例钉住记录。）

const PRIOR_JOB = "aa11bb22cc33dd44";
const HASH_A = "c".repeat(64);
const HASH_B = "d".repeat(64);

const writeLiveWiki = (root, title = "Old Wiki") => {
  const live = path.join(root, ".dsh-wiki");
  mkdirSync(path.join(live, "site"), { recursive: true });
  writeFileSync(path.join(live, "wiki.json"), JSON.stringify({ schema: "repo-wiki-local/1", repoId: root, language: "en", pages: [{ id: "old", title }] }));
  writeFileSync(path.join(live, "site", "index.html"), "<!DOCTYPE html><html><main>old</main></html>");
};
const readLive = (root) => {
  try { return JSON.parse(readFileSync(path.join(root, ".dsh-wiki", "wiki.json"), "utf8")); } catch { return null; }
};

/** A real store in a sibling temp dir, plus a spy that records the call order. */
async function journalFixture(root, hooks = {}) {
  const storeDir = realpathSync(tempDir("dsh-wiki-jstore-"));
  const canonicalRoot = realpathSync(root);
  const store = await openJournalStore({ storeDir, allowedRoots: [canonicalRoot], hostInstanceId: JOURNAL_HOST });
  const calls = [];
  const spy = {
    calls,
    hostInstanceId: store.hostInstanceId,
    load: (value) => { calls.push("load"); return store.load(value); },
    create: (record) => { calls.push(`create:${record.phase}`); return store.create(record); },
    advance: async (previous, next) => {
      calls.push(`advance:${next.phase}`);
      if (hooks.onAdvance) await hooks.onAdvance(next, previous);
      const result = await store.advance(previous, next);
      if (hooks.afterAdvance) await hooks.afterAdvance(next, result);
      return result;
    },
    replaceTerminal: (previous, next) => { calls.push(`replaceTerminal:${next.phase}`); return store.replaceTerminal(previous, next); },
  };
  return { store, spy, calls, canonicalRoot, managerOptions: { journalStore: spy, hostInstanceId: JOURNAL_HOST, allowedRoots: [canonicalRoot] } };
}

test("journal deps are mandatory: a missing/partial set is 503 services-unavailable and creates no staging, session, fence or record", async () => {
  const cases = [
    ["none supplied", {}, ["journalStore", "hostInstanceId", "allowedRoots"]],
    ["invalid store", { journalStore: {} }, ["journalStore", "hostInstanceId", "allowedRoots"]],
    ["hostInstanceId only", { hostInstanceId: JOURNAL_HOST }, ["journalStore", "allowedRoots"]],
    ["allowedRoots only", { allowedRoots: [] }, ["journalStore", "hostInstanceId"]],
    ["invalid store + hostInstanceId", { journalStore: {}, hostInstanceId: JOURNAL_HOST }, ["journalStore", "allowedRoots"]],
    ["invalid store + allowedRoots", { journalStore: {}, allowedRoots: [] }, ["journalStore", "hostInstanceId"]],
    ["hostInstanceId + allowedRoots", { hostInstanceId: JOURNAL_HOST, allowedRoots: [] }, ["journalStore"]],
  ];
  for (const [label, partial, missing] of cases) {
    const host = makeHost();
    const root = realpathSync(tempDir("dsh-wiki-503-"));
    const bare = createJobManager({
      ...host.deps, buildWorkerPrompt, builderPath: "unused",
      runBuilder: async () => ({ ok: true, code: 0, output: "", stdout: "{}" }),
      ...partial,
    });
    assert.throws(() => bare.start({ root, action: "generate", model: { provider: "p", model: "m" } }),
      (error) => error.status === 503 && error.code === "services-unavailable", label);
    assert.deepEqual(bare.journalState(), { mode: "journal", missing, fenced: [] }, label);
    assert.equal(bare.isBusy(root), false, `${label}: no fence`);
    assert.equal(bare.view(root).active, null, `${label}: no active job`);
    assert.deepEqual(readdirSync(root), [], `${label}: no staging directory was created`);
    assert.equal(host.log.includes("create"), false, `${label}: no session was created`);
    assert.equal(host.state.followups.length, 0, `${label}: no followup`);
  }
  // 真 store 但只提供 store：仍然是 503，且 store 里没有写任何事务记录。
  const root = realpathSync(tempDir("dsh-wiki-503-"));
  const storeDir = realpathSync(tempDir("dsh-wiki-503-store-"));
  const store = await openJournalStore({ storeDir, allowedRoots: [root], hostInstanceId: JOURNAL_HOST });
  const host = makeHost();
  const bare = createJobManager({
    ...host.deps, buildWorkerPrompt, builderPath: "unused", journalStore: store,
    runBuilder: async () => ({ ok: true, code: 0, output: "", stdout: "{}" }),
  });
  assert.throws(() => bare.start({ root, action: "generate", model: { provider: "p", model: "m" } }),
    (error) => error.status === 503 && error.code === "services-unavailable");
  assert.deepEqual(bare.journalState(), { mode: "journal", missing: ["hostInstanceId", "allowedRoots"], fenced: [] });
  assert.equal(await store.load(root), null, "no journal record was written");
  assert.deepEqual(readdirSync(root), [], "no staging directory was created");
  assert.equal(host.log.includes("create"), false, "no session was created");
});

test("journal happy path: created → worker-running → worker-stopped → validated → live-moved → published, in that order", async () => {
  const host = makeHost({ onFollowup: (a, _m, s) => completeTurn(a, s) });
  const hookStates = [];
  const root = tempDir("dsh-wiki-wk-");
  writeLiveWiki(root);
  const real = await journalFixture(root, {
    onAdvance: async (next) => {
      const live = readLive(root);
      hookStates.push({
        phase: next.phase,
        livePresent: existsSync(path.join(root, ".dsh-wiki")),
        liveOld: live?.pages?.[0]?.id === "old",
        liveCandidate: live?.pages?.[0]?.id === "p",
        stagePresent: existsSync(next.stagePath),
        backupPresent: existsSync(next.backupPath),
      });
    },
  });
  const journaled = createJobManager({
    ...host.deps, buildWorkerPrompt, builderPath: "unused",
    runBuilder: async (job, args) => {
      if (args[0] === "resolve-config") return { ok: true, code: 0, output: "", stdout: JSON.stringify(EFFECTIVE) };
      if (args[0] === "assemble") writeFileSync(path.join(job.stageDir, "wiki.json"), JSON.stringify({ schema: "repo-wiki-local/1", repoId: job.root, language: "en", pages: [{ id: "p" }] }));
      return { ok: true, code: 0, output: "", stdout: "" };
    },
    pollMs: 10, idleGraceMs: 150, disposeTimeoutMs: 150, jobTimeoutMs: 5000,
    getSourceCommit: async () => "a".repeat(40),
    ...real.managerOptions,
  });
  startJob(journaled, root);
  const last = await finish(journaled, root);
  assert.equal(last.phase, "done", JSON.stringify(last.error));
  assert.equal(last.published, true);
  assert.deepEqual(real.calls, [
    "load", "create:created", "advance:worker-running", "advance:worker-stopped",
    "advance:validated", "advance:live-moved", "advance:published",
  ]);
  const byPhase = Object.fromEntries(hookStates.map((s) => [s.phase, s]));
  // validated is durable BEFORE the first rename: live is still the old wiki, no backup exists.
  assert.deepEqual(byPhase.validated, { phase: "validated", livePresent: true, liveOld: true, liveCandidate: false, stagePresent: true, backupPresent: false });
  // the first rename already happened when live-moved is written, and the promotion has not.
  assert.deepEqual(byPhase["live-moved"], { phase: "live-moved", livePresent: false, liveOld: false, liveCandidate: false, stagePresent: true, backupPresent: true });
  // published is written only AFTER the promotion.
  assert.deepEqual(byPhase.published, { phase: "published", livePresent: true, liveOld: false, liveCandidate: true, stagePresent: false, backupPresent: true });
  const record = (await real.store.load(root)).record;
  assert.equal(record.phase, "published");
  assert.equal(real.store.hostInstanceId, JOURNAL_HOST);
});

test("journal store error (commit-uncertain) halts publication, keeps the fence, and moves nothing", async () => {
  const host = makeHost({ onFollowup: (a, _m, s) => completeTurn(a, s) });
  const { root } = await makeManager(host, { options: (rootPath) => { writeLiveWiki(rootPath); return {}; } });
  const fixture = await journalFixture(root, {
    onAdvance: async (next) => {
      if (next.phase === "validated") {
        throw Object.assign(new Error("journal store unavailable"), { name: "JournalStoreError", code: "commit-uncertain", committed: true });
      }
    },
  });
  const journaled = createJobManager({
    ...host.deps, buildWorkerPrompt, builderPath: "unused",
    runBuilder: async (job, args) => {
      if (args[0] === "resolve-config") return { ok: true, code: 0, output: "", stdout: JSON.stringify(EFFECTIVE) };
      if (args[0] === "assemble") writeFileSync(path.join(job.stageDir, "wiki.json"), JSON.stringify({ schema: "repo-wiki-local/1", repoId: job.root, language: "en", pages: [{ id: "p" }] }));
      return { ok: true, code: 0, output: "", stdout: "" };
    },
    pollMs: 10, idleGraceMs: 150, disposeTimeoutMs: 150, jobTimeoutMs: 5000,
    getSourceCommit: async () => "a".repeat(40),
    ...fixture.managerOptions,
  });
  startJob(journaled, root);
  const last = await finish(journaled, root);
  assert.equal(last.phase, "failed");
  assert.equal(last.error.code, "journal-commit-uncertain");
  assert.equal(last.blocked?.journal, true, JSON.stringify(last.blocked));
  assert.equal(journaled.isBusy(root), true, "the fence stays raised");
  assert.equal(readLive(root)?.pages?.[0]?.id, "old", "the live wiki was never renamed");
  assert.equal(existsSync(path.join(root, `.dsh-wiki.bak-${last.id}`)), false);
  assert.equal(stagingOf(root).length, 1, "staging is retained, never cleaned up on a journal fault");
  // cancel cannot release a journal fence; the record stays at the last durable phase.
  const release = journaled.cancel(root);
  assert.equal(release.quarantine, true);
  assert.match(release.reason, /reconcile/);
  assert.equal(journaled.isBusy(root), true);
  const record = (await fixture.store.load(root)).record;
  assert.equal(record.phase, "worker-stopped");
  // reconcile (worker liveness unknown by default) quarantines and touches nothing.
  const reconcileManager = createJobManager({ ...fixture.managerOptions, journalStore: fixture.store, logger: { warn: () => {} } });
  const planned = await reconcileManager.reconcile(root);
  assert.equal(planned.plan.decision, "quarantine");
  assert.equal(planned.plan.code, "worker-liveness-unknown");
  assert.equal(stagingOf(root).length, 1);
});

test("journal: a failure before the first rename records aborted and removes only the bound staging", async () => {
  const host = makeHost({ onFollowup: (a, _m, s) => completeTurn(a, s) });
  const { root } = await makeManager(host, { options: (rootPath) => { writeLiveWiki(rootPath); return {}; } });
  const fixture = await journalFixture(root);
  const journaled = createJobManager({
    ...host.deps, buildWorkerPrompt, builderPath: "unused",
    runBuilder: async (job, args) => {
      if (args[0] === "resolve-config") return { ok: true, code: 0, output: "", stdout: JSON.stringify(EFFECTIVE) };
      if (args[0] === "assemble") writeFileSync(path.join(job.stageDir, "wiki.json"), JSON.stringify({ schema: "repo-wiki-local/1", repoId: job.root, language: "en", pages: [{ id: "p" }] }));
      if (args[0] === "selfcheck") return { ok: false, code: 1, output: "boom", stdout: "" };
      return { ok: true, code: 0, output: "", stdout: "" };
    },
    pollMs: 10, idleGraceMs: 150, disposeTimeoutMs: 150, jobTimeoutMs: 5000,
    getSourceCommit: async () => "a".repeat(40),
    ...fixture.managerOptions,
  });
  startJob(journaled, root);
  const last = await finish(journaled, root);
  assert.equal(last.phase, "failed");
  assert.equal(last.error.code, "selfcheck-failed");
  assert.equal(last.blocked, null);
  assert.equal(journaled.isBusy(root), false, "an ordinary failure releases the fence");
  const record = (await fixture.store.load(root)).record;
  assert.equal(record.phase, "aborted");
  assert.equal(existsSync(path.join(root, ".dsh-wiki")), true, "the old wiki is untouched");
  assert.equal(readLive(root)?.pages?.[0]?.id, "old");
  assert.equal(stagingOf(root).length, 0, "the aborted staging was removed after the record said so");
  // reconcile now sees aborted + staging gone => no-op (a trusted proof that the worker exited is required).
  const reconcileManager = createJobManager({
    ...fixture.managerOptions, journalStore: fixture.store, logger: { warn: () => {} },
    workerLiveness: () => ({ state: "stopped", proof: "process-exit" }),
  });
  const planned = await reconcileManager.reconcile(root, { execute: true });
  assert.equal(planned.plan.decision, "no-op");
  assert.equal(planned.plan.code, "aborted-staging-already-removed");
});

test("journal: an unfinished prior transaction fences the repository (journal-not-terminal), no staging created", async () => {
  const host = makeHost({ onFollowup: (a, _m, s) => completeTurn(a, s) });
  const { root } = await makeManager(host, { options: (rootPath) => { writeLiveWiki(rootPath); return {}; } });
  const fixture = await journalFixture(root);
  const canonicalRoot = fixture.canonicalRoot;
  const liveIdentity = await identityOf(path.join(canonicalRoot, ".dsh-wiki"));
  const priorStage = path.join(canonicalRoot, `.dsh-wiki.staging-${PRIOR_JOB}`);
  mkdirSync(priorStage);
  const stageIdentity = await identityOf(priorStage);
  const base = {
    version: 1, jobId: PRIOR_JOB, hostInstanceId: JOURNAL_HOST, rootReal: canonicalRoot,
    rootIdentity: identityJson(await identityOf(canonicalRoot)),
    stagePath: priorStage, livePath: path.join(canonicalRoot, ".dsh-wiki"),
    backupPath: path.join(canonicalRoot, `.dsh-wiki.bak-${PRIOR_JOB}`),
    workerSessionId: `dsh-wiki-${PRIOR_JOB}`, protocolSha256: HASH_A, promptSha256: HASH_B,
  };
  const { snapshot } = await fixture.store.create({ ...base, phase: "created", snapshots: { stage: null, live: identityJson(liveIdentity), backup: null } });
  await fixture.store.advance(snapshot, { ...base, phase: "worker-running", snapshots: { stage: identityJson(stageIdentity), live: identityJson(liveIdentity), backup: null } });
  const journaled = createJobManager({
    ...host.deps, buildWorkerPrompt, builderPath: "unused",
    runBuilder: async () => ({ ok: true, code: 0, output: "", stdout: JSON.stringify(EFFECTIVE) }),
    pollMs: 10, idleGraceMs: 150, disposeTimeoutMs: 150, jobTimeoutMs: 5000,
    getSourceCommit: async () => "a".repeat(40),
    ...fixture.managerOptions,
  });
  startJob(journaled, root);
  const last = await finish(journaled, root);
  assert.equal(last.phase, "failed");
  assert.equal(last.error.code, "journal-not-terminal");
  assert.equal(last.blocked?.journal, true);
  assert.equal(journaled.isBusy(root), true, "the fence is kept for the unfinished transaction");
  assert.equal(existsSync(priorStage), true, "the prior transaction's staging is never deleted");
  assert.equal(stagingOf(root).length, 1);
  assert.equal(readLive(root)?.pages?.[0]?.id, "old");
});

test("journal: a terminal prior record is replaced with replaceTerminal and the new job completes", async () => {
  const host = makeHost({ onFollowup: (a, _m, s) => completeTurn(a, s) });
  const { root } = await makeManager(host, { options: (rootPath) => { writeLiveWiki(rootPath); return {}; } });
  const fixture = await journalFixture(root);
  const canonicalRoot = fixture.canonicalRoot;
  const liveIdentity = await identityOf(path.join(canonicalRoot, ".dsh-wiki"));
  const base = {
    version: 1, jobId: PRIOR_JOB, hostInstanceId: JOURNAL_HOST, rootReal: canonicalRoot,
    rootIdentity: identityJson(await identityOf(canonicalRoot)),
    stagePath: path.join(canonicalRoot, `.dsh-wiki.staging-${PRIOR_JOB}`),
    livePath: path.join(canonicalRoot, ".dsh-wiki"),
    backupPath: path.join(canonicalRoot, `.dsh-wiki.bak-${PRIOR_JOB}`),
    workerSessionId: `dsh-wiki-${PRIOR_JOB}`, protocolSha256: HASH_A, promptSha256: HASH_B,
  };
  const { snapshot } = await fixture.store.create({ ...base, phase: "created", snapshots: { stage: null, live: identityJson(liveIdentity), backup: null } });
  await fixture.store.advance(snapshot, { ...base, phase: "aborted", snapshots: { stage: null, live: identityJson(liveIdentity), backup: null } });
  const journaled = createJobManager({
    ...host.deps, buildWorkerPrompt, builderPath: "unused",
    runBuilder: async (job, args) => {
      if (args[0] === "resolve-config") return { ok: true, code: 0, output: "", stdout: JSON.stringify(EFFECTIVE) };
      if (args[0] === "assemble") writeFileSync(path.join(job.stageDir, "wiki.json"), JSON.stringify({ schema: "repo-wiki-local/1", repoId: job.root, language: "en", pages: [{ id: "p" }] }));
      return { ok: true, code: 0, output: "", stdout: "" };
    },
    pollMs: 10, idleGraceMs: 150, disposeTimeoutMs: 150, jobTimeoutMs: 5000,
    getSourceCommit: async () => "a".repeat(40),
    ...fixture.managerOptions,
  });
  startJob(journaled, root);
  const last = await finish(journaled, root);
  assert.equal(last.phase, "done", JSON.stringify(last.error));
  assert.equal(fixture.calls[0], "load");
  assert.equal(fixture.calls[1], "replaceTerminal:created");
  assert.equal(fixture.calls.at(-1), "advance:published");
  const record = (await fixture.store.load(root)).record;
  assert.equal(record.phase, "published");
  assert.notEqual(record.jobId, PRIOR_JOB);
  assert.equal(readLive(root)?.pages?.[0]?.id, "p");
});

test("journal: a refused promotion rolls the backup back, records rolled-back, keeps the candidate", async () => {
  const host = makeHost({ onFollowup: (a, _m, s) => completeTurn(a, s) });
  const root = tempDir("dsh-wiki-wk-");
  writeLiveWiki(root);
  // Between the two renames the staging directory is swapped for a different directory, so the
  // promotion cannot match the identity bound at "worker-running".
  const fixture = await journalFixture(root, {
    afterAdvance: async (next) => {
      if (next.phase !== "live-moved") return;
      const fs = await import("node:fs/promises");
      await fs.rename(next.stagePath, `${next.stagePath}-swapped`);
      mkdirSync(next.stagePath);
      writeFileSync(path.join(next.stagePath, "impostor.txt"), "impostor");
    },
  });
  const journaled = createJobManager({
    ...host.deps, buildWorkerPrompt, builderPath: "unused",
    runBuilder: async (job, args) => {
      if (args[0] === "resolve-config") return { ok: true, code: 0, output: "", stdout: JSON.stringify(EFFECTIVE) };
      if (args[0] === "assemble") writeFileSync(path.join(job.stageDir, "wiki.json"), JSON.stringify({ schema: "repo-wiki-local/1", repoId: job.root, language: "en", pages: [{ id: "p" }] }));
      return { ok: true, code: 0, output: "", stdout: "" };
    },
    pollMs: 10, idleGraceMs: 150, disposeTimeoutMs: 150, jobTimeoutMs: 5000,
    getSourceCommit: async () => "a".repeat(40),
    ...fixture.managerOptions,
  });
  startJob(journaled, root);
  const last = await finish(journaled, root);
  assert.equal(last.phase, "failed", JSON.stringify(last));
  assert.equal(last.error.code, "publish-failed");
  assert.equal(last.blocked, null);
  assert.equal(journaled.isBusy(root), false);
  const record = (await fixture.store.load(root)).record;
  assert.equal(record.phase, "rolled-back");
  assert.equal(readLive(root)?.pages?.[0]?.id, "old", "the previous wiki is live again");
  assert.equal(existsSync(path.join(root, `.dsh-wiki.bak-${last.id}`)), false, "the backup became the live directory");
  assert.equal(existsSync(`${path.join(root, `.dsh-wiki.staging-${last.id}`)}-swapped`), true, "the validated candidate is retained");
});

test("journal: a failed rollback keeps the backup, quarantines, and leaves the record at live-moved", async () => {
  const host = makeHost({ onFollowup: (a, _m, s) => completeTurn(a, s) });
  const root = tempDir("dsh-wiki-wk-");
  writeLiveWiki(root);
  // After the first rename something appears at the live path: the promotion is refused AND the
  // rollback cannot restore the backup there.
  const fixture = await journalFixture(root, {
    afterAdvance: async (next) => {
      if (next.phase !== "live-moved") return;
      mkdirSync(path.join(root, ".dsh-wiki"));
      writeFileSync(path.join(root, ".dsh-wiki", "squatter.txt"), "squatter");
    },
  });
  const journaled = createJobManager({
    ...host.deps, buildWorkerPrompt, builderPath: "unused",
    runBuilder: async (job, args) => {
      if (args[0] === "resolve-config") return { ok: true, code: 0, output: "", stdout: JSON.stringify(EFFECTIVE) };
      if (args[0] === "assemble") writeFileSync(path.join(job.stageDir, "wiki.json"), JSON.stringify({ schema: "repo-wiki-local/1", repoId: job.root, language: "en", pages: [{ id: "p" }] }));
      return { ok: true, code: 0, output: "", stdout: "" };
    },
    pollMs: 10, idleGraceMs: 150, disposeTimeoutMs: 150, jobTimeoutMs: 5000,
    getSourceCommit: async () => "a".repeat(40),
    ...fixture.managerOptions,
  });
  startJob(journaled, root);
  const last = await finish(journaled, root);
  assert.equal(last.phase, "failed");
  assert.equal(last.error.code, "rollback-failed");
  assert.equal(last.blocked?.journal, true);
  assert.equal(journaled.isBusy(root), true);
  const record = (await fixture.store.load(root)).record;
  assert.equal(record.phase, "live-moved", "the record must not claim a rollback that did not happen");
  const backup = path.join(root, `.dsh-wiki.bak-${last.id}`);
  assert.equal(existsSync(backup), true, "the previous wiki stays in the backup");
  assert.equal(JSON.parse(readFileSync(path.join(backup, "wiki.json"), "utf8")).pages[0].id, "old");
  // reconcile (records live-moved, backup bound, live replaced) never guesses: manual/quarantine only.
  const reconcileManager = createJobManager({
    ...fixture.managerOptions, journalStore: fixture.store, logger: { warn: () => {} },
    workerLiveness: () => ({ state: "stopped", proof: "process-exit" }),
  });
  const planned = await reconcileManager.reconcile(root);
  assert.equal(planned.plan.actions.length, 0, JSON.stringify(planned.plan));
  assert.ok(["manual", "quarantine"].includes(planned.plan.decision));
});

test("journal: a locked store refuses the transaction (journal-store-locked), keeps the fence, creates no staging", async () => {
  const host = makeHost({ onFollowup: (a, _m, s) => completeTurn(a, s) });
  const root = tempDir("dsh-wiki-wk-");
  writeLiveWiki(root);
  const fixture = await journalFixture(root);
  const lockPath = path.join(fixture.store.storeDir, `${journalFileName(fixture.canonicalRoot).replace(/\.journal\.json$/, "")}.lock`);
  mkdirSync(lockPath);
  const journaled = createJobManager({
    ...host.deps, buildWorkerPrompt, builderPath: "unused",
    runBuilder: async (_job, args) => (args[0] === "resolve-config" ? { ok: true, code: 0, output: "", stdout: JSON.stringify(EFFECTIVE) } : { ok: true, code: 0, output: "", stdout: "" }),
    pollMs: 10, idleGraceMs: 150, disposeTimeoutMs: 150, jobTimeoutMs: 5000,
    getSourceCommit: async () => "a".repeat(40),
    ...fixture.managerOptions,
  });
  startJob(journaled, root);
  const last = await finish(journaled, root);
  assert.equal(last.phase, "failed");
  assert.equal(last.error.code, "journal-store-locked");
  assert.equal(last.blocked?.journal, true);
  assert.equal(journaled.isBusy(root), true, "the fence stays raised while the store lock is unexplained");
  assert.equal(stagingOf(root).length, 0, "no staging was ever created");
  assert.equal(readLive(root)?.pages?.[0]?.id, "old");
  assert.equal(host.state.followups.length, 0, "no worker session was created");
});

for (const [phase, code] of [["worker-running", "transaction-incomplete"], ["worker-stopped", "transaction-incomplete"], ["validated", "publication-not-started"]]) {
  test(`journal: a store fault right after "${phase}" leaves the record there and moves nothing`, async () => {
    const host = makeHost({ onFollowup: (a, _m, s) => completeTurn(a, s) });
    const root = tempDir("dsh-wiki-wk-");
    writeLiveWiki(root);
    const fixture = await journalFixture(root, {
      afterAdvance: async (next) => {
        if (next.phase !== phase) return;
        throw Object.assign(new Error("post-commit fault"), { name: "JournalStoreError", code: "commit-uncertain", committed: true });
      },
    });
    const journaled = createJobManager({
      ...host.deps, buildWorkerPrompt, builderPath: "unused",
      runBuilder: async (job, args) => {
        if (args[0] === "resolve-config") return { ok: true, code: 0, output: "", stdout: JSON.stringify(EFFECTIVE) };
        if (args[0] === "assemble") writeFileSync(path.join(job.stageDir, "wiki.json"), JSON.stringify({ schema: "repo-wiki-local/1", repoId: job.root, language: "en", pages: [{ id: "p" }] }));
        return { ok: true, code: 0, output: "", stdout: "" };
      },
      pollMs: 10, idleGraceMs: 150, disposeTimeoutMs: 150, jobTimeoutMs: 5000,
      getSourceCommit: async () => "a".repeat(40),
      ...fixture.managerOptions,
    });
    startJob(journaled, root);
    const last = await finish(journaled, root);
    assert.equal(last.error.code, "journal-commit-uncertain");
    assert.equal(last.blocked?.journal, true);
    assert.equal(journaled.isBusy(root), true);
    const record = (await fixture.store.load(root)).record;
    assert.equal(record.phase, phase, "the record is never advanced past the failed step");
    assert.equal(readLive(root)?.pages?.[0]?.id, "old", "no rename happened");
    assert.equal(existsSync(path.join(root, `.dsh-wiki.bak-${last.id}`)), false);
    assert.equal(stagingOf(root).length, 1, "the bound staging is retained");
    const reconcileManager = createJobManager({
      ...fixture.managerOptions, journalStore: fixture.store, logger: { warn: () => {} },
      workerLiveness: () => ({ state: "stopped", proof: "process-exit" }),
    });
    const planned = await reconcileManager.reconcile(root);
    assert.equal(planned.plan.decision, "manual");
    assert.equal(planned.plan.code, code);
    assert.equal(planned.plan.actions.length, 0, "no action is planned for an interrupted pre-mutation transaction");
  });
}

test("journal: a fault after the promotion but before \"published\" fails closed and is never undone automatically", async () => {
  const host = makeHost({ onFollowup: (a, _m, s) => completeTurn(a, s) });
  const root = tempDir("dsh-wiki-wk-");
  writeLiveWiki(root);
  const fixture = await journalFixture(root, {
    onAdvance: async (next) => {
      if (next.phase !== "published") return;
      throw Object.assign(new Error("record could not be written"), { name: "JournalStoreError", code: "commit-uncertain", committed: false });
    },
  });
  const journaled = createJobManager({
    ...host.deps, buildWorkerPrompt, builderPath: "unused",
    runBuilder: async (job, args) => {
      if (args[0] === "resolve-config") return { ok: true, code: 0, output: "", stdout: JSON.stringify(EFFECTIVE) };
      if (args[0] === "assemble") writeFileSync(path.join(job.stageDir, "wiki.json"), JSON.stringify({ schema: "repo-wiki-local/1", repoId: job.root, language: "en", pages: [{ id: "p" }] }));
      return { ok: true, code: 0, output: "", stdout: "" };
    },
    pollMs: 10, idleGraceMs: 150, disposeTimeoutMs: 150, jobTimeoutMs: 5000,
    getSourceCommit: async () => "a".repeat(40),
    ...fixture.managerOptions,
  });
  startJob(journaled, root);
  const last = await finish(journaled, root);
  assert.equal(last.phase, "failed");
  assert.equal(last.error.code, "journal-commit-uncertain");
  assert.equal(last.blocked?.journal, true);
  assert.equal(journaled.isBusy(root), true, "fail closed: the fence stays raised");
  assert.equal(readLive(root)?.pages?.[0]?.id, "p", "the promotion really happened");
  assert.equal(stagingOf(root).length, 0);
  assert.equal(existsSync(path.join(root, `.dsh-wiki.bak-${last.id}`)), true, "the previous wiki is preserved as the backup");
  const record = (await fixture.store.load(root)).record;
  assert.equal(record.phase, "live-moved", "the record lags the promotion; it is never rewritten to guess");
  const reconcileManager = createJobManager({
    ...fixture.managerOptions, journalStore: fixture.store, logger: { warn: () => {} },
    workerLiveness: () => ({ state: "stopped", proof: "process-exit" }),
  });
  const planned = await reconcileManager.reconcile(root, { execute: true });
  assert.equal(planned.plan.decision, "manual");
  assert.equal(planned.plan.code, "staging-missing");
  assert.ok((planned.effects ?? 0) === 0, "no automatic undo of a promotion the record does not confirm");
  assert.equal(readLive(root)?.pages?.[0]?.id, "p");
  assert.equal(existsSync(path.join(root, `.dsh-wiki.bak-${last.id}`)), true);
});

// ================= publication deadline (lock-internal budget re-checks) =================
// A phase-entry budget check cannot bound the DURATION of an awaited filesystem phase: these cases
// make one journal write finish past the same deadlineAt (no second deadline, no re-basing) and pin
// what the two checks INSIDE the publication lock then do:
//   - before the first rename the live tree must not move at all;
//   - after the live move the promotion must not start: the definite outcome is a recorded
//     rollback (backup -> live, phase "rolled-back"), or fail-closed quarantine if that restore
//     cannot be proven. Staging is only removed once the worker resolved its dispose.
const PUBLISH_BUDGET_MS = 2000;
const publicationBuilder = (job, args) => {
  if (args[0] === "resolve-config") return { ok: true, code: 0, output: "", stdout: JSON.stringify(EFFECTIVE) };
  if (args[0] === "assemble") writeFileSync(path.join(job.stageDir, "wiki.json"), JSON.stringify({ schema: "repo-wiki-local/1", repoId: job.root, language: "en", pages: [{ id: "p" }] }));
  return { ok: true, code: 0, output: "", stdout: "" };
};
/** Wait until this job's own deadlineAt + overshootMs: a slow write that crosses the deadline. */
const sleepPastDeadline = async (manager, root, overshootMs) => {
  const startedAt = Date.parse(manager.view(root).active?.startedAt ?? "");
  assert.ok(Number.isFinite(startedAt), "the running job must expose its startedAt");
  const wait = startedAt + PUBLISH_BUDGET_MS + overshootMs - Date.now();
  if (wait > 0) await sleep(wait);
};
/**
 * Hold the journal write of the current phase until this job's deadline has expired and then
 * `overshootMs` more, i.e. until deadlineAt + overshootMs. Unlike sleepPastDeadline it reads no
 * absolute clock: the wait is measured from the deadlineAt the job wrote when it reached that phase,
 * so an earlier slow phase (a cold filesystem, a loaded machine) cannot make the deadline expire
 * before the phase the case is about has run — and a fast Phase-2 check in lib/jobs.js can never be
 * read as this held phase. `waited` is the real time spent holding and `deadlineAfterArrival` the
 * deadline that was left when the phase was reached; the callers assert on both.
 */
const holdPastDeadline = async (manager, root, overshootMs) => {
  const startedAt = Date.parse(manager.view(root).active?.startedAt ?? "");
  assert.ok(Number.isFinite(startedAt), "the running job must expose its startedAt");
  const arriveAt = Date.now();
  const deadlineAt = startedAt + PUBLISH_BUDGET_MS;
  await sleep(Math.max(0, deadlineAt + overshootMs - Date.now()));
  // Stamped as the sleep returns, before any observation stops the clock at this margins size.
  const finishedAt = Date.now();
  return { waited: finishedAt - arriveAt, deadlineAfterArrival: deadlineAt - arriveAt, finishedAt, deadlineAt };
};
/**
 * Run one publication whose journal write of `slowPhase` finishes past the deadline.
 * @param {string} slowPhase "validated" (before publication) or "live-moved" (before promotion)
 * @param {number} overshootMs how far past the deadline the write finishes (both modes)
 * @param {{liveBefore?: boolean, hold?: boolean}} options liveBefore=false => first generation;
 *   hold=true holds from the arrival at slowPhase until deadlineAt + overshootMs instead of waiting
 *   from startedAt, and returns the margin in `held` so the case can prove the deadline expired
 *   while slowPhase was the phase in flight
 */
const runDeadlinePublication = async (slowPhase, overshootMs, { liveBefore = true, hold = false } = {}) => {
  const host = makeHost({ onFollowup: (a, _m, s) => completeTurn(a, s) });
  const root = tempDir("dsh-wiki-wk-");
  if (liveBefore) writeLiveWiki(root);
  const liveDir = path.join(root, ".dsh-wiki");
  const liveIdentityBefore = liveBefore ? await identityOf(liveDir) : null;
  const atPhase = {};
  let journaled;
  let held = null;
  const fixture = await journalFixture(root, {
    onAdvance: async (next) => {
      if (next.phase !== slowPhase) return;
      if (!hold) {
        await sleepPastDeadline(journaled, root, overshootMs);
        return;
      }
      // The release is stamped at the end of that sleep, so `finishedAt - deadlineAt` is the real
      // lateness. Any overshoot >= 1 ms ends after the deadline, so the in-lock re-check — never a
      // check made before this phase — is what must decide the outcome.
      held = await holdPastDeadline(journaled, root, overshootMs);
    },
    afterAdvance: async (next) => {
      // What the disk looked like at the moment each phase became durable: staging must never be
      // removed before the terminal record is written.
      atPhase[next.phase] = {
        staging: stagingOf(root).length,
        live: readLive(root)?.pages?.[0]?.id ?? null,
      };
    },
  });
  journaled = createJobManager({
    ...host.deps, buildWorkerPrompt, builderPath: "unused", runBuilder: publicationBuilder,
    pollMs: 10, idleGraceMs: 150, disposeTimeoutMs: 150, jobTimeoutMs: PUBLISH_BUDGET_MS,
    getSourceCommit: async () => "a".repeat(40),
    ...fixture.managerOptions,
  });
  startJob(journaled, root);
  const last = await finish(journaled, root, 15000);
  return {
    root, last, calls: fixture.calls, store: fixture.store, manager: journaled, host, atPhase, held,
    fixtureOptions: fixture.managerOptions,
    liveDir, liveIdentityBefore,
    liveIdentityAfter: existsSync(liveDir) ? await identityOf(liveDir) : null,
    live: readLive(root),
    backup: existsSync(path.join(root, `.dsh-wiki.bak-${last.id}`)),
    staging: stagingOf(root).length,
    record: (await fixture.store.load(root)).record,
  };
};

test("publication deadline: an expiry re-checked inside the lock refuses the first rename", async () => {
  // The expiry has to happen AFTER the check before advanceJournal("validated"), so the in-lock re-check
  // is what refuses the rename. Timing it from startedAt let a slow run (validation, scan, release of
  // the worker) spend the whole budget first and then trip the pre-validated check instead; the same
  // store hook cannot be skipped, so this is deterministic rather than merely likely.
  const run = await runDeadlinePublication("validated", 1, { hold: true });
  assert.ok(run.held.deadlineAfterArrival > 0,
    `the deadline must be in the future when "validated" is reached; only ${run.held.deadlineAfterArrival} ms were left`);
  assert.ok(run.held.waited >= run.held.deadlineAfterArrival,
    `the journal write must finish past the job's deadline (waited ${run.held.waited} ms, deadline was in ${run.held.deadlineAfterArrival} ms)`);
  assert.ok(run.held.finishedAt > run.held.deadlineAt,
    `the write must finish past the deadline; it finished ${run.held.finishedAt - run.held.deadlineAt} ms past it`);
  assert.equal(run.last.phase, "failed", JSON.stringify(run.last));
  assert.equal(run.last.error.code, "job-timeout");
  assert.equal(run.last.published, false);
  assert.equal(run.last.blocked, null);
  // The first rename never started: live is still the same directory (same dev/ino) with the old wiki.
  assert.deepEqual(run.liveIdentityAfter, run.liveIdentityBefore, "the live directory was never moved");
  assert.equal(run.live?.pages?.[0]?.id, "old");
  assert.equal(run.backup, false, "no backup was created");
  // The record never passes "validated": run-finally records aborted, and staging is removed only
  // after the worker was proven stopped.
  assert.deepEqual(run.calls, [
    "load", "create:created", "advance:worker-running", "advance:worker-stopped",
    "advance:validated", "advance:aborted",
  ]);
  assert.equal(run.record.phase, "aborted");
  assert.equal(run.staging, 0, "the bound staging is removed after the worker is proven stopped");
});

test("publication deadline: a journal write that overshoots the deadline gets one fixed decision", async () => {
  const shape = (run) => ({
    phase: run.last.phase,
    code: run.last.error.code,
    published: run.last.published,
    blocked: run.last.blocked,
    live: run.live?.pages?.[0]?.id,
    liveSame: JSON.stringify(run.liveIdentityAfter) === JSON.stringify(run.liveIdentityBefore),
    backup: run.backup,
    staging: run.staging,
    journal: run.record.phase,
    calls: run.calls,
  });
  const expected = {
    phase: "failed", code: "job-timeout", published: false, blocked: null, live: "old",
    liveSame: true, backup: false, staging: 0, journal: "aborted",
    calls: ["load", "create:created", "advance:worker-running", "advance:worker-stopped", "advance:validated", "advance:aborted"],
  };
  // Not a race against a timer: the decision is taken AFTER the write returns, so two very different
  // overshoots (50 ms and 750 ms past the deadline) produce the same state instead of a timing-dependent
  // one. Each run holds from its own arrival at "validated" (same reason as the first rename case: a
  // fast pre-validated check must never be what a slow run reads), and the margin proves the deadline
  // expired while that write was in flight.
  const lateness = {};
  const runs = { late: 50, later: 750 };
  for (const [name, overshoot] of Object.entries(runs)) {
    const run = await runDeadlinePublication("validated", overshoot, { hold: true });
    assert.ok(run.held.deadlineAfterArrival > 0,
      `the deadline must be in the future when "validated" is reached; only ${run.held.deadlineAfterArrival} ms were left`);
    assert.ok(run.held.waited >= run.held.deadlineAfterArrival,
      `the journal write must finish past the job's deadline (waited ${run.held.waited} ms, deadline was in ${run.held.deadlineAfterArrival} ms)`);
    // Every hold that frees the write at deadlineAt + 1 ms or later is late; a hold sized for
    // `overshoot` is late by about that much (Date.now() resolves 1-2 ms, so do not pin the exact value).
    lateness[name] = run.held.finishedAt - run.held.deadlineAt;
    assert.ok(lateness[name] > 0 && lateness[name] >= overshoot - 2,
      `the ${name} write finished ${lateness[name]} ms past the deadline; it was held for ${overshoot} ms`);
    assert.deepEqual(shape(run), expected);
  }
  // The two runs really were far apart (>= 400 ms, an order of magnitude beyond timer jitter), so the
  // identical state above is the proof, not the same scenario run twice.
  assert.ok(lateness.later - lateness.late >= 400,
    `the two overshoots must differ (${lateness.late} ms vs ${lateness.later} ms past the deadline)`);
});

test("publication deadline: an expiry re-checked before promotion restores the previous wiki and records rolled-back", async () => {
  const run = await runDeadlinePublication("live-moved", 250);
  assert.equal(run.last.phase, "failed", JSON.stringify(run.last));
  assert.equal(run.last.error.code, "job-timeout");
  assert.equal(run.last.published, false);
  assert.equal(run.last.blocked, null);
  // Definite post-move outcome: NO promotion. The exact previous wiki is moved back by identity and
  // the record is the terminal "rolled-back" state (stage still bound, live = the previous wiki).
  assert.deepEqual(run.liveIdentityAfter, run.liveIdentityBefore, "the previous wiki is live again, same directory");
  assert.equal(run.live?.pages?.[0]?.id, "old", "the candidate was never promoted");
  assert.equal(run.backup, false, "the backup became the live directory again");
  assert.equal(run.staging, 0, "the bound staging is removed after the worker is proven stopped");
  assert.deepEqual(run.calls, [
    "load", "create:created", "advance:worker-running", "advance:worker-stopped",
    "advance:validated", "advance:live-moved", "advance:rolled-back",
  ]);
  assert.equal(run.record.phase, "rolled-back");
  assert.notEqual(run.record.snapshots.stage, null, "rolled-back keeps the candidate bound to staging");
  assert.equal(run.record.snapshots.backup, null);
  // journal-consistent: reconcile has nothing to fix and plans no action.
  const reconcileManager = createJobManager({
    ...run.fixtureOptions, journalStore: run.store, logger: { warn: () => {} },
    workerLiveness: () => ({ state: "stopped", proof: "process-exit" }),
  });
  const planned = await reconcileManager.reconcile(run.root);
  assert.deepEqual(planned.plan.actions, [], JSON.stringify(planned.plan));
  assert.equal(planned.plan.decision, "no-op", JSON.stringify(planned.plan));
});

test("publication deadline: a first generation that expires before promotion never creates live", async () => {
  const run = await runDeadlinePublication("live-moved", 250, { liveBefore: false });
  assert.equal(run.last.phase, "failed", JSON.stringify(run.last));
  assert.equal(run.last.error.code, "job-timeout");
  assert.equal(run.last.published, false);
  assert.equal(existsSync(run.liveDir), false, "no live directory was created");
  assert.equal(stagingOf(run.root).length, 0);
  assert.deepEqual(run.calls, [
    "load", "create:created", "advance:worker-running", "advance:worker-stopped",
    "advance:validated", "advance:live-moved", "advance:rolled-back",
  ]);
  assert.equal(run.record.phase, "rolled-back");
  assert.equal(run.record.snapshots.live, null);
});

test("publication deadline: staging is kept until the terminal record is durable, and the fence is released only then", async () => {
  // Reachable retention rule on an expiry path: the job can only reach publication after
  // terminateWorker() resolved (jobs.js records "worker-stopped" strictly after that), so an expiry
  // there must never remove staging first and record afterwards. The candidate is removed only by the
  // existing fail path, after "aborted"/"rolled-back" is on disk, and the fence is released last.
  const run = await runDeadlinePublication("live-moved", 250);
  assert.equal(run.atPhase["live-moved"].staging, 1, "the candidate is still staged when live-moved is durable");
  assert.equal(run.atPhase["rolled-back"].staging, 1, "the rollback record is durable while the candidate is still staged");
  assert.equal(run.atPhase["rolled-back"].live, "old", "the previous wiki is live again when rolled-back is recorded");
  assert.equal(run.staging, 0, "the bound staging is removed only afterwards, with the worker proven stopped");
  assert.equal(run.manager.isBusy(run.root), false, "the single-flight fence is released only after the job finished");
  // The same ordering holds for the pre-publication expiry: staging survives "validated" and "aborted".
  // Held from the arrival at "validated", so the in-lock re-check (not a pre-validated one spent by a
  // slow run) is what every atPhase observation below is about.
  const before = await runDeadlinePublication("validated", 250, { hold: true });
  assert.ok(before.held.deadlineAfterArrival > 0,
    `the deadline must be in the future when "validated" is reached; only ${before.held.deadlineAfterArrival} ms were left`);
  assert.ok(before.held.waited >= before.held.deadlineAfterArrival,
    `the journal write must finish past the job's deadline (waited ${before.held.waited} ms, deadline was in ${before.held.deadlineAfterArrival} ms)`);
  assert.ok(before.held.finishedAt - before.held.deadlineAt >= 248,
    `the journal write must finish about 250 ms past the deadline; it finished ${before.held.finishedAt - before.held.deadlineAt} ms past it`);
  assert.equal(before.atPhase.validated.staging, 1, "staging is still there when validated is durable");
  assert.equal(before.atPhase.aborted.staging, 1, "staging is removed only after aborted is durable");
  assert.equal(before.staging, 0);
  assert.equal(before.manager.isBusy(before.root), false);
});

// ================= unload vs the journal fence =================
// "aborted" is terminal, so aborting a fenced record on unload would let the next start()
// replaceTerminal it without reconcile — a fence bypass. Only reconcile() may release a fence.
const heldWikiBuilder = async (job, args) => {
  if (args[0] === "resolve-config") return { ok: true, code: 0, output: "", stdout: JSON.stringify(EFFECTIVE) };
  if (args[0] === "assemble") writeFileSync(path.join(job.stageDir, "wiki.json"), JSON.stringify({ schema: "repo-wiki-local/1", repoId: job.root, language: "en", pages: [{ id: "p" }] }));
  return { ok: true, code: 0, output: "", stdout: "" };
};

/** A manager whose job ends fenced at "validated": the live wiki is stolen between the durable
 *  "validated" record and the first publish rename => journal-live-move-uncertain. */
async function makeLiveMoveUncertain() {
  const warnings = [];
  const host = makeHost({ onFollowup: (a, _m, s) => completeTurn(a, s) });
  const root = tempDir("dsh-wiki-wk-");
  writeLiveWiki(root);
  const live = path.join(root, ".dsh-wiki");
  const fixture = await journalFixture(root, {
    afterAdvance: async (next) => {
      if (next.phase !== "validated") return;
      renameSync(live, path.join(root, ".dsh-wiki.stolen"));
    },
  });
  const manager = createJobManager({
    ...host.deps, buildWorkerPrompt, builderPath: "unused", runBuilder: heldWikiBuilder,
    pollMs: 10, idleGraceMs: 150, disposeTimeoutMs: 150, jobTimeoutMs: 5000,
    getSourceCommit: async () => "a".repeat(40),
    logger: { warn: (message) => warnings.push(message) },
    ...fixture.managerOptions,
  });
  startJob(manager, root);
  const last = await finish(manager, root);
  return { host, root, fixture, manager, warnings, last };
}

/** A manager whose job is fenced at "validated" by a store fault right after that record committed
 *  (journal-commit-uncertain): "validated" -> "aborted" is an accepted step, so an abort would work. */
async function makeValidatedStoreFault() {
  const warnings = [];
  const host = makeHost({ onFollowup: (a, _m, s) => completeTurn(a, s) });
  const root = tempDir("dsh-wiki-wk-");
  writeLiveWiki(root);
  const fixture = await journalFixture(root, {
    afterAdvance: async (next) => {
      if (next.phase !== "validated") return;
      throw Object.assign(new Error("post-commit fault"), { name: "JournalStoreError", code: "commit-uncertain", committed: true });
    },
  });
  const manager = createJobManager({
    ...host.deps, buildWorkerPrompt, builderPath: "unused", runBuilder: heldWikiBuilder,
    pollMs: 10, idleGraceMs: 150, disposeTimeoutMs: 150, jobTimeoutMs: 5000,
    getSourceCommit: async () => "a".repeat(40),
    logger: { warn: (message) => warnings.push(message) },
    ...fixture.managerOptions,
  });
  startJob(manager, root);
  const last = await finish(manager, root);
  return { host, root, fixture, manager, warnings, last };
}

test("unload keeps a journal-fenced record and its staging: dispose never aborts validated (journal-live-move-uncertain)", async () => {
  const { host, root, fixture, manager, warnings, last } = await makeLiveMoveUncertain();
  assert.equal(last.phase, "failed");
  assert.equal(last.error.code, "journal-live-move-uncertain");
  assert.equal(last.blocked?.journal, true);
  const before = (await fixture.store.load(root)).record;
  assert.equal(before.phase, "validated");
  assert.equal(stagingOf(root).length, 1);
  const advances = fixture.calls.filter((call) => call.startsWith("advance:"));
  const disposes = host.log.filter((entry) => entry === "dispose-start").length;
  assert.ok(disposes >= 1, "the worker handle was disposed before the fence was reached");
  await manager.dispose();
  // The record and its bound staging are untouched: "aborted" would be terminal and replaceable.
  const after = (await fixture.store.load(root)).record;
  assert.equal(after.phase, "validated");
  assert.equal(after.jobId, before.jobId);
  assert.deepEqual(fixture.calls.filter((call) => call.startsWith("advance:")), advances, "dispose must not advance the journal");
  assert.equal(stagingOf(root).length, 1, "the journal-bound staging is never deleted on unload");
  // The worker was terminated (it had already stopped before the fence) and is not disposed twice.
  assert.equal(host.state.released.length, 1);
  assert.equal(host.log.filter((entry) => entry === "dispose-start").length, disposes);
  // The unload warning says the fence needs reconcile() and names the retained staging.
  const fence = warnings.find((message) => /journal fence/.test(message) && /on unload/.test(message));
  assert.ok(fence, JSON.stringify(warnings));
  assert.match(fence, /reconcile\(\) is required/);
  assert.match(fence, new RegExp(`job ${last.id} `));
  assert.equal(fence.includes(path.join(root, `.dsh-wiki.staging-${last.id}`)), true);
  // The manager still reports the quarantine: unload did not release the fence.
  assert.equal(manager.isBusy(root), true);
  const view = manager.view(root);
  assert.equal(view.active?.blocked?.journal, true);
  assert.equal(view.last?.blocked?.journal, true);
  const release = manager.cancel(root);
  assert.equal(release.quarantine, true);
  assert.match(release.reason, /reconcile/);
});

test("unload does not abort a journal fence even when the abort itself would have succeeded", async () => {
  const { root, fixture, manager, last } = await makeValidatedStoreFault();
  assert.equal(last.error.code, "journal-commit-uncertain");
  assert.equal(last.blocked?.journal, true);
  const before = (await fixture.store.load(root)).record;
  assert.equal(before.phase, "validated");
  assert.equal(stagingOf(root).length, 1);
  await manager.dispose();
  const after = (await fixture.store.load(root)).record;
  assert.equal(after.phase, "validated", "dispose must not abort a fenced record");
  assert.equal(after.jobId, before.jobId);
  assert.equal(stagingOf(root).length, 1);
  assert.equal(fixture.calls.includes("advance:aborted"), false, "no aborted advance was attempted");
  assert.equal(manager.isBusy(root), true);
  // Control: validated -> aborted IS an accepted step, so unload skipped an abort it could have
  // performed; the fence is released only by reconcile(), never by unload.
  const snapshot = await fixture.store.load(root);
  const aborted = { ...snapshot.record, phase: "aborted", snapshots: { stage: snapshot.record.snapshots.stage, live: snapshot.record.snapshots.live, backup: null } };
  await fixture.store.advance(snapshot, aborted);
  assert.equal((await fixture.store.load(root)).record.phase, "aborted");
});

test("unload keeps the current behaviour for a quarantine without a journal fence: abort the record and delete the staging", async () => {
  const hostOpts = { onFollowup: (a, _m, s) => completeTurn(a, s), disposeThrows: true };
  const host = makeHost(hostOpts);
  const { root, manager, store } = await makeManager(host);
  startJob(manager, root);
  for (let i = 0; i < 300 && !host.state.handles.length; i++) await sleep(10);
  const last = await finish(manager, root);
  assert.equal(last.blocked?.reason, "worker-not-stopped");
  assert.equal(last.blocked?.journal, undefined, "no journal fence");
  assert.equal((await store.load(root)).record.phase, "worker-running");
  assert.equal(stagingOf(root).length, 1);
  await sleep(150); // let the quarantine retries settle: the worker is still un-stoppable
  assert.equal(manager.isBusy(root), true);
  hostOpts.disposeThrows = false; // the worker can be stopped now
  await manager.dispose();
  assert.equal((await store.load(root)).record.phase, "aborted");
  assert.equal(stagingOf(root).length, 0, "an unfenced quarantine is cleaned up on unload");
  // Current behaviour is preserved: only the record and staging are released on unload, the job
  // entry itself stays quarantined (no journal fence is involved here).
  assert.equal(manager.view(root).active?.blocked?.reason, "worker-not-stopped");
  assert.equal(manager.view(root).active?.blocked?.journal, undefined);
  assert.ok(host.log.includes("dispose-end"));
});

test("unload never throws out of dispose() for a journal-fenced job whose handle rejects or never resolves", async () => {
  for (const [label, dispose] of [
    ["rejects", async () => { throw new Error("dispose boom"); }],
    ["hangs", () => new Promise(() => {})],
  ]) {
    const { root, fixture, manager, warnings } = await makeLiveMoveUncertain();
    // The shipped flow stops the worker before the fence; re-arm a live handle so the unload path
    // itself is exercised (its only duty for a fenced record is to terminate the worker).
    const job = [...manager._jobs.values()][0];
    const calls = { dispose: 0 };
    job.workerStopped = false;
    job.disposePromise = null;
    job.handle = { dispose: () => { calls.dispose++; return dispose(); } };
    const record = (await fixture.store.load(root)).record;
    await assert.doesNotReject(manager.dispose());
    assert.equal(calls.dispose, 1, `${label}: the worker is still disposed exactly once`);
    assert.equal((await fixture.store.load(root)).record.phase, record.phase, label);
    assert.equal(stagingOf(root).length, 1, label);
    assert.equal(manager.isBusy(root), true, label);
    assert.equal(manager.view(root).active?.blocked?.journal, true, label);
    const fence = warnings.find((message) => /journal fence/.test(message) && /on unload/.test(message));
    assert.ok(fence, `${label}: ${JSON.stringify(warnings)}`);
    assert.match(fence, /reconcile\(\) is required/, label);
    assert.match(fence, /worker could not be confirmed stopped/, label);
  }
});

// ================= reconcile 解开内存栅栏（review 缺陷） =================
// 缺陷：reconcile() 执行并推进了存储记录，却从不更新内存作业——恢复成功之后管理器仍然栅栏这个
// root、拒绝新作业，store 说已恢复而内存说 blocked。撤销条件（三条同时成立）：
// 计划真的执行完（executed + effects>0）、重读记录仍属同一 jobId 且已终止、两条停止证明
// （planRecovery 的 worker 观测 + 该作业 terminateWorker 的 dispose resolve）。
// 仅仅“存储相位已经终止”绝不撤销；active/disposing 作业脚下的状态绝不清。

/** 一次“两次 rename 之间”崩点：live 已经被移进记录绑定的 backup 路径。 */
function crashBetweenRenames(root, jobId) {
  const backup = path.join(root, `.dsh-wiki.bak-${jobId}`);
  renameSync(path.join(root, ".dsh-wiki"), backup);
  return backup;
}

/** 只在第一次 "validated" 提交之后报错的 store：记录停在 validated 且栅栏立起，而同一个 store 上
 *  的后续作业仍能跑到发布——这样“store 与内存一致”可以被真正验证，而不是靠一个只会失败的 store。 */
async function makeOneShotValidatedFence(extra = {}) {
  const warnings = [];
  const host = makeHost({ onFollowup: (a, _m, s) => completeTurn(a, s) });
  const root = tempDir("dsh-wiki-wk-");
  writeLiveWiki(root);
  let faults = 0;
  const fixture = await journalFixture(root, {
    afterAdvance: async (next) => {
      if (next.phase !== "validated" || faults > 0) return;
      faults += 1;
      throw Object.assign(new Error("post-commit fault"), { name: "JournalStoreError", code: "commit-uncertain", committed: true });
    },
  });
  const manager = createJobManager({
    ...host.deps, buildWorkerPrompt, builderPath: "unused", runBuilder: heldWikiBuilder,
    pollMs: 10, idleGraceMs: 150, disposeTimeoutMs: 150, jobTimeoutMs: 5000,
    getSourceCommit: async () => "a".repeat(40),
    logger: { warn: (message) => warnings.push(message) },
    ...(extra.options ?? {}),
    ...fixture.managerOptions,
  });
  startJob(manager, root);
  const last = await finish(manager, root);
  return { host, root, fixture, manager, warnings, last };
}

test("reconcile: a verified recovery releases the fence, memory follows the store, and the root accepts a new job", async () => {
  const { root, fixture, manager, last } = await makeOneShotValidatedFence({
    options: { workerLiveness: () => ({ state: "stopped", proof: "process-exit" }) },
  });
  assert.equal(last.blocked?.journal, true);
  assert.equal(manager.isBusy(root), true, "the fence is raised before the reconcile");
  assert.equal((await fixture.store.load(root)).record.phase, "validated");
  const backup = crashBetweenRenames(root, last.id);
  assert.equal(readLive(root), null, "the crash left no live wiki");

  const recovered = await manager.reconcile(root, { execute: true });
  assert.equal(recovered.status, "planned", JSON.stringify(recovered));
  assert.equal(recovered.plan.decision, "restore-backup");
  assert.equal(recovered.executed, true);
  assert.equal(recovered.effects, 1);
  assert.equal(recovered.advancedTo, "aborted");
  assert.equal(recovered.released, true, JSON.stringify(recovered));
  assert.equal(recovered.releaseReason, "reconciled");
  // 存储记录终止，且被恢复的旧 wiki 回到了 live。
  const stored = (await fixture.store.load(root)).record;
  assert.equal(stored.phase, "aborted");
  assert.equal(stored.jobId, last.id);
  assert.equal(readLive(root)?.pages?.[0]?.id, "old");
  assert.equal(existsSync(backup), false, "the backup became the live directory again");
  // 内存跟着 store 走，陈旧的条目不再报告 blocked。
  assert.equal(manager.isBusy(root), false);
  assert.equal(manager.view(root).active, null);
  const summary = manager.view(root).last;
  assert.equal(summary.blocked, null);
  assert.equal(summary.journalPhase, stored.phase);
  assert.equal(summary.journalJobId, stored.jobId);
  assert.deepEqual(manager.journalState(), { mode: "journal", missing: [], fenced: [] });
  // 新作业必须真的被接受（不是只改一个标志）：它跑完并再次发布。
  const accepted = startJob(manager, root);
  assert.equal(accepted.phase, "running");
  assert.equal(manager.isBusy(root), true);
  const finished = await finish(manager, root);
  assert.equal(finished.phase, "done", JSON.stringify(finished.error));
  assert.equal(finished.published, true);
  const after = (await fixture.store.load(root)).record;
  assert.equal(after.phase, "published");
  assert.notEqual(after.jobId, last.id);
  assert.equal(finished.journalJobId, after.jobId, "the new job replaced the reconciled record");
  assert.equal(manager.view(root).last.journalPhase, "published");
});

test("reconcile: an unproven-stopped worker releases nothing (no liveness proof, and a dispose that never resolves)", async () => {
  // (a) 没有可信存活提供者：planRecovery 只给 quarantine，零动作、零释放。
  {
    const { root, fixture, manager, last } = await makeOneShotValidatedFence();
    crashBetweenRenames(root, last.id);
    const planned = await manager.reconcile(root, { execute: true });
    assert.equal(planned.plan.decision, "quarantine");
    assert.equal(planned.plan.code, "worker-liveness-unknown");
    assert.equal(planned.executed, false);
    assert.equal(planned.effects, 0);
    assert.equal(planned.released, false, JSON.stringify(planned));
    assert.equal(planned.releaseReason, "no-action");
    assert.equal(manager.isBusy(root), true, "the fence stays raised");
    assert.equal(manager.view(root).active?.blocked?.journal, true);
    assert.equal(manager.view(root).last?.blocked?.journal, true);
    assert.equal((await fixture.store.load(root)).record.phase, "validated");
    assert.equal(readLive(root), null, "nothing was renamed");
  }
  // (b) 记录的 worker 被证明停下，但这个作业自己的 dispose 不 resolve：不碰目录、不撤销。
  {
    const { root, fixture, manager, last } = await makeOneShotValidatedFence({
      options: { workerLiveness: () => ({ state: "stopped", proof: "process-exit" }) },
    });
    const job = [...manager._jobs.values()][0];
    job.workerStopped = false;
    job.disposePromise = null;
    job.handle = { dispose: () => new Promise(() => {}) };
    const backup = crashBetweenRenames(root, last.id);
    const advances = fixture.calls.filter((call) => call.startsWith("advance:")).length;
    const refused = await manager.reconcile(root, { execute: true });
    assert.equal(refused.plan.decision, "restore-backup", "the plan WOULD have executed");
    assert.equal(refused.status, "refused", JSON.stringify(refused));
    assert.equal(refused.code, "worker-not-stopped");
    assert.equal(refused.executed, false);
    assert.equal(refused.effects, 0);
    assert.equal(refused.released, false);
    assert.equal(refused.releaseReason, "worker-not-proven-stopped");
    assert.equal(fixture.calls.filter((call) => call.startsWith("advance:")).length, advances, "no journal advance was attempted");
    assert.equal((await fixture.store.load(root)).record.phase, "validated");
    assert.equal(readLive(root), null, "nothing was renamed");
    assert.equal(existsSync(backup), true);
    assert.equal(manager.isBusy(root), true);
    assert.equal(manager.view(root).active?.blocked?.journal, true);
  }
});

test("reconcile: a merely terminal stored phase releases nothing", async () => {
  const { root, fixture, manager, last } = await makeOneShotValidatedFence({
    options: { workerLiveness: () => ({ state: "stopped", proof: "process-exit" }) },
  });
  // 操作者（或更早的一次运行）已经把记录推到终止相位、并删掉了绑定的暂存：记录终止且干净，
  // 但本管理器从未执行过任何恢复计划——仅“相位已终止”绝不解开栅栏。
  const snapshot = await fixture.store.load(root);
  await fixture.store.advance(snapshot, {
    ...snapshot.record,
    phase: "aborted",
    snapshots: { stage: snapshot.record.snapshots.stage, live: snapshot.record.snapshots.live, backup: null },
  });
  rmSync(path.join(root, `.dsh-wiki.staging-${last.id}`), { recursive: true, force: true });
  const stored = (await fixture.store.load(root)).record;
  assert.equal(stored.phase, "aborted");
  const planned = await manager.reconcile(root, { execute: true });
  assert.equal(planned.plan.decision, "no-op");
  assert.equal(planned.plan.code, "aborted-staging-already-removed");
  assert.equal(planned.executed, false);
  assert.equal(planned.effects, 0);
  assert.equal(planned.released, false, "a terminal stored phase alone must never release the fence");
  assert.equal(planned.releaseReason, "no-action");
  assert.equal(manager.isBusy(root), true);
  assert.equal(manager.view(root).active?.blocked?.journal, true);
  assert.equal(manager.view(root).last?.blocked?.journal, true);
  assert.deepEqual(manager.journalState().fenced.map((entry) => entry.jobId), [last.id]);
});

test("reconcile: cancel and unload still cannot release a journal fence", async () => {
  const { root, fixture, manager, last } = await makeOneShotValidatedFence();
  assert.equal(manager.isBusy(root), true);
  const cancel = manager.cancel(root);
  assert.equal(cancel.canceled, false);
  assert.equal(cancel.quarantine, true);
  assert.match(cancel.reason, /reconcile/);
  assert.equal(manager.isBusy(root), true, "cancel never releases a journal fence");
  const advances = fixture.calls.filter((call) => call.startsWith("advance:"));
  const outcome = await manager.dispose();
  assert.deepEqual(outcome.unresolved, [], "the fenced job's worker was already proven stopped");
  assert.equal(manager.isBusy(root), true, "unload never releases a journal fence");
  assert.equal(manager.view(root).active?.blocked?.journal, true);
  assert.equal(manager.view(root).last?.blocked?.journal, true);
  assert.deepEqual(fixture.calls.filter((call) => call.startsWith("advance:")), advances, "neither path advances the journal");
  assert.equal((await fixture.store.load(root)).record.phase, "validated", "the record is kept for reconcile");
  assert.equal(stagingOf(root).length, 1, "the bound staging is kept");
  assert.deepEqual(manager.journalState().fenced, [{ root: last.root, jobId: last.id, reason: "journal-commit-uncertain" }]);
});

test("reconcile: an active job for the root is never cleared underneath it (refused job-active)", async () => {
  const host = makeHost(); // 回合不会自己结束：作业一直处于 active，直到被取消。
  const { root, manager, store } = await makeManager(host, { options: { jobTimeoutMs: 60000 } });
  startJob(manager, root);
  for (let i = 0; i < 300 && host.state.followups.length === 0; i++) await sleep(5);
  assert.equal(host.state.followups.length, 1, "the job is running");
  assert.equal(manager.view(root).active?.blocked ?? null, null, "no fence: the job is active");
  const refused = await manager.reconcile(root, { execute: true });
  assert.equal(refused.status, "refused", JSON.stringify(refused));
  assert.equal(refused.code, "job-active");
  assert.equal(refused.executed, false);
  assert.equal(refused.effects, 0);
  assert.equal(refused.released, false);
  assert.equal(refused.releaseReason, "job-active");
  // 运行中的作业原封不动：仍然 active、仍然没有 blocked，记录仍是非终止相位。
  assert.equal(manager.isBusy(root), true);
  assert.equal(manager.view(root).active?.blocked ?? null, null);
  assert.equal((await store.load(root)).record.phase, "worker-running");
  assert.equal(stagingOf(root).length, 1);
  // 只读的计划模式仍然可用（它什么都不改）。
  const planned = await manager.reconcile(root);
  assert.equal(planned.status, "planned");
  assert.equal(planned.plan.decision, "quarantine");
  assert.equal(planned.plan.code, "worker-liveness-unknown");
  assert.equal(planned.plan.actions.length, 0);
  assert.equal(manager.view(root).active?.blocked ?? null, null);
  // 让作业正常结束，测试不留下运行中的作业。
  assert.equal(manager.cancel(root).canceled, true);
  await finish(manager, root);
  assert.equal(manager.isBusy(root), false);
});

// ================= unresolved-worker reporting (review defect 1) =================
// dispose() 必须报告哪些作业的 worker 仍未（或无法）证明停下：index.js 只据此保留这些 agent 的
// guard activation。报告必须精确——多报会泄漏 activation，少报会释放一个仍在运行的 worker 的围栏。

test("dispose() reports the worker it could not confirm stopped (unresolved) with root/jobId/sessionId", async () => {
  const host = makeHost({ disposeHangs: true });
  const { root, manager } = await makeManager(host);
  startJob(manager, root);
  for (let i = 0; i < 300 && !host.state.handles.length; i++) await sleep(10);
  const job = [...manager._jobs.values()][0];
  assert.ok(job, "the job is tracked while its worker is live");
  const sessionId = job.sessionId ?? job.agent?.id ?? null;
  assert.equal(typeof sessionId, "string", "a live worker has an agent id");

  // 卸载之前的同步报告：这个 worker 仍在运行（从未确认 dispose resolve）。
  assert.deepEqual(manager.unresolvedWorkers(), [{ root, jobId: job.id, sessionId }]);

  const outcome = await manager.dispose();
  assert.ok(outcome && Array.isArray(outcome.unresolved), JSON.stringify(outcome));
  assert.deepEqual(outcome.unresolved, [{ root, jobId: job.id, sessionId }]);
  assert.deepEqual(manager.unresolvedWorkers(), [{ root, jobId: job.id, sessionId }], "still unreported after unload");
});

test("dispose() reports no unresolved worker when every worker was proven stopped", async () => {
  const host = makeHost({ onFollowup: (a, _m, s) => completeTurn(a, s) });
  const { root, manager } = await makeManager(host);
  startJob(manager, root);
  const last = await finish(manager, root);
  assert.equal(last.phase, "done");
  assert.deepEqual(manager.unresolvedWorkers(), [], "a finished job has no live worker");
  const outcome = await manager.dispose();
  assert.deepEqual(outcome.unresolved, []);
  assert.equal(host.state.released.length, 1, "the proven-stopped worker's activation was released");
});

test("dispose() reports only the unproven worker: a proven-stopped job is never reported (mixed)", async () => {
  const stuck = new Set();
  const hostOpts = {
    onFollowup: (a, _m, s) => completeTurn(a, s),
    // 只有 A 的 worker 停不下来；B 的 dispose 正常 resolve。
    disposeThrows: (agent) => stuck.has(agent.id),
  };
  const host = makeHost(hostOpts);
  const rootB = tempDir("dsh-wiki-wk-b-");
  const { root: rootA, manager } = await makeManager(host, { allowedRoots: [rootB] });

  // A: the worker cannot be stopped at the end of its turn => quarantined, unproven.
  startJob(manager, rootA);
  for (let i = 0; i < 300 && !host.state.handles.length; i++) await sleep(5);
  assert.equal(host.state.handles.length, 1, "the worker was created");
  stuck.add(host.state.handles[0].agent.id);
  const lastA = await finish(manager, rootA);
  assert.equal(lastA.blocked?.reason, "worker-not-stopped");
  // B: completes and its worker is confirmed stopped (the job leaves the single-flight fence).
  startJob(manager, rootB);
  const lastB = await finish(manager, rootB);
  assert.equal(lastB.phase, "done");
  assert.equal(manager.isBusy(rootB), false);

  const reported = manager.unresolvedWorkers();
  assert.equal(reported.length, 1, JSON.stringify(reported));
  assert.equal(reported[0].root, path.resolve(rootA));
  assert.equal(reported[0].jobId, lastA.id);
  assert.equal(reported[0].sessionId, [...manager._jobs.values()].find((job) => job.id === lastA.id)?.sessionId);

  const outcome = await manager.dispose();
  assert.equal(outcome.unresolved.length, 1, JSON.stringify(outcome.unresolved));
  assert.equal(outcome.unresolved[0].root, path.resolve(rootA));
  assert.equal(outcome.unresolved[0].jobId, lastA.id);
  assert.equal(host.state.released.length, 1, "only the proven-stopped worker's activation was released");
  assert.equal(manager.isBusy(rootA), true, "the quarantined root keeps its fence");
});

// ================= public error projection: raw text / paths / stack never leave =================
const SENTINEL = "TOKEN_SENTINEL";
const SENTINEL_PATH = path.join(tmpdir(), "dsh-wiki-secret-dir", "private", "path");

test("view(root, { public: true }): a builder failure exposes a fixed code + message, never stderr or paths", async () => {
  const host = makeHost({ onFollowup: (a, _m, s) => completeTurn(a, s) });
  const { root, manager } = await makeManager(host, {
    options: {
      runBuilder: async (job, args) => {
        if (args[0] === "resolve-config") return { ok: true, code: 0, output: "", stdout: JSON.stringify(EFFECTIVE) };
        if (args[0] === "assemble") writeFileSync(path.join(job.stageDir, "wiki.json"), JSON.stringify({ schema: "repo-wiki-local/1", repoId: job.root, language: "en", pages: [{ id: "p" }] }));
        if (args[0] === "build") return { ok: false, code: 1, output: `${SENTINEL} ${SENTINEL_PATH}\nbuilder stderr: exploded`, stdout: "" };
        return { ok: true, code: 0, output: "", stdout: "" };
      },
    },
  });
  startJob(manager, root);
  const last = await finish(manager, root);
  assert.equal(last.error.code, "build-failed");
  const view = manager.view(root, { public: true });
  assert.equal(view.active, null);
  assert.deepEqual(view.last.error, { code: "build-failed", message: PUBLIC_ERROR_MESSAGES["build-failed"] });
  const text = JSON.stringify(view);
  for (const needle of [SENTINEL, SENTINEL_PATH, "builder stderr", "exploded"]) assert.equal(text.includes(needle), false, needle);
  assert.equal("engine" in view.last, false);
  // 默认视图（不经 { public: true }）同样是投影后的契约：原始 builder stderr/路径/解释器名只进 logger。
  const internal = manager.view(root);
  assert.deepEqual(internal.last.error, { code: "build-failed", message: PUBLIC_ERROR_MESSAGES["build-failed"] });
  assert.equal(internal.active, null);
  const internalText = JSON.stringify(internal);
  for (const needle of [SENTINEL, SENTINEL_PATH, "builder stderr", "exploded"]) {
    assert.equal(internalText.includes(needle), false, `default view leaked ${needle}`);
  }
  assert.equal("engine" in internal.last, false, "the default view must not carry the host interpreter");
});

test("view: an in-flight quarantined job never exposes the staging path, in the internal or public summary", async () => {
  const host = makeHost({ disposeHangs: true });
  const { root, manager } = await makeManager(host);
  startJob(manager, root);
  for (let i = 0; i < 300 && !host.state.handles.length; i++) await sleep(10);
  manager.cancel(root);
  const last = await finish(manager, root);
  assert.equal(last.blocked?.reason, "worker-not-stopped");
  const publicView = manager.view(root, { public: true });
  for (const view of [manager.view(root), publicView]) {
    for (const summary of [view.active, view.last]) {
      assert.ok(summary);
      assert.equal(summary.blocked.reason, "worker-not-stopped");
      assert.equal("staging" in summary.blocked, false);
      if (view === publicView) assert.equal(JSON.stringify(summary).includes(".dsh-wiki.staging-"), false);
    }
  }
});

test("publicError/publicJobView: arbitrary codes, messages, stack and paths collapse to bounded public fields", () => {
  assert.equal(publicError(null), null);
  const raw = Object.assign(new Error(`${SENTINEL} ${SENTINEL_PATH}`), { code: `${SENTINEL} ${SENTINEL_PATH}`, stack: `at ${SENTINEL_PATH}`, status: 401 });
  assert.deepEqual(publicError(raw), { code: "internal-error", message: PUBLIC_ERROR_MESSAGES["internal-error"] });
  assert.deepEqual(publicError({ code: "EACCES", message: SENTINEL }), { code: "eacces", message: PUBLIC_ERROR_MESSAGES["job-failed"] });
  assert.deepEqual(publicError({ message: SENTINEL }), { code: "job-failed", message: PUBLIC_ERROR_MESSAGES["job-failed"] });
  const summary = publicJobView({
    id: "j", root: "/repo", action: "generate", model: { provider: "p", model: "m" }, targetLang: "en",
    phase: "failed", stage: "build", error: raw, blocked: { reason: "worker-not-stopped", staging: SENTINEL_PATH, journal: true },
    engine: SENTINEL_PATH, promptSha256: "z".repeat(64), extra: SENTINEL,
  });
  assert.deepEqual(summary.blocked, { reason: "worker-not-stopped", journal: true });
  assert.equal(summary.promptSha256, null);
  assert.equal("engine" in summary || "extra" in summary, false);
  assert.equal(JSON.stringify(summary).includes(SENTINEL), false);
});

test("normalizeCatalog: failures carry a fixed public code/message, not the provider's text", () => {
  const catalog = normalizeCatalog({
    groups: [{ id: "p", name: "P", models: [{ id: "m", name: "M", description: "ok" }] }],
    default: { provider: "p", model: "m" },
    failures: [{ id: "broken", name: "Broken", message: `${SENTINEL} ${SENTINEL_PATH}`, stack: `at ${SENTINEL_PATH}` }],
  });
  assert.deepEqual(catalog.failures, [{ id: "broken", name: "Broken", code: "model-catalog-failure", message: PUBLIC_ERROR_MESSAGES["model-catalog-failure"] }]);
  assert.equal(JSON.stringify(catalog).includes(SENTINEL), false);
  assert.equal(JSON.stringify(catalog).includes(SENTINEL_PATH), false);
  assert.deepEqual(catalog.models[0], { provider: "p", model: "m", label: "M", providerLabel: "P", description: "ok" });
});

// ---------- content gate: coverage-inventory advisory (never a gate) ----------
// 协议（skills/worker-protocol.md）要求根页面自带“每个顶层目录 + 递归文件数”的清单；缺席只产生
// coverage-inventory warning。四个用例钉住：有清单不警告且 ok 仍为 true（同一断言，回归成闸门立刻失败）；
// 没有清单只是 warning，ok 与“检查不会触发”的同一份 wiki 完全一致；散文里的数字是近失误、不满足启发式；
// 已有的失败分类一个不少，warning 绝不混进 failures。
const GATE_CONFIG = { pages: { min: 2, max: 100 }, wordsPerPage: [100, 5000], diagrams: "none", citations: "relaxed", skeleton: { knownIssues: false } };
const gateBody = (markdown) => `${markdown} ${Array.from({ length: 120 }, (_, i) => `word${i}`).join(" ")} lib/jobs.js`;
const gateWiki = (rootMarkdown) => ({
  pages: [
    { id: "overview", parentId: null, title: "Overview", markdown: gateBody(rootMarkdown) },
    { id: "tooling", parentId: "overview", title: "Tooling", markdown: gateBody("## Tooling") },
  ],
});
const INVENTORY_TABLE = `
## Directory inventory

| Directory | Files | Coverage |
|---|---|---|
| \`specs/\` | 50,605 | excluded: generated specs |
| \`plugins/dsh-wiki\` | 1,234 | covered |
| \`docs\` | 67 files | covered |
`;

test("content gate: a counted directory inventory raises no coverage-inventory warning and keeps ok true", () => {
  const verdict = evaluateContentGate(gateWiki(INVENTORY_TABLE), GATE_CONFIG);
  assert.equal(verdict.warnings.some((warning) => warning.category === "coverage-inventory"), false, "a counted inventory must be recognised");
  assert.equal(verdict.ok, true, "the advisory must never gate a passing wiki");
  assert.deepEqual(verdict.failures, []);
});

test("content gate: a root page without an inventory only warns, and ok is identical with or without the check firing", () => {
  const without = evaluateContentGate(gateWiki("## Overview\n\nThe wiki covers the tooling around `lib/jobs.js`."), GATE_CONFIG);
  const withInventory = evaluateContentGate(gateWiki(INVENTORY_TABLE), GATE_CONFIG);
  assert.deepEqual(without.warnings.map((warning) => warning.category), ["coverage-inventory"]);
  assert.equal(without.warnings[0].detail.includes("root page"), true, "the warning names what is missing");
  assert.equal(without.ok, withInventory.ok, "a warning must not move ok");
  assert.equal(without.ok, true);
  assert.deepEqual(without.failures, withInventory.failures, "a warning must not add failures");
});

test("content gate: prose that merely mentions file counts is a near miss, not an inventory", () => {
  const prose = [
    "## Overview",
    "",
    "The repository holds 50,605 files across `specs/` and 6 more under VKFG/, counted on 2026-11-10.",
    "",
    "1. **Workspace** `examples-workspace` — the repository root (`docs/HANDOFF.md:7`).",
    "2. **Repo** `example-repo` — this repository (`docs/HANDOFF.md:9`).",
    "3. **Products** — prefix groups across `plugins/`, `apps/`, `packages/` (`AGENTS.md:10`).",
    "",
    "- `specs/` is the largest area; see `docs/arch-notes/dsh-wiki-run2-defect-audit-20261110.md:48`.",
    "",
    "| Area | Files |",
    "|---|---|",
    "| `specs/` | 50,605 |",
    "| `docs/` | 67 |",
  ].join("\n");
  const verdict = evaluateContentGate(gateWiki(prose), GATE_CONFIG);
  assert.deepEqual(verdict.warnings.map((warning) => warning.category), ["coverage-inventory"], "prose and a 2-row table are below the 3-entry bar");
  assert.equal(verdict.ok, true, "the near miss is a warning, never a failure");
});

test("content gate: existing failure categories fire unchanged and coverage-inventory never joins failures", () => {
  const failing = {
    pages: [
      { id: "overview", parentId: null, title: "Overview", markdown: "too short" },
      { id: "architecture", parentId: "overview", title: "Architecture", markdown: "also short" },
    ],
  };
  const verdict = evaluateContentGate(failing, { ...GATE_CONFIG, diagrams: "minimal", citations: "strict", pages: { min: 5, max: 10 }, skeleton: { knownIssues: true } });
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.failures.map((failure) => failure.category), ["words-below-min", "citations", "diagrams", "known-issues", "page-count"]);
  assert.deepEqual(verdict.failures.map((failure) => failure.count), [2, 2, 2, 1, 2]);
  assert.equal(verdict.failures.some((failure) => failure.category === "coverage-inventory"), false, "an advisory must never be a failure");
  assert.deepEqual(verdict.warnings.map((warning) => warning.category), ["coverage-inventory"]);
  // 配置非法时仍 fail closed：只有 config 失败，warnings 为空（返回形状固定）。
  const invalid = evaluateContentGate({ pages: [] }, { ...GATE_CONFIG, wordsPerPage: [900, 400] });
  assert.deepEqual(invalid, {
    ok: false,
    failures: [{ category: "config", count: 1, detail: "the resolved config does not provide wordsPerPage" }],
    warnings: [],
  });
});

// ---------- content gate: severity split by direction (real-run regression) ----------
// 真实 run（16 分钟、28 页 + 20 卡、发布 0）满足页数带、diagram、known-issues 与每一个词数下限，却仅因
// “1 页超过上限 150 词”与“2 页缺 path:line 引用”被整次拒绝。严重性现在按方向划分：
//   words-above-max        → 只警告（格式偏好，不影响 ok）；
//   citations              → 只有超阈值才致命（CITATION_UNCITED_MAX_ABSOLUTE / CITATION_UNCITED_MAX_SHARE）；
//   words-below-min / page-count / known-issues / diagrams / config → 保持致命。
// 这组用例同时钉住“ok 只由 failures 决定”：以下两个通过场景都显式断言 ok === true，一旦回归成闸门立刻失败。
const severityWords = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
const severityCited = (n) => `${severityWords(n)} Evidence: \`lib/jobs.js:12\`.`; // n + 5 词，含 1 条 path:line 引用
const severityUncited = (n) => `${severityWords(n)} Evidence in lib/jobs.js.`; // n + 5 词，无 path:line 引用
const SEVERITY_CONFIG = { pages: { min: 2, max: 100 }, wordsPerPage: [20, 60], diagrams: "none", citations: "strict", skeleton: { knownIssues: false } };
const severityRoot = (markdown) => `${INVENTORY_TABLE}\n\n${markdown}`;

test("content gate severity: one page over the words ceiling only warns and ok stays true", () => {
  const wiki = {
    pages: [
      { id: "overview", parentId: null, title: "Overview", markdown: severityRoot(severityCited(30)) },
      { id: "known-issues", parentId: "overview", title: "Known Issues", markdown: severityCited(100) },
    ],
  };
  const verdict = evaluateContentGate(wiki, SEVERITY_CONFIG);
  assert.equal(verdict.ok, true, "an advisory ceiling overflow must never gate");
  assert.deepEqual(verdict.failures, []);
  assert.deepEqual(verdict.warnings.map((warning) => warning.category), ["words-above-max"], "the overflow is still surfaced");
  assert.equal(verdict.warnings[0].detail, "1 page(s) above 69 words (wordsPerPage[1]=60 + 15% tolerance)");
});

test("content gate severity: a thin page is still fatal (words-below-min)", () => {
  const wiki = {
    pages: [
      { id: "overview", parentId: null, title: "Overview", markdown: severityRoot(severityCited(30)) },
      { id: "tooling", parentId: "overview", title: "Tooling", markdown: severityCited(3) },
    ],
  };
  const verdict = evaluateContentGate(wiki, SEVERITY_CONFIG);
  assert.equal(verdict.ok, false, "a thin page is real quality loss, never an advisory");
  assert.deepEqual(verdict.failures.map((failure) => failure.category), ["words-below-min"]);
  assert.deepEqual(verdict.failures.map((failure) => failure.count), [1]);
  assert.equal(verdict.warnings.some((warning) => warning.category === "words-above-max"), false, "a thin page is not a ceiling overflow");
});

test("content gate severity: a few uncited pages in a large wiki only warn, while most pages uncited still fail", () => {
  assert.equal(CITATION_UNCITED_MAX_ABSOLUTE, 3, "the absolute allowance is part of the public rule");
  assert.equal(CITATION_UNCITED_MAX_SHARE, 0.1, "the relative allowance is part of the public rule");
  const large = (uncitedPages) => {
    const pages = [{ id: "overview", parentId: null, title: "Overview", markdown: severityRoot(severityCited(30)) }];
    for (let i = 0; i < 27; i += 1) {
      pages.push({ id: `page-${i}`, parentId: "overview", title: `Page ${i}`, markdown: i < uncitedPages ? severityUncited(30) : severityCited(30) });
    }
    return { pages };
  };
  const few = evaluateContentGate(large(2), SEVERITY_CONFIG);
  assert.equal(few.ok, true, "2 uncited pages in 28 must not annihilate the run");
  assert.deepEqual(few.failures, []);
  assert.deepEqual(few.warnings.map((warning) => warning.category), ["citations"]);
  assert.equal(few.warnings[0].detail, "2 page(s) carry no a path:line citation under citations=strict");
  const most = evaluateContentGate(large(20), SEVERITY_CONFIG);
  assert.equal(most.ok, false, "most pages uncited is a real coverage failure");
  assert.deepEqual(most.failures.map((failure) => failure.category), ["citations"]);
  assert.deepEqual(most.failures.map((failure) => failure.count), [20]);
  // 相对阈值：小 wiki 里 1/2 页缺引用 = 50% > 10%，仍然致命（否则一条规则会被小样本绕过）。
  const small = evaluateContentGate({
    pages: [
      { id: "overview", parentId: null, title: "Overview", markdown: severityRoot(severityCited(30)) },
      { id: "tooling", parentId: "overview", title: "Tooling", markdown: severityUncited(30) },
    ],
  }, SEVERITY_CONFIG);
  assert.equal(small.ok, false);
  assert.deepEqual(small.failures.map((failure) => failure.category), ["citations"]);
  assert.deepEqual(small.failures.map((failure) => failure.count), [1]);
});

test("content gate severity: page-count, known-issues, diagrams and config stay fatal", () => {
  const base = { pages: { min: 3, max: 10 }, wordsPerPage: [20, 60], diagrams: "none", citations: "strict", skeleton: { knownIssues: true } };
  const pages = [
    { id: "overview", parentId: null, title: "Overview", markdown: severityRoot(severityCited(30)) },
    { id: "architecture", parentId: "overview", title: "Architecture", markdown: severityCited(30) },
  ];
  const verdict = evaluateContentGate({ pages }, { ...base, diagrams: "minimal" });
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.failures.map((failure) => failure.category), ["diagrams", "known-issues", "page-count"]);
  assert.deepEqual(verdict.failures.map((failure) => failure.count), [2, 1, 2], "both overview and architecture are diagram pages");
  assert.deepEqual(verdict.warnings, [], "no advisory may be manufactured for a fatal wiki");
  // 配置不可解析仍然 fail closed：只有 config 失败，warnings 为空。
  const invalid = evaluateContentGate({ pages }, { ...base, citations: "loose" });
  assert.deepEqual(invalid, {
    ok: false,
    failures: [{ category: "config", count: 1, detail: "the resolved config does not provide citations" }],
    warnings: [],
  });
});

test("content gate severity: the real 28-page shape (one 1185-word page, two uncited pages) now passes with exactly two warnings", () => {
  const REAL_CONFIG = { pages: { min: 18, max: 50 }, wordsPerPage: [400, 900], diagrams: "none", citations: "strict", skeleton: { knownIssues: true } };
  const knownIssues = severityCited(1180);
  assert.equal(countWords(knownIssues), 1185, "the fixture must reproduce the measured 1185-word known-issues page");
  const pages = [
    { id: "overview", parentId: null, title: "Overview", markdown: severityRoot(severityCited(430)) },
    { id: "known-issues", parentId: "overview", title: "Known Issues", markdown: knownIssues },
  ];
  // 28 页里恰好 2 页没有 path:line 引用；其余页面全部落在 [400, 1035] 词内。
  for (let i = 0; i < 26; i += 1) {
    pages.push({ id: `page-${i}`, parentId: "overview", title: `Page ${i}`, markdown: i < 2 ? severityUncited(430) : severityCited(430) });
  }
  const verdict = evaluateContentGate({ pages }, REAL_CONFIG);
  assert.equal(verdict.ok, true, "the shape that destroyed a real run must publish");
  assert.deepEqual(verdict.failures, []);
  assert.deepEqual(verdict.warnings.map((warning) => warning.category), ["words-above-max", "citations"]);
  assert.equal(verdict.warnings[0].detail, "1 page(s) above 1035 words (wordsPerPage[1]=900 + 15% tolerance)");
  assert.equal(verdict.warnings[1].detail, "2 page(s) carry no a path:line citation under citations=strict");
});

// ================= failure diagnostics: local evidence, never an HTTP projection =================
// 终态失败只对外给固定短句；真实原因（builder stderr、闸门分类细节）落到
// <journalStoreDir>/failures/<jobId>.json。该目录只是本机运维证据：没有路由、没有响应投影读它，
// 写盘失败也绝不影响作业结果。取消与成功都不写。
const PUBLIC_VIEW_KEYS = [
  "action", "blocked", "error", "id", "journalJobId", "journalPhase", "model", "pages", "phase",
  "promptSha256", "protocolSha256", "published", "root", "sessionId", "stage", "startedAt", "targetLang",
  "updatedAt", "waitingFor",
];
const failuresDirOf = (store) => path.join(store.storeDir, "failures");
const failureFileOf = (store, id) => path.join(failuresDirOf(store), `${id}.json`);
const readFailure = (store, id) => JSON.parse(readFileSync(failureFileOf(store, id), "utf8"));
const gateFailsWith = (detail) => () => ({ ok: false, failures: [{ category: "citations", count: 1, detail }] });

test("failure diagnostic: a content-gate failure leaves the builder's real reason in failures/<id>.json", async () => {
  const host = makeHost({ onFollowup: (a, _m, s) => completeTurn(a, s) });
  const gateDetail = "1 of 431 citations is a bare ROADMAP.md shorthand (page overview)";
  const { root, manager, store } = await makeManager(host, { options: { contentGate: gateFailsWith(gateDetail) } });
  startJob(manager, root);
  const last = await finish(manager, root);
  assert.equal(last.phase, "failed");
  assert.equal(last.error.code, "content-gate-failed");
  const payload = readFailure(store, last.id);
  assert.equal(payload.jobId, last.id);
  assert.equal(payload.action, "generate");
  assert.equal(payload.targetLang, "en");
  assert.equal(payload.phase, "failed");
  assert.equal(payload.errorCode, "content-gate-failed");
  assert.equal(typeof payload.finishedAt, "string");
  assert.equal(Number.isNaN(Date.parse(payload.finishedAt)), false, payload.finishedAt);
  assert.ok(payload.detail.length > 0, "the diagnostic must carry a detail");
  assert.match(payload.detail, /ROADMAP\.md shorthand/, "the reason the public sentence drops must survive locally");
});

test("failure diagnostic: a successful job writes no failure file and creates no evidence directory", async () => {
  const host = makeHost({ onFollowup: (a, _m, s) => completeTurn(a, s) });
  const { root, manager, store } = await makeManager(host);
  startJob(manager, root);
  const last = await finish(manager, root);
  assert.equal(last.phase, "done", JSON.stringify(last.error));
  assert.equal(existsSync(failureFileOf(store, last.id)), false);
  assert.equal(existsSync(failuresDirOf(store)), false);
});

test("failure diagnostic: a user-canceled job writes no failure file", async () => {
  const host = makeHost(); // no followup completion: the job only ends when it is canceled
  const { root, manager, store } = await makeManager(host);
  startJob(manager, root);
  for (let i = 0; i < 300 && !host.state.handles.length; i++) await sleep(10);
  assert.equal(manager.cancel(root).canceled, true);
  const last = await finish(manager, root);
  assert.equal(last.phase, "canceled");
  assert.equal(existsSync(failureFileOf(store, last.id)), false);
  assert.equal(existsSync(failuresDirOf(store)), false);
});

test("failure diagnostic: a huge builder output is bounded to 8 KiB, truncated from the front and marked", async () => {
  const host = makeHost({ onFollowup: (a, _m, s) => completeTurn(a, s) });
  const finalLine = "FINAL: selfcheck refused 1 of 431 citations (bare ROADMAP.md shorthand)";
  const { root, manager, store } = await makeManager(host, {
    options: {
      runBuilder: async (job, args) => {
        if (args[0] === "resolve-config") return { ok: true, code: 0, output: "", stdout: JSON.stringify(EFFECTIVE) };
        if (args[0] === "assemble") {
          writeFileSync(path.join(job.stageDir, "wiki.json"), JSON.stringify({ schema: "repo-wiki-local/1", repoId: job.root, language: "en", pages: [{ id: "p" }] }));
          return { ok: true, code: 0, output: "", stdout: "" };
        }
        if (args[0] === "selfcheck") return { ok: false, code: 1, output: `${"X".repeat(200000)}\n${finalLine}`, stdout: "" };
        return { ok: true, code: 0, output: "", stdout: "" };
      },
    },
  });
  startJob(manager, root);
  const last = await finish(manager, root);
  assert.equal(last.error.code, "selfcheck-failed");
  const payload = readFailure(store, last.id);
  const bytes = Buffer.byteLength(payload.detail, "utf8");
  assert.ok(bytes <= 8 * 1024, `the detail is ${bytes} bytes, more than 8 KiB`);
  assert.match(payload.detail, /^\.\.\.\[truncated/, "the truncation is marked at the front, never silent");
  assert.equal(payload.detail.includes(finalLine), true, "the tail is what an operator needs and it survives");
});

test("failure diagnostic: at most 50 files are kept; the oldest are pruned by mtime", async () => {
  const host = makeHost({ onFollowup: (a, _m, s) => completeTurn(a, s) });
  const { root, manager, store } = await makeManager(host, { options: { contentGate: gateFailsWith("prune fixture") } });
  const dir = failuresDirOf(store);
  mkdirSync(dir, { recursive: true });
  const base = Date.now() - 60 * 60 * 1000;
  for (let i = 0; i < 60; i += 1) {
    const file = path.join(dir, `old-${String(i).padStart(2, "0")}.json`);
    writeFileSync(file, "{}");
    const stamp = new Date(base + i * 1000);
    utimesSync(file, stamp, stamp);
  }
  startJob(manager, root);
  const last = await finish(manager, root);
  assert.equal(last.phase, "failed");
  const kept = readdirSync(dir).filter((name) => name.endsWith(".json"));
  assert.equal(kept.length, 50, JSON.stringify(kept.sort()));
  // 60 个旧文件 + 1 个新的 = 61，删除最旧的 11 个（old-00 .. old-10）。
  assert.equal(existsSync(path.join(dir, "old-00.json")), false);
  assert.equal(existsSync(path.join(dir, "old-10.json")), false);
  assert.equal(existsSync(path.join(dir, "old-11.json")), true);
  assert.equal(existsSync(failureFileOf(store, last.id)), true, "the new evidence survives its own prune");
});

test("failure diagnostic: an unwritable evidence path only warns and never changes the job result", async () => {
  const host = makeHost({ onFollowup: (a, _m, s) => completeTurn(a, s) });
  const warnings = [];
  const { root, manager, store } = await makeManager(host, {
    options: { logger: { warn: (message) => warnings.push(message) }, contentGate: gateFailsWith("unwritable fixture") },
  });
  // 用一个普通文件占住 failures/：mkdir 必然失败，且这种“不可用路径”在 Windows 上也能稳定复现。
  writeFileSync(failuresDirOf(store), "not a directory");
  startJob(manager, root);
  const last = await finish(manager, root);
  assert.equal(last.phase, "failed");
  assert.equal(last.error.code, "content-gate-failed", "the diagnostic failure never replaces the job's own error");
  assert.equal(manager.isBusy(root), false, "the fence is released exactly as before");
  assert.equal(existsSync(failureFileOf(store, last.id)), false);
  assert.equal(warnings.some((message) => message.includes("could not write the failure diagnostic")), true, JSON.stringify(warnings));
});

test("failure diagnostic: the public job view gains no key and never names the evidence file", async () => {
  const host = makeHost({ onFollowup: (a, _m, s) => completeTurn(a, s) });
  const { root, manager, store } = await makeManager(host, { options: { contentGate: gateFailsWith("projection fixture") } });
  startJob(manager, root);
  const last = await finish(manager, root);
  assert.equal(last.phase, "failed");
  assert.equal(existsSync(failureFileOf(store, last.id)), true, "the evidence does exist on disk");
  const view = manager.view(root, { public: true });
  assert.deepEqual(Object.keys(view.last).sort(), PUBLIC_VIEW_KEYS, "the HTTP projection keeps exactly its documented keys");
  const text = JSON.stringify(view);
  assert.equal(text.includes("failures"), false);
  assert.equal(text.includes("detail"), false);
  // 即使有人把证据挂到摘要上，allowlist 投影也不会放它出去。
  const polluted = publicJobView({ ...last, evidence: "RAW EVIDENCE", failureFile: failureFileOf(store, last.id), detail: "d" });
  for (const key of ["evidence", "failureFile", "detail"]) assert.equal(key in polluted, false, key);
  assert.equal(JSON.stringify(polluted).includes(store.storeDir), false);
});
