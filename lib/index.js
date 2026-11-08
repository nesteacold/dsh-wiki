// dsh-wiki — 纯本地 Repo Wiki（DeepWiki 式）宿主半区。
// 职责：注册 agent 技能（生成协议）、/wiki 命令、本机站点路由 /dsh-wiki。
// 只用 node 内建模块；宿主服务全部通过 ctx 名称解析，不直接 import DSH 包。
import { readFile, writeFile, rename, mkdir, stat } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const name = "dsh-wiki";
export const inject = ["skills", "commands", "webServer"];

const NS = "dsh-wiki";
const ROUTE = "/dsh-wiki";
const REGISTRY_VERSION = 1;
const LOCALE = {
  zh: {
    commandDescription: "生成本地 Repo Wiki、查看站点或列出已知 wiki",
    commandHint: "[generate <仓库路径>] | view [仓库路径] | list",
    noWiki: "当前目录没有 wiki。先运行：/wiki generate",
    started: "已启动子代理开始生成 wiki（在当前会话中运行）。完成后会汇报站点路径。",
    startFailed: "启动生成失败：",
    siteReady: "Wiki 站点：",
    siteMissing: "站点未构建（缺 site/index.html）。先运行 /wiki generate 或按技能重新 build。",
    listHeader: "已知 wiki（会话工作区 + 配置 wikiRoots + 同级目录自动扫描）：",
    listEmpty: "还没有任何 wiki。在一个仓库会话里运行 /wiki generate。",
  },
  en: {
    commandDescription: "Generate a local repo wiki, open the site, or list known wikis",
    commandHint: "[generate <repo path>] | view [repo path] | list",
    noWiki: "No wiki in this directory yet. Run /wiki generate first.",
    started: "Subagent started to generate the wiki (runs in this session). It will report the site path when done.",
    startFailed: "Failed to start generation: ",
    siteReady: "Wiki site: ",
    siteMissing: "Site not built (missing site/index.html). Run /wiki generate, or rebuild per the skill.",
    listHeader: "Known wikis (session workspaces + configured wikiRoots + sibling scan):",
    listEmpty: "No wikis yet. Run /wiki generate in a repo session.",
  },
};
let activeLocale = "zh";
const t = (key) => LOCALE[activeLocale]?.[key] ?? LOCALE.zh[key] ?? key;

const DEFAULT_CONFIG = { wikiDirName: ".dsh-wiki", wikiRoots: [] };
const cleanRoots = (roots) =>
  Array.isArray(roots) ? roots.filter((r) => typeof r === "string" && path.isAbsolute(r)) : [];

const normalize = (p) => (p.endsWith(path.sep) ? p.slice(0, -1) : p);

// ---------- 请求信任围栏：只放行回环 Host（桌面端绑定 127.0.0.1） ----------
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
function isLoopbackRequest(req) {
  const host = req.headers?.host;
  if (typeof host !== "string" || host.length > 255) return false;
  const hostname = host.split(":", 1)[0].toLowerCase();
  return LOOPBACK_HOSTS.has(hostname);
}
function writeJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(text);
}
function writeText(res, status, text, type = "text/html; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(text);
}

// ---------- 工作区登记：从会话事件自动记住工作目录 ----------
function createWorkspaceBook(ctx, persistPath) {
  const seen = new Map(); // cwd -> lastSeen(ms)
  let saveTimer = null;
  const load = async () => {
    if (!persistPath) return;
    try {
      const raw = JSON.parse(await readFile(persistPath, "utf8"));
      if (raw && raw.version === REGISTRY_VERSION && Array.isArray(raw.roots)) {
        for (const row of raw.roots) {
          if (row && typeof row.path === "string" && path.isAbsolute(row.path)) {
            seen.set(normalize(row.path), Number(row.lastSeen) || 0);
          }
        }
      }
    } catch {
      /* 首次启动无登记文件属正常 */
    }
  };
  const persist = () => {
    if (!persistPath) return;
    if (saveTimer) return;
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      try {
        const roots = [...seen.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([p, lastSeen]) => ({ path: p, lastSeen }));
        const body = JSON.stringify({ version: REGISTRY_VERSION, roots }, null, 2);
        await mkdir(path.dirname(persistPath), { recursive: true });
        const tmp = `${persistPath}.tmp-${process.pid}`;
        await writeFile(tmp, body, "utf8");
        await rename(tmp, persistPath);
      } catch (err) {
        ctx.logger?.warn?.(`dsh-wiki: 登记文件写入失败 ${err?.message ?? err}`);
      }
    }, 2000);
  };
  const remember = (cwd) => {
    if (typeof cwd !== "string" || !path.isAbsolute(cwd) || cwd === "/") return;
    seen.set(normalize(cwd), Date.now());
    persist();
  };
  return { load, remember, roots: () => [...seen.keys()] };
}

// ---------- wiki 探测 ----------
function wikiFor(root, wikiDirName) {
  const dir = path.join(root, wikiDirName);
  const site = path.join(dir, "site", "index.html");
  if (!existsSync(site)) return null;
  let title = null;
  try {
    if (existsSync(path.join(dir, "wiki.json"))) {
      const parsed = JSON.parse(readFileSync(path.join(dir, "wiki.json"), "utf8"));
      if (typeof parsed.title === "string" && parsed.title) title = parsed.title;
      else if (typeof parsed.repoId === "string" && parsed.repoId) title = parsed.repoId;
    }
  } catch {
    /* 缺 meta 不影响列出 */
  }
  if (!title) title = path.basename(root);
  return { root, dir, site, title };
}

export function apply(ctx, rawConfig) {
  const config = { ...DEFAULT_CONFIG, ...(rawConfig && typeof rawConfig === "object" ? rawConfig : {}) };
  const wikiDirName = typeof config.wikiDirName === "string" && config.wikiDirName.startsWith(".")
    ? config.wikiDirName
    : DEFAULT_CONFIG.wikiDirName;
  const extraRoots = cleanRoots(config.wikiRoots);

  const pluginRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const builderPath = path.join(pluginRoot, "scripts", "build_wiki_site.py");

  // 宿主可用端口（webServer.port 由 dsh-host-webserver 提供，OS 分配时也是实际监听值）
  const baseUrl = () => {
    const ws = ctx.get?.("webServer");
    const port = ws?.port ?? 0;
    return port ? `http://127.0.0.1:${port}` : null;
  };

  // 1) agent 技能：生成协议（构建器绝对路径烧进内容，省去 find）
  const protocolFile = path.join(pluginRoot, "skills", "wiki-protocol.md");
  const skillContent = readFileSync(protocolFile, "utf8").split("{{BUILDER_PATH}}").join(builderPath);
  ctx.effect(() => ctx.skills.register({
    name: "dsh-wiki",
    description:
      "纯本地 Repo Wiki（零上传）。用户说“repo wiki”“生成 wiki”“仓库知识库”“deepwiki”“导入旧 wiki”或想要仓库深度分页文档时使用。" +
      "产出带证据引用（路径:行号）的分页 wiki（目录树+图表），构建单文件自包含站点，全程本地零网络。",
    whenToUse: "User asks to generate/refresh/import a repository wiki or wants deep, evidence-cited repo documentation locally.",
    source: "runtime",
    content: skillContent,
    resourceBase: { kind: "opaque", description: "dsh-wiki 生成协议（skills/wiki-protocol.md）" },
  }), "dsh-wiki: skill");

  // 2) 工作区登记
  const home = ctx.get?.("profileContext")?.home;
  const persistPath = home ? path.join(home, NS, "registry.json") : null;
  const book = createWorkspaceBook(ctx, persistPath);
  void book.load();
  const stopWatch = ctx.on("session/event", (session) => {
    const cwd = session?.header?.cwd;
    if (typeof cwd === "string") book.remember(cwd);
  });
  ctx.effect(() => stopWatch, "dsh-wiki: session watcher");

  // 3) 已知 wiki 列表（会话工作区 + 配置 wikiRoots + 同级目录扫描，去重）
  //    import-legacy 的落盘目标取旧 wiki.json 的 repoId，与会话 cwd 无关，
  //    登记表天然覆盖不到导入的 wiki。因此对已知根的父目录做一层扫描：
  //    兄弟目录凡含 <wikiDirName>/site/index.html 的也视为 wiki 根（非递归、跳过点目录）。
  const SIBLING_TTL = 5000;
  const siblingCache = new Map(); // parent -> { at, roots[] }
  const siblingRoots = (parents) => {
    const now = Date.now();
    const found = [];
    for (const parent of parents) {
      const hit = siblingCache.get(parent);
      if (hit && now - hit.at < SIBLING_TTL) {
        found.push(...hit.roots);
        continue;
      }
      const roots = [];
      let entries;
      try {
        entries = readdirSync(parent, { withFileTypes: true });
      } catch {
        siblingCache.set(parent, { at: now, roots });
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const candidate = path.join(parent, entry.name);
        if (existsSync(path.join(candidate, wikiDirName, "site", "index.html"))) roots.push(candidate);
      }
      siblingCache.set(parent, { at: now, roots });
      found.push(...roots);
    }
    return found;
  };
  const knownRoots = () => {
    const set = new Set(book.roots());
    for (const r of extraRoots) set.add(normalize(r));
    const base = [...set].filter((r) => existsSync(r));
    const parents = new Set();
    for (const r of base) {
      const parent = path.dirname(r);
      if (parent && parent !== r && parent !== path.parse(r).root) parents.add(parent);
    }
    for (const r of siblingRoots([...parents])) set.add(normalize(r));
    return [...set].filter((r) => existsSync(r));
  };
  const knownWikis = () =>
    knownRoots()
      .map((r) => wikiFor(r, wikiDirName))
      .filter(Boolean)
      .sort((a, b) => a.root.localeCompare(b.root));

  // 4) 路由
  const indexPage = (wikis) => {
    const rows = wikis.length
      ? wikis
          .map(
            (w) =>
              `<li><a href="${ROUTE}/site?path=${encodeURIComponent(w.dir)}"><strong>${escapeHtml(w.title)}</strong></a>` +
              `<code class="p">${escapeHtml(w.root)}</code></li>`
          )
          .join("\n")
      : `<li class="empty">${escapeHtml(t("listEmpty"))}</li>`;
    return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>dsh-wiki · 本地 Wiki 索引</title>
<style>
:root{color-scheme:light dark}
body{font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;padding:40px 20px;background:#f6f7f9;color:#1c1e21}
main{max-width:760px;margin:0 auto}
h1{font-size:22px;margin:0 0 4px}
.sub{color:#6b7280;font-size:13px;margin-bottom:24px}
ul{list-style:none;padding:0;margin:0}
li{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px;margin-bottom:10px}
a{color:#2563eb;text-decoration:none;font-size:16px}
a:hover{text-decoration:underline}
code.p{display:block;color:#6b7280;font-size:12px;margin-top:6px;word-break:break-all}
li.empty{color:#6b7280}
@media (prefers-color-scheme:dark){body{background:#111318;color:#e5e7eb}li{background:#1a1d24;border-color:#2a2f3a}.sub,code.p,li.empty{color:#9ca3af}}
</style></head><body><main>
<h1>📖 dsh-wiki</h1>
<div class="sub">纯本地 Repo Wiki · 生成命令 <code>/wiki generate</code> · 产物在仓库 <code>${escapeHtml(wikiDirName)}/</code> · 会话工作区的同级目录自动发现</div>
<ul>${rows}</ul>
</main>${backBarScript()}</body></html>`;
  };
  const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  // 独立窗口打开时提供"返回"入口：window.close 对 window.open 出的窗口生效；兜底回宿主根路径。
  // 若已被嵌入 iframe（侧栏面板内嵌阅读），直接跳过——那时"返回"应由面板自身承担，
  // 兜底 location.assign("/") 会把 iframe 导航成应用套应用。
  const backBarScript = () =>
    `<script>(function(){if(window.self!==window.top)return;` +
    `var b=document.createElement("button");b.textContent="← 返回 DSH";` +
    `b.onclick=function(){window.close();setTimeout(function(){location.assign("/")},200)};` +
    `b.style.cssText="position:fixed;top:14px;right:16px;z-index:2147483647;padding:6px 14px;border-radius:8px;` +
    `border:1px solid rgba(127,127,127,.4);background:rgba(17,19,24,.85);color:#e5e7eb;` +
    `font:13px -apple-system,BlinkMacSystemFont,sans-serif;cursor:pointer";` +
    `document.body.appendChild(b)})()</script>`;

  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: ROUTE,
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: "untrusted host" });
      const url = new URL(req.url ?? "/", "http://localhost");
      const pathname = url.pathname.replace(/\/+$/, "") || ROUTE;
      if (req.method !== "GET" && req.method !== "HEAD") return writeJson(res, 405, { error: "method not allowed" });

      if (pathname === ROUTE || pathname === `${ROUTE}/index.html`) {
        return writeText(res, 200, indexPage(knownWikis()));
      }
      if (pathname === `${ROUTE}/api/status`) {
        return writeJson(res, 200, {
          ok: true,
          wikiDirName,
          builder: builderPath,
          wikis: knownWikis().map((w) => ({ root: w.root, title: w.title, url: `${ROUTE}/site?path=${encodeURIComponent(w.dir)}` })),
        });
      }
      if (pathname === `${ROUTE}/site`) {
        const target = url.searchParams.get("path");
        if (!target || !path.isAbsolute(target)) return writeJson(res, 400, { error: "path query must be an absolute site dir" });
        const dir = normalize(path.resolve(target));
        if (path.basename(dir) !== wikiDirName) return writeJson(res, 403, { error: `not a ${wikiDirName} directory` });
        const siteFile = path.join(dir, "site", "index.html");
        try {
          const st = await stat(siteFile);
          if (!st.isFile()) throw new Error("not a file");
        } catch {
          return writeJson(res, 404, { error: "site/index.html not found — run /wiki generate first" });
        }
        const html = await readFile(siteFile, "utf8");
        // 注入点取最后一个 </body>：内联脚本字符串里可能有假的 "</body>" 字面量
        // （旧构建产物未打断边界标签时），首个匹配会把 <script> 注进脚本中间，
        // 注入的 </script> 提前闭合脚本并把 bundle 余下部分泄漏为正文。
        const closer = html.toLowerCase().lastIndexOf("</body>");
        const stamped = closer === -1
          ? html + backBarScript()
          : html.slice(0, closer) + backBarScript() + html.slice(closer);
        return writeText(res, 200, stamped);
      }
      return writeJson(res, 404, { error: "not found" });
    },
  }), "dsh-wiki: routes");

  // 5) /wiki 命令
  const sessionCwd = (invocation) => {
    const cwd = invocation?.agent?.session?.header?.cwd;
    return typeof cwd === "string" && path.isAbsolute(cwd) ? cwd : null;
  };
  // view 只认参数/当前工作区，不做"退而求其次"——想看别的仓库用 /wiki list
  const resolveWiki = (invocation, argPath) => {
    const roots = [];
    if (argPath) roots.push(argPath);
    const cwd = sessionCwd(invocation);
    if (cwd) roots.push(cwd);
    for (const r of roots) {
      if (!r || !path.isAbsolute(r)) continue;
      const w = wikiFor(normalize(path.resolve(r)), wikiDirName);
      if (w) return w;
    }
    return null;
  };
  const siteUrl = (w) => {
    const base = baseUrl();
    return base ? `${base}${ROUTE}/site?path=${encodeURIComponent(w.dir)}` : `${ROUTE}/site?path=${encodeURIComponent(w.dir)}`;
  };

  ctx.effect(() => ctx.commands.register({
    name: "wiki",
    description: t("commandDescription"),
    input: { hint: t("commandHint") },
    recordInput: false,
    handler: (invocation) => {
      const raw = (invocation?.rawInput ?? "").trim();
      const [verb, ...rest] = raw.split(/\s+/);
      const argPath = rest.join(" ").trim();
      const argAbs = argPath ? path.resolve(sessionCwd(invocation) ?? process.cwd(), argPath) : null;

      if (!verb || verb === "view" || verb === "open") {
        const w = resolveWiki(invocation, argAbs);
        if (!w) return { kind: "error", text: t("noWiki") };
        if (!existsSync(w.site)) return { kind: "error", text: t("siteMissing") };
        return { kind: "success", text: `${t("siteReady")}${siteUrl(w)}\n（磁盘：${w.site}）` };
      }
      if (verb === "list") {
        const wikis = knownWikis();
        if (!wikis.length) return { kind: "success", text: t("listEmpty") };
        return { kind: "success", text: `${t("listHeader")}\n${wikis.map((w) => `- ${w.title} — ${siteUrl(w)}`).join("\n")}` };
      }
      if (verb === "generate") {
        const target = argAbs ?? sessionCwd(invocation);
        if (!target || !existsSync(target)) return { kind: "error", text: `generate 需要一个存在的仓库路径，收到：${argPath || "(无)"}` };
        return startGeneration(invocation, target);
      }
      return { kind: "error", text: `未知子命令 “${verb}”。用法：${t("commandHint")}` };
    },
  }), "dsh-wiki: command");

  // fork 子代理执行生成；兼容 startActivation（新）与 start（旧）两条路
  function startGeneration(invocation, target) {
    const subagents = ctx.get?.("subagents");
    if (!subagents) return { kind: "error", text: t("startFailed") + "subagents 服务不可用（headless profile 不支持 /wiki generate）" };
    const provider = subagents.getProvider?.("fork");
    if (!provider?.inheritsParentContext) return { kind: "error", text: t("startFailed") + "fork provider 缺少 inheritsParentContext" };
    const label = `dsh-wiki:${globalThis.crypto.randomUUID()}`;
    const prompt = [
      {
        type: "text",
        text:
          `请使用 dsh-wiki 技能，为仓库 ${target} 生成完整 wiki。\n` +
          "严格按技能协议执行：resolve-config → 5 阶段（盘点/配置/语言/规划/写作/落盘）→ build + selfcheck 全绿。\n" +
          "完成后汇报：site/index.html 绝对路径、页数、目录树摘要、待确认清单，以及本机站点 URL（/dsh-wiki/site?path=…）。",
      },
    ];
    const run = (async () => {
      if (typeof subagents.startActivation === "function") {
        const activation = await subagents.startActivation({
          provider: "fork",
          label,
          childId: globalThis.crypto.randomUUID(),
          request: { parent: invocation.agent, prompt },
          signal: invocation.signal,
          delivery: "caller",
        });
        try {
          await activation.result;
        } finally {
          await activation.dispose?.();
        }
        return;
      }
      const legacy = await subagents.start("fork", {
        parent: invocation.agent,
        label,
        signal: invocation.signal,
        prompt,
      });
      try {
        await legacy.result;
      } finally {
        await legacy.dispose?.();
      }
    })();
    run.catch((err) => ctx.logger?.warn?.(`dsh-wiki: 生成任务失败 ${err?.message ?? err}`));
    return { kind: "success", text: t("started") };
  }
}
