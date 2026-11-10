// dsh-wiki 后台作业 **模块级** 离线 harness —— 直接驱动 lib/jobs.js（DORMANT：index.js 仍 503）。
//
// 状态：作业在 T018–T020 开放闸门通过前不对外提供；这里是 jobs.js 作为 future/internal 契约的回归覆盖。
// 宿主依赖全部注入（agents.create / agentPresets / workingDirectory / workerGuard / presetId / buildWorkerPrompt），
// 假宿主在 agents.create 里跑真正的 setup；builder 用真实 python 脚本。candidate 由 Host 的 assemble 组装
// （worker 只写 pages/cards），所以 wiki.json 的 repoId/language 由 Host 决定，worker 无法伪造。
// worker 专项（setup 顺序/失败/隔离/泄漏绊线）见 tools/jobs-worker-test.mjs。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const here = import.meta.dirname;
const jobsUrl = pathToFileURL(path.join(here, "..", "lib", "jobs.js")).href;
const { createJobManager, evaluateContentGate, PUBLIC_ERROR_MESSAGES, readBoundedJson } = await import(jobsUrl);
const { buildWorkerPrompt, buildTranslationPrompt } = await import(pathToFileURL(path.join(here, "..", "lib", "worker-protocol.js")).href);
const { openJournalStore } = await import(pathToFileURL(path.join(here, "..", "lib", "journal-store.js")).href);

// Every fixture directory is registered on creation and removed from one place, so a failed check or an
// unexpected throw between creation and the end of the script still cleans up. This script ends in
// process.exit(), and that fires the exit handler synchronously; an uncaught throw does too.
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
process.on("exit", cleanupTempDirs);

const FAILS = [];
const check = (name, ok, detail = "") => {
  console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : `  [${detail}]`));
  if (!ok) FAILS.push(name);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PYTHON = process.env.DSH_WIKI_TEST_PYTHON || "python";
const BUILDER = path.join(here, "..", "scripts", "build_wiki_site.py");

// ---------- 夹具仓库 ----------
const repo = tempDir("dsh-wiki-jobs-");
const repoOther = tempDir("dsh-wiki-jobs2-");
const repoFault = tempDir("dsh-wiki-jobs3-");
// 翻译作业的独立仓库：没有已发布的 live wiki，所以 start() 接纳之后必须 fail closed（live-missing）。
const repoTranslate = tempDir("dsh-wiki-jobs-translate-");
const OLD_WIKI = { schema: "repo-wiki-local/1", repoId: repo, title: "Old Wiki", language: "en", pages: [{ id: "old", parentId: null, order: 1, title: "Old", markdown: "# Old page" }] };
const writeOldWiki = (root, wiki) => {
  mkdirSync(path.join(root, ".dsh-wiki", "site"), { recursive: true });
  writeFileSync(path.join(root, ".dsh-wiki", "wiki.json"), JSON.stringify(wiki));
  writeFileSync(path.join(root, ".dsh-wiki", "site", "index.html"), "<!DOCTYPE html><html><main>old</main></body></html>");
};
// worker 只写 pages/<id>.md（front-matter）；wiki.json 由 Host assemble 生成。
// forged：额外写一个伪造的 wiki.json，证明 Host 的 --repo/--language 覆盖它。
const writeCandidate = (stage, root, { title = "New Wiki", markdown = "# P1\n\nBody.", forged = null } = {}) => {
  mkdirSync(path.join(stage, "pages"), { recursive: true });
  writeFileSync(path.join(stage, "pages", "p1.md"), `---\nid: "p1"\ntitle: ${JSON.stringify(title)}\nparentId: null\norder: 1\ndescription: "d"\nfilePaths: []\n---\n${markdown}\n`);
  if (forged) writeFileSync(path.join(stage, "wiki.json"), JSON.stringify({ schema: "repo-wiki-local/1", title, ...forged }));
};
const readWikiTitle = (root) => {
  try { const w = JSON.parse(readFileSync(path.join(root, ".dsh-wiki", "wiki.json"), "utf8")); return w.title ?? (w.pages?.[0]?.title === "Old" ? "Old Wiki" : w.pages?.[0]?.title) ?? null; } catch { return null; }
};
const stagingDirs = (root) => {
  try { return readdirSync(root).filter((n) => n.startsWith(".dsh-wiki.staging-")); } catch { return []; }
};
const backupDirs = (root) => {
  try { return readdirSync(root).filter((n) => n.startsWith(".dsh-wiki.bak-")); } catch { return []; }
};
writeOldWiki(repo, OLD_WIKI);
writeOldWiki(repoOther, { ...OLD_WIKI, repoId: repoOther, title: "Other Wiki" });

// 真实端到端翻译夹具（T014a-rev）：canonical wiki 自带 pages/*.md + cards/*.md，翻译作业从它播种
// 语言镜像，再由真 builder 的 assemble 组装 units。引用的文件名必须真实存在（selfcheck 会机检）。
const repoTranslateReal = tempDir("dsh-wiki-jobs-translate-e2e-");
const TR_REPO = realpathSync(repoTranslateReal);
const TR_PAGE = "# P1\n\nSee `README.md:1`.\n";
writeFileSync(path.join(TR_REPO, "README.md"), "hello\n");
mkdirSync(path.join(TR_REPO, ".dsh-wiki", "pages"), { recursive: true });
mkdirSync(path.join(TR_REPO, ".dsh-wiki", "cards"), { recursive: true });
writeFileSync(path.join(TR_REPO, ".dsh-wiki", "wiki.json"), JSON.stringify({
  schema: "repo-wiki-local/1", repoId: TR_REPO, language: "en", title: "Canonical",
  pages: [{ id: "p1", parentId: null, order: 1, title: "P1", description: "d", filePaths: ["README.md"], markdown: TR_PAGE }],
  cards: [{ id: "c1", title: "C1", kind: "concept", summary: "One line.", keyFiles: ["README.md"] }],
}));
writeFileSync(path.join(TR_REPO, ".dsh-wiki", "pages", "p1.md"), `---\nid: "p1"\nparentId: null\norder: 1\ntitle: "P1"\ndescription: "d"\nfilePaths: ["README.md"]\n---\n${TR_PAGE}`);
writeFileSync(path.join(TR_REPO, ".dsh-wiki", "cards", "c1.md"), `---\nid: "c1"\ntitle: "C1"\nkind: "concept"\nkeyFiles: ["README.md"]\n---\nOne line.\n`);
const TR_WIKI_BYTES = readFileSync(path.join(TR_REPO, ".dsh-wiki", "wiki.json"));
const TR_PAGE_BYTES = readFileSync(path.join(TR_REPO, ".dsh-wiki", "pages", "p1.md"));

// ---------- 真 journal store（journal 依赖是强制的） ----------
// store dir 在所有 fixture repo 之外；allowedRoots 恰为 fixture roots；host 实例固定。
const JOURNAL_HOST = "host-jobs-harness-01";
const STORE_DIR = realpathSync(tempDir("dsh-wiki-journal-store-"));
const ROOTS = [repo, repoOther, repoFault, repoTranslate, repoTranslateReal].map((value) => realpathSync(value));
const journalStore = await openJournalStore({ storeDir: STORE_DIR, allowedRoots: ROOTS, hostInstanceId: JOURNAL_HOST });

// ---------- 假宿主服务（注入式依赖；agents.create 里真跑 setup） ----------
const env = { behavior: null, agents: new Map(), sessions: new Map(), events: [], released: 0 };
const FIVE = ["read", "glob", "grep", "write", "edit"];

const makeAgent = (sessionId, root) => {
  const agent = {
    id: sessionId, root, status: "idle", selected: null, followups: [], events: [],
    model: { select: (selection) => { agent.selected = { ...selection }; } },
    followup(message) {
      agent.followups.push(message);
      agent.status = "running";
      env.events.push("followup");
      const text = message?.content?.[0]?.text ?? "";
      const quoted = /Staging wiki directory \(absolute\): ("(?:[^"\\]|\\.)*")/.exec(text)?.[1];
      const stage = quoted ? JSON.parse(quoted) : undefined;
      agent.stage = stage;
      const behavior = env.behavior;
      setTimeout(() => {
        try { behavior?.(agent, stage); } catch (error) { env.events.push("behavior-threw:" + error?.message); }
      }, 5);
    },
    cancel(cause) {
      agent.cancelCause = cause;
      env.events.push("cancel");
      if (env.ignoreCancel) { env.events.push("cancel-ignored"); return; }
      if (agent.status === "running") {
        agent.status = "idle";
        agent.events.push({ type: "turn/end", seq: agent.events.length + 1, data: { turn: 1, reason: { kind: "aborted", reason: { kind: "user" } } } });
      }
    },
    session: { id: sessionId, header: { id: sessionId, cwd: root }, snapshotEvents: () => agent.events },
  };
  return agent;
};

// preset 服务的最小可信形状：mount 绑定成功 + composedPreset 报告该 agent 真实组合的 preset。
// jobs.js 要求 composedPreset 存在（否则无法证明 preset 真的挂上了），所以 mock 必须提供它。
const mountedPresets = new Map();
const agentPresets = {
  mount: async (agentCtx, id) => { mountedPresets.set(agentCtx, id); return { id }; },
  composedPreset: (agentCtx) => mountedPresets.get(agentCtx),
};
const workerGuard = {
  activate: () => { let live = true; return () => { if (live) { live = false; env.released++; } }; },
  authorizeSync: () => ({ allow: true }),
};
const agents = {
  create: async (options) => {
    const agent = makeAgent(options.sessionId, options.meta.cwd);
    env.sessions.set(options.sessionId, { cwd: options.meta.cwd });
    env.agents.set(options.sessionId, agent);
    const effects = [];
    const agentCtx = {
      tools: {
        restrict: () => () => {},
        definitions: () => FIVE.map((name) => ({ name })),
        executable: (name) => ({ name }),
        guard: () => () => {},
      },
      effect: (fn) => { const d = fn(); effects.push(d); return d; },
    };
    await options.setup(agentCtx, agent);
    return {
      agent,
      // dispose 只有在 worker 真停下之后才 resolve；ignoreCancel 模拟停不下来的 worker（永不 resolve）
      dispose: async () => {
        while (env.ignoreCancel && agent.status === "running") await sleep(20);
        agent.status = "idle";
        for (const d of effects.reverse()) if (typeof d === "function") d();
      },
    };
  },
};
const configOf = (overrides = {}) => ({
  agents, agentPresets, workerGuard, workingDirectory: { get: () => "unused" }, presetId: "dsh-wiki-worker", buildWorkerPrompt, buildTranslationPrompt, pendingInput: (agent) => agent.pendingInput ?? [],
  logger: { warn: (m) => { env.events.push("warn:" + m); } },
  journalStore, hostInstanceId: JOURNAL_HOST, allowedRoots: ROOTS,
  wikiDirName: ".dsh-wiki",
  builderPath: BUILDER,
  pythonPath: PYTHON,
  pollMs: 20,
  idleGraceMs: 400,
  disposeTimeoutMs: 400,
  jobTimeoutMs: 60000,
  buildTimeoutMs: 120000,
  selfcheckTimeoutMs: 120000,
  ...overrides,
});
const manager = createJobManager(configOf());
// 独立的短超时实例：主实例 60s 超时在一次 harness 里等不到。
// 用 3000ms 而不是 300ms：作业预算从 start() 起算（配置阶段也计入），真实 python 的
// resolvePython + resolve-config 实测约 380ms，300ms 会让作业在 agent 阶段之前就过期。
const managerShort = createJobManager(configOf({ jobTimeoutMs: 3000 }));

const view = (m, root) => m.view(root);
const waitJob = async (m, root, predicate, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  let current = null;
  while (Date.now() < deadline) {
    current = view(m, root);
    if (!current.active && predicate(current.last)) return current;
    await sleep(40);
  }
  return current;
};
const start = (m, root, extra = {}) => m.start({ root, action: "generate", model: { provider: "mock", model: "m1" }, ...extra });
const startErr = (m, root, extra = {}) => {
  try { start(m, root, extra); return null; } catch (error) { return error; }
};
// 会话要等 resolve-config + 建 worker 之后才存在；取消/卸载必须在 agent 已存在之后触发。
const waitActiveSession = async (m, root, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const active = view(m, root).active;
    if (active && typeof active.sessionId === "string") return active.sessionId;
    await sleep(20);
  }
  return null;
};
const lastAgent = () => [...env.agents.values()].at(-1);

// ---------- 1. 服务缺失 ----------
const sessionsBeforeRefusals = env.sessions.size;
const noServices = (() => {
  const bare = createJobManager(configOf({ agents: undefined }));
  return startErr(bare, repo);
})();
check("start() refuses to fence without the injected agents dependency (503 services-unavailable)",
  noServices?.status === 503 && noServices?.code === "services-unavailable", JSON.stringify({ status: noServices?.status, code: noServices?.code }));
check("a refused start leaves no fence behind", manager.isBusy(repo) === false && view(manager, repo).active === null);

// journal 依赖永远必需：缺任何一项（或只给一部分）= 503 services-unavailable，没有无 journal 的发布路径。
for (const [label, overrides, missing] of [
  ["none", { journalStore: undefined, hostInstanceId: undefined, allowedRoots: undefined }, ["journalStore", "hostInstanceId", "allowedRoots"]],
  ["journalStore only", { hostInstanceId: undefined, allowedRoots: undefined }, ["hostInstanceId", "allowedRoots"]],
  ["hostInstanceId only", { journalStore: undefined, allowedRoots: undefined }, ["journalStore", "allowedRoots"]],
  ["allowedRoots only", { journalStore: undefined, hostInstanceId: undefined }, ["journalStore", "hostInstanceId"]],
  ["invalid journalStore", { journalStore: {}, hostInstanceId: undefined, allowedRoots: undefined }, ["journalStore", "hostInstanceId", "allowedRoots"]],
]) {
  const refused = createJobManager(configOf(overrides));
  const error = startErr(refused, repo);
  const state = refused.journalState();
  check(`journal deps (${label}): start() is 503 services-unavailable, mode journal, missing ${missing.join(", ")}`,
    error?.status === 503 && error?.code === "services-unavailable"
    && state.mode === "journal" && JSON.stringify(state.missing) === JSON.stringify(missing)
    && refused.isBusy(repo) === false && view(refused, repo).active === null,
    JSON.stringify({ error: error?.code ?? null, state, busy: refused.isBusy(repo) }));
}
const recordsAfterRefusals = await Promise.all(ROOTS.map((value) => journalStore.load(value)));
check("every refused start created no staging, no session, no fence and no journal record",
  [repo, repoOther, repoFault].every((value) => stagingDirs(value).length === 0 && backupDirs(value).length === 0)
  && env.sessions.size === sessionsBeforeRefusals
  && recordsAfterRefusals.every((snapshot) => snapshot === null)
  && manager.isBusy(repo) === false && manager.isBusy(repoOther) === false && manager.isBusy(repoFault) === false,
  JSON.stringify({ staging: [repo, repoOther, repoFault].map(stagingDirs), sessions: [sessionsBeforeRefusals, env.sessions.size], records: recordsAfterRefusals.map((snapshot) => snapshot === null) }));

// ---------- 1b. 语言动作契约（T014a） ----------
const genVi = startErr(manager, repoOther, { targetLang: "vi" });
check("start() still refuses generate + vi with 501 language-unsupported",
  genVi?.status === 501 && genVi?.code === "language-unsupported", JSON.stringify({ status: genVi?.status, code: genVi?.code }));
const trNoLang = startErr(manager, repoOther, { action: "translate" });
check("start() refuses translate without a targetLang (400 invalid-target-lang)",
  trNoLang?.status === 400 && trNoLang?.code === "invalid-target-lang", JSON.stringify({ status: trNoLang?.status, code: trNoLang?.code }));
const trEn = startErr(manager, repoOther, { action: "translate", targetLang: "en" });
check("start() refuses translate to the canonical en (400 invalid-target-lang)",
  trEn?.status === 400 && trEn?.code === "invalid-target-lang", JSON.stringify({ status: trEn?.status, code: trEn?.code }));
check("the three refusals left no fence, no staging and no record",
  manager.isBusy(repoOther) === false && stagingDirs(repoOther).length === 0 && (await journalStore.load(repoOther)) === null,
  JSON.stringify({ busy: manager.isBusy(repoOther), staging: stagingDirs(repoOther) }));

const translateStarted = start(manager, repoTranslate, { action: "translate", targetLang: "vi" });
check("start() accepts translate + vi and reports the action and the target language",
  translateStarted.phase === "running" && translateStarted.action === "translate" && translateStarted.targetLang === "vi",
  JSON.stringify(translateStarted));
const translateDone = await waitJob(manager, repoTranslate, (last) => last && last.phase !== "running");
check("a translate job with no published canonical wiki fails closed (live-missing) and publishes nothing",
  translateDone.last?.phase === "failed" && translateDone.last?.error?.code === "live-missing"
  && !existsSync(path.join(repoTranslate, ".dsh-wiki")) && stagingDirs(repoTranslate).length === 0,
  JSON.stringify({ last: translateDone.last, live: existsSync(path.join(repoTranslate, ".dsh-wiki")), staging: stagingDirs(repoTranslate) }));

// ---------- 1c. 真实端到端翻译（真 locales-init + 真 assemble）：worker 篡改 canonical 也发布不了它 ----------
// 这是实测缺陷的回归：真实运行里 worker 把暂存根上的英文 Markdown 就地翻成了越南语。现在 worker 的
// 工作区是 locales/<lang>/ 镜像，宿主在 worker 停下之后从 live 重新播种 canonical，再用镜像组装 units。
{
  // 这个用例断言的是管道行为，不是预算：显式给足预算，避免机器负载把断言变成超时噪声。
  const managerTr = createJobManager(configOf({ jobTimeoutMs: 180000, buildTimeoutMs: 180000, selfcheckTimeoutMs: 180000 }));
  let metaAtWorker = null;
  env.behavior = (agent, stage) => {
    // 镜像里的英文副本被就地翻译：front-matter 结构键、代码围栏与 path:line 引用逐字保留。
    writeFileSync(path.join(stage, "locales", "vi", "pages", "p1.md"), `---\nid: "p1"\nparentId: null\norder: 1\ntitle: "Trang 1"\ndescription: "mo ta"\nfilePaths: ["README.md"]\n---\n# Trang 1\n\nXem \`README.md:1\`.\n`);
    writeFileSync(path.join(stage, "locales", "vi", "cards", "c1.md"), `---\nid: "c1"\ntitle: "The 1"\nkind: "concept"\nkeyFiles: ["README.md"]\n---\nMot dong.\n`);
    metaAtWorker = readFileSync(path.join(stage, "locales", "vi", "translation-meta.json"));
    // 实测到的行为：worker 把暂存根上的 canonical 就地改写了（language 也改了）。
    writeFileSync(path.join(stage, "pages", "p1.md"), `---\nid: "p1"\n---\n# Trang\n`);
    writeFileSync(path.join(stage, "wiki.json"), JSON.stringify({
      schema: "repo-wiki-local/1", repoId: agent.root, language: "vi", title: "Wiki tieng Viet", pages: [{ id: "p1", title: "Trang" }],
    }));
    agent.events.push({ type: "turn/end", seq: 2, data: { turn: 1, reason: { kind: "completed" } } });
    agent.status = "idle";
  };
  env.events.length = 0;
  start(managerTr, TR_REPO, { action: "translate", targetLang: "vi" });
  const trDone = await waitJob(managerTr, TR_REPO, (last) => last && last.phase !== "running", 180000);
  const liveTr = path.join(TR_REPO, ".dsh-wiki");
  check("translate e2e: the real locales-init + assemble pipeline publishes the job",
    trDone.last?.phase === "done" && trDone.last?.published === true, JSON.stringify(trDone?.last));
  check("translate e2e: the published canonical tree is byte-identical to the live canonical (re-seeded after the worker)",
    (() => {
      try {
        return readFileSync(path.join(liveTr, "wiki.json")).equals(TR_WIKI_BYTES)
          && readFileSync(path.join(liveTr, "pages", "p1.md")).equals(TR_PAGE_BYTES);
      } catch { return false; }
    })(), JSON.stringify({ error: trDone?.last?.error ?? null }));
  check("translate e2e: the published locales/<lang>/wiki.json is assembled from the translated Markdown",
    (() => {
      try {
        const units = JSON.parse(readFileSync(path.join(liveTr, "locales", "vi", "wiki.json"), "utf8"));
        return units.language === "vi" && units.pages?.[0]?.title === "Trang 1" && units.cards?.[0]?.summary === "Mot dong.";
      } catch { return false; }
    })(), JSON.stringify(trDone?.last?.error ?? null));
  check("translate e2e: translation-meta.json survives the assemble and the publish byte-identically",
    (() => {
      try {
        return metaAtWorker !== null && readFileSync(path.join(liveTr, "locales", "vi", "translation-meta.json")).equals(metaAtWorker);
      } catch { return false; }
    })());
  check("translate e2e: the translation gate passed on the real checker (publish implies check-translation ok)",
    trDone.last?.phase === "done" && !env.events.some((event) => typeof event === "string" && event.includes("translation-gate")));
  check("translate e2e: staging is gone and the journal records a published transaction",
    stagingDirs(TR_REPO).length === 0 && (await journalStore.load(TR_REPO))?.record?.phase === "published",
    JSON.stringify({ staging: stagingDirs(TR_REPO), phase: (await journalStore.load(TR_REPO))?.record?.phase ?? null }));
}

// ---------- 2. 成功路径：staging → build → selfcheck → 发布 ----------
env.behavior = (agent, stage) => {
  writeCandidate(stage, agent.root, { title: "New Wiki" });
  agent.events.push({ type: "turn/end", seq: 2, data: { turn: 1, reason: { kind: "completed" } } });
  agent.status = "idle";
};
env.events.length = 0;
const started = start(manager, repo);
check("start() returns a running job summary", started.phase === "running" && started.root === repo && typeof started.id === "string",
  JSON.stringify(started));
check("start() closes the single-flight fence synchronously", manager.isBusy(repo) === true && view(manager, repo).active?.id === started.id);
const busy = startErr(manager, repo);
check("a second start for the same root is fenced (409 job-busy)", busy?.status === 409 && busy?.code === "job-busy", JSON.stringify({ status: busy?.status, code: busy?.code }));
let done = await waitJob(manager, repo, (last) => last && last.phase !== "running");
check("success: job completes and publishes the candidate", done.last?.phase === "done" && done.last?.published === true, JSON.stringify(done?.last));
check("success: active .dsh-wiki holds the new candidate", readWikiTitle(repo) === "New Wiki", String(readWikiTitle(repo)));
check("success: staging directory is gone and no backup is left behind", stagingDirs(repo).length === 0 && backupDirs(repo).length === 0,
  JSON.stringify([stagingDirs(repo), backupDirs(repo)]));
check("success: the fence is released only for a terminal, non-quarantined job", manager.isBusy(repo) === false && done.last?.blocked === null);
check("success: job records the worker session id for the panel link", typeof done.last?.sessionId === "string" && done.last.sessionId.startsWith("dsh-wiki-"));
check("success: the job pins the requested model on the agent", (() => {
  const agent = lastAgent();
  return agent?.selected?.provider === "mock" && agent?.selected?.model === "m1";
})(), JSON.stringify(lastAgent()?.selected));
check("success: Host-owned guard activation was released after dispose", env.released >= 1, String(env.released));
check("success: the agent wrote into the staging dir, never into the live wiki", (() => {
  const agent = lastAgent();
  return typeof agent?.stage === "string" && agent.stage.includes(".dsh-wiki.staging-") && path.dirname(agent.stage) === repo;
})());
check("success: the Host-built prompt names the staging dir and carries no python/git instructions", (() => {
  const text = lastAgent()?.followups?.[0]?.content?.[0]?.text ?? "";
  return text.includes(".dsh-wiki.staging-") && !/\bpython3?\s+\S|git\s+-C|rev-parse|resolve-config|--wiki\b/i.test(text);
})());
check("success: promptSha256 and protocolSha256 are recorded", /^[0-9a-f]{64}$/.test(done.last?.promptSha256 ?? "") && /^[0-9a-f]{64}$/.test(done.last?.protocolSha256 ?? ""));
check("success: Host wrote generation-meta.json with the pinned model and hashes", (() => {
  try {
    const meta = JSON.parse(readFileSync(path.join(repo, ".dsh-wiki", "generation-meta.json"), "utf8"));
    return meta.docModel?.model === "m1" && meta.promptSha256 === done.last.promptSha256 && meta.resolved?.language === "en";
  } catch { return false; }
})());

// ---------- 3. agent 回合失败（模型/路由错误）：保留旧 wiki ----------
writeOldWiki(repo, OLD_WIKI);
env.behavior = (agent) => {
  agent.events.push({ type: "turn/end", seq: 2, data: { turn: 1, reason: { kind: "error", error: { message: "mock provider rejected the route", code: "AUTH", status: 401 } } } });
  agent.status = "idle";
};
env.events.length = 0;
start(manager, repo);
done = await waitJob(manager, repo, (last) => last && last.phase !== "running");
// 默认视图（view(root)）与公开投影同一条契约：稳定 code + 固定短句，provider 的原文只进 logger。
check("turn error: the default view exposes a fixed code + message, never the provider's raw text",
  done.last?.phase === "failed" && done.last?.error?.code === "auth"
  && done.last?.error?.message === PUBLIC_ERROR_MESSAGES["job-failed"]
  && !JSON.stringify(done.last).includes("mock provider rejected the route"),
  JSON.stringify(done?.last?.error));
check("turn error: the raw provider message is kept only in the logger",
  env.events.some((event) => typeof event === "string" && event.startsWith("warn:") && event.includes("mock provider rejected the route")),
  JSON.stringify(env.events.filter((event) => typeof event === "string" && event.startsWith("warn:")).slice(-3)));
check("turn error: the previous wiki survives untouched", readWikiTitle(repo) === "Old Wiki" && stagingDirs(repo).length === 0);
check("turn error: the worker was confirmed stopped before staging was removed", lastAgent()?.status !== "running" && manager.isBusy(repo) === false);

// ---------- 4. 候选缺失 / 自检失败：保留旧 wiki ----------
env.behavior = (agent) => {
  agent.events.push({ type: "turn/end", seq: 2, data: { turn: 1, reason: { kind: "completed" } } });
  agent.status = "idle";
};
start(manager, repo);
done = await waitJob(manager, repo, (last) => last && last.phase !== "running");
check("a worker that wrote no pages fails at the Host assemble step and keeps the old wiki", done.last?.phase === "failed"
  && done.last?.error?.code === "assemble-failed" && readWikiTitle(repo) === "Old Wiki", JSON.stringify(done?.last?.error));

env.behavior = (agent, stage) => {
  writeCandidate(stage, agent.root, { title: "Bad Citations", markdown: "See `no-such-file.py:12`." });
  agent.events.push({ type: "turn/end", seq: 2, data: { turn: 1, reason: { kind: "completed" } } });
  agent.status = "idle";
};
start(manager, repo);
done = await waitJob(manager, repo, (last) => last && last.phase !== "running");
check("selfcheck failure keeps the old wiki (candidate never published)", done.last?.phase === "failed"
  && (done.last?.stage === "selfcheck" || /selfcheck/.test(done.last?.error?.message ?? ""))
  && readWikiTitle(repo) === "Old Wiki", JSON.stringify({ stage: done?.last?.stage, error: done?.last?.error }));

// ---------- 5. Host 决定 repoId/language：worker 伪造的 wiki.json 不能改它们 ----------
env.behavior = (agent, stage) => {
  writeCandidate(stage, agent.root, { title: "Forged Meta", forged: { repoId: repoOther, language: "vi" } });
  agent.events.push({ type: "turn/end", seq: 2, data: { turn: 1, reason: { kind: "completed" } } });
  agent.status = "idle";
};
start(manager, repo);
done = await waitJob(manager, repo, (last) => last && last.phase !== "running");
check("a forged candidate wiki.json cannot change repoId/language: Host assemble forces --repo/--language en",
  done.last?.phase === "done" && (() => {
    try { const w = JSON.parse(readFileSync(path.join(repo, ".dsh-wiki", "wiki.json"), "utf8")); return w.repoId === repo && w.language === "en"; } catch { return false; }
  })(), JSON.stringify(done?.last?.error));
writeOldWiki(repo, OLD_WIKI);

// ---------- 6. 遗留的非 en live wiki：开会话之前就拒绝 ----------
writeOldWiki(repo, { ...OLD_WIKI, language: "vi", title: "Legacy Vietnamese" });
env.behavior = (agent, stage) => {
  writeCandidate(stage, agent.root, { title: "Should Not Start" });
  agent.events.push({ type: "turn/end", seq: 2, data: { turn: 1, reason: { kind: "completed" } } });
  agent.status = "idle";
};
const sessionsBefore = env.sessions.size;
const followupsBefore = [...env.agents.values()].reduce((n, a) => n + a.followups.length, 0);
start(manager, repo);
done = await waitJob(manager, repo, (last) => last && last.phase !== "running");
check("a legacy non-en live wiki is rejected before a session is created (no model call, live untouched)",
  done.last?.phase === "failed" && done.last?.error?.code === "live-not-canonical"
  && env.sessions.size === sessionsBefore
  && [...env.agents.values()].reduce((n, a) => n + a.followups.length, 0) === followupsBefore
  && readWikiTitle(repo) === "Legacy Vietnamese" && stagingDirs(repo).length === 0,
  JSON.stringify({ phase: done?.last?.phase, error: done?.last?.error, sessions: [sessionsBefore, env.sessions.size], title: readWikiTitle(repo) }));
writeOldWiki(repo, OLD_WIKI);

// ---------- 7. 宿主所有条目：config.json 与 locales/ 必须原样保留 ----------
const liveDir = path.join(repo, ".dsh-wiki");
const configPath = path.join(liveDir, "config.json");
const localePath = path.join(liveDir, "locales", "vi", "wiki.json");
const CONFIG_BYTES = Buffer.from(JSON.stringify({ profile: "compact", pages: { min: 6, max: 16 } }, null, 2) + "\n", "utf8");
const LOCALE_BYTES = Buffer.from(JSON.stringify({ schema: "repo-wiki-local/1", repoId: repo, language: "vi", pages: [{ id: "vi-p1", markdown: "# VI" }] }, null, 2) + "\n", "utf8");
writeFileSync(configPath, CONFIG_BYTES);
mkdirSync(path.dirname(localePath), { recursive: true });
writeFileSync(localePath, LOCALE_BYTES);
env.behavior = (agent, stage) => {
  writeCandidate(stage, agent.root, { title: "Preserved Wiki" });
  // 故障注入：模型往候选里写“自己的” config/locales，发布时绝不允许覆盖宿主条目
  writeFileSync(path.join(stage, "config.json"), JSON.stringify({ profile: "legacy", hijacked: true }));
  mkdirSync(path.join(stage, "locales", "vi"), { recursive: true });
  writeFileSync(path.join(stage, "locales", "vi", "wiki.json"), JSON.stringify({ language: "vi", hijacked: true }));
  agent.events.push({ type: "turn/end", seq: 2, data: { turn: 1, reason: { kind: "completed" } } });
  agent.status = "idle";
};
start(manager, repo);
done = await waitJob(manager, repo, (last) => last && last.phase !== "running");
const configKept = existsSync(configPath) && Buffer.compare(readFileSync(configPath), CONFIG_BYTES) === 0;
const localeKept = existsSync(localePath) && Buffer.compare(readFileSync(localePath), LOCALE_BYTES) === 0;
check("publish keeps host-owned config.json and locales/ byte-identical while replacing the en wiki",
  done.last?.phase === "done" && done.last?.published === true
  && readWikiTitle(repo) === "Preserved Wiki" && configKept && localeKept
  && stagingDirs(repo).length === 0 && backupDirs(repo).length === 0,
  JSON.stringify({ phase: done?.last?.phase, title: readWikiTitle(repo), configKept, localeKept, staging: stagingDirs(repo), backups: backupDirs(repo) }));

// ---------- 8. 符号链接的宿主条目：拒绝发布，live 不动 ----------
const outside = tempDir("dsh-wiki-outside-");
writeFileSync(path.join(outside, "wiki.json"), "outside-secret");
const realLocales = path.join(liveDir, "locales");
const nestedLocales = path.join(liveDir, "locales-real");
await import("node:fs/promises").then((fs) => fs.rename(realLocales, nestedLocales));
let symlinkOk = true;
try {
  (await import("node:fs")).symlinkSync(outside, realLocales, "junction");
} catch (error) {
  symlinkOk = false;
  env.events.push("symlink-unsupported:" + error?.message);
}
if (symlinkOk) {
  env.behavior = (agent, stage) => {
    writeCandidate(stage, agent.root, { title: "Symlink Publish" });
    agent.events.push({ type: "turn/end", seq: 2, data: { turn: 1, reason: { kind: "completed" } } });
    agent.status = "idle";
  };
  start(manager, repo);
  done = await waitJob(manager, repo, (last) => last && last.phase !== "running");
  check("a symlinked host-owned entry refuses publication (protected-symlink), live untouched",
    done.last?.phase === "failed" && done.last?.error?.code === "protected-symlink"
    && readWikiTitle(repo) === "Preserved Wiki" && configKept
    && stagingDirs(repo).length === 0,
    JSON.stringify({ phase: done?.last?.phase, error: done?.last?.error, title: readWikiTitle(repo), staging: stagingDirs(repo) }));
  try { (await import("node:fs")).unlinkSync(realLocales); } catch { /* 链接已不存在 */ }
} else {
  console.log("SKIP symlink rejection: this host cannot create directory symlinks");
}
await import("node:fs/promises").then((fs) => fs.rename(nestedLocales, realLocales));

// ---------- 9. 取消：先停 worker 再删 staging，旧 wiki 不动 ----------
env.events.length = 0;
env.behavior = () => { /* 挂起：只有 cancel 能结束 */ };
start(manager, repo);
const cancelledSession = await waitActiveSession(manager, repo);
const runningView = view(manager, repo);
check("view() exposes an active running job with its stage and session", runningView.active?.phase === "running"
  && typeof runningView.active.stage === "string" && runningView.active.sessionId === cancelledSession,
  JSON.stringify(runningView));
const cancelRes = manager.cancel(repo);
check("cancel() accepts the cancel", cancelRes.canceled === true && typeof cancelRes.id === "string", JSON.stringify(cancelRes));
done = await waitJob(manager, repo, (last) => last && last.phase === "canceled");
check("cancel: job ends canceled, old wiki intact, staging removed", done.last?.phase === "canceled"
  && readWikiTitle(repo) === "Preserved Wiki" && stagingDirs(repo).length === 0, JSON.stringify(done?.last));
check("cancel: agent.cancel({kind:'user'}) was called before the staging delete", (() => {
  const cancelAt = env.events.indexOf("cancel");
  return cancelAt >= 0 && lastAgent()?.cancelCause?.kind === "user";
})(), JSON.stringify({ cancelAt: env.events.indexOf("cancel"), agent: lastAgent()?.id, cause: lastAgent()?.cancelCause, last: done.last?.sessionId, events: env.events }));
check("cancel: canceling with no active job is a no-op", manager.cancel(repo).canceled === false);

// ---------- 10. 并发栅栏在 await 之前：两个同时到达的请求只有一个能进 ----------
env.behavior = () => { /* 挂起 */ };
const [firstErr, secondErr] = [startErr(manager, repo), startErr(manager, repo)];
check("two starts in the same tick: exactly one wins the fence (one 409 job-busy)",
  [firstErr, secondErr].filter(Boolean).length === 1 && [firstErr, secondErr].find(Boolean)?.code === "job-busy",
  `${firstErr?.code}/${secondErr?.code}`);
manager.cancel(repo);
await waitJob(manager, repo, (last) => last && last.phase === "canceled");

// ---------- 11. 遗留 recover() 已删除：不存在发现式恢复 ----------
check("legacy recover() (filename/mtime backup discovery) no longer exists", typeof manager.recover === "undefined");

// ---------- 12. 超时：worker 还活着时也必须先停下，再删暂存、放栅栏 ----------
const resetFaultWiki = (title) => writeOldWiki(repoFault, { ...OLD_WIKI, repoId: repoFault, title });
resetFaultWiki("Fault Old Wiki");
// 残留暂存目录（例如上一个 worker 仍在写的目录）：EEXIST 失败的新作业不得顺手删掉它
const fixedId = "deadbeefdeadbeef";
const leftoverStage = path.join(repoFault, `.dsh-wiki.staging-${fixedId}`);
mkdirSync(leftoverStage, { recursive: true });
writeFileSync(path.join(leftoverStage, "worker-still-writing.txt"), "do not delete");
let idInjected = true;
try {
  Object.defineProperty(globalThis.crypto, "randomUUID", { value: () => fixedId, configurable: true });
} catch (error) {
  idInjected = false;
  env.events.push("uuid-injection-unsupported:" + error?.message);
}
const leftoverErr = startErr(manager, repoFault);
const leftoverView = await waitJob(manager, repoFault, (last) => last && last.phase !== "running", 15000);
check("a job whose staging name already exists fails with staging-exists and never deletes that directory",
  leftoverErr === null && leftoverView.last?.phase === "failed" && leftoverView.last?.error?.code === "staging-exists"
  && existsSync(path.join(leftoverStage, "worker-still-writing.txt"))
  && manager.isBusy(repoFault) === false,
  JSON.stringify({ startErr: leftoverErr?.code ?? null, last: leftoverView.last?.error, kept: existsSync(path.join(leftoverStage, "worker-still-writing.txt")), injected: idInjected }));
if (idInjected) delete globalThis.crypto.randomUUID;
await import("node:fs/promises").then((fs) => fs.rm(leftoverStage, { recursive: true, force: true }));
env.events.length = 0;
env.behavior = () => { /* 一直 running：只有超时/取消能结束 */ };
const timeoutStart = start(managerShort, repoFault);
check("timeout instance accepts the job", timeoutStart.phase === "running", JSON.stringify(timeoutStart));
done = await waitJob(managerShort, repoFault, (last) => last && last.phase !== "running", 15000);
const timeoutAgent = lastAgent();
check("timeout: job fails with job-timeout, the worker is cancelled and confirmed stopped",
  done.last?.phase === "failed" && done.last?.error?.code === "job-timeout"
  && env.events.includes("cancel") && timeoutAgent?.status !== "running",
  JSON.stringify({ phase: done?.last?.phase, error: done?.last?.error, status: timeoutAgent?.status, events: env.events }));
check("timeout: staging removed and the old wiki untouched only after the worker stopped",
  stagingDirs(repoFault).length === 0 && readWikiTitle(repoFault) === "Fault Old Wiki" && backupDirs(repoFault).length === 0,
  JSON.stringify({ staging: stagingDirs(repoFault), title: readWikiTitle(repoFault) }));
const afterTimeout = start(managerShort, repoFault);
check("single-flight is released after a timed-out job (next start wins the fence, not 409)",
  afterTimeout.phase === "running" && managerShort.isBusy(repoFault) === true, JSON.stringify(afterTimeout));
managerShort.cancel(repoFault);
await waitJob(managerShort, repoFault, (last) => last && last.phase === "canceled", 15000);

// ---------- 13. 隔离：worker 停不下来时保留暂存与栅栏 ----------
resetFaultWiki("Fault Old Wiki");
env.events.length = 0;
env.ignoreCancel = true;
env.behavior = () => { /* running 且 cancel 被忽略 */ };
start(managerShort, repoFault);
done = await waitJob(managerShort, repoFault, (last) => last && last.blocked, 15000);
const quarantinedAgent = lastAgent();
check("quarantine: a worker that never stops keeps staging + fence and reports an explicit blocked state",
  done.last?.phase === "failed" && done.last?.error?.code === "worker-not-stopped"
  && done.last?.blocked?.reason === "worker-not-stopped"
  && stagingDirs(repoFault).length === 1
  && view(managerShort, repoFault).active?.blocked?.reason === "worker-not-stopped"
  && quarantinedAgent?.status === "running",
  JSON.stringify({ last: done?.last, active: view(managerShort, repoFault).active, staging: stagingDirs(repoFault) }));
check("quarantine: the fence stays closed (isBusy true) while the worker is alive", managerShort.isBusy(repoFault) === true);
const blockedStart = startErr(managerShort, repoFault);
check("quarantine: a new job for the same root is refused (409 job-quarantined), not started next to a live worker",
  blockedStart?.status === 409 && blockedStart?.code === "job-quarantined", JSON.stringify({ status: blockedStart?.status, code: blockedStart?.code }));
// 释放路径：worker 真的停下后，cancel 才能删暂存并放开栅栏
quarantinedAgent.status = "idle";
env.ignoreCancel = false;
const release = managerShort.cancel(repoFault);
check("quarantine: cancel reports the quarantine and retries the release",
  release.canceled === false && release.quarantine === true, JSON.stringify(release));
const releasedDeadline = Date.now() + 5000;
let released = null;
while (Date.now() < releasedDeadline) {
  released = view(managerShort, repoFault);
  if (!released.active) break;
  await sleep(40);
}
check("quarantine: once the worker is gone the fence is released and staging removed",
  released && !released.active && stagingDirs(repoFault).length === 0,
  JSON.stringify({ active: released?.active, staging: stagingDirs(repoFault) }));
const afterQuarantine = start(managerShort, repoFault);
check("after release the root accepts a job again", afterQuarantine.phase === "running", JSON.stringify(afterQuarantine));
managerShort.cancel(repoFault);
await waitJob(managerShort, repoFault, (last) => last && last.phase === "canceled", 15000);

// ---------- 14. 等待人工输入：短暂等待、有界到期，绝不无限等待 ----------
// 缺陷（第二遍 review）：waitWhileInputPending 没有截止时间，而 supervise 每次返回都重算
// `Date.now() + jobTimeoutMs`，于是每次输入暂停都能给作业续一次执行预算。这里用很小的注入值证明：
// 输入暂停有自己的上限（input-timeout），重复暂停也越不过作业的绝对预算（job-timeout）。
const managerInput = createJobManager(configOf({ jobTimeoutMs: 60000, inputTimeoutMs: 1000 }));
// 重复暂停的回归实例：作业预算很小、输入预算很大 => 结束只可能来自绝对预算。
const managerInputRetry = createJobManager(configOf({ jobTimeoutMs: 2500, inputTimeoutMs: 20000 }));

// 14a. 可解决的人工输入：先等（不立刻失败），输入到了就继续并成功发布。
resetFaultWiki("Fault Old Wiki");
env.events.length = 0;
env.behavior = (agent, stage) => {
  agent.pendingInput = ["approval"];
  agent.status = "running";
  // 250ms 后“人”回答了：清空 pending、写候选并结束回合。输入预算 1000ms，这次等待是安全的。
  setTimeout(() => {
    agent.pendingInput = [];
    writeCandidate(stage, agent.root, { title: "Input Resolved Wiki" });
    agent.events.push({ type: "turn/end", seq: 2, data: { turn: 1, reason: { kind: "completed" } } });
    agent.status = "idle";
  }, 250);
};
start(managerInput, repoFault);
// resolvePython + 会话创建要先跑完，等待输入状态才会出现：轮询到 waiting_input 为止
const waitingDeadline = Date.now() + 10000;
let waitingView = view(managerInput, repoFault);
while (Date.now() < waitingDeadline && waitingView.active?.stage !== "waiting_input") {
  await sleep(40);
  waitingView = view(managerInput, repoFault);
}
check("input required: job stays active with stage waiting_input and the pending inputs exposed",
  waitingView.active?.phase === "running" && waitingView.active.stage === "waiting_input"
  && Array.isArray(waitingView.active.waitingFor) && waitingView.active.waitingFor.includes("approval"),
  JSON.stringify(waitingView.active));
// 150ms 远小于 1000ms 的输入预算：有界等待仍然必须给可解决的输入留出时间，不能立刻判死。
await sleep(150);
const brieflyWaiting = view(managerInput, repoFault);
check("input required: the job waits for the input budget instead of failing instantly (staging kept during the pause)",
  brieflyWaiting.active?.stage === "waiting_input" && brieflyWaiting.active.phase === "running"
  && stagingDirs(repoFault).length === 1 && readWikiTitle(repoFault) === "Fault Old Wiki",
  JSON.stringify({ active: brieflyWaiting.active, staging: stagingDirs(repoFault) }));
done = await waitJob(managerInput, repoFault, (last) => last && last.phase !== "running", 30000);
check("input required: an input that does resolve is not killed early — the job resumes and publishes",
  done.last?.phase === "done" && done.last?.published === true
  && readWikiTitle(repoFault) === "Input Resolved Wiki" && stagingDirs(repoFault).length === 0,
  JSON.stringify({ last: done?.last, title: readWikiTitle(repoFault), staging: stagingDirs(repoFault) }));

// 14b. 等待中的作业仍可取消（取消优先于输入到期）。
resetFaultWiki("Fault Old Wiki");
env.events.length = 0;
env.behavior = (agent) => { agent.pendingInput = ["approval"]; agent.status = "running"; };
start(managerInput, repoFault);
const cancelWaitDeadline = Date.now() + 10000;
let cancelWaitView = view(managerInput, repoFault);
while (Date.now() < cancelWaitDeadline && cancelWaitView.active?.stage !== "waiting_input") {
  await sleep(40);
  cancelWaitView = view(managerInput, repoFault);
}
const waitingCancel = managerInput.cancel(repoFault);
check("input required: the waiting job is cancellable", waitingCancel.canceled === true, JSON.stringify(waitingCancel));
done = await waitJob(managerInput, repoFault, (last) => last && last.phase === "canceled", 15000);
check("input required: cancel ends the job, removes staging and keeps the old wiki",
  done.last?.phase === "canceled" && stagingDirs(repoFault).length === 0
  && readWikiTitle(repoFault) === "Fault Old Wiki",
  JSON.stringify({ last: done?.last, staging: stagingDirs(repoFault) }));
const afterWaiting = start(managerInput, repoFault);
check("single-flight is released after the waiting-input job is canceled",
  afterWaiting.phase === "running", JSON.stringify(afterWaiting));
managerInput.cancel(repoFault);
await waitJob(managerInput, repoFault, (last) => last && last.phase === "canceled", 15000);

// 14c. 永远不解决的输入：在输入预算到期时失败，稳定 code 为 input-timeout，且走既有终止路径。
resetFaultWiki("Fault Old Wiki");
env.events.length = 0;
env.behavior = (agent) => { agent.pendingInput = ["approval"]; agent.status = "running"; };
const pendingStart = Date.now();
start(managerInput, repoFault);
done = await waitJob(managerInput, repoFault, (last) => last && last.phase !== "running", 20000);
const pendingWaitedMs = Date.now() - pendingStart;
check("input timeout: a permanently pending input fails with the stable input-timeout code after the input budget",
  done.last?.phase === "failed" && done.last?.error?.code === "input-timeout"
  && done.last?.error?.message === PUBLIC_ERROR_MESSAGES["input-timeout"]
  && pendingWaitedMs >= 1000 && pendingWaitedMs < 12000,
  JSON.stringify({ error: done?.last?.error, waitedMs: pendingWaitedMs, last: done?.last }));
check("input timeout: the worker was confirmed stopped before staging was removed (existing termination path)",
  lastAgent()?.status !== "running" && stagingDirs(repoFault).length === 0
  && readWikiTitle(repoFault) === "Fault Old Wiki" && managerInput.isBusy(repoFault) === false,
  JSON.stringify({ status: lastAgent()?.status, staging: stagingDirs(repoFault), title: readWikiTitle(repoFault) }));

// 14d. 回归（真正的缺陷）：重复输入暂停不得再延长作业的绝对预算。
// 旧代码每次回到 supervise() 都新开一个 jobTimeoutMs 窗口，这些暂停会让作业永远不结束。
resetFaultWiki("Fault Old Wiki");
env.events.length = 0;
let pauseLoop = true;
let pauseResolutions = 0;
env.behavior = (agent) => {
  agent.pendingInput = ["approval"];
  agent.status = "running";
  // 输入不断被回答、又不断出现新的暂停：每次暂停都短暂可解决，正是旧实现“续期”的场景。
  const cycle = () => {
    if (!pauseLoop) return;
    if (Array.isArray(agent.pendingInput) && agent.pendingInput.length > 0) {
      agent.pendingInput = [];
      pauseResolutions += 1;
    } else {
      agent.pendingInput = ["approval"];
    }
    setTimeout(cycle, 40);
  };
  setTimeout(cycle, 40);
};
const retryStart = Date.now();
start(managerInputRetry, repoFault);
done = await waitJob(managerInputRetry, repoFault, (last) => last && last.phase !== "running", 25000);
const retryElapsedMs = Date.now() - retryStart;
pauseLoop = false;
check("re-basing regression: repeated input pauses do not extend the absolute job deadline (job-timeout at the one budget)",
  done.last?.phase === "failed" && done.last?.error?.code === "job-timeout"
  && pauseResolutions >= 3 && retryElapsedMs >= 2000 && retryElapsedMs < 12000,
  JSON.stringify({ error: done?.last?.error, pauses: pauseResolutions, elapsedMs: retryElapsedMs }));
check("re-basing regression: the bounded job ends once, releasing the fence and removing staging",
  done.last?.blocked === null && stagingDirs(repoFault).length === 0
  && managerInputRetry.isBusy(repoFault) === false && readWikiTitle(repoFault) === "Fault Old Wiki",
  JSON.stringify({ blocked: done?.last?.blocked, staging: stagingDirs(repoFault), active: view(managerInputRetry, repoFault).active }));

// 14e. 到期 + worker 停不下来：沿用既有隔离路径，保留暂存与栅栏，绝不删除。
resetFaultWiki("Fault Old Wiki");
env.events.length = 0;
env.ignoreCancel = true;
env.behavior = (agent) => { agent.pendingInput = ["approval"]; agent.status = "running"; };
start(managerInput, repoFault);
const stuckDeadline = Date.now() + 20000;
let stuckView = view(managerInput, repoFault);
while (Date.now() < stuckDeadline && !stuckView.last?.blocked) {
  await sleep(40);
  stuckView = view(managerInput, repoFault);
}
const stuckAgent = lastAgent();
check("input timeout: a worker that cannot be proven stopped quarantines the job and keeps staging + fence",
  stuckView.last?.phase === "failed" && stuckView.last?.blocked?.reason === "worker-not-stopped"
  && stuckView.last?.error?.code === "worker-not-stopped"
  && stagingDirs(repoFault).length === 1
  && view(managerInput, repoFault).active?.blocked?.reason === "worker-not-stopped"
  && managerInput.isBusy(repoFault) === true && stuckAgent?.status === "running",
  JSON.stringify({ last: stuckView?.last, active: view(managerInput, repoFault).active, staging: stagingDirs(repoFault), status: stuckAgent?.status }));
stuckAgent.status = "idle";
env.ignoreCancel = false;
const inputRelease = managerInput.cancel(repoFault);
check("input timeout: the quarantine release path still applies once the worker is gone",
  inputRelease.canceled === false && inputRelease.quarantine === true, JSON.stringify(inputRelease));
const inputReleaseDeadline = Date.now() + 5000;
let inputReleased = null;
while (Date.now() < inputReleaseDeadline) {
  inputReleased = view(managerInput, repoFault);
  if (!inputReleased.active) break;
  await sleep(40);
}
check("input timeout: after release the fence is free and staging removed (nothing deleted while unproven)",
  inputReleased && !inputReleased.active && stagingDirs(repoFault).length === 0,
  JSON.stringify({ active: inputReleased?.active, staging: stagingDirs(repoFault) }));

// ---------- 15. 绝对预算：一个 deadlineAt 覆盖 worker 之后的宿主阶段；清理有独立预算 ----------
// 缺陷（第三遍 review，D 部分）：T031 的 deadlineAt 只监督 worker/启动/输入。runBuilder 仍用自己的
// timeoutMs，worker 之后的 assemble/validate/build/selfcheck/preserve/publish 完全没有 deadline 闸门——
// worker 恰好在截止时间之前完成，仍然可以在截止时间之后发布。下面的假 builder（不跑 python）记录每次
// 调用拿到的超时，用小的注入预算证明 (a)–(e)；全部是毫秒级注入值，没有分钟级等待。
const budgetLog = [];
let budgetHold = null; // { command, extraMs }：让假 builder 用满它拿到的（已被 cap 的）超时
let contentGateCalls = 0;
// resolve-config 的 stdout 是完整有效配置（worker-protocol 会逐字段校验）。
const BUDGET_EFFECTIVE = {
  language: "en", granularity: "theme", pages: { min: 6, max: 40 }, tree: { maxChildren: 8, maxDepth: 4 },
  wordsPerPage: [400, 900], diagrams: "minimal", citations: "strict", skeleton: { knownIssues: true },
};
const budgetBuilder = async (job, args, timeoutMs) => {
  budgetLog.push({ command: args[0], timeoutMs, remaining: job.deadlineAt - Date.now() });
  if (args[0] === "assemble") {
    // 真 assemble 的替代：Host 的 wiki.json 由这里写出（worker 只写 pages）。
    writeFileSync(path.join(job.stageDir, "wiki.json"), JSON.stringify({
      schema: "repo-wiki-local/1", repoId: job.root, language: "en", title: "Budget Wiki",
      pages: [{ id: "p1", parentId: null, order: 1, title: "P1", description: "d", filePaths: [], markdown: "# P1\n\nBody." }],
    }));
  }
  if (budgetHold?.command === args[0]) await sleep(timeoutMs + budgetHold.extraMs);
  if (args[0] === "resolve-config") return { ok: true, code: 0, output: "", stdout: JSON.stringify(BUDGET_EFFECTIVE) };
  return { ok: true, code: 0, output: "", stdout: "" };
};
const budgetContentGate = () => { contentGateCalls += 1; return { ok: true }; };
const budgetConfig = (overrides = {}) => configOf({
  runBuilder: budgetBuilder,
  contentGate: budgetContentGate,
  buildTimeoutMs: 120000,
  selfcheckTimeoutMs: 120000,
  ...overrides,
});

// (e) 正常路径不受新增闸门影响：预算充足时每个宿主阶段都真的跑过，并且照常发布。
const managerBudgetOk = createJobManager(budgetConfig({ jobTimeoutMs: 20000 }));
resetFaultWiki("Fault Old Wiki");
budgetLog.length = 0;
budgetHold = null;
env.events.length = 0;
env.behavior = (agent, stage) => {
  writeCandidate(stage, agent.root);
  agent.events.push({ type: "turn/end", seq: agent.events.length + 1, data: { turn: 1, reason: { kind: "completed" } } });
  agent.status = "idle";
};
start(managerBudgetOk, repoFault);
done = await waitJob(managerBudgetOk, repoFault, (last) => last && last.phase !== "running", 20000);
const okCommands = budgetLog.map((entry) => entry.command);
check("budget: a job with a sufficient budget still runs every Host phase and publishes",
  done.last?.phase === "done" && done.last?.published === true
  && readWikiTitle(repoFault) === "Budget Wiki" && stagingDirs(repoFault).length === 0
  && ["resolve-config", "assemble", "build", "selfcheck"].every((command) => okCommands.includes(command)),
  JSON.stringify({ last: done?.last, commands: okCommands, title: readWikiTitle(repoFault) }));

// (b) 每次 builder 调用的超时都是“剩余预算”，不是它自己的 buildTimeoutMs（注入值 120000）。
check("budget: builder calls are capped by the remaining job budget, not by buildTimeoutMs",
  budgetLog.length > 0
  && budgetLog.every((entry) => entry.timeoutMs >= 1 && entry.timeoutMs <= entry.remaining + 5 && entry.timeoutMs < 120000)
  && budgetLog.find((entry) => entry.command === "resolve-config")?.timeoutMs < 20000,
  JSON.stringify(budgetLog));

// (a)/(2) 慢配置：配置用满整个预算之后，作业拒绝继续，而不是带着 journal/暂存状态变成晚到的 startup-timeout。
resetFaultWiki("Fault Old Wiki");
budgetLog.length = 0;
env.events.length = 0;
env.behavior = () => { /* 挂起：慢配置场景根本走不到 worker */ };
const managerBudgetConfig = createJobManager(budgetConfig({ jobTimeoutMs: 700 }));
const sessionsBeforeConfig = env.sessions.size;
budgetHold = { command: "resolve-config", extraMs: 30 };
start(managerBudgetConfig, repoFault);
done = await waitJob(managerBudgetConfig, repoFault, (last) => last && last.phase !== "running", 20000);
budgetHold = null;
const configRecord = await journalStore.load(repoFault);
check("budget: a configuration step that consumes the whole budget is cut off and the job refuses to continue",
  done.last?.phase === "failed" && done.last?.error?.code === "job-timeout"
  && budgetLog.length === 1 && budgetLog[0].command === "resolve-config"
  && budgetLog[0].timeoutMs <= budgetLog[0].remaining + 5 && budgetLog[0].timeoutMs < 120000
  && stagingDirs(repoFault).length === 0 && env.sessions.size === sessionsBeforeConfig
  && (configRecord === null || configRecord.record.jobId !== done.last?.id),
  JSON.stringify({ last: done?.last, calls: budgetLog, staging: stagingDirs(repoFault), record: configRecord?.record?.jobId ?? null }));
check("budget: the slow-configuration job left no staging, no session and no fence behind",
  stagingDirs(repoFault).length === 0 && managerBudgetConfig.isBusy(repoFault) === false
  && readWikiTitle(repoFault) === "Fault Old Wiki",
  JSON.stringify({ staging: stagingDirs(repoFault), busy: managerBudgetConfig.isBusy(repoFault), title: readWikiTitle(repoFault) }));

// (a)/(c) worker 恰在截止时间之前完成：assemble 用满剩余预算（跨过 deadline），随后的宿主阶段被拒绝，
// 作业绝不能在截止时间之后继续 validate/build/selfcheck/preserve/publish。
resetFaultWiki("Fault Old Wiki");
budgetLog.length = 0;
env.events.length = 0;
const gateCallsBeforeOverrun = contentGateCalls;
env.behavior = (agent, stage) => {
  writeCandidate(stage, agent.root);
  agent.events.push({ type: "turn/end", seq: agent.events.length + 1, data: { turn: 1, reason: { kind: "completed" } } });
  agent.status = "idle";
};
const managerBudgetPost = createJobManager(budgetConfig({ jobTimeoutMs: 1500 }));
budgetHold = { command: "assemble", extraMs: 30 };
start(managerBudgetPost, repoFault);
done = await waitJob(managerBudgetPost, repoFault, (last) => last && last.phase !== "running", 20000);
budgetHold = null;
const overrunCommands = budgetLog.map((entry) => entry.command);
const assembleCall = budgetLog.find((entry) => entry.command === "assemble");
check("budget: a phase whose remaining budget is gone is refused instead of overrunning the deadline",
  done.last?.phase === "failed" && done.last?.error?.code === "job-timeout"
  && contentGateCalls === gateCallsBeforeOverrun
  && !overrunCommands.includes("build") && !overrunCommands.includes("selfcheck")
  && typeof assembleCall === "object",
  JSON.stringify({ last: done?.last, commands: overrunCommands, gateCalls: contentGateCalls - gateCallsBeforeOverrun }));
check("budget: the assemble call itself was capped by the remaining budget (not by buildTimeoutMs)",
  typeof assembleCall === "object" && assembleCall.timeoutMs <= 1500
  && assembleCall.timeoutMs <= assembleCall.remaining + 5 && assembleCall.timeoutMs < 120000,
  JSON.stringify(budgetLog));
check("budget: a worker that finishes just inside the deadline cannot publish after it",
  done.last?.published === false && readWikiTitle(repoFault) === "Fault Old Wiki"
  && stagingDirs(repoFault).length === 0 && backupDirs(repoFault).length === 0
  && managerBudgetPost.isBusy(repoFault) === false,
  JSON.stringify({ last: done?.last, title: readWikiTitle(repoFault), staging: stagingDirs(repoFault), busy: managerBudgetPost.isBusy(repoFault) }));

// (d) 终止/清理的独立预算：执行预算已经过期，worker 仍然必须被真正停下；停不下来时按既有隔离语义
// 保留暂存与栅栏（绝不删除）。清理预算（cleanupTimeoutMs）大于执行预算，所以“过期”不会截断清理。
resetFaultWiki("Fault Old Wiki");
env.events.length = 0;
env.ignoreCancel = false;
env.behavior = () => { /* 一直 running：只有超时能结束 */ };
const managerBudgetCleanup = createJobManager(budgetConfig({ jobTimeoutMs: 450, cleanupTimeoutMs: 1200, disposeTimeoutMs: 1200 }));
const cleanupStart = Date.now();
start(managerBudgetCleanup, repoFault);
done = await waitJob(managerBudgetCleanup, repoFault, (last) => last && last.phase !== "running", 20000);
const cleanupElapsedMs = Date.now() - cleanupStart;
check("cleanup: termination completes after the execution budget is already exhausted (worker stopped, staging removed)",
  done.last?.phase === "failed" && done.last?.error?.code === "job-timeout"
  && env.events.includes("cancel") && lastAgent()?.status !== "running"
  && stagingDirs(repoFault).length === 0 && readWikiTitle(repoFault) === "Fault Old Wiki"
  && managerBudgetCleanup.isBusy(repoFault) === false && cleanupElapsedMs >= 400,
  JSON.stringify({ last: done?.last, elapsedMs: cleanupElapsedMs, status: lastAgent()?.status, staging: stagingDirs(repoFault) }));

// 停不下来的 worker：清理预算照常跑满（长于执行预算），结果仍是隔离——保留暂存与栅栏，绝不删除。
resetFaultWiki("Fault Old Wiki");
env.events.length = 0;
env.ignoreCancel = true;
env.behavior = () => { /* running 且 cancel 被忽略 */ };
const stuckCleanupStart = Date.now();
start(managerBudgetCleanup, repoFault);
let stuckCleanupView = view(managerBudgetCleanup, repoFault);
const stuckCleanupDeadline = Date.now() + 20000;
while (Date.now() < stuckCleanupDeadline && !stuckCleanupView.last?.blocked) {
  await sleep(40);
  stuckCleanupView = view(managerBudgetCleanup, repoFault);
}
const stuckCleanupElapsedMs = Date.now() - stuckCleanupStart;
const stuckCleanupAgent = lastAgent();
check("cleanup: an expired job whose worker cannot be proven stopped quarantines instead of deleting (cleanup budget outlives the execution budget)",
  stuckCleanupView.last?.phase === "failed"
  && stuckCleanupView.last?.error?.code === "worker-not-stopped"
  && stuckCleanupView.last?.blocked?.reason === "worker-not-stopped"
  && stagingDirs(repoFault).length === 1 && stuckCleanupAgent?.status === "running"
  && managerBudgetCleanup.isBusy(repoFault) === true
  && stuckCleanupElapsedMs >= 1400,
  JSON.stringify({ last: stuckCleanupView?.last, elapsedMs: stuckCleanupElapsedMs, staging: stagingDirs(repoFault), status: stuckCleanupAgent?.status }));
stuckCleanupAgent.status = "idle";
env.ignoreCancel = false;
const budgetRelease = managerBudgetCleanup.cancel(repoFault);
check("cleanup: the quarantine release path still applies once the worker is gone",
  budgetRelease.canceled === false && budgetRelease.quarantine === true, JSON.stringify(budgetRelease));
const budgetReleaseDeadline = Date.now() + 5000;
let budgetReleased = null;
while (Date.now() < budgetReleaseDeadline) {
  budgetReleased = view(managerBudgetCleanup, repoFault);
  if (!budgetReleased.active) break;
  await sleep(40);
}
check("cleanup: after release the fence is free and staging removed (nothing deleted while unproven)",
  budgetReleased && !budgetReleased.active && stagingDirs(repoFault).length === 0,
  JSON.stringify({ active: budgetReleased?.active, staging: stagingDirs(repoFault) }));

// ---------- 16. 内容闸门的建议性 warning：可见（warn 通道）且无害（不改发布/journal/暂存/栅栏） ----------
// 缺陷：applyContentGate 只读 ok/failures，coverage-inventory 这类 warnings 被算出来就丢掉——操作者永远看不到。
// 这里注入**真** evaluateContentGate（真判定、真 warning），假 builder 只写候选 wiki.json：
// (a) 通过的闸门缺计数清单 => 恰好一条 coverage-inventory warning 走 logger.warn，作业照常发布；
// (b) 根页面带真清单 => 一条 warning 都没有（同一条发布路径）；
// (c) 失败的闸门照旧因自己的分类失败，warning 只排在 failures 之后，既不遮蔽也不重排；
// (d) warning 路径不改 published、journal phase、暂存与栅栏。
const GATE_EFFECTIVE = {
  language: "en", granularity: "theme", pages: { min: 2, max: 100 }, tree: { maxChildren: 8, maxDepth: 4 },
  wordsPerPage: [100, 5000], diagrams: "none", citations: "relaxed", skeleton: { knownIssues: false },
};
// 与 tools/jobs-worker-test.mjs 的 INVENTORY_TABLE 同形：3 条“目录 + 计数”表格行才够 MIN_INVENTORY_ENTRIES。
const GATE_INVENTORY = [
  "## Directory inventory",
  "",
  "| Directory | Files |",
  "|---|---|",
  "| `specs/` | 50,605 |",
  "| `plugins/dsh-wiki` | 1,234 |",
  "| `docs` | 67 files |",
].join("\n");
const gateProse = Array.from({ length: 60 }, () => "lorem ipsum dolor sit amet").join(" "); // 300 words, well inside wordsPerPage
const gatePage = (id, parentId, order, title, markdown) => ({ id, parentId, order, title, description: "d", filePaths: [], markdown });
const gatePages = (rootMarkdown) => [
  gatePage("p1", null, 1, "Repository Map", `# Repository Map\n\n${rootMarkdown}\n\nSee \`lib/jobs.js\`.\n`),
  gatePage("p2", "p1", 2, "Tooling", `# Tooling\n\n${gateProse}\n\nSee \`lib/jobs.js\`.\n`),
];
// 每个用例一个新 manager + 真 evaluateContentGate；假 builder 让 assemble 写出给定的候选 wiki（不跑 python）。
const gateRun = async (pages) => {
  const builder = async (job, args) => {
    if (args[0] === "assemble") {
      writeFileSync(path.join(job.stageDir, "wiki.json"),
        JSON.stringify({ schema: "repo-wiki-local/1", repoId: job.root, language: "en", title: "Gate Wiki", pages }));
    }
    if (args[0] === "resolve-config") return { ok: true, code: 0, output: "", stdout: JSON.stringify(GATE_EFFECTIVE) };
    return { ok: true, code: 0, output: "", stdout: "" };
  };
  const gateManager = createJobManager(configOf({ runBuilder: builder, contentGate: evaluateContentGate, jobTimeoutMs: 20000 }));
  resetFaultWiki("Fault Old Wiki");
  env.events.length = 0;
  env.behavior = (agent, stage) => {
    writeCandidate(stage, agent.root);
    agent.events.push({ type: "turn/end", seq: agent.events.length + 1, data: { turn: 1, reason: { kind: "completed" } } });
    agent.status = "idle";
  };
  start(gateManager, repoFault);
  const finished = await waitJob(gateManager, repoFault, (last) => last && last.phase !== "running", 20000);
  // 只看闸门自己的 warn 行：别的 warn（例如 replaceTerminal 的 retained 提示）不参与断言。
  const warns = env.events.filter((event) => typeof event === "string" && event.startsWith("warn:") && event.includes("content gate"));
  const record = await journalStore.load(repoFault);
  return {
    last: finished?.last, warns, journalPhase: record?.record?.phase ?? null,
    staging: stagingDirs(repoFault), backups: backupDirs(repoFault), busy: gateManager.isBusy(repoFault), title: readWikiTitle(repoFault),
  };
};

// (a) 通过的闸门 + 缺清单：恰好一条 coverage-inventory warning，且作业照常发布。
const gateNoInventory = await gateRun(gatePages(gateProse));
const missingInventoryWarns = gateNoInventory.warns.filter((event) => event.includes("[coverage-inventory]"));
check("content gate warning: a passing gate whose wiki lacks the inventory emits exactly one coverage-inventory warning on the warn channel",
  gateNoInventory.last?.phase === "done" && gateNoInventory.last?.published === true
  && missingInventoryWarns.length === 1
  && missingInventoryWarns[0].startsWith("warn:dsh-wiki: content gate advisory")
  && missingInventoryWarns[0].includes("carry no counted directory inventory"),
  JSON.stringify({ phase: gateNoInventory.last?.phase, published: gateNoInventory.last?.published, warns: gateNoInventory.warns }));

// (b) 同一份 wiki 加上真清单：一条 warning 都没有，发布路径不变。
const gateInventory = await gateRun(gatePages(`${GATE_INVENTORY}\n\n${gateProse}`));
check("content gate warning: a root page with a counted directory inventory emits no warning and the job still publishes",
  gateInventory.last?.phase === "done" && gateInventory.last?.published === true
  && gateInventory.warns.length === 0 && gateInventory.title === "Gate Wiki",
  JSON.stringify({ phase: gateInventory.last?.phase, published: gateInventory.last?.published, warns: gateInventory.warns, title: gateInventory.title }));

// (c) 失败的闸门：自己的 failures 先报、warning 垫后，绝不遮蔽/重排，公开投影里也没有分类细节。
const gateFailed = await gateRun([
  gatePage("p1", null, 1, "Repository Map", "# Repository Map\n\nshort page.\n\nSee `lib/jobs.js`.\n"),
]);
check("content gate warning: a failing gate still fails for its own failures, with the advisory emitted only after them",
  gateFailed.last?.phase === "failed" && gateFailed.last?.published === false
  && gateFailed.last?.error?.code === "content-gate-failed"
  && gateFailed.last?.error?.message === PUBLIC_ERROR_MESSAGES["content-gate-failed"]
  && gateFailed.warns.length === 3
  && gateFailed.warns[0].includes("refused") && gateFailed.warns[0].includes("[words-below-min]")
  && gateFailed.warns[1].includes("refused") && gateFailed.warns[1].includes("[page-count]")
  && gateFailed.warns[2].includes("advisory") && gateFailed.warns[2].includes("[coverage-inventory]")
  && !JSON.stringify(gateFailed.last).includes("words-below-min"),
  JSON.stringify({ phase: gateFailed.last?.phase, error: gateFailed.last?.error, warns: gateFailed.warns }));

// (d) warning 路径与无 warning 的通过路径在 published/journal/暂存/栅栏上完全一致；失败路径仍走 aborted。
check("content gate warning: the advisory path changes neither published, the journal phase, staging nor the fence",
  gateNoInventory.last?.published === true && gateInventory.last?.published === true
  && gateNoInventory.journalPhase === "published" && gateInventory.journalPhase === "published"
  && gateNoInventory.staging.length === 0 && gateInventory.staging.length === 0
  && gateNoInventory.backups.length === 0 && gateInventory.backups.length === 0
  && gateNoInventory.busy === false && gateInventory.busy === false
  && gateNoInventory.last?.blocked === null && gateInventory.last?.blocked === null
  && gateFailed.journalPhase === "aborted" && gateFailed.staging.length === 0 && gateFailed.busy === false,
  JSON.stringify({
    noInventory: { published: gateNoInventory.last?.published, journal: gateNoInventory.journalPhase, staging: gateNoInventory.staging, busy: gateNoInventory.busy, blocked: gateNoInventory.last?.blocked },
    inventory: { published: gateInventory.last?.published, journal: gateInventory.journalPhase, staging: gateInventory.staging, busy: gateInventory.busy, blocked: gateInventory.last?.blocked },
    failed: { journal: gateFailed.journalPhase, staging: gateFailed.staging, busy: gateFailed.busy },
  }));

// ---------- 17. 卸载取消插件拥有的作业 ----------
env.behavior = () => { /* 挂起 */ };
start(managerShort, repoFault);
await waitActiveSession(managerShort, repoFault);
await managerShort.dispose();
check("dispose() cancels the owned agent", lastAgent()?.cancelCause?.kind === "user",
  JSON.stringify({ agent: lastAgent()?.id, cause: lastAgent()?.cancelCause, events: env.events.slice(-6) }));
const afterDispose = startErr(managerShort, repoFault);
check("after dispose, new jobs are refused (503 plugin-unloaded)",
  afterDispose?.status === 503 && afterDispose?.code === "plugin-unloaded", JSON.stringify({ status: afterDispose?.status, code: afterDispose?.code }));

// ---------- 18. 请求体：字节有界，**时间**也有界 ----------
// 缺陷：`for await (const chunk of req)` 只受字节上限约束，客户端发一个分片就停住会永远等下去，
// 把处理函数和它的 socket 一起钉住。现在超时返回 408（`abandoned: true`），晚到的分片既不会复活
// 这次读取也不会变成 unhandled rejection；正常请求体照旧解析。
// 约定：读取器本身**不再** destroy 请求。关闭 socket 归调用方，而且必须在响应 flush **之后**
// （lib/index.js 的 closeAfterResponse）：在同一个 socket 上写 413/408 的响应体之前 destroy，
// chunked 请求（没有 content-length）的对端拿到的是 ECONNRESET 而不是响应体。因此本节多处断言
// `destroyed === false` 是**新的契约**，不是回归——不要把它“修”回去。
{
  const { Readable } = await import("node:stream");

  const jsonRequest = (body, headers = { "content-type": "application/json" }) => {
    const req = Readable.from([Buffer.from(body, "utf8")]);
    req.headers = headers;
    return req;
  };

  const good = await readBoundedJson(jsonRequest(JSON.stringify({ root: repo, confirm: "execute-recovery" })));
  check("readBoundedJson: a normal body still parses",
    good.ok === true && good.value?.root === repo && good.value?.confirm === "execute-recovery", JSON.stringify(good));

  // The production deadline timer is unref()'d on purpose (it must never hold the process open), so in
  // this synthetic stream — which has no socket handle keeping the loop alive as a real request would —
  // the test holds the loop itself while awaiting. This does not mask a hang: the assertion below has
  // its own upper bound (elapsed < 2000ms) and the process would otherwise exit on an unsettled await.
  const keepAlive = async (promise) => {
    const ticker = setInterval(() => {}, 1000);
    try { return await promise; } finally { clearInterval(ticker); }
  };

  // 一个只发一个小分片、然后永不 end 的流：必须在 (大约) 50ms 内返回 408，而不是一直挂住。
  const stalled = new Readable({
    read() { /* never push: one chunk was pushed below and the stream is then silent forever */ },
  });
  stalled.headers = { "content-type": "application/json" };
  stalled.push(Buffer.from('{"root":', "utf8"));
  let destroyed = false;
  const realDestroy = stalled.destroy.bind(stalled);
  stalled.destroy = (...args) => { destroyed = true; return realDestroy(...args); };
  const startedAt = Date.now();
  const timedOut = await keepAlive(readBoundedJson(stalled, 32 * 1024, { timeoutMs: 50 }));
  const elapsed = Date.now() - startedAt;
  check("readBoundedJson: a stalled body resolves 408 within roughly the deadline (never hangs)",
    timedOut.ok === false && timedOut.status === 408 && timedOut.error === "request body was not received in time"
    && elapsed >= 40 && elapsed < 2000,
    `${JSON.stringify(timedOut)} in ${elapsed}ms`);
  // 反向断言（新契约，见本节开头）：读取器**不** destroy 请求，socket 由调用方在响应 flush 之后关闭。
  check("readBoundedJson: a timed-out read is abandoned (abandoned:true) and leaves the socket to the caller",
    timedOut.abandoned === true && destroyed === false, `${JSON.stringify(timedOut)} destroyed=${destroyed}`);

  // 超时之后才到的分片：读取已经结算，迟到的 chunk 不得复活 Promise，也不得成为 unhandled rejection。
  let lateTrouble = null;
  const onLate = (reason) => { lateTrouble = reason; };
  process.on("unhandledRejection", onLate);
  const late = new Readable({ read() {} });
  late.headers = { "content-type": "application/json" };
  const lateResult = await keepAlive(readBoundedJson(late, 32 * 1024, { timeoutMs: 20 }));
  late.push(Buffer.from('{"root":"late"}', "utf8")); // arrives after the timeout already returned
  await sleep(30);
  process.off("unhandledRejection", onLate);
  check("readBoundedJson: a chunk arriving after the timeout neither revives the read nor throws",
    lateResult.ok === false && lateResult.status === 408 && lateTrouble === null,
    `${JSON.stringify(lateResult)} unhandled=${lateTrouble === null ? "none" : String(lateTrouble)}`);

  // 既有行为不变：空体 / 非 JSON / 非法 JSON / 超大字节数。
  check("readBoundedJson: existing refusals are unchanged (empty, non-JSON, too large)",
    (await readBoundedJson(jsonRequest("   "))).status === 400
    && (await readBoundedJson(jsonRequest("{nope"))).status === 400
    && (await readBoundedJson(jsonRequest("x".repeat(40)), 16)).status === 413
    // declared content-length over the limit is refused before the body is read at all
    && (await readBoundedJson({ headers: { "content-length": "9999" } }, 16)).status === 413,
    "empty=400 nonJSON=400 oversized=413 declared-oversized=413");

  // 回归（review 实测缺陷 A）：`iterator.next()` 只承诺返回“像 promise 的东西”。返回**普通对象**
  // （没有 .then）时旧实现的 `.then(...)` 抛 TypeError；返回一个 then 返回 undefined 的外来 thenable
  // 时竞速结算成 undefined，下一行 `step.kind` 再从函数里抛出（review 实测 `null THREW TypeError…`）。
  // 契约：失败必须 **return** { ok:false, status:400 }，绝不 throw。这里的 throw 被捕获成断言细节——
  // 绝不让一个拒绝的 promise 逃出测试，否则整轮 harness 会被 unhandled rejection 杀掉而不是出一条 FAIL。
  {
    const oddRequest = (nextImpl) => ({
      headers: { "content-type": "application/json" },
      [Symbol.asyncIterator]() {
        return { next: nextImpl, return() { return Promise.resolve({ done: true }); } };
      },
    });
    const cases = [
      ["null from next()", () => null, 400, "request body could not be read"],
      ["a plain object with no .then", () => ({}), 400, "request body could not be read"],
      // then 返回 undefined 的外来 thenable 永远不会结算：读取器只能用期限结束它（408），同样不得 throw。
      ["a foreign thenable whose then returns undefined", () => ({ then() { /* never settles */ } }), 408, "request body was not received in time"],
    ];
    const seen = [];
    let threw = null;
    let allMatched = true;
    for (const [label, nextImpl, status, error] of cases) {
      let out = null;
      try {
        out = await keepAlive(readBoundedJson(oddRequest(nextImpl), 32 * 1024, { timeoutMs: 15 }));
      } catch (e) {
        threw = `${label} THREW ${String(e)}`;
      }
      seen.push({ label, status: out?.status ?? null, error: out?.error ?? null, abandoned: out?.abandoned ?? null, threw });
      if (threw !== null || out?.ok !== false || out?.status !== status || out?.error !== error || out?.abandoned !== true) {
        allMatched = false;
      }
    }
    check("readBoundedJson: a next() returning a plain object or a foreign thenable is a returned refusal, never a throw",
      threw === null && allMatched, JSON.stringify({ threw, seen }));
  }

  // 回归（review 实测缺陷 B）：一个 null/undefined 分片、一个普通对象、或一个 `length` getter 会抛的
  // 分片，旧实现直接在 `buf.length` 上抛出去（review 实测 `throwlen THREW 1`）。只接受 Node 流真正
  // 会产出的 Buffer / Uint8Array / string，其余一律走与超时、溢出相同的 400 放弃路径（abandoned:true）。
  {
    const chunkRequest = (value) => ({
      headers: { "content-type": "application/json" },
      [Symbol.asyncIterator]() {
        let sent = false;
        return {
          next() {
            if (sent) return Promise.resolve({ done: true, value: undefined });
            sent = true;
            return Promise.resolve({ done: false, value });
          },
          return() { return Promise.resolve({ done: true }); },
        };
      },
    });
    const throwingLength = {};
    Object.defineProperty(throwingLength, "length", { get() { throw 1; }, enumerable: true, configurable: true });
    // 这一例是“类型正确但 length 访问器会抛”的分片：它必须走到被兜住的那次读取，而不是靠类型判断绕过。
    const hostileBuffer = Buffer.from("ab", "utf8");
    Object.defineProperty(hostileBuffer, "length", { get() { throw 1; }, configurable: true });
    const prettyJson = Buffer.from('{"root":"x"}', "utf8");
    const cases = [
      ["null chunk", null],
      ["undefined chunk", undefined],
      ["a plain object with a throwing length getter", throwingLength],
      ["a Buffer whose own length getter throws", hostileBuffer],
      ["a thenable chunk", { then() { return undefined; } }],
      // 正向对照：合法的 Buffer 分片仍照常解析（这条防止“一律 400”把正常读取也堵死）。
      ["a real Buffer chunk (control)", prettyJson],
    ];
    const seen = [];
    let threw = null;
    let allMatched = true;
    for (const [label, value] of cases) {
      let out = null;
      try {
        out = await keepAlive(readBoundedJson(chunkRequest(value), 32 * 1024, { timeoutMs: 50 }));
      } catch (e) {
        threw = `${label} THREW ${String(e)}`;
      }
      seen.push({ label, ok: out?.ok ?? null, status: out?.status ?? null, error: out?.error ?? null, abandoned: out?.abandoned ?? null, threw });
      const control = label.startsWith("a real Buffer chunk");
      const okCase = control
        ? out?.ok === true && out?.value?.root === "x"
        : out?.ok === false && out?.status === 400 && out?.error === "request body could not be read" && out?.abandoned === true;
      if (threw !== null || !okCase) allMatched = false;
    }
    check("readBoundedJson: a null/odd chunk or a throwing length getter is a returned 400, never a throw",
      threw === null && allMatched, JSON.stringify({ threw, seen }));
  }

  // 回归（review 实测缺陷）：溢出路径曾 `await iterator.return()`，不在期限竞速里。一个永不结算的
  // return() 于是把整个读取挂住——期限只结算了它自己的竞速，没人观察它，函数再也不返回、调用方也
  // 永远拿不到结果（review 实测：2 字节对 1 字节上限 => "STILL PENDING destroyed false"）。
  // 现在溢出路径**不等待**清理：必须在很小的上限内返回 413；响应体仍要由调用方写出，所以这里同样
  // 断言读取器没有 destroy 请求（`destroyed === false` 是新契约）。
  {
    let overflowDestroyed = false;
    const hanging = {
      headers: { "content-type": "application/json" },
      destroy() { overflowDestroyed = true; },
      [Symbol.asyncIterator]() {
        let sent = false;
        return {
          next() {
            if (sent) return new Promise(() => {}); // 溢出之后绝不会再被读到
            sent = true;
            return Promise.resolve({ done: false, value: Buffer.from("ab", "utf8") });
          },
          return() { return new Promise(() => {}); }, // 永久 pending 的清理
        };
      },
    };
    const overflowStart = Date.now();
    const overflow = await keepAlive(readBoundedJson(hanging, 1, { timeoutMs: 15 }));
    const overflowElapsed = Date.now() - overflowStart;
    check("readBoundedJson: an oversize body whose iterator return() never settles still resolves 413 with abandoned:true and leaves the socket to the caller",
      overflow.ok === false && overflow.status === 413 && overflow.error === "request body exceeds 1 bytes"
      && overflow.abandoned === true
      && overflowElapsed < 500 && overflowDestroyed === false,
      `${JSON.stringify(overflow)} in ${overflowElapsed}ms destroyed=${overflowDestroyed}`);
  }

  // 停止等待之后才拒绝的清理 promise 不得变成 unhandled rejection：拒绝处理器在停止等待的那一刻挂上。
  {
    const rejections = [];
    const onRejection = (reason) => { rejections.push(reason); };
    process.on("unhandledRejection", onRejection);
    let rejectDestroyed = false;
    const lateReject = {
      headers: { "content-type": "application/json" },
      destroy() { rejectDestroyed = true; },
      [Symbol.asyncIterator]() {
        let sent = false;
        return {
          next() {
            if (sent) return new Promise(() => {});
            sent = true;
            return Promise.resolve({ done: false, value: Buffer.from("ab", "utf8") });
          },
          // 稍后才拒绝：读取早已返回 413，所以要越过 Node 的 unhandledRejection 检查点。
          return() { return new Promise((_resolve, reject) => { setTimeout(() => reject(new Error("cleanup failed")), 5); }); },
        };
      },
    };
    const lateRejectResult = await keepAlive(readBoundedJson(lateReject, 1, { timeoutMs: 15 }));
    await sleep(60); // 越过 unhandledRejection 的检查点（在下一个 tick 之后触发）
    process.off("unhandledRejection", onRejection);
    check("readBoundedJson: a cleanup promise that rejects after overflow still yields 413 with abandoned:true, no unhandled rejection and no reader-side destroy",
      lateRejectResult.ok === false && lateRejectResult.status === 413 && lateRejectResult.abandoned === true
      && rejectDestroyed === false && rejections.length === 0,
      `${JSON.stringify(lateRejectResult)} destroyed=${rejectDestroyed} unhandled=${rejections.length ? String(rejections[0]) : "none"}`);
  }

  // 绝对期限：到期的时钟只创建一次，到达的分片绝不重置它（review 实测 5ms/分片 + 40ms 期限 ≈46ms 返回 408）。
  {
    let dripDestroyed = false;
    const drip = {
      headers: { "content-type": "application/json" },
      destroy() { dripDestroyed = true; },
      [Symbol.asyncIterator]() {
        return {
          async next() {
            await sleep(5); // 每 5ms 一个 1 字节分片：远低于字节上限，只有时间能结束它
            return { done: false, value: Buffer.from("{", "utf8") };
          },
          return() { return Promise.resolve({ done: true }); },
        };
      },
    };
    const dripStart = Date.now();
    const dripResult = await keepAlive(readBoundedJson(drip, 32 * 1024, { timeoutMs: 40 }));
    const dripElapsed = Date.now() - dripStart;
    check("readBoundedJson: a slow drip under the byte cap still hits the absolute deadline (408, abandoned:true, socket left to the caller)",
      dripResult.ok === false && dripResult.status === 408
      && dripResult.error === "request body was not received in time"
      && dripResult.abandoned === true
      && dripElapsed >= 30 && dripElapsed < 500 && dripDestroyed === false,
      `${JSON.stringify(dripResult)} in ${dripElapsed}ms destroyed=${dripDestroyed}`);
  }

  // 回归（review 实测缺陷，OOM）：`next()` 每次立刻结算、每次只给**零字节**分片的迭代器会让循环完全
  // 停在微任务里——宏任务上的期限定时器回调永远轮不到，字节上限也永远不触发（零字节不进 chunks）。
  // 旧实现因此永不返回，只能靠看门狗 SIGTERM。能结束它的只有每轮迭代的**同步** elapsed 检查。
  // 这个 fixture 不允许把测试写成会 OOM 的形状：CAP 让 fixture 自己停下（done:true）。
  // CAP 取得足够大——正确实现一定先撞到 20ms 期限（本机实测 20ms 内 5.7k–25k 次迭代，CAP=200_000
  // 有 ~8x 余量），又足够小——坏掉的实现即使把每次迭代的零字节分片都累积下来也只是几十 MB 就收场，
  // 回归因此表现为一条失败断言，而不是进程被 OOM 杀掉（没有同步检查时 fixture 会以 done:true 结束，
  // 空体走 400，断言照样失败）。堆用量不做断言：它受 GC 时机影响，波动的数字只会让测试变脆；
  // 真正防 OOM 的是 CAP，而不是一个堆阈值。
  {
    const CAP = 200_000;
    let iterations = 0;
    const starving = {
      headers: { "content-type": "application/json" },
      destroy() { /* 读取器不得 destroy（新契约），这里只证明它没被调用 */ },
      [Symbol.asyncIterator]() {
        return {
          next() {
            iterations += 1;
            // fixture 自限：坏掉的实现也必须在 CAP 次迭代后拿到 done:true 而收场。
            if (iterations >= CAP) return Promise.resolve({ done: true, value: undefined });
            return Promise.resolve({ done: false, value: Buffer.alloc(0) });
          },
          return() { return Promise.resolve({ done: true }); },
        };
      },
    };
    const starveStart = Date.now();
    const starved = await keepAlive(readBoundedJson(starving, 32 * 1024, { timeoutMs: 20 }));
    const starveElapsed = Date.now() - starveStart;
    check("readBoundedJson: an always-resolved zero-byte iterator cannot starve the deadline (408 via the synchronous check, bounded iterations)",
      starved.ok === false && starved.status === 408 && starved.abandoned === true
      && starveElapsed < 500 && iterations < CAP,
      `${JSON.stringify(starved)} in ${starveElapsed}ms iterations=${iterations} cap=${CAP}`);
  }

  // 回归（review 实测）：真实 HTTP 上的 **chunked** 请求（显式没有 content-length）溢出时，对端必须
  // 收到 413 的响应体，而不是 ECONNRESET。这里复刻生产形状：读取体 -> abandoned 时登记
  // `res.once("finish")` 关闭请求（lib/index.js closeAfterResponse）-> 再写响应。
  // 陷阱：客户端**不能**发 content-length。readBoundedJson 顶部有一个“声明超限直接 413”的提前拒绝，
  // 一旦带上 content-length，这个测试就只是在测量那条分支（根本不进读取循环），对溢出路径毫无证明力。
  // 为了证明真的进了读取循环，handler 把 `out.abandoned` 记下来并断言为 true：提前拒绝返回的 413
  // 没有 abandoned 字段，所以这条断言就是“确实走了流式溢出分支”的证据。
  {
    const http = await import("node:http");
    let enteredReadLoop = false;
    let handlerOutcome = null;
    const server = http.createServer(async (req, res) => {
      const out = await readBoundedJson(req, 64, { timeoutMs: 500 });
      enteredReadLoop = out.abandoned === true; // 只有溢出/超时/中止的读取才会是 true
      handlerOutcome = out;
      if (out.abandoned === true) res.once("finish", () => { try { req.destroy(); } catch { /* already closed */ } });
      res.writeHead(out.ok ? 200 : out.status, { "content-type": "application/json" });
      res.end(JSON.stringify(out.ok ? { ok: true } : { error: out.error }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    const received = await new Promise((resolve, reject) => {
      const request = http.request({
        host: "127.0.0.1", port, method: "POST", path: "/body",
        // agent: false —— 请求结束后不把 socket 留在连接池里，server.close() 才不会等一个池化连接。
        agent: false,
        // chunked：显式不发 content-length（见上，否则测的是提前拒绝分支）
        headers: { "content-type": "application/json", "transfer-encoding": "chunked" },
      }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (piece) => { body += piece; });
        response.on("end", () => resolve({ status: response.statusCode, body }));
        response.on("error", reject);
      });
      request.on("error", reject);
      request.write(Buffer.from("x".repeat(100), "utf8"));
      request.write(Buffer.from("y".repeat(100), "utf8"));
      request.end();
    });
    // 关闭是兜底的：任何残留连接都直接断掉，这个测试不允许挂在 server.close() 上。
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    check("readBoundedJson: a chunked (no content-length) overflow still delivers the 413 body to the peer",
      enteredReadLoop === true && received.status === 413
      && received.body.includes("request body exceeds 64 bytes"),
      JSON.stringify({ enteredReadLoop, handlerOutcome, status: received.status, body: received.body.slice(0, 200) }));
  }
}

console.log(FAILS.length ? `\n${FAILS.length} FAILED` : "\nALL PASS");
process.exit(FAILS.length ? 1 : 0);

