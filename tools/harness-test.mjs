// dsh-wiki host half offline harness — fake cordis ctx, drive apply() end to end.
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, statSync, symlinkSync, linkSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
const { apply, __jobsInternals, __siteInternals, makeHostInstanceId, __livenessInternals } = await import(pathToFileURL(path.join(import.meta.dirname, "..", "lib", "index.js")).href);
const { isSameOrigin, parseHostHeader, PUBLIC_ERROR_MESSAGES } = await import(pathToFileURL(path.join(import.meta.dirname, "..", "lib", "jobs.js")).href);
const { hostEpochFileName } = await import(pathToFileURL(path.join(import.meta.dirname, "..", "lib", "host-liveness.js")).href);
const { WORKER_PROOFS } = await import(pathToFileURL(path.join(import.meta.dirname, "..", "lib", "journal.js")).href);

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

// 后台作业依赖的探针（spec 007）：默认配置下这些实现必须一次都不被调用。测试接缝只替换
// __jobsInternals 上的引用，替换后仍然委托给真实实现，默认行为不变。
const REAL_JOBS_INTERNALS = { ...__jobsInternals };
const jobProbe = { openJournalStore: 0, createJobManager: 0, createWorkerGuard: 0, register: 0 };
const resetJobProbe = () => { for (const key of Object.keys(jobProbe)) jobProbe[key] = 0; };
const spyJobsInternals = (overrides = {}) => {
  __jobsInternals.openJournalStore = overrides.openJournalStore ?? ((...args) => {
    jobProbe.openJournalStore++;
    return REAL_JOBS_INTERNALS.openJournalStore(...args);
  });
  __jobsInternals.createJobManager = overrides.createJobManager ?? ((...args) => {
    jobProbe.createJobManager++;
    return REAL_JOBS_INTERNALS.createJobManager(...args);
  });
  __jobsInternals.createWorkerGuard = overrides.createWorkerGuard ?? ((...args) => {
    jobProbe.createWorkerGuard++;
    return REAL_JOBS_INTERNALS.createWorkerGuard(...args);
  });
};
const restoreJobsInternals = () => { Object.assign(__jobsInternals, REAL_JOBS_INTERNALS); };
spyJobsInternals();

// fixture repo with a built wiki
const repo = tempDir("dsh-wiki-harness-");
mkdirSync(path.join(repo, ".dsh-wiki", "site"), { recursive: true });
writeFileSync(path.join(repo, ".dsh-wiki", "wiki.json"), JSON.stringify({ schema: "repo-wiki-local/1", repoId: repo, title: "Demo Repo", pages: [] }));
writeFileSync(path.join(repo, ".dsh-wiki", "site", "index.html"), "<!DOCTYPE html><html><main><h1>demo</h1></main></html>");
// second repo without site (should be skipped in list, still valid for view error)
const repoNoSite = tempDir("dsh-wiki-harness2-");
mkdirSync(path.join(repoNoSite, ".dsh-wiki"), { recursive: true });

const disposers = [];
const registered = { skills: [], commands: [], routes: [] };
const ctx = {
  effect: (fn, label) => { const d = fn(); disposers.push(d); return d; },
  get: (name) => ctx[name],
  on: (ev, fn) => { ctx["_on_" + ev] = fn; return () => delete ctx["_on_" + ev]; },
  skills: { register: (s) => { registered.skills.push(s); return () => {}; } },
  commands: { register: (c) => { registered.commands.push(c); return () => {}; } },
  webServer: {
    port: 19387,
    register: (r) => { registered.routes.push(r); return () => {}; },
  },
  subagents: {
    getProvider: (k) => ({ inheritsParentContext: true }),
    start: async (k, opts) => {
      ctx["_legacyStart"] = opts;
      return { result: Promise.resolve({ ok: true }), dispose: async () => {} };
    },
  },
  // 作业依赖的宿主服务：默认配置下即使全部可用，也不许被构造路径碰到。
  agents: { create: async () => { throw new Error("jobs must not construct a worker when disabled"); } },
  workingDirectory: { get: () => tmpdir() },
  agentPresets: {
    register: () => {
      jobProbe.register++;
      throw new Error("jobs must not register a preset when disabled");
    },
    mount: async () => ({ id: "dsh-wiki-worker" }),
  },
  logger: { warn: (m) => console.log("LOG", m) },
};

apply(ctx, { wikiDirName: ".dsh-wiki", wikiRoots: [repo, repoNoSite] });
// simulate a session event so the cwd book also has the fixture repo
ctx["_on_session/event"]({ header: { cwd: repo } }, {});
await new Promise((r) => setTimeout(r, 10)); // let debounced persist settle harmlessly

// skill registered with builder path baked in
check("skill registered", registered.skills.length === 1);
const skill = registered.skills[0];
check("skill name/kebab", skill?.name === "dsh-wiki");
check("skill content has builder abs path", typeof skill?.content === "string" && skill.content.includes(path.join(import.meta.dirname, "..", "scripts", "build_wiki_site.py")));
check("skill placeholder replaced", !skill?.content?.includes("{{BUILDER_PATH}}"));
check("skill source runtime", skill?.source === "runtime");

// command registered
check("command registered", registered.commands.length === 1 && registered.commands[0].name === "wiki");

// routes registered
check("route registered", registered.routes.length === 1 && registered.routes[0].kind === "prefix" && registered.routes[0].path === "/dsh-wiki");
const handler = registered.routes[0].handler;

const resOf = () => {
  const res = { status: 0, headers: null, body: "" };
  res.writeHead = (s, h) => { res.status = s; res.headers = h; };
  res.end = (b) => { res.body = b ?? ""; };
  return res;
};

// 1. status JSON
let res = resOf();
await handler({ method: "GET", headers: { host: "127.0.0.1:19387" }, url: "/dsh-wiki/api/status" }, res);
let body = JSON.parse(res.body);
check("status 200", res.status === 200 && body.ok === true);
check("status is an allowlist projection (no builder path, client path, graph excerpt or wiki roots)",
  Object.keys(body).sort().join(",") === "clientModule,jobs,ok,plugin"
  && body.plugin?.name === "@dsh-ext/dsh-wiki" && /^[0-9]+\.[0-9]+\.[0-9]+/.test(body.plugin?.version ?? "")
  && body.jobs?.enabled === false && body.jobs?.available === false && body.jobs?.state === "disabled"
  && body.jobs?.code === "jobs-disabled"
  && body.clientModule?.service === false && body.clientModule?.loaded === false
  && body.clientModule?.code === "client-module-unavailable"
  && !("builder" in body) && !("wikiDirName" in body) && !("wikis" in body), res.body);
// 项目发现（保留 fixture wiki、排除无站点根）改由 /api/projects 断言（见第 17 节）；status 不再列出根。

// 2. index page
res = resOf();
await handler({ method: "GET", headers: { host: "localhost:19387" }, url: "/dsh-wiki/" }, res);
check("index 200 html", res.status === 200 && res.body.startsWith("<!DOCTYPE html>") && res.body.includes("Demo Repo"));

// 3. site serving
res = resOf();
await handler({ method: "GET", headers: { host: "127.0.0.1:19387" }, url: `/dsh-wiki/site?path=${encodeURIComponent(path.join(repo, ".dsh-wiki"))}` }, res);
check("site 200 serves index.html", res.status === 200 && res.body.includes("<!DOCTYPE html>") && res.body.includes("demo"));

// 3b. backbar must land at the LAST </body>: a fake "</body>" literal inside an
// inline script string (old builds escaped only </script>) must not steal the
// injection point — a mid-script injection closes the script early and leaks
// the rest of the bundle as page text.
const repoFake = tempDir("dsh-wiki-harness3-");
mkdirSync(path.join(repoFake, ".dsh-wiki", "site"), { recursive: true });
writeFileSync(path.join(repoFake, ".dsh-wiki", "site", "index.html"),
  '<!DOCTYPE html><html><head></head><body><main>d</main><script>var s="</body></html>";</script></body></html>');
// /site only serves a site whose parent is a known project root (release gate), so register the fixture.
ctx["_on_session/event"]({ header: { cwd: repoFake } }, {});
res = resOf();
await handler({ method: "GET", headers: { host: "127.0.0.1:19387" }, url: `/dsh-wiki/site?path=${encodeURIComponent(path.join(repoFake, ".dsh-wiki"))}` }, res);
const fakeAt = res.body.indexOf('"</body');
const barAt = res.body.indexOf("Back to DSH");
check("site injection at last </body>", res.status === 200 && fakeAt !== -1 && barAt > fakeAt
  && res.body.toLowerCase().lastIndexOf("</body>") > barAt,
  `fakeAt=${fakeAt} barAt=${barAt}`);

// 4. security: non-loopback host
res = resOf();
await handler({ method: "GET", headers: { host: "evil.example.com" }, url: "/dsh-wiki/api/status" }, res);
check("non-loopback host 403", res.status === 403);

// 5. security: basename must be .dsh-wiki
res = resOf();
await handler({ method: "GET", headers: { host: "127.0.0.1:19387" }, url: `/dsh-wiki/site?path=${encodeURIComponent(repo)}` }, res);
check("non-wiki dir 403", res.status === 403);

// 6. security: traversal via .. resolves to non-basename
res = resOf();
await handler({ method: "GET", headers: { host: "127.0.0.1:19387" }, url: `/dsh-wiki/site?path=${encodeURIComponent(path.join(repo, ".dsh-wiki", "..", "x"))}` }, res);
check("traversal 403", res.status === 403);

// 7. missing site 404
res = resOf();
await handler({ method: "GET", headers: { host: "127.0.0.1:19387" }, url: `/dsh-wiki/site?path=${encodeURIComponent(path.join(repoNoSite, ".dsh-wiki"))}` }, res);
check("missing site 404", res.status === 404);

// 8. command /wiki view (session cwd = fixture repo)
const invocation = { rawInput: "view", agent: { session: { header: { id: "s1", cwd: repo } } }, signal: undefined };
let out = registered.commands[0].handler(invocation);
check("view success", out.kind === "success" && out.text.includes("http://127.0.0.1:19387/dsh-wiki/site?path=") && out.text.includes("Demo Repo") === false);

// 9. command /wiki view with no wiki
out = registered.commands[0].handler({ rawInput: "view", agent: { session: { header: { id: "s1", cwd: tmpdir() } } } });
check("view error when absent", out.kind === "error");

// 10. command /wiki list
out = registered.commands[0].handler({ rawInput: "list", agent: { session: { header: { id: "s1", cwd: repoNoSite } } } });
check("list shows fixture", out.kind === "success" && out.text.includes("Demo Repo"));

// 11. command /wiki generate → legacy start path (harness has no startActivation)
const genInvocation = { rawInput: "generate", agent: { session: { header: { id: "s1", cwd: repo } } }, signal: undefined };
out = registered.commands[0].handler(genInvocation);
check("generate starts", out.kind === "success" && out.text.length > 0);
await new Promise((r) => setTimeout(r, 20));
check("legacy start got prompt", ctx["_legacyStart"]?.prompt?.[0]?.text?.includes("Use the dsh-wiki skill") && ctx["_legacyStart"].parent === genInvocation.agent);
check("legacy start label prefixed", typeof ctx["_legacyStart"].label === "string" && ctx["_legacyStart"].label.startsWith("dsh-wiki:"));

// 12. command /wiki generate <bad>
out = registered.commands[0].handler({ rawInput: "generate /nonexistent-xyz", agent: { session: { header: { id: "s1", cwd: repo } } } });
check("generate bad path error", out.kind === "error");

// 13. session event cwd tracking: a cwd seen on the event stream becomes a known project
//     (status no longer lists roots — its payload is an allowlist; discovery shows in /api/projects).
const cwdProbe = tempDir("dsh-wiki-cwdprobe-");
ctx["_on_session/event"]({ header: { cwd: cwdProbe } }, {});
res = resOf();
await handler({ method: "GET", headers: { host: "127.0.0.1:19387" }, url: "/dsh-wiki/api/projects" }, res);
check("session cwd remembered as a known project", JSON.parse(res.body).projects.some((p) => p.root === cwdProbe));

// 14. unknown subcommand
out = registered.commands[0].handler({ rawInput: "frobnicate", agent: { session: { header: { id: "s1", cwd: repo } } } });
check("unknown verb error", out.kind === "error");

// 15. 返回栏：iframe 守卫（侧栏面板内嵌阅读时不渲染「← 返回 DSH」，否则会把 iframe 导航成应用套应用）
res = resOf();
await handler({ method: "GET", headers: { host: "127.0.0.1:19387" }, url: "/dsh-wiki/" }, res);
check("index backbar iframe-guarded", res.body.includes("window.self!==window.top"));
res = resOf();
await handler({ method: "GET", headers: { host: "127.0.0.1:19387" }, url: `/dsh-wiki/site?path=${encodeURIComponent(path.join(repo, ".dsh-wiki"))}` }, res);
check("site backbar iframe-guarded", res.body.includes("window.self!==window.top"));

// 15b. 返回栏位置/尺寸（defect 2）：桌面窗口 caption 按钮在右上角且顶栏是可拖拽区，
//      旧实现贴右上角 + 无 no-drag，点击被窗口吞掉。新约定：左上角 left:16px / top:44px
//      （安全落在 caption 按钮之下）、最小高度 40px、高对比描边、no-drag。
const backbar = (() => {
  const m = res.body.match(/<script>\(function\(\)\{if\(window\.self!==window\.top\)return;[\s\S]*?<\/script>/);
  return m ? m[0] : "";
})();
check("backbar: pinned top-left at left:16px / top:44px, min-height 40px",
  /position:fixed;left:16px;top:44px/.test(backbar) && /min-height:40px/.test(backbar),
  backbar.slice(0, 400));
check("backbar: high-contrast styling + -webkit-app-region:no-drag",
  /background:#111318/.test(backbar) && /color:#f8fafc/.test(backbar) && /-webkit-app-region:no-drag/.test(backbar));
check("backbar: closes the window first, then history.back() when same-origin history exists",
  /window\.close\(\)/.test(backbar) && /document\.referrer/.test(backbar)
  && /indexOf\(location\.origin\)===0/.test(backbar) && /history\.back\(\)/.test(backbar));
check("backbar: falls back to location.assign(\"/\") when there is no same-origin history",
  /location\.assign\("\/"\)/.test(backbar) && backbar.indexOf("history.back()") < backbar.indexOf('location.assign("/")'));
check("backbar: no longer anchored to the top-right corner", !/top:14px;right:16px/.test(backbar));

// 16. 同级目录自动发现：import-legacy 落盘目标（旧 wiki.json 的 repoId）不在登记表里，
//     靠扫描已知根的父目录一层收录；无站点与点目录兄弟不收录。
const sibParent = tempDir("dsh-wiki-sibs-");
const probe = path.join(sibParent, "probe"); // 已知根（会话 cwd），自身无 wiki
mkdirSync(probe, { recursive: true });
const sibWiki = path.join(sibParent, "sib-wiki"); // 兄弟带完整站点 → 应被发现
mkdirSync(path.join(sibWiki, ".dsh-wiki", "site"), { recursive: true });
writeFileSync(path.join(sibWiki, ".dsh-wiki", "wiki.json"), JSON.stringify({ schema: "repo-wiki-local/1", repoId: sibWiki, title: "Sib Wiki", pages: [] }));
writeFileSync(path.join(sibWiki, ".dsh-wiki", "site", "index.html"), "<!DOCTYPE html><html><main>sib</main></html>");
const sibNoSite = path.join(sibParent, "sib-nosite"); // 有 .dsh-wiki 无站点 → 不收录
mkdirSync(path.join(sibNoSite, ".dsh-wiki"), { recursive: true });
const sibDot = path.join(sibParent, ".sib-hidden"); // 点目录 → 跳过
mkdirSync(path.join(sibDot, ".dsh-wiki", "site"), { recursive: true });
writeFileSync(path.join(sibDot, ".dsh-wiki", "site", "index.html"), "<!DOCTYPE html><html><main>h</main></html>");
ctx["_on_session/event"]({ header: { cwd: probe } }, {});
res = resOf();
await handler({ method: "GET", headers: { host: "127.0.0.1:19387" }, url: "/dsh-wiki/api/projects" }, res);
const sibListed = JSON.parse(res.body).projects.map((p) => p.root);
check("sibling wiki discovered", sibListed.includes(sibWiki));
check("sibling without site skipped", !sibListed.includes(sibNoSite));
check("dot-dir sibling skipped", !sibListed.includes(sibDot));

// 17. spec 006 原生 UI 接口：项目列表 / 单项目状态 / wiki JSON，路径白名单
const get = async (url, host = "127.0.0.1:19387") => {
  const r = resOf();
  await handler({ method: "GET", headers: { host }, url }, r);
  let json = null;
  try { json = JSON.parse(r.body); } catch { /* html */ }
  return { status: r.status, json, body: r.body, headers: r.headers };
};
writeFileSync(path.join(repo, ".dsh-wiki", "wiki.json"), JSON.stringify({
  schema: "repo-wiki-local/1", repoId: repo, title: "Demo Repo", language: "en",
  pages: [{ id: "ov", parentId: null, order: 1, title: "Overview", markdown: "# Hi\n\n<script>x</script>", filePaths: ["a.py"] },
          { id: 7, title: { bad: 1 }, markdown: null }],
  cards: [{ id: "c1", title: "Card", kind: "api", summary: "s", keyFiles: ["a.py:1"], tags: "t" }],
}));
writeFileSync(path.join(repo, ".dsh-wiki", "generation-meta.json"), JSON.stringify({ sourceCommit: "0".repeat(40) }));
let r17 = await get("/dsh-wiki/api/projects");
const proj = r17.json?.projects?.find((p) => p.root === repo);
check("api/projects lists known root with counts", r17.status === 200 && proj?.generated === true
  && proj.pageCount === 2 && proj.cardCount === 1 && proj.language === "en" && proj.title === "Demo Repo", JSON.stringify(proj));
const noSiteProj = r17.json?.projects?.find((p) => p.root === repoNoSite);
check("api/projects includes not-generated root", noSiteProj && noSiteProj.generated === false && noSiteProj.pageCount === 0
  && noSiteProj.head === null && noSiteProj.updateAvailable === false);
r17 = await get(`/dsh-wiki/api/project?root=${encodeURIComponent(repo)}`);
check("api/project returns status with sourceCommit", r17.status === 200 && r17.json.project.sourceCommit === "0".repeat(40)
  && "head" in r17.json.project && typeof r17.json.project.updateAvailable === "boolean");
r17 = await get(`/dsh-wiki/api/wiki?root=${encodeURIComponent(repo)}`);
check("api/wiki returns normalized pages/cards (strings only)", r17.status === 200 && r17.json.pages.length === 2
  && r17.json.pages[1].id === "7" && r17.json.pages[1].title === "[object Object]" && r17.json.pages[1].markdown === ""
  && r17.json.cards[0].tags[0] === "t" && r17.json.pages[0].markdown.includes("<script>x</script>"), JSON.stringify(r17.json).slice(0, 200));
// path validation
for (const [label, root] of [
  ["unknown dir", tmpdir()],
  ["relative", "relative/path"],
  ["traversal", path.join(repo, "..", path.basename(repo), "..", "..")],
  ["wiki subdir", path.join(repo, ".dsh-wiki")],
  ["missing", ""],
]) {
  const rr = await get(`/dsh-wiki/api/wiki?root=${encodeURIComponent(root)}`);
  const rp = await get(`/dsh-wiki/api/project?root=${encodeURIComponent(root)}`);
  check(`api path validation rejects ${label} (403)`, rr.status === 403 && rp.status === 403, `${rr.status}/${rp.status}`);
}
r17 = await get(`/dsh-wiki/api/wiki?root=${encodeURIComponent(path.join(repo, ".", "x", ".."))}`);
check("api normalizes equivalent root path", r17.status === 200);
r17 = await get(`/dsh-wiki/api/wiki?root=${encodeURIComponent(repoNoSite)}`);
check("api/wiki 404 when not generated", r17.status === 404);
r17 = await get("/dsh-wiki/api/projects", "evil.example.com");
check("api/projects non-loopback 403", r17.status === 403);
r17 = await get(`/dsh-wiki/api/wiki?root=${encodeURIComponent(repo)}`, "evil.example.com:19387");
check("api/wiki non-loopback 403", r17.status === 403);
// workspaceRegistry 来源的根也被收录（可选服务）
const wsRoot = tempDir("dsh-wiki-ws-");
ctx.workspaceRegistry = { list: () => [{ id: "w1", path: wsRoot, title: "WS Title" }] };
r17 = await get("/dsh-wiki/api/projects");
check("api/projects includes workspaceRegistry roots with workspaceId", r17.json.projects.some((p) => p.root === wsRoot && p.title === "WS Title" && !p.generated && p.workspaceId === "w1"));
check("api/projects workspaceId null for non-workspace roots", r17.json.projects.find((p) => p.root === repo)?.workspaceId === null);
r17 = await get(`/dsh-wiki/api/project?root=${encodeURIComponent(wsRoot)}`);
check("api/project accepts workspace root and exposes workspaceId", r17.status === 200 && r17.json.project.generated === false && r17.json.project.workspaceId === "w1");
delete ctx.workspaceRegistry;
r17 = await get(`/dsh-wiki/api/project?root=${encodeURIComponent(wsRoot)}`);
check("api/project rejects root after workspace disappears", r17.status === 403);

// 17b. 网格陈旧标记：/api/projects 必须自己解析 HEAD（旧实现传 withHead=false，永远 false），
//      并且同一轮轮询共用缓存。临时 git 仓库缺失 git 时跳过，不让其余检查误红。
const repoGit = tempDir("dsh-wiki-git-");
mkdirSync(path.join(repoGit, ".dsh-wiki", "site"), { recursive: true });
writeFileSync(path.join(repoGit, ".dsh-wiki", "wiki.json"), JSON.stringify({ schema: "repo-wiki-local/1", repoId: repoGit, title: "Git Repo", pages: [] }));
writeFileSync(path.join(repoGit, ".dsh-wiki", "site", "index.html"), "<!DOCTYPE html><html><main>git</main></html>");
const gitHead = (() => {
  try {
    const env = { ...process.env, GIT_AUTHOR_NAME: "dsh-wiki-test", GIT_AUTHOR_EMAIL: "dsh-wiki@test.invalid",
      GIT_COMMITTER_NAME: "dsh-wiki-test", GIT_COMMITTER_EMAIL: "dsh-wiki@test.invalid" };
    execFileSync("git", ["init", "-q", repoGit], { stdio: "ignore", windowsHide: true });
    execFileSync("git", ["-C", repoGit, "commit", "--allow-empty", "-q", "-m", "init"], { env, stdio: "ignore", windowsHide: true });
    const sha = execFileSync("git", ["-C", repoGit, "rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch { return null; }
})();
if (!gitHead) {
  console.log("SKIP api/projects HEAD staleness (git unavailable)");
} else {
  writeFileSync(path.join(repoGit, ".dsh-wiki", "generation-meta.json"), JSON.stringify({ sourceCommit: "0".repeat(40) }));
  ctx["_on_session/event"]({ header: { cwd: repoGit } }, {});
  let rg = await get("/dsh-wiki/api/projects");
  let gp = rg.json?.projects?.find((p) => p.root === repoGit);
  check("api/projects resolves HEAD for the grid (stale wiki flagged)", rg.status === 200 && gp?.generated === true
    && gp?.head === gitHead && gp?.sourceCommit === "0".repeat(40) && gp?.updateAvailable === true, JSON.stringify(gp));
  let rp = await get(`/dsh-wiki/api/project?root=${encodeURIComponent(repoGit)}`);
  check("api/projects and api/project agree on head/updateAvailable",
    rp.status === 200 && rp.json.project.head === gp.head && rp.json.project.updateAvailable === gp.updateAvailable,
    JSON.stringify(rp.json?.project));
  writeFileSync(path.join(repoGit, ".dsh-wiki", "generation-meta.json"), JSON.stringify({ sourceCommit: gitHead }));
  rg = await get("/dsh-wiki/api/projects");
  gp = rg.json?.projects?.find((p) => p.root === repoGit);
  check("api/projects clears the update badge when sourceCommit matches HEAD",
    gp?.head === gitHead && gp?.updateAvailable === false, JSON.stringify(gp));
}
// mermaid 沙箱帧与资产
r17 = await get("/dsh-wiki/mermaid-frame");
{
  const csp = r17.headers["content-security-policy"] ?? "";
  const nonce = (csp.match(/script-src[^;]*'nonce-([A-Za-z0-9+/=_-]+)'/) ?? [])[1];
  const scripts = [...r17.body.matchAll(/<script\b([^>]*)>/gi)].map((m) => m[1]);
  check("mermaid-frame CSP: default-src none, connect-src none, nonce-based script-src (no host origin, no unsafe-inline)",
    r17.status === 200 && /default-src 'none'/.test(csp) && /connect-src 'none'/.test(csp) && !!nonce
    && !/script-src[^;]*'unsafe-inline'/.test(csp) && !/script-src[^;]*http:/.test(csp), csp);
  check("mermaid-frame: every <script> it serves carries the CSP nonce and none use src=",
    scripts.length >= 2 && scripts.every((a) => a.includes(`nonce="${nonce}"`) && !/\bsrc=/.test(a)), JSON.stringify(scripts));
  check("mermaid-frame inlines the mermaid runtime and bootstrap", r17.body.includes("__esbuild_esm_mermaid_nm") && r17.body.includes("dshWikiRender") && r17.body.length > 100000);
  const scriptBodies = [...r17.body.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  check("mermaid-frame: inline runtime cannot close its <script> early", scriptBodies.length === scripts.length);
  const r2 = await get("/dsh-wiki/mermaid-frame");
  const nonce2 = ((r2.headers["content-security-policy"] ?? "").match(/'nonce-([^']+)'/) ?? [])[1];
  check("mermaid-frame nonce changes per response", nonce2 && nonce2 !== nonce);
}r17 = await get("/dsh-wiki/assets/mermaid.min.js");
check("mermaid asset served", r17.status === 200 && r17.body.length > 1000);
r17 = await get("/dsh-wiki/assets/..%2Flib%2Findex.js");
check("assets route serves only mermaid", r17.status === 404);

// 18. 已知根的子目录一层发现（工作区是仓库父目录的情形）
const wsParent = tempDir("dsh-wiki-wsparent-");
const childRepo = path.join(wsParent, "child-repo");
mkdirSync(path.join(childRepo, ".dsh-wiki", "site"), { recursive: true });
writeFileSync(path.join(childRepo, ".dsh-wiki", "wiki.json"), JSON.stringify({ title: "Child", pages: [{ id: "a", title: "A", markdown: "x" }] }));
writeFileSync(path.join(childRepo, ".dsh-wiki", "site", "index.html"), "<!DOCTYPE html><html><main>c</main></html>");
ctx["_on_session/event"]({ header: { cwd: wsParent } }, {});
r17 = await get("/dsh-wiki/api/projects");
check("child repo of a known workspace root discovered", r17.json.projects.some((p) => p.root === childRepo && p.generated && p.pageCount === 1));
r17 = await get(`/dsh-wiki/api/wiki?root=${encodeURIComponent(childRepo)}`);
check("discovered child repo readable via api/wiki", r17.status === 200 && r17.json.title === "Child");

// 19. 发布闸门（reviewer 2026-11-09）：后台作业是写路径，在文件系统隔离与恢复评审通过前整段关闭。
//     必须能证明的是三件事：POST 端点 503、GET /api/jobs 只回报 disabled（不构造管理器）、
//     只读 GET 路由不再调用 recover()（查看站点/项目不得改动文件系统）。
const GATE_MESSAGE = "Background wiki jobs are disabled pending filesystem isolation and recovery review";
const post = async (url, payload, headers = {}) => {
  const text = payload === undefined ? "" : JSON.stringify(payload);
  const req = {
    method: "POST", url,
    headers: {
      host: "127.0.0.1:19387", origin: "http://127.0.0.1:19387",
      "content-type": "application/json", "content-length": String(Buffer.byteLength(text)),
      ...headers,
    },
  };
  // 仍然提供可读请求体：闸门必须靠自己的 503 拒答，而不是靠请求体读取失败。
  req[Symbol.asyncIterator] = async function* () { if (text) yield Buffer.from(text, "utf8"); };
  const r = resOf();
  await handler(req, r);
  let json = null;
  try { json = JSON.parse(r.body); } catch { /* html */ }
  return { status: r.status, json, body: r.body };
};

for (const url of ["/dsh-wiki/api/jobs", "/dsh-wiki/api/jobs/cancel"]) {
  const gate = await post(url, { root: repo, action: "generate", model: { provider: "mock", model: "m1" } });
  check(`jobs gate: POST ${url} → 503 with the isolation/recovery message`,
    gate.status === 503 && gate.json?.error === GATE_MESSAGE && gate.json?.disabled === true,
    `${gate.status} ${gate.body.slice(0, 160)}`);
}
const gateReadOnly = await post("/dsh-wiki/api/models", {});
check("jobs gate: POST to a read-only route stays 405 (gate opens no other write path)", gateReadOnly.status === 405,
  `${gateReadOnly.status} ${gateReadOnly.body.slice(0, 120)}`);

let rj = await get(`/dsh-wiki/api/jobs?root=${encodeURIComponent(repo)}`);
check("jobs gate: GET /api/jobs reports disabled without instantiating a manager",
  rj.status === 200 && rj.json?.disabled === true && rj.json?.disabledReason === GATE_MESSAGE
  && rj.json?.active === null && rj.json?.last === null && rj.json?.root === repo, JSON.stringify(rj.json));
rj = await get(`/dsh-wiki/api/jobs?root=${encodeURIComponent(path.join(repo, "no-such-project"))}`);
check("jobs gate: GET /api/jobs still rejects an unknown root (403)", rj.status === 403);

// 19b. /site 白名单：父目录不是已登记项目根的 .dsh-wiki 一律拒绝，且在任何读盘之前。
//      游离仓库放在自己的临时父目录下，避免被已知根父目录的兄弟扫描收录。
const strayOuter = tempDir("dsh-wiki-stray-");
const strayRoot = path.join(strayOuter, "not-a-known-root");
mkdirSync(path.join(strayRoot, ".dsh-wiki", "site"), { recursive: true });
writeFileSync(path.join(strayRoot, ".dsh-wiki", "site", "index.html"), "<!DOCTYPE html><html><main>stray</main></html>");
rj = await get(`/dsh-wiki/site?path=${encodeURIComponent(path.join(strayRoot, ".dsh-wiki"))}`);
check("site rejects an unknown project root before reading (403)", rj.status === 403,
  `${rj.status} ${rj.body.slice(0, 160)}`);
rj = await get(`/dsh-wiki/site?path=${encodeURIComponent(strayRoot)}`);
check("site still rejects a non-.dsh-wiki basename (403)", rj.status === 403);

// 19c. 查看不得改动文件系统：崩溃遗留的 .dsh-wiki.bak-* 必须原地不动。旧实现会在
//      /api/projects、/api/project、/api/wiki、/site 里调用 recover()，把任意备份目录改名成活动目录。
const repoBak = tempDir("dsh-wiki-bak-");
mkdirSync(path.join(repoBak, ".dsh-wiki.bak-deadbeef", "site"), { recursive: true });
writeFileSync(path.join(repoBak, ".dsh-wiki.bak-deadbeef", "site", "index.html"), "<!DOCTYPE html><html><main>bak</main></html>");
ctx["_on_session/event"]({ header: { cwd: repoBak } }, {});
await get("/dsh-wiki/api/projects");
await get(`/dsh-wiki/api/project?root=${encodeURIComponent(repoBak)}`);
await get(`/dsh-wiki/api/wiki?root=${encodeURIComponent(repoBak)}`);
const bakSite = await get(`/dsh-wiki/site?path=${encodeURIComponent(path.join(repoBak, ".dsh-wiki"))}`);
const bakLive = existsSync(path.join(repoBak, ".dsh-wiki"));
check("GET /api/projects|project|wiki|site never recover a leftover backup",
  !bakLive && existsSync(path.join(repoBak, ".dsh-wiki.bak-deadbeef", "site", "index.html")) && bakSite.status === 404,
  `live=${bakLive} site=${bakSite.status}`);

// 19d. 受控读（reviewer 2026-11-10 defect）：词法路径授权 + 普通 readFile/stat 会**跟随**
//      junction/symlink，`.dsh-wiki`（或它的某一级、wiki.json、site/index.html）被换成链接后，
//      读可以重定向到仓库之外，而且不需要任何 race。这里要求：授权比较规范路径、逐级 lstat 拒绝
//      链接、只接受普通文件、打开后把句柄身份绑到已检查的身份上，并且在读到任何内容字节之前拒绝；
//      拒绝只能是固定 JSON（稳定 code、不含仓库外绝对路径、不含 fs 异常文本）。
const SECRET_TITLE = "OUTSIDE-SECRET-TITLE";
const SECRET_BODY = "OUTSIDE-SECRET-BODY";
const linkOuter = tempDir("dsh-wiki-link-");
const outsideWiki = path.join(linkOuter, "outside-wiki");
mkdirSync(path.join(outsideWiki, "site"), { recursive: true });
writeFileSync(path.join(outsideWiki, "wiki.json"), JSON.stringify({
  schema: "repo-wiki-local/1", title: SECRET_TITLE, pages: [{ id: "secret", title: SECRET_TITLE, markdown: SECRET_BODY }],
}));
writeFileSync(path.join(outsideWiki, "site", "index.html"), `<!DOCTYPE html><html><body>${SECRET_BODY}</body></html>`);
const outsideSite = path.join(linkOuter, "outside-site");
mkdirSync(outsideSite, { recursive: true });
writeFileSync(path.join(outsideSite, "index.html"), `<!DOCTYPE html><html><body>${SECRET_BODY}</body></html>`);
// junction 在 Windows 上不需要管理员权限；真符号链接在部分平台需要权限 => 创建失败时显式 SKIP。
const makeJunction = (target, link) => { try { symlinkSync(target, link, "junction"); return true; } catch { return false; } };
const leakedOutside = (r) => r.body.includes(SECRET_BODY) || r.body.includes(SECRET_TITLE) || r.body.includes(linkOuter);
const fixedRefusal = (r, code) => r.status === 403 && r.json?.code === code && typeof r.json?.error === "string"
  && !/[A-Za-z]:[\\/]/.test(r.body)
  && !/ENOENT|EACCES|EPERM|ELOOP|EBUSY|symbolic link|junction|reparse/i.test(r.body);

// 19d-1. 整个 .dsh-wiki 被 junction 换成仓库外目录：/site 与 /api/wiki 必须拒绝，且回不了外部字节。
const repoLinkedDir = path.join(linkOuter, "repo-linked-dir");
mkdirSync(path.join(repoLinkedDir, ".dsh-wiki", "site"), { recursive: true });
writeFileSync(path.join(repoLinkedDir, ".dsh-wiki", "wiki.json"), JSON.stringify({ title: "Inside Repo", pages: [] }));
writeFileSync(path.join(repoLinkedDir, ".dsh-wiki", "site", "index.html"), "<!DOCTYPE html><html><main>inside</main></html>");
ctx["_on_session/event"]({ header: { cwd: repoLinkedDir } }, {});
let rLink = await get(`/dsh-wiki/site?path=${encodeURIComponent(path.join(repoLinkedDir, ".dsh-wiki"))}`);
check("linked .dsh-wiki: the legitimate site still serves before the swap", rLink.status === 200 && rLink.body.includes("inside"),
  `${rLink.status} ${rLink.body.slice(0, 160)}`);
rmSync(path.join(repoLinkedDir, ".dsh-wiki"), { recursive: true, force: true });
if (!makeJunction(outsideWiki, path.join(repoLinkedDir, ".dsh-wiki"))) {
  console.log("SKIP linked .dsh-wiki tests (junction creation unavailable on this filesystem)");
} else {
  rLink = await get(`/dsh-wiki/site?path=${encodeURIComponent(path.join(repoLinkedDir, ".dsh-wiki"))}`);
  check("linked .dsh-wiki: /site refuses the junction (403 unsafe-path, no outside bytes)",
    fixedRefusal(rLink, "unsafe-path") && !leakedOutside(rLink), `${rLink.status} ${rLink.body.slice(0, 200)}`);
  rLink = await get(`/dsh-wiki/api/wiki?root=${encodeURIComponent(repoLinkedDir)}`);
  check("linked .dsh-wiki: /api/wiki refuses the junction (403 unsafe-path, no outside bytes)",
    fixedRefusal(rLink, "unsafe-path") && !leakedOutside(rLink), `${rLink.status} ${rLink.body.slice(0, 200)}`);
  // 摘要路径（/api/projects、/api/project）不得读出外部内容：只能报告“未生成”。
  const rSummaries = await get("/dsh-wiki/api/projects");
  const rSummary = rSummaries.json?.projects?.find((p) => p.root === repoLinkedDir);
  check("linked .dsh-wiki: /api/projects reports it as not generated and leaks no outside content",
    rSummaries.status === 200 && rSummary?.generated === false && rSummary?.pageCount === 0
    && rSummary?.hasSite === false && !leakedOutside(rSummaries), JSON.stringify(rSummary));
  rLink = await get(`/dsh-wiki/api/project?root=${encodeURIComponent(repoLinkedDir)}`);
  check("linked .dsh-wiki: /api/project reports it as not generated and leaks no outside content",
    rLink.status === 200 && rLink.json?.project?.generated === false && !leakedOutside(rLink), rLink.body.slice(0, 200));
  // 索引页标题同样来自 wiki.json：链接换掉的 .dsh-wiki 不得把外部标题显示出来（退回目录名）。
  rLink = await get("/dsh-wiki/");
  check("linked .dsh-wiki: the index page never shows a title read through the link",
    rLink.status === 200 && !rLink.body.includes(SECRET_TITLE) && rLink.body.includes(path.basename(repoLinkedDir)),
    rLink.body.slice(0, 200));
}

// 19d-2. 只把 .dsh-wiki/site 换成 junction：/site 拒绝，而真实 wiki.json 仍然可用。
const repoSiteLink = path.join(linkOuter, "repo-site-link");
mkdirSync(path.join(repoSiteLink, ".dsh-wiki"), { recursive: true });
writeFileSync(path.join(repoSiteLink, ".dsh-wiki", "wiki.json"), JSON.stringify({ title: "Site Link Repo", pages: [{ id: "p", title: "t" }] }));
ctx["_on_session/event"]({ header: { cwd: repoSiteLink } }, {});
if (!makeJunction(outsideSite, path.join(repoSiteLink, ".dsh-wiki", "site"))) {
  console.log("SKIP linked .dsh-wiki/site test (junction creation unavailable on this filesystem)");
} else {
  const rSite = await get(`/dsh-wiki/site?path=${encodeURIComponent(path.join(repoSiteLink, ".dsh-wiki"))}`);
  check("linked .dsh-wiki/site: /site refuses the junction (403 unsafe-path, no outside bytes)",
    fixedRefusal(rSite, "unsafe-path") && !leakedOutside(rSite), `${rSite.status} ${rSite.body.slice(0, 200)}`);
  const rWiki = await get(`/dsh-wiki/api/wiki?root=${encodeURIComponent(repoSiteLink)}`);
  check("linked .dsh-wiki/site: /api/wiki still serves the real wiki.json",
    rWiki.status === 200 && rWiki.json?.pages?.length === 1, `${rWiki.status} ${rWiki.body.slice(0, 160)}`);
}

// 19d-3. wiki.json 本身是文件符号链接（需要权限；不可用时显式 SKIP 而不是静默放过）。
const repoLinkedWiki = path.join(linkOuter, "repo-linked-wiki");
mkdirSync(path.join(repoLinkedWiki, ".dsh-wiki", "site"), { recursive: true });
writeFileSync(path.join(repoLinkedWiki, ".dsh-wiki", "site", "index.html"), "<!DOCTYPE html><html><main>own-site</main></html>");
ctx["_on_session/event"]({ header: { cwd: repoLinkedWiki } }, {});
let fileLinkOk = true;
try { symlinkSync(path.join(outsideWiki, "wiki.json"), path.join(repoLinkedWiki, ".dsh-wiki", "wiki.json")); } catch { fileLinkOk = false; }
if (!fileLinkOk) {
  console.log("SKIP linked wiki.json test (file symlinks unavailable on this platform)");
} else {
  const rWikiLink = await get(`/dsh-wiki/api/wiki?root=${encodeURIComponent(repoLinkedWiki)}`);
  check("linked wiki.json: /api/wiki refuses the symlink (403 unsafe-path, no outside bytes)",
    fixedRefusal(rWikiLink, "unsafe-path") && !leakedOutside(rWikiLink), `${rWikiLink.status} ${rWikiLink.body.slice(0, 200)}`);
  const rSiteOwn = await get(`/dsh-wiki/site?path=${encodeURIComponent(path.join(repoLinkedWiki, ".dsh-wiki"))}`);
  check("linked wiki.json: /site still serves the real index.html", rSiteOwn.status === 200 && rSiteOwn.body.includes("own-site"),
    `${rSiteOwn.status} ${rSiteOwn.body.slice(0, 160)}`);
}

// 19d-3b. 非普通文件：wiki.json 是目录（不需要链接权限，任何平台都跑）。要求“普通文件”的地方必须拒绝。
const repoWikiDir = path.join(linkOuter, "repo-wiki-dir");
mkdirSync(path.join(repoWikiDir, ".dsh-wiki", "wiki.json"), { recursive: true });
mkdirSync(path.join(repoWikiDir, ".dsh-wiki", "site"), { recursive: true });
writeFileSync(path.join(repoWikiDir, ".dsh-wiki", "site", "index.html"), "<!DOCTYPE html><html><main>dir-wiki</main></html>");
ctx["_on_session/event"]({ header: { cwd: repoWikiDir } }, {});
const rNonRegular = await get(`/dsh-wiki/api/wiki?root=${encodeURIComponent(repoWikiDir)}`);
check("non-regular wiki.json: /api/wiki refuses a directory with the fixed unsafe-path (403)",
  fixedRefusal(rNonRegular, "unsafe-path"), `${rNonRegular.status} ${rNonRegular.body.slice(0, 200)}`);

// 19d-4. 祖先换位：<parent>/link 是 junction，并且**被登记成已知根**（会话 cwd + 兄弟扫描两条都会收录）。
//        词法授权会接受它；规范授权必须拒绝，且拒绝体里不能出现它指向的真实目录。
const legitRepo = path.join(linkOuter, "legit-repo");
mkdirSync(path.join(legitRepo, ".dsh-wiki", "site"), { recursive: true });
writeFileSync(path.join(legitRepo, ".dsh-wiki", "wiki.json"), JSON.stringify({ title: "Legit Repo", pages: [{ id: "a", title: "A" }] }));
writeFileSync(path.join(legitRepo, ".dsh-wiki", "site", "index.html"), "<!DOCTYPE html><html><main>legit</main></html>");
// 显式登记（不依赖兄弟扫描的 5s 缓存时序）：真正的项目根应当始终可用。
ctx["_on_session/event"]({ header: { cwd: legitRepo } }, {});
const linkedParent = path.join(linkOuter, "linked-parent");
if (!makeJunction(legitRepo, linkedParent)) {
  console.log("SKIP ancestor-swap test (junction creation unavailable on this filesystem)");
} else {
  ctx["_on_session/event"]({ header: { cwd: linkedParent } }, {});
  const rParent = await get(`/dsh-wiki/api/wiki?root=${encodeURIComponent(linkedParent)}`);
  check("ancestor swap: a junction parent is refused even though it is registered (403 unknown-project)",
    rParent.status === 403 && rParent.json?.code === "unknown-project"
    && !rParent.body.includes(legitRepo) && !rParent.body.includes(linkOuter), `${rParent.status} ${rParent.body.slice(0, 200)}`);
  const rParentSite = await get(`/dsh-wiki/site?path=${encodeURIComponent(path.join(linkedParent, ".dsh-wiki"))}`);
  check("ancestor swap: /site under a junction parent is refused (403 unknown-project)",
    rParentSite.status === 403 && rParentSite.json?.code === "unknown-project" && !rParentSite.body.includes(legitRepo),
    `${rParentSite.status} ${rParentSite.body.slice(0, 200)}`);
  // 回归守卫：链路之外的真实项目仍然 200，body 形状不变。
  const rLegit = await get(`/dsh-wiki/api/wiki?root=${encodeURIComponent(legitRepo)}`);
  check("ancestor swap: the legitimate project still returns 200 with the same body shape",
    rLegit.status === 200 && rLegit.json?.ok === true && rLegit.json?.title === "Legit Repo"
    && rLegit.json?.pages?.length === 1 && rLegit.json?.pages?.[0]?.id === "a" && Array.isArray(rLegit.json?.cards),
    rLegit.body.slice(0, 200));
  const rLegitSite = await get(`/dsh-wiki/site?path=${encodeURIComponent(path.join(legitRepo, ".dsh-wiki"))}`);
  check("ancestor swap: the legitimate site still returns 200", rLegitSite.status === 200 && rLegitSite.body.includes("legit"),
    `${rLegitSite.status}`);
  const rList = await get("/dsh-wiki/api/projects");
  check("ancestor swap: /api/projects never lists the junction root",
    rList.status === 200 && !rList.json.projects.some((p) => p.root === linkedParent),
    JSON.stringify(rList.json?.projects?.map((p) => p.root)));
}

// 19d-5. 回归守卫：主 fixture 项目仍然 200，且 body 形状不变（规范化不得误伤合法 wiki）。
const rRegression = await get(`/dsh-wiki/api/wiki?root=${encodeURIComponent(repo)}`);
check("containment regression: the legitimate wiki still returns 200 with the same body shape",
  rRegression.status === 200 && rRegression.json?.ok === true && rRegression.json?.root === repo
  && Array.isArray(rRegression.json?.pages) && Array.isArray(rRegression.json?.cards), rRegression.body.slice(0, 160));

// 19d-6. 硬链接（reviewer 2026-11-10 第二处缺口）：仓库内的 wiki.json / site/index.html 是指向
//        仓库外文件的**硬链接**时，规范路径、逐级无链接、dev/ino 三道证明全部通过——因为仓库内外的
//        两个名字就是同一个文件，链接本身不是链接项。只有链接数能说出这件事。因此两条受控读都必须在
//        「授权证明」与「打开后的句柄」上要求 nlink === 1，拒绝形状与其它受控读拒绝完全一致
//        （403 unsafe-path、不回显路径、不回显链接数）。硬链接在同一个卷内不需要任何权限；
//        创建失败（例如夹具跨卷）时显式 SKIP，绝不假装断言过。
const outsideHardlinkDir = path.join(linkOuter, "outside-hardlink");
mkdirSync(path.join(outsideHardlinkDir, "site"), { recursive: true });
writeFileSync(path.join(outsideHardlinkDir, "wiki.json"), JSON.stringify({
  schema: "repo-wiki-local/1", title: SECRET_TITLE, pages: [{ id: "secret", title: SECRET_TITLE, markdown: SECRET_BODY }],
}));
writeFileSync(path.join(outsideHardlinkDir, "site", "index.html"), `<!DOCTYPE html><html><body>${SECRET_BODY}</body></html>`);
const outsideHardlinkWiki = path.join(outsideHardlinkDir, "wiki.json");
const outsideHardlinkSite = path.join(outsideHardlinkDir, "site", "index.html");
const nlinkOf = (file) => String(statSync(file, { bigint: true }).nlink);
// 拒绝体不得回显：仓库外路径、链接数、以及任何 fs/符号链接文本（fixedRefusal 已覆盖后两者）。
const hardlinkRefusalOk = (r) => fixedRefusal(r, "unsafe-path") && !leakedOutside(r)
  && !r.body.includes(outsideHardlinkDir) && !/nlink/i.test(r.body) && !/\b[2-9]\d*\s*links?\b/i.test(r.body);

// 19d-6a. wiki.json 硬链接到仓库外文件：异步读（/api/wiki、摘要）与同步读（索引页、/wiki list）。
const repoHlWiki = path.join(linkOuter, "repo-hl-wiki");
mkdirSync(path.join(repoHlWiki, ".dsh-wiki", "site"), { recursive: true });
writeFileSync(path.join(repoHlWiki, ".dsh-wiki", "site", "index.html"), "<!DOCTYPE html><html><main>hl-own-site</main></html>");
let hlWikiOk = true;
try { linkSync(outsideHardlinkWiki, path.join(repoHlWiki, ".dsh-wiki", "wiki.json")); } catch { hlWikiOk = false; }
ctx["_on_session/event"]({ header: { cwd: repoHlWiki } }, {});
if (!hlWikiOk) {
  console.log("SKIP hardlinked wiki.json tests (hardlinks unavailable or cross-device in the fixture)");
} else {
  // 夹具断言：仓库内的名字确实是同一个文件的第二个链接（nlink 2），否则这些断言什么都没证明。
  check("hardlinked wiki.json fixture: the in-repo name really is a 2nd link to the outside file",
    nlinkOf(path.join(repoHlWiki, ".dsh-wiki", "wiki.json")) === "2" && nlinkOf(outsideHardlinkWiki) === "2",
    `inside=${nlinkOf(path.join(repoHlWiki, ".dsh-wiki", "wiki.json"))} outside=${nlinkOf(outsideHardlinkWiki)}`);
  const rHlWiki = await get(`/dsh-wiki/api/wiki?root=${encodeURIComponent(repoHlWiki)}`);
  check("hardlinked wiki.json: /api/wiki refuses it (403 unsafe-path, no outside bytes, no path/link-count echo)",
    hardlinkRefusalOk(rHlWiki), `${rHlWiki.status} ${rHlWiki.body.slice(0, 200)}`);
  // 同步读：索引页标题来自 readContainedFileSync，不可信必须退回目录名，外部标题一个字都不能出现。
  const rHlIndex = await get("/dsh-wiki/");
  check("hardlinked wiki.json: the index page never shows the outside title (sync reader falls back to the dir name)",
    rHlIndex.status === 200 && !rHlIndex.body.includes(SECRET_TITLE)
    && rHlIndex.body.includes(path.basename(repoHlWiki)), rHlIndex.body.slice(0, 200));
  const hlListText = registered.commands[0].handler({
    rawInput: "list", agent: { session: { header: { id: "s1", cwd: repoHlWiki } } },
  })?.text ?? "";
  check("hardlinked wiki.json: /wiki list never shows the outside title (same sync reader)",
    !hlListText.includes(SECRET_TITLE) && !hlListText.includes(SECRET_BODY)
    && hlListText.includes(path.basename(repoHlWiki)), hlListText.slice(0, 200));
  const rHlSummaries = await get("/dsh-wiki/api/projects");
  const hlSummary = rHlSummaries.json?.projects?.find((p) => p.root === repoHlWiki);
  check("hardlinked wiki.json: /api/projects reports it as not generated and leaks no outside content",
    rHlSummaries.status === 200 && hlSummary?.generated === false && hlSummary?.pageCount === 0
    && !leakedOutside(rHlSummaries), JSON.stringify(hlSummary));
}

// 19d-6b. site/index.html 硬链接到仓库外文件：/site 必须拒绝，而真实（单链接）wiki.json 仍然可用。
const repoHlSite = path.join(linkOuter, "repo-hl-site");
mkdirSync(path.join(repoHlSite, ".dsh-wiki", "site"), { recursive: true });
writeFileSync(path.join(repoHlSite, ".dsh-wiki", "wiki.json"),
  JSON.stringify({ title: "Hl Site Repo", pages: [{ id: "a", title: "A" }] }));
let hlSiteOk = true;
try { linkSync(outsideHardlinkSite, path.join(repoHlSite, ".dsh-wiki", "site", "index.html")); } catch { hlSiteOk = false; }
ctx["_on_session/event"]({ header: { cwd: repoHlSite } }, {});
if (!hlSiteOk) {
  console.log("SKIP hardlinked site/index.html tests (hardlinks unavailable or cross-device in the fixture)");
} else {
  check("hardlinked site/index.html fixture: the in-repo name really is a 2nd link to the outside file",
    nlinkOf(path.join(repoHlSite, ".dsh-wiki", "site", "index.html")) === "2"
    && nlinkOf(outsideHardlinkSite) === "2",
    `inside=${nlinkOf(path.join(repoHlSite, ".dsh-wiki", "site", "index.html"))} outside=${nlinkOf(outsideHardlinkSite)}`);
  const rHlSite = await get(`/dsh-wiki/site?path=${encodeURIComponent(path.join(repoHlSite, ".dsh-wiki"))}`);
  check("hardlinked site/index.html: /site refuses it (403 unsafe-path, no outside bytes, no path/link-count echo)",
    hardlinkRefusalOk(rHlSite), `${rHlSite.status} ${rHlSite.body.slice(0, 200)}`);
  const rHlSiteWiki = await get(`/dsh-wiki/api/wiki?root=${encodeURIComponent(repoHlSite)}`);
  check("hardlinked site/index.html: /api/wiki still serves the real single-link wiki.json",
    rHlSiteWiki.status === 200 && rHlSiteWiki.json?.pages?.length === 1,
    `${rHlSiteWiki.status} ${rHlSiteWiki.body.slice(0, 160)}`);
}

// 19d-6c. 回归守卫：正常的单链接产物（nlink 1）必须照旧 200——链接数闸门不得误伤合法站点。
const repoSingleLink = path.join(linkOuter, "repo-single-link");
mkdirSync(path.join(repoSingleLink, ".dsh-wiki", "site"), { recursive: true });
writeFileSync(path.join(repoSingleLink, ".dsh-wiki", "wiki.json"),
  JSON.stringify({ title: "Single Link Repo", pages: [{ id: "p1", title: "P1" }] }));
writeFileSync(path.join(repoSingleLink, ".dsh-wiki", "site", "index.html"),
  "<!DOCTYPE html><html><main>single-link-site</main></html>");
ctx["_on_session/event"]({ header: { cwd: repoSingleLink } }, {});
const rSingleWiki = await get(`/dsh-wiki/api/wiki?root=${encodeURIComponent(repoSingleLink)}`);
check("link-count guard: a normal single-link wiki.json (nlink 1) still returns 200 with the same body shape",
  nlinkOf(path.join(repoSingleLink, ".dsh-wiki", "wiki.json")) === "1"
  && rSingleWiki.status === 200 && rSingleWiki.json?.ok === true && rSingleWiki.json?.title === "Single Link Repo"
  && rSingleWiki.json?.pages?.length === 1, `${rSingleWiki.status} ${rSingleWiki.body.slice(0, 160)}`);
const rSingleSite = await get(`/dsh-wiki/site?path=${encodeURIComponent(path.join(repoSingleLink, ".dsh-wiki"))}`);
check("link-count guard: a normal single-link site/index.html (nlink 1) still returns 200",
  nlinkOf(path.join(repoSingleLink, ".dsh-wiki", "site", "index.html")) === "1"
  && rSingleSite.status === 200 && rSingleSite.body.includes("single-link-site"),
  `${rSingleSite.status} ${rSingleSite.body.slice(0, 160)}`);

// 19e. 语言面板（T017a）：/api/languages 只列项目内真实存在的 locale 目录，/api/wiki?lang=
//      用同一个受控读返回翻译 units。两条读路由都不回文件系统路径，也不接受未授权的根。
const noDrivePath = (r) => !/[A-Za-z]:[\\/]/.test(r.body);
const langRepo = path.join(linkOuter, "repo-lang");
mkdirSync(path.join(langRepo, ".dsh-wiki", "locales", "vi"), { recursive: true });
mkdirSync(path.join(langRepo, ".dsh-wiki", "locales", "zh-CN"), { recursive: true });
mkdirSync(path.join(langRepo, ".dsh-wiki", "locales", "not a tag!"), { recursive: true });
mkdirSync(path.join(langRepo, ".dsh-wiki", "site"), { recursive: true });
writeFileSync(path.join(langRepo, ".dsh-wiki", "wiki.json"), JSON.stringify({
  schema: "repo-wiki-local/1", repoId: langRepo, title: "Lang Repo", language: "en",
  pages: [{ id: "ov", parentId: null, order: 1, title: "Overview", markdown: "# Overview" }],
  cards: [{ id: "c1", title: "Card", kind: "api", summary: "s" }],
}));
writeFileSync(path.join(langRepo, ".dsh-wiki", "site", "index.html"), "<!DOCTYPE html><html><main>lang</main></html>");
writeFileSync(path.join(langRepo, ".dsh-wiki", "locales", "vi", "wiki.json"), JSON.stringify({
  schema: "repo-wiki-local/1", repoId: langRepo, title: "Lang Repo", language: "vi",
  pages: [{ id: "ov", parentId: null, order: 1, title: "Tổng quan", markdown: "# Tổng quan\n\nXin chào" }],
  cards: [{ id: "c1", title: "Thẻ", kind: "api", summary: "s" }],
}));
// 普通文件不能算一种语言（名字合法但不是目录）；目录名不合法时跳过而不是回显。
writeFileSync(path.join(langRepo, ".dsh-wiki", "locales", "zz"), "not a locale dir");
ctx["_on_session/event"]({ header: { cwd: langRepo } }, {});

// 没有 locales 目录的项目：空列表，不是错误。
const langEmpty = path.join(linkOuter, "repo-lang-empty");
mkdirSync(path.join(langEmpty, ".dsh-wiki"), { recursive: true });
writeFileSync(path.join(langEmpty, ".dsh-wiki", "wiki.json"), JSON.stringify({ title: "Empty Langs", pages: [] }));
ctx["_on_session/event"]({ header: { cwd: langEmpty } }, {});
let rLangs = await get(`/dsh-wiki/api/languages?root=${encodeURIComponent(langEmpty)}`);
check("api/languages: no locales dir => ok with an empty list (not an error)",
  rLangs.status === 200 && JSON.stringify(rLangs.json) === JSON.stringify({ ok: true, canonical: "en", languages: [] }),
  rLangs.body.slice(0, 200));

rLangs = await get(`/dsh-wiki/api/languages?root=${encodeURIComponent(langRepo)}`);
check("api/languages: only proven locale dirs, sorted, with units flags (invalid names/files skipped)",
  rLangs.status === 200 && rLangs.json?.ok === true && rLangs.json?.canonical === "en"
  && JSON.stringify(rLangs.json?.languages) === JSON.stringify([{ tag: "vi", units: true }, { tag: "zh-CN", units: false }]),
  JSON.stringify(rLangs.json?.languages));
check("api/languages: no filesystem path in the body",
  noDrivePath(rLangs) && !rLangs.body.includes(langRepo) && !rLangs.body.includes(".dsh-wiki"),
  rLangs.body.slice(0, 200));

rLangs = await get(`/dsh-wiki/api/languages?root=${encodeURIComponent(path.join(tmpdir(), "dsh-wiki-languages-unknown-xyz"))}`);
check("api/languages: unknown root => 403 unknown-project (no path echoed)",
  rLangs.status === 403 && rLangs.json?.code === "unknown-project" && noDrivePath(rLangs),
  `${rLangs.status} ${rLangs.body.slice(0, 200)}`);

// /api/wiki 的语言分支：缺席与 "en" 都仍是 canonical；非 en 走同一受控读。
const wikiNoLang = await get(`/dsh-wiki/api/wiki?root=${encodeURIComponent(langRepo)}`);
check("api/wiki: no lang keeps the canonical behaviour (regression)",
  wikiNoLang.status === 200 && wikiNoLang.json?.ok === true && wikiNoLang.json?.root === langRepo
  && wikiNoLang.json?.title === "Lang Repo" && wikiNoLang.json?.language === "en"
  && wikiNoLang.json?.pages?.length === 1 && wikiNoLang.json?.pages?.[0]?.id === "ov",
  wikiNoLang.body.slice(0, 200));
const wikiEn = await get(`/dsh-wiki/api/wiki?root=${encodeURIComponent(langRepo)}&lang=en`);
check("api/wiki: lang=en returns exactly the same body as no lang",
  wikiEn.status === 200 && JSON.stringify(wikiEn.json) === JSON.stringify(wikiNoLang.json),
  `${wikiEn.status} ${wikiEn.body.slice(0, 200)}`);

const wikiVi = await get(`/dsh-wiki/api/wiki?root=${encodeURIComponent(langRepo)}&lang=vi`);
check("api/wiki: lang=vi serves the translated units in the same normalized shape (no root/paths)",
  wikiVi.status === 200 && wikiVi.json?.ok === true && wikiVi.json?.language === "vi"
  && wikiVi.json?.pages?.[0]?.title === "Tổng quan" && wikiVi.json?.pages?.[0]?.markdown.includes("Xin chào")
  && wikiVi.json?.cards?.[0]?.title === "Thẻ" && !("root" in (wikiVi.json ?? {})),
  wikiVi.body.slice(0, 200));
check("api/wiki: the translated payload carries no drive-letter path", noDrivePath(wikiVi), wikiVi.body.slice(0, 200));

const wikiZhMissingUnits = await get(`/dsh-wiki/api/wiki?root=${encodeURIComponent(langRepo)}&lang=zh-CN`);
check("api/wiki: a locale dir without wiki.json is a fixed 404 translation-missing (no path, no fs text)",
  wikiZhMissingUnits.status === 404 && wikiZhMissingUnits.json?.code === "translation-missing"
  && wikiZhMissingUnits.json?.error === PUBLIC_ERROR_MESSAGES["translation-missing"]
  && noDrivePath(wikiZhMissingUnits) && !/ENOENT|EACCES|\\/.test(wikiZhMissingUnits.body),
  `${wikiZhMissingUnits.status} ${wikiZhMissingUnits.body.slice(0, 200)}`);
const wikiViNoLocales = await get(`/dsh-wiki/api/wiki?root=${encodeURIComponent(langEmpty)}&lang=vi`);
check("api/wiki: no locale directory at all is the same fixed 404 translation-missing",
  wikiViNoLocales.status === 404 && wikiViNoLocales.json?.code === "translation-missing"
  && wikiViNoLocales.json?.error === PUBLIC_ERROR_MESSAGES["translation-missing"] && noDrivePath(wikiViNoLocales),
  `${wikiViNoLocales.status} ${wikiViNoLocales.body.slice(0, 200)}`);

const wikiBadLang = await get(`/dsh-wiki/api/wiki?root=${encodeURIComponent(langRepo)}&lang=${encodeURIComponent("%%%invalid")}`);
check("api/wiki: an invalid lang is 400 invalid-target-lang (never silently canonical)",
  wikiBadLang.status === 400 && wikiBadLang.json?.code === "invalid-target-lang" && noDrivePath(wikiBadLang),
  `${wikiBadLang.status} ${wikiBadLang.body.slice(0, 200)}`);
const wikiEmptyLang = await get(`/dsh-wiki/api/wiki?root=${encodeURIComponent(langRepo)}&lang=`);
check("api/wiki: an empty lang is 400 invalid-target-lang (present but not a valid tag)",
  wikiEmptyLang.status === 400 && wikiEmptyLang.json?.code === "invalid-target-lang", wikiEmptyLang.body.slice(0, 200));

// 硬链接：locale 的 wiki.json 是仓库外文件的第二个名字 —— 受控读必须拒绝，/api/languages 也不得
// 把它算成 units:true。硬链接在同一卷内不需要权限，创建失败时显式 SKIP（绝不假装断言过）。
const langHl = path.join(linkOuter, "repo-lang-hardlink");
mkdirSync(path.join(langHl, ".dsh-wiki", "locales", "vi"), { recursive: true });
const outsideLangWiki = path.join(linkOuter, "outside-lang-wiki.json");
writeFileSync(outsideLangWiki, JSON.stringify({ title: SECRET_TITLE, pages: [{ id: "secret", title: SECRET_TITLE, markdown: SECRET_BODY }] }));
let langHlOk = true;
try { linkSync(outsideLangWiki, path.join(langHl, ".dsh-wiki", "locales", "vi", "wiki.json")); } catch { langHlOk = false; }
ctx["_on_session/event"]({ header: { cwd: langHl } }, {});
if (!langHlOk) {
  console.log("SKIP hardlinked locale wiki.json test (hardlinks unavailable or cross-device in the fixture)");
} else {
  check("hardlinked locale wiki.json fixture: the in-repo name really is a 2nd link to the outside file",
    nlinkOf(path.join(langHl, ".dsh-wiki", "locales", "vi", "wiki.json")) === "2" && nlinkOf(outsideLangWiki) === "2",
    `inside=${nlinkOf(path.join(langHl, ".dsh-wiki", "locales", "vi", "wiki.json"))} outside=${nlinkOf(outsideLangWiki)}`);
  const rHlLang = await get(`/dsh-wiki/api/wiki?root=${encodeURIComponent(langHl)}&lang=vi`);
  check("hardlinked locale wiki.json: /api/wiki refuses it (403 unsafe-path, no outside bytes, no path/link-count echo)",
    hardlinkRefusalOk(rHlLang) && noDrivePath(rHlLang), `${rHlLang.status} ${rHlLang.body.slice(0, 200)}`);
  const rHlLangs = await get(`/dsh-wiki/api/languages?root=${encodeURIComponent(langHl)}`);
  check("hardlinked locale wiki.json: /api/languages reports units:false and leaks no outside content",
    rHlLangs.status === 200 && JSON.stringify(rHlLangs.json?.languages) === JSON.stringify([{ tag: "vi", units: false }])
    && !leakedOutside(rHlLangs) && noDrivePath(rHlLangs), rHlLangs.body.slice(0, 200));
}

// 20. 后台作业接线（spec 007）：默认关闭；显式开启才构造；失败 fail closed；卸载有序且不抛。
//     这里是 Host 侧接线测试：管理器/journal store 全部由 __jobsInternals 注入假实现，
//     不启动 worker、不跑 python、不写任何仓库。

// 20a. 默认（jobs.enabled 缺省 = false）即使依赖齐全也不构造任何东西。
check("jobs default: no store/manager/guard/preset constructed",
  jobProbe.openJournalStore === 0 && jobProbe.createJobManager === 0
  && jobProbe.createWorkerGuard === 0 && jobProbe.register === 0, JSON.stringify(jobProbe));
const makeCtx = (name) => {
  const state = { name, disposers: [], registered: { skills: [], commands: [], routes: [] }, warnings: [] };
  const c = {
    effect: (fn) => { const d = fn(); state.disposers.push(d); return d; },
    get: (key) => c[key],
    on: (ev, fn) => { c["_on_" + ev] = fn; return () => { delete c["_on_" + ev]; }; },
    skills: { register: () => () => {} },
    commands: { register: () => () => {} },
    webServer: { port: 19388, register: (r) => { state.registered.routes.push(r); return () => {}; } },
    logger: { warn: (m) => state.warnings.push(String(m)) },
  };
  state.ctx = c;
  return state;
};
const resOfLocal = () => {
  const res = { status: 0, headers: null, body: "" };
  res.writeHead = (s, h) => { res.status = s; res.headers = h; };
  res.end = (b) => { res.body = b ?? ""; };
  return res;
};
const makeClient = (handler) => ({
  get: async (url, host = "127.0.0.1:19388") => {
    const r = resOfLocal();
    await handler({ method: "GET", headers: { host }, url }, r);
    let json = null; try { json = JSON.parse(r.body); } catch { /* html */ }
    return { status: r.status, json, body: r.body, headers: r.headers };
  },
  post: async (url, payload, headers = {}) => {
    const text = payload === undefined ? "" : typeof payload === "string" ? payload : JSON.stringify(payload);
    const req = {
      method: "POST", url,
      headers: {
        host: "127.0.0.1:19388", origin: "http://127.0.0.1:19388",
        "content-type": "application/json", "content-length": String(Buffer.byteLength(text)),
        ...headers,
      },
    };
    req[Symbol.asyncIterator] = async function* () { if (text) yield Buffer.from(text, "utf8"); };
    const r = resOfLocal();
    await handler(req, r);
    let json = null; try { json = JSON.parse(r.body); } catch { /* html */ }
    return { status: r.status, json, body: r.body };
  },
});
// 构造是异步的（preset 注册 + 已知根扫描可能很慢），测试等待可观测结果而不是固定 sleep。
const waitFor = async (predicate, label, timeoutMs = 5000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  console.log(`TIMEOUT waiting for ${label}`);
  return false;
};
// 构造是异步的（preset 注册/resolve + 管理器）。需要“构造完成之后才登记工作区根”的用例先等它跑完，
// 否则根可能在构造的“已知根”检查之前出现，让构造顺带打开 store（时序依赖而不是契约）。
const settleRuntime = () => new Promise((r) => setTimeout(r, 25));
const disposeAll = async (state) => {
  for (const dispose of [...state.disposers].reverse()) {
    if (typeof dispose === "function") await dispose();
  }
};
const jobError = (status, code, message) => Object.assign(new Error(message), { status, code });
// preset 服务的最小可信形状：index.js 要求 register/mount/resolve/composedPreset 同时在位，
// 否则按“无法证明 worker preset 已挂载”在开启时 fail closed（不建会话、路由只有固定 code）。
const presetService = (overrides = {}) => ({
  register: () => async () => {},
  mount: async () => ({ id: "dsh-wiki-worker" }),
  resolve: async (id) => ({ id: id ?? "dsh-wiki-worker" }),
  composedPreset: () => "dsh-wiki-worker",
  ...overrides,
});

// 20a2. 非法 jobs 配置必须被拒绝（schema 可用时由 Loader 拒绝，链接目录取不到 schemastery 时由
// apply() 用同一套规则拒绝——两条路径都不得让非法值进入运行时）。
for (const [label, jobs] of [
  ["enabled is not a boolean", { enabled: "yes" }],
  ["storeDir is relative", { storeDir: "relative/journal" }],
  ["storeDir is empty", { storeDir: "" }],
  ["disposeTimeoutMs is not a positive integer", { disposeTimeoutMs: 0 }],
  ["presetId is blank", { presetId: "   " }],
  // preset 身份是固定的：注册与挂载必须是同一个 id，任何“指向别的 preset”的配置都必须被拒绝。
  ["presetId points at another preset", { presetId: "some-other-preset" }],
  ["jobs is not an object", "on"],
]) {
  let rejected = null;
  try { apply(makeCtx("invalid").ctx, { wikiDirName: ".dsh-wiki", jobs }); } catch (error) { rejected = error; }
  check(`jobs config rejected: ${label}`, rejected instanceof TypeError, String(rejected));
}

// 20b. 显式 enabled=false + 显式 storeDir：仍然 503、GET 同一份禁用载荷、且不创建 store 目录。
resetJobProbe();
const storeOff = path.join(tempDir("dsh-wiki-offstore-"), "journal");
const off = makeCtx("off");
apply(off.ctx, { wikiDirName: ".dsh-wiki", wikiRoots: [repo], jobs: { enabled: false, storeDir: storeOff } });
off.ctx["_on_session/event"]({ header: { cwd: repo } }, {});
const offClient = makeClient(off.registered.routes[0].handler);
let offPost = await offClient.post("/dsh-wiki/api/jobs", { root: repo, action: "generate", model: { provider: "p", model: "m" } });
check("jobs disabled: POST /api/jobs keeps the 503 contract",
  offPost.status === 503 && offPost.json?.error === GATE_MESSAGE && offPost.json?.disabled === true,
  `${offPost.status} ${offPost.body.slice(0, 160)}`);
offPost = await offClient.post("/dsh-wiki/api/jobs/cancel", { root: repo });
check("jobs disabled: POST /api/jobs/cancel keeps the 503 contract",
  offPost.status === 503 && offPost.json?.error === GATE_MESSAGE && offPost.json?.disabled === true);
let offGet = await offClient.get(`/dsh-wiki/api/jobs?root=${encodeURIComponent(repo)}`);
check("jobs disabled: GET /api/jobs keeps the exact disabled payload",
  offGet.status === 200 && JSON.stringify(offGet.json) === JSON.stringify({
    ok: true, root: repo, disabled: true, disabledReason: GATE_MESSAGE, active: null, last: null,
  }), JSON.stringify(offGet.json));
check("jobs disabled: no store directory created and nothing constructed",
  !existsSync(storeOff) && jobProbe.openJournalStore === 0 && jobProbe.createJobManager === 0
  && jobProbe.createWorkerGuard === 0 && jobProbe.register === 0);
await disposeAll(off);

// 20c. 显式 enabled=true + 假 store/manager/guard/preset：接线、状态码映射、GET 只读。
const jobOrder = [];
const storeOn = path.join(tempDir("dsh-wiki-onstore-"), "journal");
const repoJobs = tempDir("dsh-wiki-jobsrepo-");
const fakeJob = { id: "job1", root: repoJobs, action: "generate", phase: "running", stage: "queued" };
const fakeManager = {
  startCalls: [],
  cancelCalls: [],
  start(request) {
    fakeManager.startCalls.push(request);
    if (fakeManager.startError) throw fakeManager.startError;
    return fakeJob;
  },
  cancel(root) { fakeManager.cancelCalls.push(root); return { canceled: true, id: "job1" }; },
  view() { return { active: fakeJob, last: null }; },
  journalState() { return { mode: "journal", missing: [] }; },
  async dispose() {
    jobOrder.push("manager");
    if (fakeManager.disposeError) throw fakeManager.disposeError;
    // 新契约：dispose() 报告哪些 worker 仍未证明停下；空数组 = 全部确认停下。
    return { unresolved: fakeManager.unresolved ?? [] };
  },
};
const fakeStore = {
  load: async () => null,
  create: async () => ({ record: {} }),
  advance: async () => ({ record: {} }),
  replaceTerminal: async () => ({ record: {} }),
};
spyJobsInternals({
  openJournalStore: async (options) => {
    jobProbe.openJournalStore++;
    fakeStore.options = options;
    return fakeStore;
  },
  createJobManager: (options) => {
    jobProbe.createJobManager++;
    fakeManager.options = options;
    return fakeManager;
  },
  createWorkerGuard: (options) => {
    jobProbe.createWorkerGuard++;
    fakeManager.guardOptions = options;
    return { activate: () => () => {}, authorizeSync: () => ({ allow: true }), releaseAll: () => jobOrder.push("guard") };
  },
});
resetJobProbe();
const on = makeCtx("on");
const presetDisposer = async () => { jobOrder.push("preset"); };
on.ctx.agents = { create: async () => { throw new Error("worker must not start in the harness"); } };
on.ctx.workingDirectory = { get: () => repoJobs };
on.ctx.agentPresets = presetService({
  register: (definition) => { jobProbe.register++; fakeManager.preset = definition; return presetDisposer; },
});
apply(on.ctx, { wikiDirName: ".dsh-wiki", wikiRoots: [repoJobs], jobs: { enabled: true, storeDir: storeOn } });
await waitFor(() => jobProbe.createJobManager === 1 && fakeStore.options !== undefined, "enabled job runtime construction");
const onClient = makeClient(on.registered.routes[0].handler);

check("jobs enabled: manager/guard/preset constructed once",
  jobProbe.createJobManager === 1 && jobProbe.createWorkerGuard === 1 && jobProbe.register === 1, JSON.stringify(jobProbe));
check("jobs enabled: preset definition is the dormant worker contract",
  fakeManager.preset?.id === "dsh-wiki-worker" && Array.isArray(fakeManager.preset?.plugins));
check("jobs enabled: manager gets journal store, hostInstanceId and the route allowlist",
  fakeManager.options?.journalStore === undefined ? false : true);
// workerLiveness 的契约是 `async (record) => { state }`（jobs.js observeWorker 会 await 它）：这里按同一
// 契约调用。存活证明按**记录属主**分别求证（host-liveness.js 的 per-instance epoch 记录）：
//   * 本进程实例写的记录 => alive（jobs.js 只接受 alive/stopped/unknown，旧接线的 "running" 会被折成 unknown）；
//   * 别的实例写的记录、且它自己那条 epoch 记录缺席 => unknown。**回归缺陷**：旧接线只保留“上一个宿主”
//     的一个全局裁决，一旦该裁决是 dead，每一条外来记录都会被判成 stopped——缺席不是死亡，别人死了也
//     不等于这条记录的主人死了；
//   * 别的实例写的记录、且它自己那条 epoch 记录证明宿主已死 => stopped + proof "process-exit"。
//     **缺陷（2026-11-10）**：这里曾返回 "epoch-host-dead"——规划器（lib/journal.js WORKER_PROOFS）
//     不认这个词，planRecovery 会把合法观测当成畸形数据抛 invalid-observations，reconcile 于是
//     status:"error"，恢复在“宿主重启后”这个它唯一存在的场景里永远不可能执行。dead 裁决的依据只有
//     PID 消失/启动时刻不匹配，也就是进程已退出，所以诚实的 proof 是 "process-exit"，且必须是
//     WORKER_PROOFS 的成员（下面 check 断言这一点，重新引入新词会让测试失败）。
const liveEpochRecord = path.join(storeOn, "host-epoch", hostEpochFileName(fakeManager.options?.hostInstanceId));
await waitFor(() => existsSync(liveEpochRecord), "host epoch claim");
const foreignLiveness = typeof fakeManager.options?.workerLiveness === "function"
  ? await fakeManager.options.workerLiveness({ hostInstanceId: "dsh-wiki.harness-other" })
  : null;
const ownLiveness = typeof fakeManager.options?.workerLiveness === "function"
  ? await fakeManager.options.workerLiveness({ hostInstanceId: fakeManager.options?.hostInstanceId })
  : null;
check("jobs enabled: manager options carry presetId/journal/allowedRoots/journalStore and the liveness verdicts",
  fakeManager.options?.presetId === "dsh-wiki-worker"
  && typeof fakeManager.options?.allowedRoots === "function"
  // 缺席的外来记录 => unknown，绝不是 stopped。
  && foreignLiveness?.state === "unknown" && foreignLiveness?.proof === undefined
  && ownLiveness?.state === "alive" && ownLiveness?.proof === undefined
  && typeof fakeManager.options?.journalStore?.load === "function"
  && typeof fakeManager.options?.hostInstanceId === "string" && fakeManager.options.hostInstanceId.length > 0,
  JSON.stringify({ presetId: fakeManager.options?.presetId, host: fakeManager.options?.hostInstanceId,
    liveness: foreignLiveness, own: ownLiveness }));
// 回归用例的正向一半：外来记录**自己的** epoch 记录证明其宿主已死 => stopped（proof process-exit）。
// 这正是修复后唯一允许 stopped 的来源；旧接线靠的是“上一个宿主的全局裁决”。
const deadForeignInstance = "dsh-wiki.harness-dead";
writeFileSync(path.join(storeOn, "host-epoch", hostEpochFileName(deadForeignInstance)),
  `${JSON.stringify({
    epochId: "harness-dead-epoch",
    hostInstanceId: deadForeignInstance,
    pid: 2147483647,
    procStart: Date.now() - 1000,
    procStartTicks: null,
    startedAt: new Date().toISOString(),
  }, null, 2)}\n`, "utf8");
const deadForeignLiveness = typeof fakeManager.options?.workerLiveness === "function"
  ? await fakeManager.options.workerLiveness({ hostInstanceId: deadForeignInstance })
  : null;
check("liveness: a foreign record whose OWN epoch record proves dead reports stopped with proof process-exit",
  deadForeignLiveness?.state === "stopped" && deadForeignLiveness?.proof === "process-exit",
  JSON.stringify(deadForeignLiveness));
// 词表一致性（2026-11-10 缺陷的守卫）：生产 provider 交出的 proof 必须是规划器 WORKER_PROOFS 的成员，
// 否则 planRecovery 抛 invalid-observations、reconcile 变成 error，恢复永远不可能执行。断言“某个已知
// 字符串”是不够的——那正是旧写法，所以这里同时钉住成员的合法性、集合的确切内容和不可变性。
check("liveness: the provider's dead-owner proof is a member of the planner's accepted vocabulary",
  WORKER_PROOFS.includes(deadForeignLiveness?.proof) && WORKER_PROOFS.includes("process-exit"),
  JSON.stringify({ proof: deadForeignLiveness?.proof, accepted: [...WORKER_PROOFS] }));
check("liveness: the planner's accepted proof vocabulary is exactly the three documented values (frozen)",
  Object.isFrozen(WORKER_PROOFS)
  && JSON.stringify([...WORKER_PROOFS]) === JSON.stringify(["process-exit", "host-registry", "worker-session-id"]),
  JSON.stringify([...(WORKER_PROOFS ?? [])]));
check("jobs enabled: guard resolves the effective cwd from ctx.workingDirectory.get",
  typeof fakeManager.guardOptions?.getEffectiveCwd === "function"
  && fakeManager.guardOptions.getEffectiveCwd({ session: { id: "s" } }) === repoJobs);
// The manager's allowedRoots provider may be sync or async (() => array | Promise<array>), so the
// diagnostic resolves it defensively instead of assuming a sync array.
const liveRoots = await Promise.resolve(fakeManager.options?.allowedRoots?.());
check("jobs enabled: store opened over the canonical storeDir with the route allowlist",
  fakeStore.options?.storeDir === storeOn && fakeStore.options?.allowedRoots?.includes(repoJobs)
  && typeof fakeStore.options?.hostInstanceId === "string",
  JSON.stringify({ storeDir: fakeStore.options?.storeDir, want: storeOn,
    roots: Array.isArray(fakeStore.options?.allowedRoots) ? fakeStore.options.allowedRoots.length : String(fakeStore.options?.allowedRoots),
    has: fakeStore.options?.allowedRoots?.includes(repoJobs), host: typeof fakeStore.options?.hostInstanceId,
    opens: jobProbe.openJournalStore, liveRoots: Array.isArray(liveRoots) ? liveRoots.length : String(liveRoots),
    liveHas: Array.isArray(liveRoots) ? liveRoots.includes(repoJobs) : false }));

// GET must not open the store, recover anything, or call reconcile: the fake manager has no reconcile.
const storeOpensBeforeGet = jobProbe.openJournalStore;
let onGet = await onClient.get(`/dsh-wiki/api/jobs?root=${encodeURIComponent(repoJobs)}`);
check("jobs enabled: GET returns manager state (not disabled)",
  onGet.status === 200 && onGet.json?.disabled === false && onGet.json?.active?.id === "job1"
  && onGet.json?.journal?.mode === "journal", JSON.stringify(onGet.json));
check("jobs enabled: GET never opens the store or reconciles",
  jobProbe.openJournalStore === storeOpensBeforeGet && typeof fakeManager.reconcile === "undefined",
  `opens ${storeOpensBeforeGet} -> ${jobProbe.openJournalStore}`);
check("jobs enabled: GET unknown root still 403", (await onClient.get("/dsh-wiki/api/jobs?root=" + encodeURIComponent(tmpdir()))).status === 403);

// GET 只读：不写 journal/lock 文件、不建 staging/backup 目录、不做 recovery。
const storeEntriesBefore = existsSync(storeOn) ? readdirSync(storeOn).sort() : null;
const repoEntriesBefore = readdirSync(repoJobs).sort();
await onClient.get(`/dsh-wiki/api/jobs?root=${encodeURIComponent(repoJobs)}`);
const storeEntriesAfter = existsSync(storeOn) ? readdirSync(storeOn).sort() : null;
const repoEntriesAfter = readdirSync(repoJobs).sort();
check("jobs enabled: GET mutates nothing on disk (no journal/lock, no staging/backup dir)",
  JSON.stringify(storeEntriesBefore) === JSON.stringify(storeEntriesAfter)
  && JSON.stringify(repoEntriesBefore) === JSON.stringify(repoEntriesAfter)
  && !repoEntriesAfter.some((n) => n.startsWith(".dsh-wiki.staging-") || n.startsWith(".dsh-wiki.bak-")),
  `${JSON.stringify(storeEntriesBefore)} -> ${JSON.stringify(storeEntriesAfter)}; ${JSON.stringify(repoEntriesAfter)}`);

// 请求校验：同源 / content-type / 有界 JSON / 动作 / 模型 / 语言 / 白名单根。
const goodBody = { root: repoJobs, action: "generate", model: { provider: "p", model: "m" } };
check("jobs enabled: cross-origin POST 403",
  (await onClient.post("/dsh-wiki/api/jobs", goodBody, { origin: "http://evil.example.com" })).status === 403);
check("jobs enabled: missing origin 403",
  (await onClient.post("/dsh-wiki/api/jobs", goodBody, { origin: "" })).status === 403);
check("jobs enabled: non-JSON content-type 415",
  (await onClient.post("/dsh-wiki/api/jobs", goodBody, { "content-type": "text/plain" })).status === 415);
check("jobs enabled: invalid JSON 400",
  (await onClient.post("/dsh-wiki/api/jobs", "{not json")).status === 400);
check("jobs enabled: oversized body 413",
  (await onClient.post("/dsh-wiki/api/jobs", { root: repoJobs, pad: "x".repeat(40 * 1024) })).status === 413);

// closeAfterResponse 接线（review 2026-11-10）：读取请求体的两个 POST 处理器（/api/jobs 与
// /api/jobs/recovery-execute）都必须在响应 flush **之后**才关闭 socket。lib/index.js 的
// readBoundedJson 不再 destroy 请求：在同一个 socket 上写 413/408 的响应体之前 destroy，chunked
// 请求（没有 content-length）的对端拿到的是 ECONNRESET 而不是响应体。所以这两个路径各自都要登记
// `res.once("finish", ...)`。这里用真实路由处理器 + 只记录 finish 监听器的响应对象来证明三件事：
// 公开形状不变（413 + 固定 error、没有 code）、finish 监听器恰好登记一次、destroy 在 finish 时发生一次。
{
  const { EventEmitter } = await import("node:events");
  const routeHandler = on.registered.routes[0].handler;
  // lib/index.js:48 的 JOB_BODY_LIMIT_BYTES：这里不 import（没有导出），只按同一数值构造溢出体。
  const BODY_LIMIT = 32 * 1024;
  const overflowBody = "x".repeat(BODY_LIMIT + 1024);
  const driveOverflow = async (url) => {
    let destroyed = 0;
    const req = new EventEmitter();
    req.method = "POST";
    req.url = url;
    // 故意不发 content-length：带上它会命中 readBoundedJson 顶部的“声明超限直接 413”，既不进读取
    // 循环，也不会返回 abandoned（那样就测不到调用方的关闭接线）。
    req.headers = { host: "127.0.0.1:19388", origin: "http://127.0.0.1:19388", "content-type": "application/json" };
    req[Symbol.asyncIterator] = async function* () { yield Buffer.from(overflowBody, "utf8"); };
    req.destroy = () => { destroyed += 1; };
    let finishListeners = -1;
    const res = new EventEmitter();
    res.status = 0;
    res.headers = null;
    res.body = "";
    res.writeHead = (status, headers) => { res.status = status; res.headers = headers; return res; };
    res.end = (body) => {
      res.body = body ?? "";
      // 先数再 emit：closeAfterResponse 用的是 once，emit 之后就没人可数了。
      finishListeners = res.listenerCount("finish");
      res.emit("finish");
      return res;
    };
    await routeHandler(req, res);
    let json = null; try { json = JSON.parse(res.body); } catch { /* not json */ }
    return { status: res.status, json, destroyed, finishListeners };
  };
  for (const url of ["/dsh-wiki/api/jobs", "/dsh-wiki/api/jobs/recovery-execute"]) {
    const out = await driveOverflow(url);
    check(`closeAfterResponse: POST ${url} keeps the 413 shape and closes the socket only after the response`,
      out.status === 413 && out.json?.error === `request body exceeds ${BODY_LIMIT} bytes`
      // code 保持缺省：这条拒绝路径历来只回 error，没有 code（不得顺手加一个）。
      && out.json?.code === undefined && out.finishListeners === 1 && out.destroyed === 1,
      `${url}: ${out.status} ${JSON.stringify(out.json)} finishListeners=${out.finishListeners} destroyed=${out.destroyed}`);
  }
}
check("jobs enabled: unknown root 403",
  (await onClient.post("/dsh-wiki/api/jobs", { ...goodBody, root: tmpdir() })).status === 403);
check("jobs enabled: unknown action 400",
  (await onClient.post("/dsh-wiki/api/jobs", { ...goodBody, action: "delete" })).status === 400);
check("jobs enabled: missing model 400",
  (await onClient.post("/dsh-wiki/api/jobs", { root: repoJobs, action: "generate" })).status === 400);
check("jobs enabled: non-en target language rejected before any job (501)",
  (await onClient.post("/dsh-wiki/api/jobs", { ...goodBody, targetLang: "vi" })).status === 501);
check("jobs enabled: rejected requests started no job", fakeManager.startCalls.length === 0);

let onPost = await onClient.post("/dsh-wiki/api/jobs", goodBody);
check("jobs enabled: POST starts the job (202) with the exact request",
  onPost.status === 202 && onPost.json?.job?.id === "job1"
  && fakeManager.startCalls.length === 1
  && fakeManager.startCalls[0].root === repoJobs && fakeManager.startCalls[0].action === "generate"
  && fakeManager.startCalls[0].model.provider === "p" && fakeManager.startCalls[0].targetLang === "en",
  JSON.stringify(onPost.json));
fakeManager.startError = jobError(409, "job-busy", "a generate job is already running");
onPost = await onClient.post("/dsh-wiki/api/jobs", goodBody);
check("jobs enabled: JobError 409 maps to HTTP 409 with its code",
  onPost.status === 409 && onPost.json?.code === "job-busy", JSON.stringify(onPost.json));
fakeManager.startError = jobError(503, "services-unavailable", "missing agents");
onPost = await onClient.post("/dsh-wiki/api/jobs", goodBody);
check("jobs enabled: JobError 503 maps to HTTP 503", onPost.status === 503 && onPost.json?.code === "services-unavailable");
fakeManager.startError = new Error("boom");
onPost = await onClient.post("/dsh-wiki/api/jobs", goodBody);
check("jobs enabled: unexpected failure is 500, never a crash", onPost.status === 500);
// defect 3：没有 status 的底层错误（fs EACCES 等）不得把自己的 code/路径当成公开错误。
fakeManager.startError = Object.assign(new Error(`EACCES: mkdir '${path.join(repoJobs, ".dsh-wiki.staging-x")}'`), { code: "EACCES" });
onPost = await onClient.post("/dsh-wiki/api/jobs", goodBody);
check("fix3: an unstructured fs error becomes a fixed 500 (no raw code, no path)",
  onPost.status === 500 && onPost.json?.code === "internal-error"
  && onPost.json?.error === "the request could not be completed"
  && !onPost.body.includes(repoJobs) && !/EACCES/.test(onPost.body), `${onPost.status} ${onPost.body.slice(0, 200)}`);
fakeManager.startError = null;
onPost = await onClient.post("/dsh-wiki/api/jobs/cancel", { root: repoJobs });
check("jobs enabled: POST /api/jobs/cancel delegates to the manager",
  onPost.status === 200 && onPost.json?.canceled === true && fakeManager.cancelCalls.length === 1);

// reconcile 永不暴露在 HTTP 上。
check("jobs: no reconcile route (GET 404)",
  (await onClient.get(`/dsh-wiki/api/jobs/reconcile?root=${encodeURIComponent(repoJobs)}`)).status === 404);
check("jobs: no reconcile route (POST 405)",
  (await onClient.post("/dsh-wiki/api/jobs/reconcile", { root: repoJobs })).status === 405);

// 20d. 卸载顺序：manager.dispose → guard.releaseAll → preset disposer，且从不抛出。
const liveBeforeUnload = jobProbe.openJournalStore;
// 卸载不是进程退出：host-epoch 记录必须活过 dispose 且逐字节不变（它是“上一个宿主存在过”的唯一证据）。
const liveEpochBytesBefore = readFileSync(liveEpochRecord);
await disposeAll(on);
check("liveness: the host-epoch record survives a plugin dispose (unload is not process exit)",
  existsSync(liveEpochRecord) && readFileSync(liveEpochRecord).equals(liveEpochBytesBefore),
  `exists=${existsSync(liveEpochRecord)}`);
check("jobs unload: dispose order manager → guard → preset",
  JSON.stringify(jobOrder) === JSON.stringify(["manager", "guard", "preset"]), JSON.stringify(jobOrder));
check("jobs unload: unload performed no new store open", jobProbe.openJournalStore === liveBeforeUnload);
const afterUnload = await onClient.post("/dsh-wiki/api/jobs", goodBody);
check("jobs unload: POST after unload is 503 (no runner is used)", afterUnload.status === 503, `${afterUnload.status}`);

// 20e. 构造失败：日志一条警告、路由 503 且带真实原因、apply 不抛、绝不运行作业。
resetJobProbe();
const broken = makeCtx("broken");
broken.ctx.agents = { create: async () => ({}) };
broken.ctx.workingDirectory = { get: () => repoJobs };
broken.ctx.agentPresets = presetService({
  register: () => { jobProbe.register++; throw new Error("preset rejected by the registry"); },
});
let brokenThrew = null;
try {
  apply(broken.ctx, { wikiDirName: ".dsh-wiki", wikiRoots: [repoJobs], jobs: { enabled: true, storeDir: storeOn } });
} catch (error) { brokenThrew = error; }
await waitFor(() => broken.warnings.length > 0, "construction failure warning");
const brokenClient = makeClient(broken.registered.routes[0].handler);
const brokenGet = await brokenClient.get(`/dsh-wiki/api/jobs?root=${encodeURIComponent(repoJobs)}`);
check("jobs construction failure: apply does not throw", brokenThrew === null, String(brokenThrew));
check("jobs construction failure: one warning carries the full internal reason",
  broken.warnings.length === 1 && /could not start/.test(broken.warnings[0]) && /preset rejected/.test(broken.warnings[0]),
  JSON.stringify(broken.warnings));
// defect 3：响应体只有稳定 code + 固定短句；原始错误文本（含路径）只进 logger。
check("jobs construction failure: GET stays 503 with a fixed public code, never the raw reason",
  brokenGet.status === 503 && brokenGet.json?.disabled === true
  && brokenGet.json?.code === "jobs-initialization-failed"
  && brokenGet.json?.error === "background wiki jobs could not start"
  && !/preset rejected/.test(brokenGet.body) && !brokenGet.body.includes(storeOn),
  `${brokenGet.status} ${brokenGet.body.slice(0, 200)}`);
const brokenPost = await brokenClient.post("/dsh-wiki/api/jobs", { root: repoJobs, action: "generate", model: { provider: "p", model: "m" } });
check("jobs construction failure: POST stays 503 and runs no job", brokenPost.status === 503 && jobProbe.createJobManager === 0);
await disposeAll(broken);

// 20f. 卸载即使 dispose 失败也不抛，后续步骤照常执行。
resetJobProbe();
const noisy = makeCtx("noisy");
const noisyOrder = [];
noisy.ctx.agents = { create: async () => ({}) };
noisy.ctx.workingDirectory = { get: () => repoJobs };
noisy.ctx.agentPresets = presetService({
  register: () => { jobProbe.register++; return async () => { noisyOrder.push("preset"); }; },
});
spyJobsInternals({
  openJournalStore: async () => { jobProbe.openJournalStore++; return { load: async () => null, create: async () => ({}), advance: async () => ({}), replaceTerminal: async () => ({}) }; },
  createJobManager: () => {
    jobProbe.createJobManager++;
    return {
      start: () => ({ id: "x" }), cancel: () => ({ canceled: false }), view: () => ({ active: null, last: null }),
      journalState: () => ({ mode: "journal", missing: [] }),
      dispose: async () => { noisyOrder.push("manager"); throw new Error("dispose exploded"); },
    };
  },
  createWorkerGuard: () => { jobProbe.createWorkerGuard++; return { activate: () => () => {}, authorizeSync: () => ({ allow: true }), releaseAll: () => noisyOrder.push("guard") }; },
});
apply(noisy.ctx, { wikiDirName: ".dsh-wiki", wikiRoots: [repoJobs], jobs: { enabled: true, storeDir: storeOn } });
await waitFor(() => jobProbe.createJobManager === 1, "noisy runtime construction");
let unloadThrew = null;
try { await disposeAll(noisy); } catch (error) { unloadThrew = error; }
check("jobs unload: a failing manager.dispose never throws out of unload", unloadThrew === null, String(unloadThrew));
// defect 1：dispose 失败 => 管理器没能报告 worker 状态 => 不能假设安全：activation 全部保留，
// preset 仍然按顺序释放（回滚/卸载各自保持完全，但永不伪装“已证明停下”）。
check("jobs unload: a failed manager.dispose keeps the guard (worker state unproven) and still unregisters the preset",
  noisyOrder[0] === "manager" && !noisyOrder.includes("guard") && noisyOrder.includes("preset"), JSON.stringify(noisyOrder));
check("jobs unload: the retained confinement is reported truthfully (process exit + reconcile)",
  noisy.warnings.some((w) => /retained until process exit/.test(w) && /reconcile/.test(w)), JSON.stringify(noisy.warnings));
check("jobs unload: the failure is reported as a warning",
  noisy.warnings.some((w) => /could not dispose the job manager/.test(w)), JSON.stringify(noisy.warnings));

// 作业 guard 的通用替身（后面的 enabled 用例共用；定义在使用之前）。
const jobGuard = () => ({ activate: () => () => {}, authorizeSync: () => ({ allow: true }), releaseAll: () => {}, activeAgentIds: () => [], release: () => false });

// 20g. preset 绑定是开启前提（reviewer MAJOR）：注册与挂载必须是同一个固定 id；无法证明 preset 已挂载
//      => 开启时 fail closed，返回固定 code，绝不创建会话、绝不给 202。
{
  const presetRepo = tempDir("dsh-wiki-preset-");
  const presetStore = path.join(tempDir("dsh-wiki-preset-store-"), "journal");
  const runPresetCase = async (name, buildPresets) => {
    const state = makeCtx(name);
    const seen = { managers: 0, options: null, resolvedId: null, definition: null };
    spyJobsInternals({
      openJournalStore: async () => ({ load: async () => null, create: async () => ({}), advance: async () => ({}), replaceTerminal: async () => ({}) }),
      createJobManager: (options) => {
        seen.managers++;
        seen.options = options;
        return {
          start: () => ({ id: "job1" }), cancel: () => ({ canceled: false }), view: () => ({ active: null, last: null }),
          journalState: () => ({ mode: "journal", missing: [] }), dispose: async () => ({ unresolved: [] }),
        };
      },
      createWorkerGuard: jobGuard,
    });
    state.ctx.agents = { create: async () => { throw new Error("no worker may start"); } };
    state.ctx.workingDirectory = { get: () => presetRepo };
    state.ctx.agentPresets = buildPresets({
      register: (definition) => { seen.definition = definition; return async () => {}; },
      resolve: async (id) => { seen.resolvedId = id; return { id }; },
    });
    apply(state.ctx, { wikiDirName: ".dsh-wiki", wikiRoots: [presetRepo], jobs: { enabled: true, storeDir: presetStore } });
    await waitFor(() => state.warnings.length > 0 || seen.managers > 0, `${name} preset decision`);
    const client = makeClient(state.registered.routes[0].handler);
    const getRes = await client.get(`/dsh-wiki/api/jobs?root=${encodeURIComponent(presetRepo)}`);
    const postRes = await client.post("/dsh-wiki/api/jobs", { root: presetRepo, action: "generate", model: { provider: "p", model: "m" } });
    await disposeAll(state);
    return { state, seen, getRes, postRes };
  };

  // 没有 resolve()：无法读 activation 诊断 => 开启即拒绝。
  const noResolve = await runPresetCase("preset-no-resolve", (base) => {
    const { resolve, ...rest } = presetService(base);
    return rest;
  });
  check("preset fail-closed: without agentPresets.resolve() jobs stay shut (503 preset-activation-failed)",
    noResolve.getRes.status === 503 && noResolve.getRes.json?.code === "preset-activation-failed"
    && noResolve.getRes.json?.error === "the worker agent preset could not be activated; background jobs stay disabled"
    && noResolve.seen.managers === 0 && noResolve.postRes.status === 503,
    `${noResolve.getRes.status} ${noResolve.getRes.body.slice(0, 200)}`);
  check("preset fail-closed: no worker session/preset registration happens for a refused prerequisite",
    noResolve.seen.definition === null && !existsSync(presetStore));

  // 没有 composedPreset()：无法证明 mount 真的绑定到这个 agent => 开启即拒绝。
  const noComposed = await runPresetCase("preset-no-composed", (base) => {
    const { composedPreset, ...rest } = presetService(base);
    return rest;
  });
  check("preset fail-closed: without agentPresets.composedPreset() the binding is unprovable (503 preset-unverifiable)",
    noComposed.getRes.status === 503 && noComposed.getRes.json?.code === "preset-unverifiable"
    && noComposed.getRes.json?.error === "this Host cannot confirm that the worker agent preset is mounted; background jobs stay disabled"
    && noComposed.seen.managers === 0,
    `${noComposed.getRes.status} ${noComposed.getRes.body.slice(0, 200)}`);

  // resolve() 报告 broken：activation 失败在 rc.1 是“可见但不抛”的，必须主动读并且当真。
  const brokenPreset = await runPresetCase("preset-broken", (base) => presetService({
    ...base,
    resolve: async () => ({ id: "dsh-wiki-worker", broken: "activation exploded at C:\\private\\preset.yml" }),
  }));
  check("preset fail-closed: a broken activation diagnostic refuses to enable (503 preset-activation-failed)",
    brokenPreset.getRes.status === 503 && brokenPreset.getRes.json?.code === "preset-activation-failed"
    && brokenPreset.seen.managers === 0
    && !brokenPreset.getRes.body.includes("private") && !/activation exploded/.test(brokenPreset.getRes.body),
    `${brokenPreset.getRes.status} ${brokenPreset.getRes.body.slice(0, 240)}`);
  check("preset fail-closed: the broken diagnostic still reaches the logger",
    brokenPreset.state.warnings.some((w) => /activation exploded/.test(w)), JSON.stringify(brokenPreset.state.warnings));

  // 正向对照：注册的是固定 definition，resolve 读的是同一个固定 id，管理器拿到的也是固定 id。
  const goodPreset = await runPresetCase("preset-good", (base) => presetService(base));
  check("preset binding: register() and resolve() both use the one fixed worker preset id",
    goodPreset.seen.managers === 1 && goodPreset.seen.definition?.id === "dsh-wiki-worker"
    && goodPreset.seen.resolvedId === "dsh-wiki-worker" && goodPreset.seen.options?.presetId === "dsh-wiki-worker"
    && goodPreset.seen.options?.agentPresets?.composedPreset !== undefined
    && goodPreset.getRes.status === 200 && goodPreset.getRes.json?.disabled === false,
    JSON.stringify({ register: goodPreset.seen.definition?.id, resolve: goodPreset.seen.resolvedId,
      presetId: goodPreset.seen.options?.presetId, get: goodPreset.getRes.status }));
}

// 20h. /api/site：受控读在证明路径之后仍可能失败（open 被拒/EACCES）。必须回固定 JSON 错误，
//      绝不把 fs 异常抛给路由。读已经改成“从句柄读字节”，所以注入点也从 readFile 变成 open。
{
  const siteCtx = makeCtx("site");
  apply(siteCtx.ctx, { wikiDirName: ".dsh-wiki", wikiRoots: [repo, repoNoSite] });
  const siteClient = makeClient(siteCtx.registered.routes[0].handler);
  const siteUrl = `/dsh-wiki/site?path=${encodeURIComponent(path.join(repo, ".dsh-wiki"))}`;
  const realOpen = __siteInternals.open;
  __siteInternals.open = async () => { throw Object.assign(new Error("EACCES: permission denied, open 'secret'"), { code: "EACCES" }); };
  let readFailedThrew = null;
  let readFailed = null;
  try { readFailed = await siteClient.get(siteUrl); } catch (error) { readFailedThrew = error; }
  __siteInternals.open = realOpen;
  check("site: a read failure after the containment check answers the fixed error shape instead of throwing",
    readFailedThrew === null && readFailed?.status === 500 && readFailed?.json?.code === "internal-error"
    && readFailed?.json?.error === "the request could not be completed",
    `${readFailed?.status} ${String(readFailedThrew)} ${readFailed?.body?.slice(0, 160)}`);
  check("site: the read failure never echoes the fs error or a path",
    readFailed?.status === 500 && !/EACCES/.test(readFailed.body) && !readFailed.body.includes(repo));
  check("site: the fixed 500 is logged with its real reason", siteCtx.warnings.some((w) => /EACCES/.test(w)), JSON.stringify(siteCtx.warnings));
  const missing = await siteClient.get(`/dsh-wiki/site?path=${encodeURIComponent(path.join(repoNoSite, ".dsh-wiki"))}`);
  check("site: a missing site still answers the fixed 404 (no throw)", missing.status === 404 && typeof missing.json?.error === "string");
  const healthy = await siteClient.get(siteUrl);
  check("site: the healthy path still serves the page", healthy.status === 200 && healthy.body.includes("demo"));
  await disposeAll(siteCtx);
}

// 20i. 同源判定：默认端口按 scheme 归一、Host 头按 URI 语法解析（方括号 IPv6）。
{
  const sameOrigin = (headers, encrypted = false) => isSameOrigin({ headers, socket: { encrypted } });
  check("origin: Host :443 with Origin https://host (default port elided) is the same origin",
    sameOrigin({ host: "127.0.0.1:443", origin: "https://127.0.0.1" }, true) === true);
  check("origin: Host without a port with Origin http://host:80 is the same origin",
    sameOrigin({ host: "127.0.0.1", origin: "http://127.0.0.1:80" }) === true);
  check("origin: an https Origin still never matches a plain-http listener",
    sameOrigin({ host: "127.0.0.1:443", origin: "https://127.0.0.1" }, false) === false);
  check("origin: a different port stays cross-origin", sameOrigin({ host: "127.0.0.1:19388", origin: "http://127.0.0.1:9999" }) === false);
  check("origin: bracketed IPv6 loopback Host/Origin match",
    sameOrigin({ host: "[::1]:8080", origin: "http://[::1]:8080" }) === true);
  check("origin: a non-loopback origin is refused", sameOrigin({ host: "127.0.0.1:19388", origin: "http://evil.example.com" }) === false);
  check("host header: bracketed IPv6 parses to a loopback hostname and its port",
    parseHostHeader("[::1]:8080")?.hostname === "::1" && parseHostHeader("[::1]:8080")?.port === "8080");
  check("host header: an unbracketed IPv6 literal is not a valid Host", parseHostHeader("::1") === null);

  // 20i2. 回归：Host 头的显式端口绝不能被剥掉后重读成另一种 scheme 的默认端口。
  //       缺陷：parseHostHeader 按 `http://` 解析（URL 顺手去掉 :80），随后空端口又被当成
  //       当前 scheme 的默认值；TLS 监听上的 Host: 127.0.0.1:80 因此会与 Origin https://127.0.0.1
  //       （默认 443）比较相等。修复后：先由传输定 scheme，默认端口只从该 scheme 派生，
  //       显式端口原样比较。契约仍是浏览器 CSRF 检查，不是调用方身份认证。
  check("origin: http Host :80 vs https Origin is cross-origin (plain transport)",
    sameOrigin({ host: "127.0.0.1:80", origin: "https://127.0.0.1" }) === false);
  check("origin: an explicit Host :80 is never reinterpreted as https :443 (TLS transport)",
    sameOrigin({ host: "127.0.0.1:80", origin: "https://127.0.0.1" }, true) === false);
  check("origin: https Host without a port matches Origin https://host (scheme default 443)",
    sameOrigin({ host: "127.0.0.1", origin: "https://127.0.0.1" }, true) === true);
  check("origin: https Host :443 matches an elided Origin port",
    sameOrigin({ host: "127.0.0.1:443", origin: "https://127.0.0.1" }, true) === true);
  check("origin: http Host without a port matches Origin http://host (scheme default 80)",
    sameOrigin({ host: "127.0.0.1", origin: "http://127.0.0.1" }) === true);
  check("origin: http Host :80 matches Origin http://host:80",
    sameOrigin({ host: "127.0.0.1:80", origin: "http://127.0.0.1:80" }) === true);
  check("origin: mismatched explicit ports are cross-origin",
    sameOrigin({ host: "127.0.0.1:8080", origin: "http://127.0.0.1:8081" }) === false);
  check("origin: bracketed IPv6 loopback matches only on the same port",
    sameOrigin({ host: "[::1]:8080", origin: "http://[::1]:8080" }) === true
    && sameOrigin({ host: "[::1]:8080", origin: "http://[::1]:8081" }) === false);
  check("origin: a missing Origin is cross-origin", sameOrigin({ host: "127.0.0.1:19388" }) === false);
  check("origin: an https Origin on a different explicit port is cross-origin",
    sameOrigin({ host: "127.0.0.1:8443", origin: "https://127.0.0.1" }, true) === false);
  check("host header: an explicit port is kept verbatim, never replaced by a scheme default",
    parseHostHeader("127.0.0.1:80")?.port === "80" && parseHostHeader("127.0.0.1:443")?.port === "443"
    && parseHostHeader("127.0.0.1")?.port === "" && parseHostHeader("[::1]:80")?.port === "80");
  // 路由外层的 Host 分流同样必须认识 [::1]:port（以前会 403 untrusted host）。
  const ipv6Ctx = makeCtx("ipv6");
  apply(ipv6Ctx.ctx, { wikiDirName: ".dsh-wiki", wikiRoots: [repo] });
  const ipv6Client = makeClient(ipv6Ctx.registered.routes[0].handler);
  const ipv6Status = await ipv6Client.get("/dsh-wiki/api/status", "[::1]:19388");
  check("host header: the route gate accepts a bracketed IPv6 loopback Host (previously 403)",
    ipv6Status.status === 200 && ipv6Status.json?.ok === true, `${ipv6Status.status} ${ipv6Status.body.slice(0, 120)}`);
  const badHost = await ipv6Client.get("/dsh-wiki/api/status", "::1");
  check("host header: an unbracketed IPv6 Host is refused by the route gate", badHost.status === 403);
  await disposeAll(ipv6Ctx);
}

// 20j. 规范化解不开的 allowlist 根：storeDir 是否“在根之外”就无法证明 => mkdir 之前拒绝，绝不退回词法比较。
{
  const base = tempDir("dsh-wiki-uncanonical-");
  const target = path.join(base, "target");
  mkdirSync(target, { recursive: true });
  const link = path.join(base, "linked-root");
  let junctionOk = true;
  try { symlinkSync(target, link, "junction"); } catch { junctionOk = false; }
  if (!junctionOk) {
    console.log("SKIP uncanonical allowlist root test (junction creation unavailable on this filesystem)");
  } else {
    const storeDir = path.join(base, "plain", "journal");
    const state = makeCtx("uncanonical");
    let opened = 0;
    spyJobsInternals({
      openJournalStore: async () => { opened++; return { load: async () => null, create: async () => ({}), advance: async () => ({}), replaceTerminal: async () => ({}) }; },
      createJobManager: () => ({ start: () => ({ id: "j" }), cancel: () => ({ canceled: false }), view: () => ({ active: null, last: null }), journalState: () => ({ mode: "journal", missing: [] }), dispose: async () => ({ unresolved: [] }) }),
      createWorkerGuard: jobGuard,
    });
    state.ctx.agents = { create: async () => ({}) };
    state.ctx.workingDirectory = { get: () => link };
    state.ctx.agentPresets = presetService();
    apply(state.ctx, { wikiDirName: ".dsh-wiki", wikiRoots: [link], jobs: { enabled: true, storeDir } });
    await waitFor(() => state.warnings.length > 0 || opened > 0, "uncanonical root decision");
    const client = makeClient(state.registered.routes[0].handler);
    const res = await client.post("/dsh-wiki/api/jobs", { root: link, action: "generate", model: { provider: "p", model: "m" } });
    check("store: an allowlist root that cannot be canonicalized refuses the store before any mkdir",
      opened === 0 && !existsSync(path.join(base, "plain")) && res.status === 503,
      `opened=${opened} created=${existsSync(path.join(base, "plain"))} status=${res.status}`);
    check("store: the refusal is a fixed public error with no store path",
      // 允许的根在 apply 时已知 => 构造期就打开 store，失败即 fail closed（不是 202，也不是原始 fs 文本）。
      // 2026-11-09: 不可信根现在有独立公开 code（root-untrusted），不再是笼统的 jobs-initialization-failed。
      res.status === 503 && res.json?.code === "root-untrusted"
      && typeof res.json?.error === "string" && res.json.error.length > 0 && !res.body.includes(base),
      `${res.status} ${res.body.slice(0, 200)}`);
    check("store: the real reason (junction root) is kept in the logger only",
      state.warnings.some((w) => /not trusted canonical director|not a trusted canonical directory/.test(w)), JSON.stringify(state.warnings));
    await disposeAll(state);
  }
}

// 20k. hostInstanceId 必须通过 journal-store **自己的** token 规则。
//      根因（实测）：它曾经写成 `dsh-wiki:<uuid>`；':' 不被 readToken（/^[A-Za-z0-9][A-Za-z0-9._-]*$/）接受，
//      openJournalStore 抛 invalid-options，整个后台运行时只报一句通用的 jobs-initialization-failed。
//      20c 的假 store 只检查“非空字符串”，所以这类缺陷在套件里当时是看不见的。这里用**插件真正构造的
//      那个值**跑真实的 openJournalStore，并用旧写法做回归守卫。
{
  const JOURNAL_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
  const liveHostId = fakeStore.options?.hostInstanceId; // 20c 里真正交给 openJournalStore 的值
  check("host id: the plugin-built hostInstanceId satisfies the journal token rule",
    typeof liveHostId === "string" && JOURNAL_TOKEN_RE.test(liveHostId)
    && !liveHostId.includes("..") && !liveHostId.endsWith("."), String(liveHostId));
  check("host id: the manager is given the same id the store is opened with",
    typeof liveHostId === "string" && fakeManager.options?.hostInstanceId === liveHostId,
    JSON.stringify({ store: String(liveHostId), manager: String(fakeManager.options?.hostInstanceId) }));
  const firstId = makeHostInstanceId();
  const secondId = makeHostInstanceId();
  check("host id: makeHostInstanceId() is token-safe, prefixed and unique per apply",
    JOURNAL_TOKEN_RE.test(firstId) && JOURNAL_TOKEN_RE.test(secondId) && firstId !== secondId
    && firstId.startsWith("dsh-wiki.") && liveHostId?.startsWith("dsh-wiki."),
    JSON.stringify({ firstId, secondId, live: String(liveHostId) }));

  const idBase = tempDir("dsh-wiki-hostid-");
  const idRoot = path.join(idBase, "repo");
  const idStore = path.join(idBase, "journal");
  mkdirSync(idRoot, { recursive: true });
  mkdirSync(idStore, { recursive: true });
  const openOptions = { storeDir: idStore, allowedRoots: [idRoot], hostInstanceId: liveHostId };
  const openedStore = await REAL_JOBS_INTERNALS.openJournalStore(openOptions);
  check("host id: the real openJournalStore accepts the id the plugin built",
    openedStore?.hostInstanceId === liveHostId && typeof openedStore?.load === "function",
    String(openedStore?.hostInstanceId));
  check("host id: opening a store writes nothing into the fresh store directory",
    readdirSync(idStore).length === 0, JSON.stringify(readdirSync(idStore)));
  let legacyError = null;
  try {
    await REAL_JOBS_INTERNALS.openJournalStore({ ...openOptions, hostInstanceId: `dsh-wiki:${globalThis.crypto.randomUUID()}` });
  } catch (error) { legacyError = error; }
  check("host id: the pre-fix 'dsh-wiki:<uuid>' spelling is refused by the real validator (regression guard)",
    legacyError?.code === "invalid-options", String(legacyError?.code ?? legacyError));
}

// 20L. store 构造失败必须是**独立**的公开 code（journal-store-unavailable），而不是笼统的
//      jobs-initialization-failed；响应体只有固定短句（无路径），原始原因只进 logger。
//      这里不替换 store：storeDir 落在 allowlist 根内部，ensureJobStoreDir 会在任何 mkdir 之前拒绝。
{
  const failBase = tempDir("dsh-wiki-storefail-");
  const failRoot = path.join(failBase, "repo");
  mkdirSync(failRoot, { recursive: true });
  const insideStore = path.join(failRoot, "journal");
  const opensBefore = jobProbe.openJournalStore;
  const state = makeCtx("storefail");
  spyJobsInternals(); // 真实的 store/manager/guard：manager 不会 start，不启动 worker
  state.ctx.agents = { create: async () => { throw new Error("no worker may start"); } };
  state.ctx.workingDirectory = { get: () => failRoot };
  state.ctx.agentPresets = presetService();
  apply(state.ctx, { wikiDirName: ".dsh-wiki", wikiRoots: [failRoot], jobs: { enabled: true, storeDir: insideStore } });
  await waitFor(() => state.warnings.length > 0, "store failure decision");
  const client = makeClient(state.registered.routes[0].handler);
  const getRes = await client.get(`/dsh-wiki/api/jobs?root=${encodeURIComponent(failRoot)}`);
  check("journal store failure: the runtime reports the distinct public code journal-store-unavailable",
    getRes.status === 503 && getRes.json?.code === "journal-store-unavailable"
    && getRes.json?.error === "the trusted journal store is unavailable" && getRes.json?.disabled === true,
    `${getRes.status} ${getRes.body.slice(0, 200)}`);
  check("journal store failure: the body stays path-free (fixed code + fixed sentence only)",
    Object.keys(getRes.json ?? {}).sort().join(",") === "code,disabled,error"
    && !getRes.body.includes(failRoot) && !getRes.body.includes(insideStore)
    && !getRes.body.includes(path.dirname(insideStore)), getRes.body.slice(0, 200));
  check("journal store failure: the real reason (with its path) still reaches the logger",
    state.warnings.some((w) => /journal-store-unavailable/.test(w) && w.includes(failRoot)),
    JSON.stringify(state.warnings));
  check("journal store failure: the store was never opened (the refusal happens before openJournalStore)",
    jobProbe.openJournalStore === opensBefore, `${opensBefore} -> ${jobProbe.openJournalStore}`);
  const postRes = await client.post("/dsh-wiki/api/jobs", { root: failRoot, action: "generate", model: { provider: "p", model: "m" } });
  check("journal store failure: POST stays 503 with the same code and never starts a job",
    postRes.status === 503 && postRes.json?.code === "journal-store-unavailable",
    `${postRes.status} ${postRes.body.slice(0, 160)}`);
  await disposeAll(state);
}

// 20M. 一个不可信的根只跳过它自己：其余白名单照常可用（运行时 ready），而它永远不会出现在交给
//      store 或 manager 的白名单里 —— 因此作业侧仍然拒绝它（jobs.js createJournal 对链接根报
//      root-untrusted，对不在白名单的规范根报 root-not-allowed），保证没有被放宽。
{
  const mixBase = tempDir("dsh-wiki-mixedroot-");
  const goodRoot = path.join(mixBase, "good-repo");
  const linkTarget = path.join(mixBase, "linked-target");
  mkdirSync(goodRoot, { recursive: true });
  mkdirSync(linkTarget, { recursive: true });
  const linkedRoot = path.join(mixBase, "linked-root");
  let junctionOk = true;
  try { symlinkSync(linkTarget, linkedRoot, "junction"); } catch { junctionOk = false; }
  if (!junctionOk) {
    console.log("SKIP mixed untrusted-root test (junction creation unavailable on this filesystem)");
  } else {
    const asKey = (value) => (process.platform === "win32" ? String(value).toLowerCase() : String(value));
    const state = makeCtx("mixedroot");
    const storesSeen = [];
    let managerOptions = null;
    spyJobsInternals({
      openJournalStore: async (options) => {
        jobProbe.openJournalStore++;
        storesSeen.push(options);
        return { load: async () => null, create: async () => ({}), advance: async () => ({}), replaceTerminal: async () => ({}) };
      },
      createJobManager: (options) => {
        jobProbe.createJobManager++;
        managerOptions = options;
        return {
          start: () => ({ id: "job1" }), cancel: () => ({ canceled: false }), view: () => ({ active: null, last: null }),
          journalState: () => ({ mode: "journal", missing: [] }), dispose: async () => ({ unresolved: [] }),
        };
      },
      createWorkerGuard: jobGuard,
    });
    state.ctx.agents = { create: async () => ({}) };
    state.ctx.workingDirectory = { get: () => goodRoot };
    state.ctx.agentPresets = presetService();
    apply(state.ctx, { wikiDirName: ".dsh-wiki", wikiRoots: [goodRoot, linkedRoot], jobs: { enabled: true, storeDir: path.join(mixBase, "journal") } });
    await waitFor(() => storesSeen.length > 0 || state.warnings.length > 0, "mixed-root store decision");
    const client = makeClient(state.registered.routes[0].handler);
    const getRes = await client.get(`/dsh-wiki/api/jobs?root=${encodeURIComponent(goodRoot)}`);
    check("mixed roots: one untrusted root is skipped and the runtime still becomes ready",
      getRes.status === 200 && getRes.json?.disabled === false && storesSeen.length === 1,
      `${getRes.status} ${getRes.body.slice(0, 200)}`);
    const storeRoots = storesSeen[0]?.allowedRoots ?? [];
    check("mixed roots: the store is opened with the trusted roots only",
      storesSeen[0]?.storeDir === path.join(mixBase, "journal")
      && storeRoots.some((root) => asKey(root) === asKey(goodRoot))
      && !storeRoots.some((root) => asKey(root) === asKey(linkedRoot)),
      JSON.stringify(storeRoots));
    const managerRoots = typeof managerOptions?.allowedRoots === "function"
      ? await managerOptions.allowedRoots() : managerOptions?.allowedRoots;
    check("mixed roots: the manager allowlist excludes the skipped root, so a job for it is refused",
      Array.isArray(managerRoots)
      && managerRoots.some((root) => asKey(root) === asKey(goodRoot))
      && !managerRoots.some((root) => asKey(root) === asKey(linkedRoot)),
      JSON.stringify(managerRoots));
    check("mixed roots: the skip is reported exactly once, bounded, and never in a response body",
      state.warnings.filter((w) => w.includes(linkedRoot)).length === 1
      && !getRes.body.includes(linkedRoot) && !getRes.body.includes(mixBase),
      JSON.stringify(state.warnings));
    // 同一份白名单交给真实的 store：被跳过的根（即使是它指向的规范目录）不能绑定任何 journal 记录。
    const realStore = await REAL_JOBS_INTERNALS.openJournalStore({
      storeDir: storesSeen[0].storeDir,
      allowedRoots: storeRoots,
      hostInstanceId: makeHostInstanceId(),
    });
    let untrustedBindError = null;
    try { await realStore.load(linkTarget); } catch (error) { untrustedBindError = error; }
    check("mixed roots: the real store refuses a skipped root's canonical target (root-not-allowed)",
      untrustedBindError?.code === "root-not-allowed", String(untrustedBindError?.code ?? untrustedBindError));
    await disposeAll(state);
  }
}

// ---------- review fixes 2026-11-09 ----------

// 21. defect 1：卸载绝不释放“未证明停下”的 worker 的 guard activation。
//     用真实的 createWorkerGuard：release 一个 activation 之后，authorizeSync 会把这个 agent 当成
//     “非 worker”（not-worker => allow），也就是卸载会把一个仍在运行的 worker 解放成无围栏进程。
const makeGuardFixture = () => {
  const base = tempDir("dsh-wiki-guardfix-");
  const repoRoot = path.join(base, "repo");
  const stageA = path.join(base, "stage-a");
  const stageB = path.join(base, "stage-b");
  for (const dir of [repoRoot, stageA, stageB]) mkdirSync(dir, { recursive: true });
  const guard = REAL_JOBS_INTERNALS.createWorkerGuard({ getEffectiveCwd: () => repoRoot });
  guard.activate("agent-live", { repoRoot, stagingRoot: stageA, cwd: repoRoot });
  guard.activate("agent-stopped", { repoRoot, stagingRoot: stageB, cwd: repoRoot });
  return { base, repoRoot, stageA, stageB, guard };
};
/**
 * jobs.enabled=true + 真实 guard + 受控 manager：manager.dispose() 返回 `unresolved`，
 * 卸载后再检查每个 agent 的围栏是否还在。
 */
const guardUnloadCase = async ({ name, unresolved, disposeError = null }) => {
  const fixture = makeGuardFixture();
  const state = makeCtx(name);
  let disposed = 0;
  const manager = {
    start: () => ({ id: "job-x" }), cancel: () => ({ canceled: false }),
    view: () => ({ active: null, last: null }), journalState: () => ({ mode: "journal", missing: [] }),
    async dispose() {
      disposed++;
      if (disposeError) throw disposeError;
      return { unresolved: unresolved.map((row) => ({ ...row, root: fixture.repoRoot })) };
    },
  };
  spyJobsInternals({
    openJournalStore: async () => ({ load: async () => null, create: async () => ({}), advance: async () => ({}), replaceTerminal: async () => ({}) }),
    createJobManager: () => manager,
    createWorkerGuard: () => fixture.guard,
  });
  state.ctx.agents = { create: async () => ({}) };
  state.ctx.workingDirectory = { get: () => fixture.repoRoot };
  state.ctx.agentPresets = presetService();
  apply(state.ctx, { wikiDirName: ".dsh-wiki", wikiRoots: [], jobs: { enabled: true, storeDir: path.join(fixture.base, "journal") } });
  await waitFor(() => state.registered.routes.length === 1, `${name} fixture`);
  await disposeAll(state);
  return { ...fixture, state, disposed: () => disposed };
};

// 21a. 前提：没有 activation 的 agent 被当成“非 worker”放行 —— 这就是释放 activation 的危险。
{
  const fixture = makeGuardFixture();
  const stranger = fixture.guard.authorizeSync({ agent: { id: "stranger" }, name: "bash", arguments: {} });
  check("fix1 premise: an agent without an activation is treated as a non-worker (allowed), so releasing one drops confinement",
    stranger.allow === true && stranger.code === "not-worker", JSON.stringify(stranger));
}

// 21b. 隔离/未证明停下的 worker：卸载后 activation 仍在，工具仍被拒绝。
{
  const { guard, repoRoot, state } = await guardUnloadCase({
    name: "unproven", unresolved: [{ jobId: "job-live", sessionId: "agent-live" }],
  });
  check("fix1: unload keeps the guard activation of an unproven worker",
    guard.isActive("agent-live") === true, JSON.stringify(guard.activeAgentIds()));
  const bash = guard.authorizeSync({ agent: { id: "agent-live" }, name: "bash", arguments: {} });
  check("fix1: the retained worker is still denied its tools after unload",
    bash.allow === false && bash.code === "tool-not-allowed", JSON.stringify(bash));
  const outside = guard.authorizeSync({
    agent: { id: "agent-live" }, name: "write",
    arguments: { file_path: path.join(repoRoot, "leak.md"), content: "x" },
  });
  check("fix1: the retained worker still cannot write outside its staging directory",
    outside.allow === false, JSON.stringify(outside));
  check("fix1: only the unproven worker is retained; the proven-stopped one is released",
    guard.isActive("agent-stopped") === false, JSON.stringify(guard.activeAgentIds()));
  check("fix1: exactly one truthful warning names the retained agent, process exit and reconcile",
    state.warnings.filter((w) => /retained until process exit/.test(w)).length === 1
    && state.warnings.some((w) => /retained until process exit/.test(w) && w.includes("agent-live") && /reconcile is required/.test(w)),
    JSON.stringify(state.warnings));
}

// 21c. 全部确认停下：正常释放整个 guard（不留下永久泄漏的 activation）。
{
  const { guard, state } = await guardUnloadCase({ name: "proven", unresolved: [] });
  check("fix1: proven-stopped jobs release every activation on unload",
    guard.activeAgentIds().length === 0, JSON.stringify(guard.activeAgentIds()));
  check("fix1: a clean unload logs no retained-confinement warning",
    !state.warnings.some((w) => /retained until process exit/.test(w)), JSON.stringify(state.warnings));
}

// 21d. 混合：只释放确认停下的那个，保留未证明停下的那个。
{
  const { guard } = await guardUnloadCase({
    name: "mixed", unresolved: [{ jobId: "job-live", sessionId: "agent-live" }],
  });
  check("fix1: mixed unload releases only the proven-stopped agent",
    guard.isActive("agent-stopped") === false && guard.isActive("agent-live") === true,
    JSON.stringify(guard.activeAgentIds()));
  check("fix1: the retained agent stays denied while the released one is unrestricted by the guard",
    guard.authorizeSync({ agent: { id: "agent-live" }, name: "bash", arguments: {} }).allow === false
    && guard.authorizeSync({ agent: { id: "agent-stopped" }, name: "bash", arguments: {} }).allow === true);
}

// 22. defect 2：不支持的字段/模式必须在 manager.start 之前显式拒绝，绝不静默丢弃。
{
  const fixtures = [];
  const makeJobs = async (name) => {
    const dir = tempDir(`dsh-wiki-req-${name}-`);
    const repoRoot = path.join(dir, "repo");
    mkdirSync(repoRoot, { recursive: true });
    const state = makeCtx(name);
    const starts = [];
    let storeOpens = 0;
    // 增量前置解析的替身（spec 013）：harness 只验证**路由的 §2.1 真值表**与“拒绝不启动作业”。
    // 真正的基线/祖先/diff-impact 解析在 jobs-harness-test 里用真 jobs.js 覆盖。
    const plan = {
      mode: "incremental",
      baseline: "a".repeat(40),
      head: "b".repeat(40),
      pages: [{ id: "overview", filePaths: ["README.md"] }],
      cards: [],
      unmappedFiles: ["docs/notes.md"],
      changedFiles: 2,
    };
    const planner = { next: () => plan };
    spyJobsInternals({
      openJournalStore: async () => { storeOpens += 1; return { load: async () => null, create: async () => ({}), advance: async () => ({}), replaceTerminal: async () => ({}) }; },
      createJobManager: () => ({
        start: (request) => { starts.push(request); return { id: "job1" }; },
        incrementalPlan: async () => planner.next(),
        cancel: () => ({ canceled: false }), view: () => ({ active: null, last: null }),
        journalState: () => ({ mode: "journal", missing: [] }), dispose: async () => ({ unresolved: [] }),
      }),
      createWorkerGuard: () => ({ activate: () => () => {}, authorizeSync: () => ({ allow: true }), releaseAll: () => {}, activeAgentIds: () => [], release: () => false }),
    });
    state.ctx.agents = { create: async () => ({}) };
    state.ctx.workingDirectory = { get: () => repoRoot };
    state.ctx.agentPresets = presetService();
    apply(state.ctx, { wikiDirName: ".dsh-wiki", wikiRoots: [repoRoot], jobs: { enabled: true, storeDir: path.join(dir, "journal") } });
    await waitFor(() => state.registered.routes.length === 1, `${name} runtime`);
    fixtures.push(state);
    return { state, client: makeClient(state.registered.routes[0].handler), repoRoot, starts, planner, opens: () => storeOpens, storeDir: path.join(dir, "journal") };
  };
  const req = await makeJobs("incremental");
  const body = { root: req.repoRoot, action: "generate", model: { provider: "p", model: "m" } };
  const updateBody = { ...body, action: "update" };
  const refusedWithoutJob = async (label, patch, status, code) => {
    const before = req.starts.length;
    const r = await req.client.post("/dsh-wiki/api/jobs", { ...body, ...patch });
    check(`spec013: ${label} is refused (${status} ${code}) and starts no job`,
      r.status === status && r.json?.code === code && req.starts.length === before,
      `${r.status} ${r.body.slice(0, 200)}`);
    return r;
  };
  // §2.1 真值表：incremental 只和 action:"update" 一起被接受。
  await refusedWithoutJob("incremental:true on generate", { incremental: true }, 400, "incremental-not-for-generate");
  await refusedWithoutJob("incremental:true on translate", { action: "translate", targetLang: "vi", incremental: true }, 400, "incremental-not-for-translate");
  await refusedWithoutJob("incremental as an object", { action: "update", incremental: { mode: "diff" } }, 400, "invalid-incremental");
  await refusedWithoutJob("incremental as a string", { action: "update", incremental: "true" }, 400, "invalid-incremental");
  await refusedWithoutJob("incremental as null", { action: "update", incremental: null }, 400, "invalid-incremental");
  // 拒绝必须是显式 409（不是 202 + 失败作业，也不是静默全量重建），并且不打开 journal store、不建目录。
  req.planner.next = () => { throw Object.assign(new Error("no live wiki"), { status: 409, code: "incremental-no-baseline" }); };
  const noBaseline = await refusedWithoutJob("incremental with no published baseline", { action: "update", incremental: true }, 409, "incremental-no-baseline");
  check("spec013: the no-baseline refusal names what is missing and suggests a full update",
    /sourceCommit/i.test(noBaseline.json?.error ?? "") && /full update/i.test(noBaseline.json?.error ?? ""),
    String(noBaseline.json?.error));
  // 拒绝必须是**显式**的：没有作业、没有 202、响应体里没有仓库路径（路径与原始文本只进 logger）。
  check("spec013: the five refusals above started no job, returned no 202 and carried no repository path",
    req.starts.length === 0 && !noBaseline.body.includes(req.repoRoot) && noBaseline.status === 409,
    `${req.starts.length} ${noBaseline.body.slice(0, 200)}`);
  // HEAD == 基线（review minor）：没有新提交就没有事可做 => 显式 409，绝不是一个“已接纳、随后无事发生”的作业。
  req.planner.next = () => { throw Object.assign(new Error("up to date"), { status: 409, code: "incremental-up-to-date" }); };
  const upToDate = await refusedWithoutJob("incremental whose published wiki already matches HEAD", { action: "update", incremental: true }, 409, "incremental-up-to-date");
  check("spec013: the up-to-date refusal keeps its fixed sentence (already matches HEAD, suggests a full update) and no path",
    upToDate.json?.error === PUBLIC_ERROR_MESSAGES["incremental-up-to-date"]
    && /matches HEAD/i.test(upToDate.json?.error ?? "") && /full update/i.test(upToDate.json?.error ?? "")
    && !upToDate.body.includes(req.repoRoot), upToDate.body.slice(0, 240));
  const BUILDER_LINE = "diff-impact failed: git is not installed or not on PATH";
  req.planner.next = () => {
    throw Object.assign(new Error(BUILDER_LINE), { status: 409, code: "incremental-unavailable", builderLine: BUILDER_LINE });
  };
  const unavailable = await refusedWithoutJob("incremental whose diff-impact fails", { action: "update", incremental: true }, 409, "incremental-unavailable");
  check("spec013: the diff-impact refusal carries the builder's first line as a bounded detail",
    unavailable.json?.detail === BUILDER_LINE && typeof unavailable.json?.error === "string"
    && unavailable.json.error !== BUILDER_LINE, unavailable.body.slice(0, 240));
  req.planner.next = () => { throw Object.assign(new Error("not an ancestor"), { status: 409, code: "incremental-baseline-diverged" }); };
  await refusedWithoutJob("incremental whose baseline is not an ancestor of HEAD", { action: "update", incremental: true }, 409, "incremental-baseline-diverged");
  // 接受路径：incremental:true + update => 202，且 plan 原样交给 manager.start。
  req.planner.next = () => ({
    mode: "incremental", baseline: "c".repeat(40), head: "d".repeat(40),
    pages: [{ id: "overview", filePaths: ["README.md"] }], cards: [], unmappedFiles: [], changedFiles: 1,
  });
  let r2 = await req.client.post("/dsh-wiki/api/jobs", { ...updateBody, incremental: true });
  check("spec013: incremental:true + update is accepted (202) and hands the resolved plan to the manager",
    r2.status === 202 && req.starts.length === 1 && req.starts[0].action === "update"
    && req.starts[0].incremental?.mode === "incremental"
    && req.starts[0].incremental?.baseline === "c".repeat(40)
    && req.starts[0].incremental?.pages?.[0]?.id === "overview", `${r2.status} ${r2.body.slice(0, 240)}`);
  r2 = await req.client.post("/dsh-wiki/api/jobs", { ...body, mode: "incremental" });
  check("fix2: an unknown top-level field is rejected (400) instead of dropped",
    r2.status === 400 && r2.json?.code === "unsupported-field"
    && Array.isArray(r2.json?.unsupportedFields) && r2.json.unsupportedFields.includes("mode"),
    `${r2.status} ${r2.body.slice(0, 200)}`);
  r2 = await req.client.post("/dsh-wiki/api/jobs", { ...body, model: { provider: "p", model: "m", temperature: 1 } });
  check("fix2: an unknown nested model field is rejected (400) instead of dropped",
    r2.status === 400 && r2.json?.unsupportedFields?.includes("model.temperature"), `${r2.status} ${r2.body.slice(0, 200)}`);
  r2 = await req.client.post("/dsh-wiki/api/jobs/cancel", { root: req.repoRoot, action: "generate" });
  check("fix2: an unsupported field on the cancel endpoint is rejected (400)",
    r2.status === 400 && r2.json?.code === "unsupported-field");
  r2 = await req.client.post("/dsh-wiki/api/jobs", { ...body, incremental: false });
  check("fix2: explicit incremental:false keeps the supported full-generate path (no silent downgrade claim)",
    r2.status === 202 && req.starts.length === 2 && r2.json?.job?.id === "job1", `${r2.status} ${r2.body.slice(0, 160)}`);
  check("fix2: the full-generate request reaches the manager without any incremental plan",
    req.starts[1] !== undefined && req.starts[1].incremental === undefined, JSON.stringify(req.starts[1] ?? null));

  // 22b. Origin scheme 必须与请求实际使用的传输一致：https 的 Origin 不能被 http 监听当成同源。
  r2 = await req.client.post("/dsh-wiki/api/jobs", body, { origin: "https://127.0.0.1:19388" });
  check("fix2: an https Origin against the plain-http loopback listener is refused (403)",
    r2.status === 403, `${r2.status} ${r2.body.slice(0, 160)}`);
  r2 = await req.client.post("/dsh-wiki/api/jobs", body, { origin: "http://127.0.0.1:19388" });
  check("fix2: the matching http Origin is still accepted", r2.status === 202, `${r2.status} ${r2.body.slice(0, 160)}`);
  r2 = await req.client.post("/dsh-wiki/api/jobs", body, { origin: "http://127.0.0.1:9999" });
  check("fix2: a mismatched port stays refused (403)", r2.status === 403);
  for (const state of fixtures) await disposeAll(state);
}

// 23. defect 3：internal 错误文本（含 storeDir / staging / journal 路径）绝不进响应体。
{
  const dir = tempDir("dsh-wiki-leak-");
  const repoRoot = path.join(dir, "repo");
  mkdirSync(repoRoot, { recursive: true });
  const storeDir = path.join(dir, "journal");
  const state = makeCtx("leak");
  const leaked = `EACCES: permission denied, mkdir '${storeDir}'`;
  spyJobsInternals({
    openJournalStore: async () => { throw Object.assign(new Error(leaked), { code: "EACCES" }); },
    createJobManager: () => ({
      start: () => { throw Object.assign(new Error(`a generate job is already running for ${repoRoot} (staging ${path.join(repoRoot, ".dsh-wiki.staging-dead")})`), { status: 409, code: "job-busy" }); },
      cancel: () => ({ canceled: false }), view: () => ({ active: null, last: null }),
      journalState: () => ({ mode: "journal", missing: [] }), dispose: async () => ({ unresolved: [] }),
    }),
    createWorkerGuard: () => ({ activate: () => () => {}, authorizeSync: () => ({ allow: true }), releaseAll: () => {}, activeAgentIds: () => [], release: () => false }),
  });
  state.ctx.agents = { create: async () => ({}) };
  state.ctx.workingDirectory = { get: () => repoRoot };
  state.ctx.agentPresets = presetService();
  apply(state.ctx, { wikiDirName: ".dsh-wiki", wikiRoots: [repoRoot], jobs: { enabled: true, storeDir } });
  // 启动时（roots 已知）打开 store 失败 => 构造失败；响应体只能有固定 code + 短句。
  await waitFor(() => state.warnings.length > 0, "leak runtime construction");
  const state2 = makeCtx("leak2");
  spyJobsInternals({
    openJournalStore: async () => ({ load: async () => null, create: async () => ({}), advance: async () => ({}), replaceTerminal: async () => ({}) }),
    createJobManager: () => ({
      start: () => { throw Object.assign(new Error(`a generate job is already running for ${repoRoot} (staging ${path.join(repoRoot, ".dsh-wiki.staging-dead")})`), { status: 409, code: "job-busy" }); },
      cancel: () => ({ canceled: false }), view: () => ({ active: null, last: null }),
      journalState: () => ({ mode: "journal", missing: [] }), dispose: async () => ({ unresolved: [] }),
    }),
    createWorkerGuard: () => ({ activate: () => () => {}, authorizeSync: () => ({ allow: true }), releaseAll: () => {}, activeAgentIds: () => [], release: () => false }),
  });
  state2.ctx.agents = { create: async () => ({}) };
  state2.ctx.workingDirectory = { get: () => repoRoot };
  state2.ctx.agentPresets = presetService();
  apply(state2.ctx, { wikiDirName: ".dsh-wiki", wikiRoots: [repoRoot], jobs: { enabled: true, storeDir: path.join(dir, "journal2") } });
  await waitFor(() => state2.registered.routes.length === 1, "leak2 runtime");
  const client = makeClient(state2.registered.routes[0].handler);
  const body = { root: repoRoot, action: "generate", model: { provider: "p", model: "m" } };
  const busy = await client.post("/dsh-wiki/api/jobs", body);
  check("fix3: a JobError keeps its status/code but exposes only the fixed public message",
    busy.status === 409 && busy.json?.code === "job-busy"
    && busy.json?.error === "a background wiki job is already running for this repository",
    `${busy.status} ${busy.body.slice(0, 240)}`);
  check("fix3: the response never carries repo paths, staging paths or raw fs text",
    !busy.body.includes(repoRoot) && !busy.body.includes(".dsh-wiki.staging-dead"), busy.body.slice(0, 240));
  // store 打不开：一条路径经“构造期”暴露，另一条经 POST 期暴露（两处都必须只回固定短句）。
  const state3 = makeCtx("leak3");
  spyJobsInternals({
    openJournalStore: async () => { throw Object.assign(new Error(leaked), { code: "EACCES" }); },
    createJobManager: () => ({
      start: () => ({ id: "job1" }), cancel: () => ({ canceled: false }), view: () => ({ active: null, last: null }),
      journalState: () => ({ mode: "journal", missing: [] }), dispose: async () => ({ unresolved: [] }),
    }),
    createWorkerGuard: () => ({ activate: () => () => {}, authorizeSync: () => ({ allow: true }), releaseAll: () => {}, activeAgentIds: () => [], release: () => false }),
  });
  state3.ctx.agents = { create: async () => ({}) };
  state3.ctx.workingDirectory = { get: () => repoRoot };
  state3.ctx.agentPresets = presetService();
  // 启动时还没有已知根 => 构造不会碰 store；根在一次会话事件之后才出现。
  apply(state3.ctx, { wikiDirName: ".dsh-wiki", wikiRoots: [], jobs: { enabled: true, storeDir } });
  await waitFor(() => state3.registered.routes.length === 1, "leak3 runtime");
  await settleRuntime(); // 构造先跑完（此刻无已知根），根之后才登记
  state3.ctx["_on_session/event"]({ header: { cwd: repoRoot } }, {});
  const storeFail = makeClient(state3.registered.routes[0].handler);
  const storeRes = await storeFail.post("/dsh-wiki/api/jobs", body);
  check("fix3: a journal-store failure at POST is a fixed 503 with no storeDir in the body",
    storeRes.status === 503 && storeRes.json?.code === "journal-store-unavailable"
    && !storeRes.body.includes(storeDir) && !/EACCES/.test(storeRes.body), `${storeRes.status} ${storeRes.body.slice(0, 240)}`);
  check("fix3: the full internal detail still reaches the logger",
    state3.warnings.some((w) => /EACCES/.test(w) && w.includes(storeDir)), JSON.stringify(state3.warnings));
  await disposeAll(state);
  await disposeAll(state2);
  await disposeAll(state3);
}

// 24. defect 4：mkdir 必须在“祖先链规范、无链接、位于 allowlist 根之外”验证之后发生。
{
  const base = tempDir("dsh-wiki-junction-");
  const target = path.join(base, "target"); // 链接指向的真实目录（= allowlist 根）
  mkdirSync(target, { recursive: true });
  const link = path.join(base, "link");
  let junctionOk = true;
  try { symlinkSync(target, link, "junction"); } catch { junctionOk = false; }
  if (!junctionOk) {
    console.log("SKIP fix4 junction storeDir tests (junction creation unavailable on this filesystem)");
  } else {
    const otherRoot = path.join(base, "other-repo");
    mkdirSync(otherRoot, { recursive: true });
    const runStoreCase = async (name, { roots, storeDir }) => {
      const state = makeCtx(name);
      let opened = null;
      spyJobsInternals({
        openJournalStore: async (options) => {
          opened = options;
          return { load: async () => null, create: async () => ({}), advance: async () => ({}), replaceTerminal: async () => ({}) };
        },
        createJobManager: () => ({
          start: () => ({ id: "job1" }), cancel: () => ({ canceled: false }), view: () => ({ active: null, last: null }),
          journalState: () => ({ mode: "journal", missing: [] }), dispose: async () => ({ unresolved: [] }),
        }),
        createWorkerGuard: () => ({ activate: () => () => {}, authorizeSync: () => ({ allow: true }), releaseAll: () => {}, activeAgentIds: () => [], release: () => false }),
      });
      state.ctx.agents = { create: async () => ({}) };
      state.ctx.workingDirectory = { get: () => roots[0] };
      state.ctx.agentPresets = presetService();
      apply(state.ctx, { wikiDirName: ".dsh-wiki", wikiRoots: roots, jobs: { enabled: true, storeDir } });
      await waitFor(() => opened !== null || state.warnings.length > 0, `${name} store decision`);
      const client = makeClient(state.registered.routes[0].handler);
      const res = await client.post("/dsh-wiki/api/jobs", { root: roots[0], action: "generate", model: { provider: "p", model: "m" } });
      await disposeAll(state);
      return { opened, res, warnings: state.warnings };
    };

    // 24a. 链接指向 allowlist 根：不得创建，且根目录一个条目都不许多。
    const underRoot = await runStoreCase("junction-root", { roots: [target], storeDir: path.join(link, "journal") });
    check("fix4: a storeDir whose junction ancestor points into an allowlisted root is refused before mkdir",
      underRoot.opened === null && !existsSync(path.join(link, "journal")) && readdirSync(target).length === 0,
      `opened=${!!underRoot.opened} created=${existsSync(path.join(link, "journal"))} target=${JSON.stringify(readdirSync(target))}`);
    check("fix4: the refusal is a fixed 503 with no storeDir in the body",
      underRoot.res.status === 503 && !underRoot.res.body.includes(base), `${underRoot.res.status} ${underRoot.res.body.slice(0, 200)}`);

    // 24b. 链接不在任何 allowlist 根内也是如此：链接本身不可信，绝不穿过它创建。
    const linkage = await runStoreCase("junction-plain", { roots: [otherRoot], storeDir: path.join(link, "nested", "journal") });
    check("fix4: no directory is created through a junction even when the target is outside every root",
      linkage.opened === null && !existsSync(path.join(link, "nested")) && readdirSync(target).length === 0,
      `opened=${!!linkage.opened} created=${existsSync(path.join(link, "nested"))} target=${JSON.stringify(readdirSync(target))}`);
    check("fix4: the allowlisted root outside the link is untouched", readdirSync(otherRoot).length === 0);

    // 24c. 对照：规范路径（父目录真实存在、无链接）照常逐级创建并交给 openJournalStore 复验。
    const plainStore = path.join(base, "plain", "journal");
    const plain = await runStoreCase("plain-store", { roots: [otherRoot], storeDir: plainStore });
    check("fix4: a canonical missing storeDir is created after verification and then opened",
      plain.opened !== null && existsSync(plainStore) && plain.opened?.storeDir === plainStore,
      `opened=${JSON.stringify(plain.opened?.storeDir)} exists=${existsSync(plainStore)}`);
  }
}

// 25. defect 5：构造失败要按严格逆序回滚（manager → guard → preset），回滚绝不抛出，
//     manager.dispose 恰好一次（回滚一次，卸载不再重复）。
{
  const dir = tempDir("dsh-wiki-rollback-");
  const repoRoot = path.join(dir, "repo");
  mkdirSync(repoRoot, { recursive: true });
  const state = makeCtx("rollback");
  const order = [];
  let managerDisposals = 0;
  spyJobsInternals({
    // 构造在 manager 之后失败：store 打不开。
    openJournalStore: async () => { throw new Error(`store unreadable at ${path.join(dir, "journal")}`); },
    createJobManager: () => ({
      start: () => ({ id: "job1" }), cancel: () => ({ canceled: false }), view: () => ({ active: null, last: null }),
      journalState: () => ({ mode: "journal", missing: [] }),
      async dispose() { managerDisposals++; order.push("manager"); return { unresolved: [] }; },
    }),
    createWorkerGuard: () => ({
      activate: () => () => {}, authorizeSync: () => ({ allow: true }),
      releaseAll: () => order.push("guard"), activeAgentIds: () => [], release: () => false,
    }),
  });
  state.ctx.agents = { create: async () => ({}) };
  state.ctx.workingDirectory = { get: () => repoRoot };
  state.ctx.agentPresets = presetService({
    register: () => { order.push("preset-register"); return async () => { order.push("preset"); }; },
  });
  let threw = null;
  try {
    apply(state.ctx, { wikiDirName: ".dsh-wiki", wikiRoots: [repoRoot], jobs: { enabled: true, storeDir: path.join(dir, "journal") } });
  } catch (error) { threw = error; }
  await waitFor(() => state.warnings.length > 0, "rollback warning");
  check("fix5: a construction failure after the manager is constructed rolls back in strict reverse order",
    threw === null && JSON.stringify(order) === JSON.stringify(["preset-register", "manager", "guard", "preset"]), JSON.stringify(order));
  check("fix5: the manager is disposed exactly once during rollback", managerDisposals === 1, String(managerDisposals));
  check("fix5: the runtime is failed shut and the route answers 503 with a fixed code",
    state.registered.routes.length === 1
    && (await makeClient(state.registered.routes[0].handler).get(`/dsh-wiki/api/jobs?root=${encodeURIComponent(repoRoot)}`)).json?.code === "journal-store-unavailable");
  let unloadThrew = null;
  try { await disposeAll(state); } catch (error) { unloadThrew = error; }
  check("fix5: unload after a rolled-back construction does not dispose the manager twice",
    unloadThrew === null && managerDisposals === 1, `${managerDisposals} ${String(unloadThrew)}`);
}

const collectStrings = (value, out = []) => {  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectStrings(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => collectStrings(v, out));
  return out;
};

// 26. T011：省略 = 规范 en；显式非法值绝不静默归一化，且在 store/manager.start/写盘之前拒绝。
{
  const dir = tempDir("dsh-wiki-t011-");
  const repoRoot = path.join(dir, "repo");
  mkdirSync(repoRoot, { recursive: true });
  const storeDir = path.join(dir, "journal");
  const state = makeCtx("t011");
  const starts = [];
  let storeOpens = 0;
  spyJobsInternals({
    openJournalStore: async () => { storeOpens++; return { load: async () => null, create: async () => ({}), advance: async () => ({}), replaceTerminal: async () => ({}) }; },
    createJobManager: () => ({
      start: (request) => { starts.push(request); return { id: "job1", root: request.root, action: request.action, model: { ...request.model }, targetLang: request.targetLang, phase: "running", stage: "queued" }; },
      cancel: () => ({ canceled: false }), view: () => ({ active: null, last: null }),
      journalState: () => ({ mode: "journal", missing: [] }), dispose: async () => ({ unresolved: [] }),
    }),
    createWorkerGuard: jobGuard,
  });
  state.ctx.agents = { create: async () => ({}) };
  state.ctx.workingDirectory = { get: () => repoRoot };
  state.ctx.agentPresets = presetService();
  // 启动时没有已知根 => 构造不碰 store；根在会话事件之后才出现，因此任何 store 打开都来自请求本身。
  apply(state.ctx, { wikiDirName: ".dsh-wiki", wikiRoots: [], jobs: { enabled: true, storeDir } });
  await waitFor(() => state.registered.routes.length === 1, "t011 runtime");
  await settleRuntime(); // 构造先跑完（此刻无已知根），根之后才登记
  state.ctx["_on_session/event"]({ header: { cwd: repoRoot } }, {});
  const client = makeClient(state.registered.routes[0].handler);
  const body = { root: repoRoot, action: "generate", model: { provider: "p", model: "m" } };
  const rejectCase = async (label, patch, status, code) => {
    const before = { opens: storeOpens, starts: starts.length };
    const r = await client.post("/dsh-wiki/api/jobs", { ...body, ...patch });
    check(`T011: ${label} is rejected (${status} ${code}), never coerced`,
      r.status === status && r.json?.code === code && r.status !== 202, `${r.status} ${r.body.slice(0, 200)}`);
    check(`T011: ${label} caused no store open, no manager.start and no store directory`,
      storeOpens === before.opens && starts.length === before.starts && !existsSync(storeDir), `${storeOpens} ${starts.length}`);
  };
  for (const [label, value, status, code] of [
    ["targetLang null", null, 400, "invalid-target-lang"],
    ["targetLang empty string", "", 400, "invalid-target-lang"],
    ["targetLang number", 42, 400, "invalid-target-lang"],
    ["targetLang object", {}, 400, "invalid-target-lang"],
    ["targetLang separator alias", "en_US", 400, "invalid-target-lang"],
    ["targetLang absolute path", "C:\\private\\vi", 400, "invalid-target-lang"],
    ["targetLang NUL", "en\u0000vi", 400, "invalid-target-lang"],
    ["targetLang overlong", "x".repeat(40), 400, "invalid-target-lang"],
    ["targetLang vi", "vi", 501, "language-unsupported"],
    ["targetLang zh-CN", "zh-CN", 501, "language-unsupported"],
    ["targetLang auto", "auto", 501, "language-unsupported"],
    ["targetLang case alias EN", "EN", 501, "language-unsupported"],
  ]) await rejectCase(label, { targetLang: value }, status, code);
  for (const [label, patch, status, code] of [
    ["root number", { root: 42 }, 400, "invalid-root"],
    ["root relative", { root: "relative/path" }, 400, "invalid-root"],
    ["action number", { action: 7 }, 400, "invalid-action"],
    // translate 是唯一接受非 en 的动作：缺 targetLang / en / 非法 tag 都是 400，绝不降级成 generate。
    ["action translate without targetLang", { action: "translate" }, 400, "invalid-target-lang"],
    ["action translate with targetLang en", { action: "translate", targetLang: "en" }, 400, "invalid-target-lang"],
    ["action translate with an invalid tag", { action: "translate", targetLang: "vi_VI" }, 400, "invalid-target-lang"],
    ["action translate with a NUL tag", { action: "translate", targetLang: "vi\u0000x" }, 400, "invalid-target-lang"],
    // generate/update 保持今天的语义：非 en 是 501 language-unsupported，不是 400。
    ["action generate with targetLang vi", { action: "generate", targetLang: "vi" }, 501, "language-unsupported"],
    ["model missing", { model: undefined }, 400, "invalid-model"],
    ["model provider number", { model: { provider: 42, model: "m" } }, 400, "invalid-model"],
    ["model provider padded", { model: { provider: " p ", model: "m" } }, 400, "invalid-model"],
    ["model extra field", { model: { provider: "p", model: "m", temperature: 1 } }, 400, "unsupported-field"],
    ["incremental string", { incremental: "false" }, 400, "invalid-incremental"],
    ["incremental null", { incremental: null }, 400, "invalid-incremental"],
    // spec 013 §2.1：增量只和 action="update" 一起可用；generate/translate 上的 incremental 是显式拒绝。
    ["incremental true on generate", { incremental: true }, 400, "incremental-not-for-generate"],
    ["incremental true on translate", { action: "translate", targetLang: "vi", incremental: true }, 400, "incremental-not-for-translate"],
    ["unknown field", { mode: "incremental" }, 400, "unsupported-field"],
  ]) await rejectCase(label, patch, status, code);
  const rc = await client.post("/dsh-wiki/api/jobs/cancel", { root: 42 });
  check("T011: cancel validates root like every other field (400 invalid-root)", rc.status === 400 && rc.json?.code === "invalid-root");

  let ok = await client.post("/dsh-wiki/api/jobs", body);
  check("T011: omitted targetLang defaults to canonical en (202)", ok.status === 202 && starts.length === 1 && starts[0].targetLang === "en", ok.body.slice(0, 200));
  check("T011: the first valid request is what opens the store", storeOpens === 1 && existsSync(storeDir));
  ok = await client.post("/dsh-wiki/api/jobs", { ...body, targetLang: "en" });
  check("T011: explicit targetLang en is accepted", ok.status === 202 && starts[1]?.targetLang === "en");
  ok = await client.post("/dsh-wiki/api/jobs", { ...body, incremental: false });
  check("T011: incremental:false is still accepted", ok.status === 202 && starts.length === 3);
  ok = await client.post("/dsh-wiki/api/jobs", { ...body, action: "translate", targetLang: "vi" });
  check("T014a: translate + vi is accepted and reaches the manager with the target language",
    ok.status === 202 && starts.length === 4 && starts[3].action === "translate" && starts[3].targetLang === "vi",
    ok.body.slice(0, 200));
  await disposeAll(state);
}

// 27. 公开错误投影：provider/builder 文本、路径、stack 绝不离开 Host。
{
  const SENTINEL = "TOKEN_SENTINEL";
  const secretPath = path.join(tempDir("dsh-wiki-secret-"), "private", "path");
  const FIXED_FAILURE = "a model provider catalog entry could not be listed";

  // 27a. /api/models：失败条目 = 固定 code/message
  ctx.sessionController = {
    modelCatalog: async () => ({
      groups: [{ id: "p", name: "P", models: [{ id: "m", name: "M" }] }], default: { provider: "p", model: "m" },
      failures: [{ id: "broken", name: "Broken", message: `${SENTINEL} ${secretPath}`, stack: `at ${secretPath}` }],
    }),
  };
  const models = await get("/dsh-wiki/api/models");
  check("sanitize: /api/models keeps the failing entry with a fixed public code/message",
    models.status === 200 && models.json?.failures?.length === 1 && models.json.failures[0].id === "broken"
    && models.json.failures[0].code === "model-catalog-failure" && models.json.failures[0].message === FIXED_FAILURE
    && models.json.models?.[0]?.model === "m", models.body.slice(0, 300));
  check("sanitize: /api/models never forwards provider text, stack or path",
    !models.body.includes(SENTINEL) && !models.body.includes(secretPath) && !/stack/.test(models.body));
  ctx.sessionController = { modelCatalog: async () => { throw new Error(`${SENTINEL} ${secretPath}`); } };
  const thrown = await get("/dsh-wiki/api/models");
  check("sanitize: a throwing catalog is a fixed 503 without the sentinel",
    thrown.status === 503 && thrown.json?.code === "model-catalog-unavailable" && !thrown.body.includes(SENTINEL) && !thrown.body.includes(secretPath));
  delete ctx.sessionController;

  // 27b. GET/POST /api/jobs：active 与 last 都带原始错误
  const dir = tempDir("dsh-wiki-sanitize-");
  const repoRoot = path.join(dir, "repo");
  mkdirSync(repoRoot, { recursive: true });
  const now = new Date().toISOString();
  const rawError = () => ({
    code: "selfcheck-failed", message: `${SENTINEL} ${secretPath}`,
    stack: `Error: ${SENTINEL}\n    at ${secretPath}:1:1`, stderr: `${SENTINEL} builder stderr ${secretPath}`,
  });
  const rawJob = (extra) => ({
    id: "job-x", root: repoRoot, action: "generate", model: { provider: "p", model: "m" }, targetLang: "en",
    phase: "running", stage: "build", startedAt: now, updatedAt: now, sessionId: "sess-1", published: false, pages: null,
    waitingFor: null, journalPhase: "validated", journalJobId: "j1", engine: path.join(secretPath, "python.exe"),
    blocked: { reason: "worker-not-stopped", staging: path.join(secretPath, ".dsh-wiki.staging-x"), journal: true },
    error: rawError(), ...extra,
  });
  const state = makeCtx("sanitize");
  spyJobsInternals({
    openJournalStore: async () => ({ load: async () => null, create: async () => ({}), advance: async () => ({}), replaceTerminal: async () => ({}) }),
    createJobManager: () => ({
      start: () => rawJob(),
      cancel: () => ({ canceled: false }),
      view: () => ({ active: rawJob(), last: rawJob({ phase: "failed" }) }),
      journalState: () => ({ mode: "journal", missing: [secretPath] }),
      dispose: async () => ({ unresolved: [] }),
    }),
    createWorkerGuard: jobGuard,
  });
  state.ctx.agents = { create: async () => ({}) };
  state.ctx.workingDirectory = { get: () => repoRoot };
  state.ctx.agentPresets = presetService();
  apply(state.ctx, { wikiDirName: ".dsh-wiki", wikiRoots: [repoRoot], jobs: { enabled: true, storeDir: path.join(dir, "journal") } });
  await waitFor(() => state.registered.routes.length === 1, "sanitize runtime");
  const client = makeClient(state.registered.routes[0].handler);
  const leaks = (text) => [SENTINEL, secretPath, "builder stderr", ".dsh-wiki.staging-", "python.exe"].filter((needle) => text.includes(needle));
  const getJobs = await client.get(`/dsh-wiki/api/jobs?root=${encodeURIComponent(repoRoot)}`);
  const expectedError = { code: "selfcheck-failed", message: "the candidate wiki failed its own checks" };
  check("sanitize: GET /api/jobs active and last carry a fixed public code/message",
    getJobs.status === 200 && JSON.stringify(getJobs.json?.active?.error) === JSON.stringify(expectedError)
    && JSON.stringify(getJobs.json?.last?.error) === JSON.stringify(expectedError)
    && getJobs.json?.active?.phase === "running" && getJobs.json?.last?.phase === "failed"
    && getJobs.json?.active?.model?.provider === "p", getJobs.body.slice(0, 400));
  check("sanitize: GET /api/jobs blocked keeps reason/journal but never the staging path",
    getJobs.json?.active?.blocked?.reason === "worker-not-stopped" && getJobs.json?.active?.blocked?.journal === true
    && !("staging" in getJobs.json.active.blocked) && !("engine" in getJobs.json.active));
  check("sanitize: GET /api/jobs body has no sentinel, path, stack or stderr anywhere (deep scan)",
    leaks(getJobs.body).length === 0 && collectStrings(getJobs.json).every((s) => leaks(s).length === 0 && !/stack/.test(s)),
    JSON.stringify(leaks(getJobs.body)));
  const postJob = await client.post("/dsh-wiki/api/jobs", { root: repoRoot, action: "generate", model: { provider: "p", model: "m" } });
  check("sanitize: POST /api/jobs 202 projects the job summary too",
    postJob.status === 202 && JSON.stringify(postJob.json?.job?.error) === JSON.stringify(expectedError) && leaks(postJob.body).length === 0, postJob.body.slice(0, 300));
  await disposeAll(state);
}

// 28. /api/status 的默认（jobs disabled）surface：显式 allowlist 投影。clientModules.graph() 可能带着
//     provider/builder 的 error/stack/stderr 与绝对路径；旧实现把 graph 片段逐字回显。这里用假
//     clientModules 注入这些哨兵，要求响应体（deep scan）一个都不出现，内部细节只进 logger。
{
  const SENTINEL = "PRIVATE_BUILDER_STDERR";
  const SECRET_WIN = "C:\\private\\.dsh-wiki.staging-secret";
  const STACK = `Error: ${SENTINEL}\n    at ${SECRET_WIN}:1:1`;
  resetJobProbe();
  const leakScan = (r) => {
    const decoded = collectStrings(r.json).join("\n");
    const needles = [SENTINEL, SECRET_WIN, "C:\\private", ".dsh-wiki.staging-secret", repo, path.dirname(repo)];
    const leaks = needles.filter((needle) => decoded.includes(needle) || r.body.includes(needle));
    const stackLike = /\n\s+at\s/.test(decoded) || /\bat\s+[A-Za-z]:\\/.test(decoded)
      || /"stack"\s*:/.test(r.body) || /"stderr"\s*:/.test(r.body);
    return { leaks, stackLike };
  };
  const statusThen = async (name, clientModules) => {
    const state = makeCtx(name);
    if (clientModules !== undefined) state.ctx.clientModules = clientModules;
    apply(state.ctx, { wikiDirName: ".dsh-wiki", wikiRoots: [repo] });
    const client = makeClient(state.registered.routes[0].handler);
    return { state, r: await client.get("/dsh-wiki/api/status") };
  };

  // 28a. graph 含 error/stack/stderr；模块确实在 graph 里 => loaded=true，entry 一个字节都不回显。
  const loaded = await statusThen("status-loaded", {
    graph: () => ({
      entries: [
        { id: "@dsh-ext/dsh-wiki", error: { code: "build-failed", message: `${SENTINEL} ${SECRET_WIN}`, stack: STACK }, stderr: `${SENTINEL} ${SECRET_WIN}` },
        { id: "other-module", note: `${SENTINEL} ${SECRET_WIN}` },
      ],
      note: `${SENTINEL} ${SECRET_WIN}`,
    }),
    clientPath: () => SECRET_WIN,
  });
  const loadedScan = leakScan(loaded.r);
  check("status: graph entries carrying error/stack/stderr are never echoed (deep scan)",
    loaded.r.status === 200 && loadedScan.leaks.length === 0 && loadedScan.stackLike === false,
    JSON.stringify(loadedScan));
  check("status: clientModule is a bounded state (service/loaded/code), not a graph excerpt",
    JSON.stringify(Object.keys(loaded.r.json?.clientModule ?? {}).sort()) === JSON.stringify(["code", "loaded", "service"])
    && loaded.r.json.clientModule.service === true && loaded.r.json.clientModule.loaded === true
    && loaded.r.json.clientModule.code === null, JSON.stringify(loaded.r.json?.clientModule));
  check("status: the loaded case exposes only the allowlist (no builder, clientPath, wikis or keys)",
    !("builder" in loaded.r.json) && !("clientPath" in loaded.r.json) && !("wikis" in loaded.r.json)
    && Object.keys(loaded.r.json).sort().join(",") === "clientModule,jobs,ok,plugin", loaded.r.body);
  check("status: jobs availability is the public default state (disabled, not available)",
    JSON.stringify(loaded.r.json?.jobs) === JSON.stringify({ enabled: false, available: false, state: "disabled", code: "jobs-disabled" }),
    JSON.stringify(loaded.r.json?.jobs));
  await disposeAll(loaded.state);

  // 28b. graph 里没有本模块 => loaded=false + 稳定 code；同一份带哨兵的 graph 依旧不回显。
  const notLoaded = await statusThen("status-not-loaded", {
    graph: () => ({ entries: [{ id: "other-module", error: { stack: STACK }, note: `${SENTINEL} ${SECRET_WIN}` }], note: `${SENTINEL} ${SECRET_WIN}` }),
  });
  check("status: a graph without the client module is a stable code, still no diagnostics",
    notLoaded.r.json?.clientModule?.service === true && notLoaded.r.json?.clientModule?.loaded === false
    && notLoaded.r.json?.clientModule?.code === "client-module-not-loaded"
    && leakScan(notLoaded.r).leaks.length === 0, notLoaded.r.body.slice(0, 300));
  await disposeAll(notLoaded.state);

  // 28c. graph() 自己抛错（异常文本含哨兵/路径）：只回报固定 code，细节只进 logger。
  const threw = await statusThen("status-graph-throws", {
    graph: () => { throw new Error(`${SENTINEL} ${SECRET_WIN}`); },
    entry: () => { throw new Error(`${SENTINEL} ${SECRET_WIN}`); },
  });
  check("status: a throwing graph() is a fixed code; the error text stays in the logger",
    threw.r.status === 200 && threw.r.json?.clientModule?.code === "client-module-diagnostics-failed"
    && threw.r.json?.clientModule?.loaded === false && leakScan(threw.r).leaks.length === 0
    && leakScan(threw.r).stackLike === false
    && threw.state.warnings.some((w) => w.includes(SENTINEL)), `${threw.r.body} | ${JSON.stringify(threw.state.warnings)}`);
  await disposeAll(threw.state);

  // 28d. clientModules 服务缺失 => service=false + 稳定 code。
  const absent = await statusThen("status-service-absent", undefined);
  check("status: an absent clientModules service is service=false with a stable code",
    absent.r.json?.clientModule?.service === false && absent.r.json?.clientModule?.loaded === false
    && absent.r.json?.clientModule?.code === "client-module-unavailable", absent.r.body.slice(0, 200));
  await disposeAll(absent.state);

  // 28e. 默认配置仍然什么也不构造（store/guard/manager/preset 0），状态路由不产生任何写盘。
  check("status: the default apply still constructs nothing (store/guard/manager/preset 0)",
    jobProbe.openJournalStore === 0 && jobProbe.createJobManager === 0
    && jobProbe.createWorkerGuard === 0 && jobProbe.register === 0, JSON.stringify(jobProbe));
}

// 29. 序列化检查：诊断/错误响应体里不允许出现盘符绝对路径。
//     数据路由（/api/projects|project|wiki|site）按设计把调用方已登记的项目根交给本机 UI，不属于诊断；
//     这里覆盖的是状态、目录失败、作业拒绝/错误与静态错误这几类响应。
{
  const DRIVE_PATH = /[A-Za-z]:[\\/]/;
  const secret = "C:\\private\\.dsh-wiki.staging-secret";
  const state = makeCtx("serialize");
  state.ctx.clientModules = {
    graph: () => ({ entries: [{ id: "other", stderr: `PRIVATE_BUILDER_STDERR ${secret}` }], clientPath: secret }),
    clientPath: () => secret,
  };
  state.ctx.sessionController = { modelCatalog: async () => { throw new Error(`PRIVATE_BUILDER_STDERR ${secret}`); } };
  apply(state.ctx, { wikiDirName: ".dsh-wiki", wikiRoots: [repo] });
  const client = makeClient(state.registered.routes[0].handler);
  const bodies = [
    ["/api/status", await client.get("/dsh-wiki/api/status")],
    ["/api/models (throwing catalog)", await client.get("/dsh-wiki/api/models")],
    ["POST /api/jobs (disabled gate)", await client.post("/dsh-wiki/api/jobs", { root: repo, action: "generate", model: { provider: "p", model: "m" } })],
    ["GET /api/jobs on an unknown root", await client.get(`/dsh-wiki/api/jobs?root=${encodeURIComponent(path.join(repo, "no-such-project"))}`)],
    ["unknown route", await client.get("/dsh-wiki/api/no-such-route")],
    ["/site with a missing site", await client.get(`/dsh-wiki/site?path=${encodeURIComponent(path.join(repoNoSite, ".dsh-wiki"))}`)],
  ];
  for (const [label, r] of bodies) {
    const decoded = r.json ? collectStrings(r.json).join("\n") : r.body;
    const hit = DRIVE_PATH.exec(decoded) ?? DRIVE_PATH.exec(r.body);
    check(`serialize: ${label} never carries a drive-letter path`, r.body.length > 0 && hit === null, hit ? hit[0] : "");
  }
  await disposeAll(state);
}

// 30. T028 slice 2：workerLiveness 接到 host-liveness 上，且不产生任何 execute 入口。
// 单进程测试里造不出“真的另一个宿主进程”，所以这里**注入假的 epoch 状态**：acquire 的成败和
// proveEpochFor 的裁决都由 __livenessInternals 的替身给出。被验证的是：领取只为本实例落一份记录、
// provider 按**记录属主**求证与映射（只有该属主自己的记录证明 dead 才 stopped）、调用形状（epochDir
// 在 journal store 目录内部）与 fail-closed 行为；真实 host-liveness 的判决由
// tools/host-liveness-test.mjs 的 26 个用例覆盖。
//
// 回归缺陷：旧接线只保留“上一个宿主”的一个全局裁决，一旦它是 dead，每一条外来记录都被判成 stopped。
// 现在每个记录属主单独求证，且裁决绝不缓存——下面“A dead 之后 B 必须是 unknown”就是这条回归。
{
  const REAL_LIVENESS = { ...__livenessInternals };
  const calls = [];
  const probe = { verdict: "dead", throws: false };
  __livenessInternals.proveEpochFor = async (options) => {
    calls.push({ call: "prove", dir: options?.dir, hostInstanceId: options?.hostInstanceId });
    if (probe.throws) throw new Error("probe exploded");
    return { verdict: probe.verdict, reason: "harness", previous: null };
  };
  const acquireOk = async (options) => {
    calls.push({ call: "acquire", dir: options?.dir, hostInstanceId: options?.hostInstanceId, takeover: options?.takeover });
    return {
      epochId: "11111111-2222-3333-4444-555555555555",
      hostInstanceId: options?.hostInstanceId,
      pid: process.pid,
      procStart: Date.now(),
    };
  };
  const stubManager = () => ({
    start: () => ({ id: "j1" }), cancel: () => ({ canceled: false }), view: () => ({ active: null, last: null }),
    journalState: () => ({ mode: "journal", missing: [] }), dispose: async () => ({ unresolved: [] }),
  });
  // 每个 apply 只领取一次 epoch（hostEpoch.attempted），所以每种场景各起一个插件实例；entries 只装该实例
  // 自己那次领取的调用（断言不能串到别的实例上）。
  const bootLive = async (label, acquireImpl = acquireOk) => {
    const storeDir = path.join(tempDir(`dsh-wiki-live-${label}-`), "journal");
    const liveRepo = tempDir(`dsh-wiki-live-${label}-repo-`);
    const from = calls.length;
    __livenessInternals.acquireHostEpoch = acquireImpl;
    let seen = null;
    spyJobsInternals({
      openJournalStore: async () => ({ load: async () => null, create: async () => ({}), advance: async () => ({}), replaceTerminal: async () => ({}) }),
      createJobManager: (options) => { seen = options; return stubManager(); },
      createWorkerGuard: jobGuard,
    });
    const state = makeCtx(`liveness-${label}`);
    state.ctx.agents = { create: async () => { throw new Error("no worker may start"); } };
    state.ctx.workingDirectory = { get: () => liveRepo };
    state.ctx.agentPresets = presetService();
    apply(state.ctx, { wikiDirName: ".dsh-wiki", wikiRoots: [liveRepo], jobs: { enabled: true, storeDir } });
    await waitFor(() => seen !== null && calls.slice(from).some((entry) => entry.call === "acquire"),
      `liveness ${label} claim`);
    return {
      state, provider: seen?.workerLiveness, storeDir, repo: liveRepo, seen,
      // `entries` is the claim-time snapshot; `entriesNow()` re-reads, because provider calls append later.
      entries: calls.slice(from),
      entriesNow: () => calls.slice(from),
    };
  };

  // (a) 领取只发生一次、只为本实例的 token，且不传 blanket takeover（是否覆盖由 acquire 按本实例
  // 自己那条记录的具体裁决决定）；epochDir 仍在 journal store 目录内部。
  const deadRun = await bootLive("dead");
  check("liveness: the epoch is claimed once for THIS host instance, without a blanket takeover",
    deadRun.entries.length === 1 && deadRun.entries[0].call === "acquire"
    && deadRun.entries[0].hostInstanceId === deadRun.seen?.hostInstanceId
    && deadRun.entries[0].takeover === undefined,
    JSON.stringify(deadRun.entries));
  check("liveness: the epoch dir sits inside the journal store directory and was created",
    path.dirname(deadRun.entries[0].dir) === deadRun.storeDir && existsSync(deadRun.entries[0].dir),
    JSON.stringify({ entries: deadRun.entries, storeDir: deadRun.storeDir }));
  check("liveness: a successful claim logs no warning and leaves the manager provider async",
    deadRun.state.warnings.length === 0 && typeof deadRun.provider === "function" && deadRun.provider.constructor.name === "AsyncFunction",
    JSON.stringify(deadRun.state.warnings));
  check("liveness: no epoch directory is created while jobs stay disabled", (() => {
    const disabledStore = path.join(tempDir("dsh-wiki-live-off-"), "journal");
    const disabledCalls = calls.length;
    const disabled = makeCtx("liveness-off");
    apply(disabled.ctx, { wikiDirName: ".dsh-wiki", wikiRoots: [deadRun.repo], jobs: { enabled: false, storeDir: disabledStore } });
    return !existsSync(disabledStore) && calls.length === disabledCalls;
  })());

  // (b) 外来记录：只有它**自己的** epoch 记录证明 dead 才 stopped（proof 固定 process-exit），
  // 并且求证必须带着那条记录属主的 hostInstanceId 去问（不是“上一个宿主”的全局裁决）。
  probe.verdict = "dead";
  const foreignA = "dsh-wiki.00000000-0000-0000-0000-000000000001";
  const foreignDead = await deadRun.provider({ jobId: "job-a", hostInstanceId: foreignA });
  check("liveness: a foreign record whose OWN epoch record proves dead is stopped with proof process-exit",
    foreignDead?.state === "stopped" && foreignDead?.proof === "process-exit", JSON.stringify(foreignDead));
  check("liveness: the dead-owner proof is accepted by the planner's vocabulary and the plan acts",
    WORKER_PROOFS.includes(foreignDead?.proof), JSON.stringify({ proof: foreignDead?.proof, accepted: [...WORKER_PROOFS] }));
  check("liveness: the provider proves the RECORD OWNER (that record's hostInstanceId, in the epoch dir)",
    deadRun.entriesNow().at(-1)?.call === "prove" && deadRun.entriesNow().at(-1)?.hostInstanceId === foreignA
    && deadRun.entriesNow().at(-1)?.dir === deadRun.entries[0]?.dir, JSON.stringify(deadRun.entriesNow()));

  // 回归：A 的 dead 裁决不得被记住并套到 B 身上；旧接线的全局 previousVerdict 正是这个缺陷。
  probe.verdict = "unknown";
  const foreignB = "dsh-wiki.00000000-0000-0000-0000-000000000002";
  const foreignUnknown = await deadRun.provider({ jobId: "job-b", hostInstanceId: foreignB });
  check("liveness: a dead verdict for instance A is NOT reused for instance B (the defect being regression-tested)",
    foreignUnknown?.state === "unknown" && foreignUnknown?.proof === undefined
    && deadRun.entriesNow().at(-1)?.hostInstanceId === foreignB, JSON.stringify({ foreignUnknown, entries: deadRun.entriesNow() }));

  // (c) 本进程实例的记录 => alive（jobs.js 真正接受的“活着”状态；旧接线的 running 会被折成 unknown），
  // 而且不需要探测任何记录。
  const own = await deadRun.provider({ jobId: "job-own", hostInstanceId: deadRun.seen?.hostInstanceId });
  check("liveness: a record from this host instance reports alive, never stopped",
    own?.state === "alive" && own?.proof === undefined, JSON.stringify(own));
  check("liveness: this host's own record is never probed on disk",
    deadRun.entriesNow().filter((entry) => entry.call === "prove").length === 2, JSON.stringify(deadRun.entriesNow()));

  // (f) 接线 provider 没有顺带造出 reconcile 入口：GET 404 / POST 405，注册的路由里也没有它。
  const deadClient = makeClient(deadRun.state.registered.routes[0].handler);
  check("liveness: wiring the provider created no reconcile route (GET 404)",
    (await deadClient.get(`/dsh-wiki/reconcile?root=${encodeURIComponent(deadRun.repo)}`)).status === 404);
  check("liveness: wiring the provider created no reconcile route (POST 405)",
    (await deadClient.post("/dsh-wiki/reconcile", { root: deadRun.repo })).status === 405);
  check("liveness: no registered route path mentions reconcile",
    deadRun.state.registered.routes.every((route) => !String(route.path).includes("reconcile")),
    JSON.stringify(deadRun.state.registered.routes.map((route) => route.path)));

  // dispose 不归还 epoch：记录必须活过卸载（见 20c 的 survive 用例）。
  await disposeAll(deadRun.state);

  // (d) 属主裁决 alive / unknown => unknown，永远不是 stopped。
  probe.verdict = "alive";
  const aliveRun = await bootLive("alive");
  const aliveForeign = await aliveRun.provider({ hostInstanceId: "dsh-wiki.00000000-0000-0000-0000-000000000003" });
  check("liveness: an alive verdict for a foreign record's own epoch record yields unknown, never stopped",
    aliveForeign?.state === "unknown" && aliveForeign?.proof === undefined, JSON.stringify(aliveForeign));
  check("liveness: a fresh host instance never authorizes a blanket takeover",
    aliveRun.entries.length === 1 && aliveRun.entries[0].takeover === undefined, JSON.stringify(aliveRun.entries));
  await disposeAll(aliveRun.state);

  probe.verdict = "unknown";
  const unknownRun = await bootLive("unknown");
  const unknownForeign = await unknownRun.provider({ hostInstanceId: "dsh-wiki.00000000-0000-0000-0000-000000000004" });
  check("liveness: an unknown verdict for a foreign record's own epoch record yields unknown, never stopped",
    unknownForeign?.state === "unknown" && unknownForeign?.proof === undefined, JSON.stringify(unknownForeign));
  await disposeAll(unknownRun.state);

  // (e) 求证自己抛错 => provider 折成 unknown：外来记录 unknown、本进程记录仍 alive、插件照常加载，
  // 而且不需要额外警告（领取已经成功，单条记录的求证失败不构成 fail-closed 事件）。
  probe.throws = true;
  const throwRun = await bootLive("probe-throws");
  const throwForeign = await throwRun.provider({ hostInstanceId: "dsh-wiki.00000000-0000-0000-0000-000000000005" });
  const throwOwn = await throwRun.provider({ hostInstanceId: throwRun.seen?.hostInstanceId });
  check("liveness: a throwing probe yields unknown for a foreign record, never stopped",
    throwForeign?.state === "unknown" && throwForeign?.proof === undefined, JSON.stringify(throwForeign));
  check("liveness: a throwing probe does not abort plugin load (routes registered, manager wired, own record alive)",
    throwRun.seen !== null && typeof throwRun.provider === "function"
    && throwRun.state.registered.routes.length > 0 && throwRun.state.registered.routes[0].handler !== undefined
    && throwOwn?.state === "alive"
    && throwRun.entriesNow().filter((entry) => entry.call === "prove").length === 1,
    JSON.stringify({ routes: throwRun.state.registered.routes.length, own: throwOwn, entries: throwRun.entriesNow() }));
  check("liveness: a throwing probe is absorbed by the provider without a fail-closed warning",
    throwRun.state.warnings.filter((w) => /could not be proven/.test(w)).length === 0
    && throwRun.state.warnings.filter((w) => /could not start/.test(w)).length === 0,
    JSON.stringify(throwRun.state.warnings));
  await disposeAll(throwRun.state);
  probe.throws = false;

  // (g) 领取失败 => provider 永久 unknown（连本进程自己的实例 token 也一样），且只记一条警告。
  const failAcquire = async (options) => {
    calls.push({ call: "acquire", dir: options?.dir, hostInstanceId: options?.hostInstanceId, takeover: options?.takeover });
    throw new Error("epoch directory is unwritable");
  };
  const failRun = await bootLive("fail", failAcquire);
  const noEpochOwn = await failRun.provider({ jobId: "job-x", hostInstanceId: failRun.seen?.hostInstanceId });
  const noEpochOther = await failRun.provider({ jobId: "job-y", hostInstanceId: "dsh-wiki.previous" });
  check("liveness: with no epoch acquired the provider reports unknown (own and foreign records alike)",
    noEpochOwn?.state === "unknown" && noEpochOther?.state === "unknown"
    && noEpochOwn?.proof === undefined && noEpochOther?.proof === undefined,
    JSON.stringify({ noEpochOwn, noEpochOther }));
  check("liveness: a failed epoch claim logs exactly one fail-closed warning and keeps jobs running",
    failRun.state.warnings.filter((w) => /host epoch/.test(w)).length === 1
    && failRun.state.warnings.filter((w) => /could not start/.test(w)).length === 0
    && failRun.state.registered.routes.length > 0,
    JSON.stringify(failRun.state.warnings));
  await disposeAll(failRun.state);

  Object.assign(__livenessInternals, REAL_LIVENESS);
}

// ---------- GET /api/jobs/recovery-plan：只读恢复计划状态（spec 007） ----------
{
  // 夹具：一个“已登记 + 规范”的正常仓库根（带 .dsh-wiki），以及指向它的 junction。
  const planRepo = tempDir("dsh-wiki-plan-");
  mkdirSync(path.join(planRepo, ".dsh-wiki", "site"), { recursive: true });
  writeFileSync(path.join(planRepo, ".dsh-wiki", "wiki.json"), JSON.stringify({ schema: "repo-wiki-local/1", title: "Plan Repo", pages: [] }));
  writeFileSync(path.join(planRepo, ".dsh-wiki", "site", "index.html"), "<!DOCTYPE html><html><body>plan</body></html>");
  const planWikiDir = path.join(planRepo, ".dsh-wiki");
  const planLink = path.join(tempDir("dsh-wiki-plan-link-"), "link");
  let planLinkOk = true;
  try { symlinkSync(planRepo, planLink, "junction"); } catch { planLinkOk = false; }

  // 目录快照：相对路径、大小、mtime 与内容（只读证明：前后必须逐字节相同）。
  const treeSnapshot = (dir) => {
    const out = [];
    const walk = (current, rel) => {
      for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        const abs = path.join(current, entry.name);
        const key = rel ? path.join(rel, entry.name) : entry.name;
        if (entry.isDirectory()) { out.push(`d:${key}`); walk(abs, key); }
        else out.push(`f:${key}:${statSync(abs).size}:${statSync(abs).mtimeMs}:${readFileSync(abs).toString("base64")}`);
      }
    };
    walk(dir, "");
    return out.join("|");
  };

  // (c) jobs 关闭：503，沿用其它作业路由的固定 code/message/disabled 形状（根仍然先被授权）。
  const planOffStore = path.join(tempDir("dsh-wiki-plan-off-"), "journal");
  const planOffState = makeCtx("plan-off");
  apply(planOffState.ctx, { wikiDirName: ".dsh-wiki", wikiRoots: [planRepo], jobs: { enabled: false, storeDir: planOffStore } });
  const planOffClient = makeClient(planOffState.registered.routes[0].handler);
  const planOffRes = await planOffClient.get(`/dsh-wiki/api/jobs/recovery-plan?root=${encodeURIComponent(planRepo)}`);
  check("recovery-plan: jobs disabled answers 503 in the existing job-unavailable shape",
    planOffRes.status === 503
    && JSON.stringify(Object.keys(planOffRes.json ?? {}).sort()) === JSON.stringify(["code", "disabled", "error"])
    && planOffRes.json?.error === GATE_MESSAGE && planOffRes.json?.code === "jobs-disabled"
    && planOffRes.json?.disabled === true && !existsSync(planOffStore),
    `${planOffRes.status} ${planOffRes.body.slice(0, 160)}`);
  await disposeAll(planOffState);

  // 开启：假 store/manager/guard（harness 既有形状），路线只读，绝不 start/cancel。
  const planStore = path.join(tempDir("dsh-wiki-plan-on-"), "journal");
  const planState = { fenced: [], unresolved: [] };
  const planProbe = { managers: 0, starts: 0 };
  spyJobsInternals({
    openJournalStore: async () => ({ load: async () => null, create: async () => ({}), advance: async () => ({}), replaceTerminal: async () => ({}) }),
    createJobManager: () => {
      planProbe.managers++;
      return {
        start: () => { planProbe.starts++; throw new Error("the recovery-plan route must never start a job"); },
        cancel: () => { planProbe.starts++; throw new Error("the recovery-plan route must never cancel a job"); },
        view: () => ({ active: null, last: null }),
        journalState: () => ({ mode: "journal", missing: [], fenced: planState.fenced }),
        unresolvedWorkers: () => planState.unresolved,
        dispose: async () => ({ unresolved: [] }),
      };
    },
    createWorkerGuard: jobGuard,
  });
  const planOnState = makeCtx("plan-on");
  planOnState.ctx.agents = { create: async () => { throw new Error("no worker may start"); } };
  planOnState.ctx.workingDirectory = { get: () => planRepo };
  planOnState.ctx.agentPresets = presetService();
  apply(planOnState.ctx, {
    wikiDirName: ".dsh-wiki",
    wikiRoots: planLinkOk ? [planRepo, planLink] : [planRepo],
    jobs: { enabled: true, storeDir: planStore },
  });
  await waitFor(() => planProbe.managers === 1, "recovery-plan job runtime construction");
  // 构造本身会打开 store 并领取 host epoch（与路线无关）：等它落定再拍快照，否则量到的是构造的写。
  await waitFor(() => existsSync(path.join(planStore, "host-epoch")), "recovery-plan store opening");
  const planClient = makeClient(planOnState.registered.routes[0].handler);

  // (a) 未知根：固定 JSON、不回显路径。
  const planUnknown = await planClient.get(`/dsh-wiki/api/jobs/recovery-plan?root=${encodeURIComponent(path.join(planRepo, "no-such-project"))}`);
  check("recovery-plan: an unknown root is refused with the fixed JSON and no path echo",
    planUnknown.status === 403 && planUnknown.json?.code === "unknown-project"
    && planUnknown.json?.error === "unknown project root"
    && JSON.stringify(Object.keys(planUnknown.json ?? {}).sort()) === JSON.stringify(["code", "error"])
    && !/[A-Za-z]:[\\/]/.test(planUnknown.body),
    `${planUnknown.status} ${planUnknown.body.slice(0, 160)}`);

  // (b) 链接根（junction）：projectFor 的规范检查拒绝，绝不回显目标路径。
  if (!planLinkOk) {
    console.log("SKIP recovery-plan linked root test (junction creation unavailable on this filesystem)");
  } else {
    const planLinked = await planClient.get(`/dsh-wiki/api/jobs/recovery-plan?root=${encodeURIComponent(planLink)}`);
    check("recovery-plan: a junction root is refused (403 unknown-project, no target echo)",
      planLinked.status === 403 && planLinked.json?.code === "unknown-project"
      && !/[A-Za-z]:[\\/]/.test(planLinked.body)
      && !planLinked.body.toLowerCase().includes(planRepo.toLowerCase()),
      `${planLinked.status} ${planLinked.body.slice(0, 160)}`);
  }

  // (d) 正常项目：200 + 精确字段集；wiki 目录与 store 目录 mtime/内容前后不变（严格只读）。
  const wikiBefore = treeSnapshot(planWikiDir);
  const storeBefore = existsSync(planStore) ? readdirSync(planStore).sort() : null;
  const planRes = await planClient.get(`/dsh-wiki/api/jobs/recovery-plan?root=${encodeURIComponent(planRepo)}`);
  const planResAgain = await planClient.get(`/dsh-wiki/api/jobs/recovery-plan?root=${encodeURIComponent(planRepo)}`);
  const wikiAfter = treeSnapshot(planWikiDir);
  const storeAfter = existsSync(planStore) ? readdirSync(planStore).sort() : null;
  check("recovery-plan: a normal project answers 200 with exactly the documented fields",
    planRes.status === 200
    && JSON.stringify(Object.keys(planRes.json ?? {}).sort())
      === JSON.stringify(["actionCount", "code", "decision", "fenceReason", "fenced", "ok", "reason", "workerState"])
    && planRes.json?.ok === true && planRes.json?.fenced === false && planRes.json?.fenceReason === null
    && planRes.json?.decision === null && planRes.json?.code === null && planRes.json?.reason === null
    && planRes.json?.actionCount === 0 && planRes.json?.workerState === null,
    `${planRes.status} ${planRes.body.slice(0, 240)}`);
  check("recovery-plan: the route is read-only (wiki contents/sizes/mtimes and store entries unchanged, no staging/backup)",
    wikiBefore === wikiAfter && JSON.stringify(storeBefore) === JSON.stringify(storeAfter)
    && planRes.body === planResAgain.body
    && !readdirSync(planRepo).some((name) => name.startsWith(".dsh-wiki.staging-") || name.startsWith(".dsh-wiki.bak-")),
    `${wikiBefore === wikiAfter} store=${JSON.stringify(storeBefore)} -> ${JSON.stringify(storeAfter)} stable=${planRes.body === planResAgain.body}`);

  // (e) 响应体里没有盘符绝对路径。
  check("recovery-plan: the body contains no drive-letter absolute path",
    !/[A-Za-z]:[\\/]/.test(planRes.body) && !planRes.body.includes(planRepo) && !planRes.body.includes(planRepo.replace(/\\/g, "\\\\")),
    planRes.body.slice(0, 240));

  // (f) POST 不执行任何东西：方法闸门直接 405，管理器一次都没被调用。
  const planPost = await planClient.post("/dsh-wiki/api/jobs/recovery-plan", { root: planRepo });
  check("recovery-plan: POST is not allowed and executes nothing (405)",
    planPost.status === 405 && planPost.json?.error === "method not allowed" && planProbe.starts === 0,
    `${planPost.status} ${planPost.body.slice(0, 160)}`);

  // fenced/workerState 投影：只用假管理器（不是真实 journal 记录），证明映射与“不回显内部记录”。
  const planWikiBeforeFence = treeSnapshot(planWikiDir);
  const planStoreBeforeFence = existsSync(planStore) ? readdirSync(planStore).sort() : null;
  planState.fenced = [{ root: planRepo, jobId: "job-fenced-1", reason: "journal-commit-uncertain" }];
  planState.unresolved = [{ root: planRepo, jobId: "job-fenced-1", sessionId: null }];
  const planFenced = await planClient.get(`/dsh-wiki/api/jobs/recovery-plan?root=${encodeURIComponent(planRepo)}`);
  check("recovery-plan: a fenced root answers 200 with fenced:true and a non-empty fenceReason",
    planFenced.status === 200 && planFenced.json?.ok === true && planFenced.json?.fenced === true
    && planFenced.json?.fenceReason === "journal-commit-uncertain",
    `${planFenced.status} ${planFenced.body.slice(0, 240)}`);
  check("recovery-plan: the fenced body echoes no drive-letter path, internal jobId or fence root",
    !/[A-Za-z]:[\\/]/.test(planFenced.body)
    && !planFenced.body.includes("job-fenced-1")
    && !planFenced.body.includes(planRepo) && !planFenced.body.includes(planRepo.replace(/\\/g, "\\\\")),
    planFenced.body.slice(0, 240));
  check("recovery-plan: an unresolved worker for this root projects workerState \"unknown\"",
    planFenced.json?.workerState === "unknown", planFenced.body.slice(0, 240));
  planState.unresolved = [];
  const planWorkerClear = await planClient.get(`/dsh-wiki/api/jobs/recovery-plan?root=${encodeURIComponent(planRepo)}`);
  check("recovery-plan: an empty unresolved list projects workerState null while the fence stays",
    planWorkerClear.status === 200 && planWorkerClear.json?.workerState === null && planWorkerClear.json?.fenced === true,
    `${planWorkerClear.status} ${planWorkerClear.body.slice(0, 240)}`);
  // (b) 同一个假管理器，去掉本根的 fenced 条目：fenced:false —— 证明该分支不是常量。
  planState.fenced = [];
  planState.unresolved = [];
  const planUnfenced = await planClient.get(`/dsh-wiki/api/jobs/recovery-plan?root=${encodeURIComponent(planRepo)}`);
  const planWikiAfterFence = treeSnapshot(planWikiDir);
  const planStoreAfterFence = existsSync(planStore) ? readdirSync(planStore).sort() : null;
  check("recovery-plan: without a fence entry the same root reports fenced:false and no worker",
    planUnfenced.status === 200 && planUnfenced.json?.fenced === false && planUnfenced.json?.fenceReason === null
    && planUnfenced.json?.workerState === null,
    `${planUnfenced.status} ${planUnfenced.body.slice(0, 240)}`);
  // (e) 严格只读：fenced 与解封两次读取前后，wiki 目录（内容/大小/mtime）与 store 条目逐字节不变。
  check("recovery-plan: fenced and unfenced reads leave the wiki dir and store untouched",
    planWikiBeforeFence === planWikiAfterFence
    && JSON.stringify(planStoreBeforeFence) === JSON.stringify(planStoreAfterFence)
    && !readdirSync(planRepo).some((name) => name.startsWith(".dsh-wiki.staging-") || name.startsWith(".dsh-wiki.bak-")),
    `wiki=${planWikiBeforeFence === planWikiAfterFence} store=${JSON.stringify(planStoreBeforeFence)} -> ${JSON.stringify(planStoreAfterFence)}`);

  await disposeAll(planOnState);
}

// ---------- POST /api/jobs/recovery-execute：journal 恢复的执行入口（T018） ----------
{
  // 夹具：一个“已登记 + 规范”的项目根（带 .dsh-wiki）；同一个根下的不存在目录作未授权对照。
  const execRepo = tempDir("dsh-wiki-exec-");
  mkdirSync(path.join(execRepo, ".dsh-wiki", "site"), { recursive: true });
  writeFileSync(path.join(execRepo, ".dsh-wiki", "wiki.json"), JSON.stringify({ schema: "repo-wiki-local/1", title: "Exec Repo", pages: [] }));
  writeFileSync(path.join(execRepo, ".dsh-wiki", "site", "index.html"), "<!DOCTYPE html><html><body>exec</body></html>");
  const EXEC_URL = "/dsh-wiki/api/jobs/recovery-execute";
  const CONFIRM = "execute-recovery";
  // 管理器收到的 root 是 projectFor 给出的规范路径：Windows 上按大小写无关比较。
  const sameRoot = (left, right) => (process.platform === "win32"
    ? path.resolve(String(left)).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(String(left)) === path.resolve(right));

  // (a) jobs 关闭：既有字节形状的 503（在读取体与触碰管理器之前），管理器与 reconcile 都是零次。
  const execOffStore = path.join(tempDir("dsh-wiki-exec-off-"), "journal");
  const execOffProbe = { managers: 0, reconciles: 0 };
  spyJobsInternals({
    createJobManager: () => {
      execOffProbe.managers++;
      return {
        reconcile: async () => { execOffProbe.reconciles++; return { status: "executed" }; },
        view: () => ({ active: null, last: null }),
        journalState: () => ({ mode: "journal", missing: [], fenced: [] }),
        unresolvedWorkers: () => [],
        dispose: async () => ({ unresolved: [] }),
      };
    },
    createWorkerGuard: jobGuard,
  });
  const execOffState = makeCtx("exec-off");
  apply(execOffState.ctx, { wikiDirName: ".dsh-wiki", wikiRoots: [execRepo], jobs: { enabled: false, storeDir: execOffStore } });
  const execOffClient = makeClient(execOffState.registered.routes[0].handler);
  const execOffRes = await execOffClient.post(EXEC_URL, { root: execRepo, confirm: CONFIRM });
  check("recovery-execute: jobs disabled answers the existing byte-identical 503 and never reconciles",
    execOffRes.status === 503
    && JSON.stringify(Object.keys(execOffRes.json ?? {}).sort()) === JSON.stringify(["disabled", "error"])
    && execOffRes.json?.error === GATE_MESSAGE && execOffRes.json?.disabled === true
    && execOffProbe.managers === 0 && execOffProbe.reconciles === 0 && !existsSync(execOffStore),
    `${execOffRes.status} ${execOffRes.body.slice(0, 160)}`);
  await disposeAll(execOffState);

  // 开启：假 store/manager（harness 既有形状）。reconcile 是唯一允许被调用的执行入口。
  const execStore = path.join(tempDir("dsh-wiki-exec-on-"), "journal");
  const execProbe = { managers: 0, calls: [], result: null, storeOpens: [] };
  spyJobsInternals({
    openJournalStore: async (options) => {
      execProbe.storeOpens.push(options);
      return { hostInstanceId: options?.hostInstanceId ?? null, load: async () => null, create: async () => ({}), advance: async () => ({}), replaceTerminal: async () => ({}) };
    },
    createJobManager: () => {
      execProbe.managers++;
      return {
        start: () => { throw new Error("the recovery-execute route must never start a job"); },
        cancel: () => { throw new Error("the recovery-execute route must never cancel a job"); },
        reconcile: async (root, options) => { execProbe.calls.push({ root, options }); return execProbe.result; },
        view: () => ({ active: null, last: null }),
        journalState: () => ({ mode: "journal", missing: [], fenced: [] }),
        unresolvedWorkers: () => [],
        dispose: async () => ({ unresolved: [] }),
      };
    },
    createWorkerGuard: jobGuard,
  });
  const execOnState = makeCtx("exec-on");
  execOnState.ctx.agents = { create: async () => { throw new Error("no worker may start"); } };
  execOnState.ctx.workingDirectory = { get: () => execRepo };
  execOnState.ctx.agentPresets = presetService();
  apply(execOnState.ctx, {
    wikiDirName: ".dsh-wiki",
    wikiRoots: [execRepo],
    jobs: { enabled: true, storeDir: execStore },
  });
  await waitFor(() => execProbe.managers === 1, "recovery-execute job runtime construction");
  // 构造本身会打开 store 并领取 host epoch：等它落定再断言，否则量到的是构造的写。
  await waitFor(() => existsSync(path.join(execStore, "host-epoch")), "recovery-execute store opening");
  const execClient = makeClient(execOnState.registered.routes[0].handler);

  // (b) 跨源：Origin 与请求实际到达的传输/Host 不一致 => 403 cross-origin，够不到管理器。
  const execCross = await execClient.post(EXEC_URL, { root: execRepo, confirm: CONFIRM }, { origin: "https://evil.example" });
  check("recovery-execute: a cross-origin request is refused 403 cross-origin and never reconciles",
    execCross.status === 403 && execCross.json?.code === "cross-origin" && execProbe.calls.length === 0,
    `${execCross.status} ${execCross.body.slice(0, 160)}`);

  // (c) content-type 不是 JSON => 415，绝不解析请求体、绝不 reconcile。
  const execContentType = await execClient.post(EXEC_URL, { root: execRepo, confirm: CONFIRM }, { "content-type": "text/plain" });
  check("recovery-execute: a non-JSON content-type is refused 415 content-type and never reconciles",
    execContentType.status === 415 && execContentType.json?.code === "content-type" && execProbe.calls.length === 0,
    `${execContentType.status} ${execContentType.body.slice(0, 160)}`);

  // (d) 只带 root、不带 confirm：400 confirmation-required，reconcile 计数必须仍是 0。
  const execNoConfirm = await execClient.post(EXEC_URL, { root: execRepo });
  check("recovery-execute: a body with root but no confirm is refused 400 confirmation-required and executes nothing",
    execNoConfirm.status === 400 && execNoConfirm.json?.code === "confirmation-required"
    && execProbe.calls.length === 0,
    `${execNoConfirm.status} ${execNoConfirm.body.slice(0, 160)}`);

  // (e) confirm 值不对：同样 400，绝不执行。
  const execWrongConfirm = await execClient.post(EXEC_URL, { root: execRepo, confirm: "yes" });
  check("recovery-execute: a wrong confirm literal is refused 400 confirmation-required and executes nothing",
    execWrongConfirm.status === 400 && execWrongConfirm.json?.code === "confirmation-required"
    && execProbe.calls.length === 0,
    `${execWrongConfirm.status} ${execWrongConfirm.body.slice(0, 160)}`);

  // (f) 未知字段：显式拒绝，绝不静默丢弃；且本路由不反射调用方输入——键名可能是一条路径，
  // 所以只回固定短句与稳定 code，没有 unsupportedFields，原始键名一个字都不进响应体。
  const execUnknownField = await execClient.post(EXEC_URL, { root: execRepo, confirm: CONFIRM, execute: true });
  const execPathShapedKey = "C:\\Users\\secret";
  const execPathShapedField = await execClient.post(EXEC_URL, {
    root: execRepo, confirm: CONFIRM, [execPathShapedKey]: true,
  });
  check("recovery-execute: an unknown field is refused 400 unsupported-field and executes nothing",
    execUnknownField.status === 400 && execUnknownField.json?.code === "unsupported-field"
    && typeof execUnknownField.json?.error === "string"
    && execUnknownField.json?.error === "the request carries a field this slice does not support"
    && !Object.hasOwn(execUnknownField.json ?? {}, "unsupportedFields")
    && execPathShapedField.status === 400 && execPathShapedField.json?.code === "unsupported-field"
    && typeof execPathShapedField.json?.error === "string"
    && !Object.hasOwn(execPathShapedField.json ?? {}, "unsupportedFields")
    && !execPathShapedField.body.includes("secret") && !execPathShapedField.body.includes("Users")
    && !execPathShapedField.body.includes(execPathShapedKey.replace(/\\/g, "\\\\"))
    && !/[A-Za-z]:[\\/]/.test(execPathShapedField.body)
    && execProbe.calls.length === 0,
    `${execUnknownField.status} ${execUnknownField.body.slice(0, 160)} | ${execPathShapedField.status} ${execPathShapedField.body.slice(0, 160)}`);

  // (g) 未授权根：403 unknown-root（projectFor 的既有语义），绝不执行、不回显路径。
  const execUnknownRoot = await execClient.post(EXEC_URL, { root: path.join(execRepo, "no-such-project"), confirm: CONFIRM });
  check("recovery-execute: an unauthorised root is refused 403 unknown-root and executes nothing",
    execUnknownRoot.status === 403 && execUnknownRoot.json?.code === "unknown-root"
    && execProbe.calls.length === 0 && !/[A-Za-z]:[\\/]/.test(execUnknownRoot.body),
    `${execUnknownRoot.status} ${execUnknownRoot.body.slice(0, 160)}`);

  // (h) 同一路径的 GET：恢复执行只有 POST 形态，方法闸门直接 405。
  const execGet = await execClient.get(EXEC_URL);
  check("recovery-execute: GET on the execute path is 405 and executes nothing",
    execGet.status === 405 && execGet.json?.error === "method not allowed" && execProbe.calls.length === 0,
    `${execGet.status} ${execGet.body.slice(0, 160)}`);

  // (i) 成功：executed/effects/released 如实投影；响应只有文档化的 8 个键，内部字段一概不回显。
  execProbe.result = {
    status: "executed", executed: true, effects: 2, released: true, releaseReason: null,
    root: execRepo, jobId: "job-exec-1", message: `restored ${execRepo}`,
    observations: { worker: "stopped" }, plan: { actions: ["restore-live"] },
  };
  const execWarnBefore = execOnState.warnings.length;
  const execOk = await execClient.post(EXEC_URL, { root: execRepo, confirm: CONFIRM });
  check("recovery-execute: a successful execute answers 200 with exactly the documented fields",
    execOk.status === 200
    && JSON.stringify(Object.keys(execOk.json ?? {}).sort())
      === JSON.stringify(["code", "effects", "executed", "ok", "releaseCode", "releaseReason", "released", "status"])
    && execOk.json?.ok === true && execOk.json?.status === "executed"
    && execOk.json?.executed === true && execOk.json?.effects === 2 && execOk.json?.released === true
    && execOk.json?.releaseReason === null
    && execOk.json?.code === null && execOk.json?.releaseCode === null,
    `${execOk.status} ${execOk.body.slice(0, 240)}`);
  // 成功的执行没有错误码：缺省的 undefined 必须投影成 null，绝不能是 internal-error。
  check("recovery-execute: a successful execute keeps status executed verbatim with code/releaseCode null",
    execOk.json?.status === "executed" && execOk.json?.code === null && execOk.json?.releaseCode === null,
    JSON.stringify(execOk.json));
  check("recovery-execute: the success body echoes no path, jobId, observations or plan",
    !/[A-Za-z]:[\\/]/.test(execOk.body)
    && !execOk.body.includes(execRepo) && !execOk.body.includes(execRepo.replace(/\\/g, "\\\\"))
    && !execOk.body.includes("job-exec-1") && !execOk.body.includes("observations")
    && !execOk.body.includes("restore-live"),
    execOk.body.slice(0, 240));
  check("recovery-execute: reconcile is called exactly once on the authorised root with execute+recovery and the unpinned store",
    execProbe.calls.length === 1 && sameRoot(execProbe.calls[0]?.root, execRepo)
    && execProbe.calls[0]?.options?.execute === true
    && execProbe.calls[0]?.options?.recovery === true
    && typeof execProbe.calls[0]?.options?.store?.load === "function"
    && execProbe.calls[0]?.options?.store?.hostInstanceId === null,
    JSON.stringify(execProbe.calls.map((call) => ({ ...call, options: { ...call.options, store: typeof call.options?.store } }))));
  // 恢复专用 store 必须是**第二个**实例：普通实例（构造时打开、钉死在本进程实例上）与未钉死的恢复实例
  // 各一个，同一 storeDir、同一份 allowlist；两者都走同一条 ensureJobStoreDir/resolveTrustedJobRoots 路径。
  check("recovery-execute: a second, UNPINNED store is opened over the same storeDir and roots",
    execProbe.storeOpens.length === 2
    && typeof execProbe.storeOpens[0]?.hostInstanceId === "string"
    && execProbe.storeOpens[1]?.hostInstanceId === undefined
    && execProbe.storeOpens[1]?.storeDir === execProbe.storeOpens[0]?.storeDir
    && JSON.stringify(execProbe.storeOpens[1]?.allowedRoots) === JSON.stringify(execProbe.storeOpens[0]?.allowedRoots),
    JSON.stringify(execProbe.storeOpens));
  const execWarns = execOnState.warnings.slice(execWarnBefore);
  check("recovery-execute: exactly one warn line per attempt, carrying only public status/code/boolean",
    execWarns.length === 1
    && execWarns[0] === "dsh-wiki: recovery execute status=executed code=null released=true"
    && !execWarns[0].includes("code=internal-error")
    && !/[A-Za-z]:[\\/]/.test(execWarns.join("|")),
    JSON.stringify(execWarns));

  // (j) 拒绝（job-active）：确定性 409 + 映射后的公开 code，绝不回显内部记录。
  execProbe.result = {
    status: "refused", code: "job-active", released: false, releaseReason: "job-active",
    root: execRepo, jobId: "job-exec-2", message: `journal fence for ${execRepo}`,
  };
  const execRefused = await execClient.post(EXEC_URL, { root: execRepo, confirm: CONFIRM });
  check("recovery-execute: a refused execute maps to 409 with the mapped public code",
    execRefused.status === 409 && execRefused.json?.code === "job-active"
    && execRefused.json?.released === false && execRefused.json?.releaseReason === "job-active"
    && execRefused.json?.ok === false && !execRefused.body.includes("job-exec-2"),
    `${execRefused.status} ${execRefused.body.slice(0, 240)}`);

  // (k) 没有 journal 记录：404 no-record。
  execProbe.result = { status: "no-record", root: execRepo };
  const execNoRecord = await execClient.post(EXEC_URL, { root: execRepo, confirm: CONFIRM });
  check("recovery-execute: a missing journal record maps to 404 no-record",
    execNoRecord.status === 404 && execNoRecord.json?.code === "no-record"
    && execNoRecord.json?.executed === false && execNoRecord.json?.effects === 0
    && execNoRecord.json?.released === false,
    `${execNoRecord.status} ${execNoRecord.body.slice(0, 240)}`);

  // (l) 管理器结果里的原始绝对路径（Windows 与 fs 风格各一条）绝不进入响应体。
  const execLeakRoot = "C:\\Users\\neste\\Documents\\DSH_Project\\dsh-ext";
  const execLeakMessage = "EACCES: permission denied, open '/home/neste/dsh-wiki/journal/record.json'";
  execProbe.result = {
    status: "planned", root: execLeakRoot, message: execLeakMessage,
    executed: false, effects: 0, released: false, releaseReason: null,
  };
  const execLeak = await execClient.post(EXEC_URL, { root: execRepo, confirm: CONFIRM });
  check("recovery-execute: absolute paths in the manager result never reach the response body",
    execLeak.status === 200
    && !execLeak.body.includes(execLeakRoot) && !execLeak.body.includes(execLeakMessage)
    && !execLeak.body.includes("Users") && !execLeak.body.includes("/home/neste")
    && !execLeak.body.includes("EACCES") && !/[A-Za-z]:[\\/]/.test(execLeak.body),
    `${execLeak.status} ${execLeak.body.slice(0, 240)}`);

  // (m) 管理器给的 code 若是“给了但不可用作 token 的字符串”（这里是一条真实的绝对路径），
  // 只能收敛为 internal-error；这与 (i) 的“缺省 => null”是两条不同的规则，原始字符串绝不进响应体。
  const execHostileCode = "C:\\Users\\secret\\key";
  execProbe.result = {
    status: "executed", executed: true, effects: 1, released: true, releaseReason: "no-action",
    code: execHostileCode, releaseCode: execHostileCode,
  };
  const execHostile = await execClient.post(EXEC_URL, { root: execRepo, confirm: CONFIRM });
  check("recovery-execute: a hostile manager-supplied code collapses to internal-error and never echoes the raw string",
    execHostile.status === 200 && execHostile.json?.code === "internal-error"
    && execHostile.json?.releaseCode === "internal-error"
    && !execHostile.body.includes("secret") && !execHostile.body.includes("Users")
    && !execHostile.body.includes(execHostileCode.replace(/\\/g, "\\\\"))
    && !/[A-Za-z]:[\\/]/.test(execHostile.body),
    `${execHostile.status} ${execHostile.body.slice(0, 240)}`);

  // (n) 白名单投影（reviewer 2026-11-10）：只有 allowlist 成员原样公开，其余（含缺省）落到文档化的
  // fallback；全部走同一个注入点 execProbe.result，逐个值验证，绝不回显管理器/调用方输入。
  // 干净的成功：缺省的可选字段一律 null（不是 internal-error）。
  execProbe.result = { status: "executed", executed: true, effects: 2, released: true };
  const execAllowOk = await execClient.post(EXEC_URL, { root: execRepo, confirm: CONFIRM });
  check("recovery-execute: the allowlist keeps a clean success at 200 with null optional codes",
    execAllowOk.status === 200 && execAllowOk.json?.ok === true && execAllowOk.json?.status === "executed"
    && execAllowOk.json?.code === null && execAllowOk.json?.releaseCode === null
    && execAllowOk.json?.releaseReason === null
    && execAllowOk.json?.executed === true && execAllowOk.json?.effects === 2 && execAllowOk.json?.released === true,
    `${execAllowOk.status} ${execAllowOk.body.slice(0, 240)}`);

  // token 形状但不在 allowlist 里的 code：只收敛成 internal-error，原值绝不带出。
  execProbe.result = { status: "executed", executed: true, effects: 1, released: true, code: "ecde9d05" };
  const execTokenCode = await execClient.post(EXEC_URL, { root: execRepo, confirm: CONFIRM });
  check("recovery-execute: a token-shaped unlisted code collapses to internal-error",
    execTokenCode.status === 200 && execTokenCode.json?.code === "internal-error"
    && !execTokenCode.body.includes("ecde9d05"),
    `${execTokenCode.status} ${execTokenCode.body.slice(0, 240)}`);

  // releaseReason 的 fallback 是 null（它没有 internal-error 这一说），原值绝不进响应体。
  execProbe.result = { status: "executed", executed: true, effects: 1, released: false, releaseReason: "385b048b8c394c07" };
  const execTokenReason = await execClient.post(EXEC_URL, { root: execRepo, confirm: CONFIRM });
  check("recovery-execute: a token-shaped unlisted releaseReason collapses to null and never leaks",
    execTokenReason.status === 200 && execTokenReason.json?.releaseReason === null
    && !execTokenReason.body.includes("385b048b8c394c07"),
    `${execTokenReason.status} ${execTokenReason.body.slice(0, 240)}`);

  // allowlist 里的正向值原样通过：code 与 releaseReason 各一个，HTTP 仍是 409 refused。
  execProbe.result = { status: "refused", code: "job-active", released: false, releaseReason: "no-action" };
  const execAllowedPositive = await execClient.post(EXEC_URL, { root: execRepo, confirm: CONFIRM });
  check("recovery-execute: allowlisted code and releaseReason pass through verbatim on 409",
    execAllowedPositive.status === 409 && execAllowedPositive.json?.code === "job-active"
    && execAllowedPositive.json?.releaseReason === "no-action"
    && execAllowedPositive.json?.ok === false,
    `${execAllowedPositive.status} ${execAllowedPositive.body.slice(0, 240)}`);

  // 不认识的 status：收敛成 error/500；显式但不可用的 code 收敛成 internal-error。
  // （code 缺省是 null——那是 (i) 的“没有错误码”规则——所以要断言 internal-error 必须显式给一个不可用值。）
  execProbe.result = { status: "weird-status", code: "weird-status" };
  const execUnknownStatus = await execClient.post(EXEC_URL, { root: execRepo, confirm: CONFIRM });
  check("recovery-execute: an unlisted status collapses to error/500 with an internal-error code",
    execUnknownStatus.status === 500 && execUnknownStatus.json?.status === "error"
    && execUnknownStatus.json?.code === "internal-error"
    && !execUnknownStatus.body.includes("weird-status"),
    `${execUnknownStatus.status} ${execUnknownStatus.body.slice(0, 240)}`);

  // no-record 保持自己的公开 code（特有的 404 分支）。
  execProbe.result = { status: "no-record" };
  const execAllowNoRecord = await execClient.post(EXEC_URL, { root: execRepo, confirm: CONFIRM });
  check("recovery-execute: no-record still maps to 404 with its own public code",
    execAllowNoRecord.status === 404 && execAllowNoRecord.json?.code === "no-record",
    `${execAllowNoRecord.status} ${execAllowNoRecord.body.slice(0, 240)}`);

  // 敌意 code（一条真实绝对路径）：仍收敛成 internal-error，原始字符串一个字都不进响应体。
  const execHostilePathCode = "C:\\Users\\secret\\key";
  execProbe.result = { status: "executed", executed: true, effects: 1, released: false, code: execHostilePathCode };
  const execHostileAgain = await execClient.post(EXEC_URL, { root: execRepo, confirm: CONFIRM });
  check("recovery-execute: a path-shaped hostile code never appears in the response",
    execHostileAgain.json?.code === "internal-error"
    && !execHostileAgain.body.includes("secret") && !execHostileAgain.body.includes("Users")
    && !execHostileAgain.body.includes(execHostilePathCode.replace(/\\/g, "\\\\"))
    && !/[A-Za-z]:[\\/]/.test(execHostileAgain.body),
    `${execHostileAgain.status} ${execHostileAgain.body.slice(0, 240)}`);

  // 公开投影的键集固定为这 8 个：任何分支（200/409/500）都不多带 unsupportedFields/message/plan/observations。
  const EXEC_RESPONSE_KEYS = JSON.stringify(["code", "effects", "executed", "ok", "releaseCode", "releaseReason", "released", "status"]);
  check("recovery-execute: every response exposes exactly the documented eight keys",
    [execAllowOk, execAllowedPositive, execUnknownStatus].every((response) =>
      JSON.stringify(Object.keys(response.json ?? {}).sort()) === EXEC_RESPONSE_KEYS),
    JSON.stringify([execAllowOk.json, execAllowedPositive.json, execUnknownStatus.json]));

  await disposeAll(execOnState);
}

restoreJobsInternals();

console.log(FAILS.length ? `\n${FAILS.length} FAILED` : "\nALL PASS");

process.exit(FAILS.length ? 1 : 0);
