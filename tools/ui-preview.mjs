// dsh-wiki 面板 UI 预览：把 lib/client.js 的真实 Detail 概览渲染成一个自包含的 HTML 文件，
// 供人截图看排版（十种状态：七种常规宽度 + 两个停靠窄面板，后者正是闸门提示条最容易塌的地方）。
// 其中 h/i/j 三格是 spec 013 的增量作业：进行中显示受影响页/卡，完成行显示重写页数与未映射文件，
// j 另外显示“删除 1 页”（被删的页必须看得见，不能静静地消失）。
// 用法：
//   node tools/ui-preview.mjs [输出路径]
// 默认写到 %TEMP%\dsh-wiki-ui-preview.html。不联网、不开服务、不启动浏览器：写一个文件就退出 0。
//
// React 取自与 tools/client-smoke.mjs 相同的 node_modules（apps/mobile-companion），
// 组件用同一套手写 hook 层渲染（renderToStaticMarkup 不跑 effect，状态槽位由本脚本预置）。
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import vm from "node:vm";

const DEFAULT_REACT = "C:\\Users\\neste\\Documents\\DSH_Project\\dsh-ext\\apps\\mobile-companion\\node_modules\\react";
const DEFAULT_REACT_DOM = "C:\\Users\\neste\\Documents\\DSH_Project\\dsh-ext\\apps\\mobile-companion\\node_modules\\react-dom";
const reactDir = process.env.DSH_WIKI_REACT || DEFAULT_REACT;
const domDir = process.env.DSH_WIKI_REACT_DOM || DEFAULT_REACT_DOM;

const req = createRequire(path.join(reactDir, "package.json"));
const React = req(reactDir);
const { renderToStaticMarkup } = createRequire(path.join(domDir, "package.json"))(path.join(domDir, "server"));

const SRC = readFileSync(path.join(import.meta.dirname, "..", "lib", "client.js"), "utf8");

// ---------- 与 client-smoke.mjs 相同的手写 hook 层 ----------
// useState 每次给一个可预置的槽位；effect 只入队不执行（静态渲染没有副作用）。
function makeHooks() {
  const hk = { at: 0, states: [], effects: [] };
  const react = {
    createElement: React.createElement,
    Fragment: React.Fragment,
    createContext: React.createContext,
    useState: (init) => {
      const i = hk.at++;
      if (!(i in hk.states)) hk.states[i] = typeof init === "function" ? init() : init;
      return [hk.states[i], (v) => { hk.states[i] = typeof v === "function" ? v(hk.states[i]) : v; }];
    },
    useRef: (init) => ({ current: init }),
    useEffect: (fn) => { hk.effects.push(fn); },
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useContext: () => null,
  };
  return { hk, react };
}

function loadClient(react) {
  let mod = null;
  const sandbox = {
    window: {
      __ModuleLoader__: { load: (spec) => { mod = spec.factory((name) => {
        if (name === "react") return react;
        throw new Error("unexpected require " + name);
      }); } },
      dispatchEvent: () => true,
    },
    CustomEvent: function (type, init) { this.type = type; this.detail = (init && init.detail) || {}; },
    location: { origin: "http://127.0.0.1" },
    console, setTimeout, clearTimeout, Promise, Object, Array, String, Number, Math, Date, RegExp, JSON,
  };
  vm.runInNewContext(SRC, sandbox);
  mod.apply({ effect: (fn) => fn(), locale: { register: () => () => {} },
    slots: { inject: (_k, fn) => fn(), register: () => () => {} } });
  return mod;
}

// ---------- fixture ----------
const ROOT = "C:\\Users\\neste\\Documents\\DSH_Project\\dsh-ext\\plugins\\dsh-wiki";
const UPDATED_AT = "2026-11-10T11:22:11.000Z";
const SOURCE_COMMIT = "dd02d64f5b0c9a71c2e4d8f3a6b1c9e2d4f60a17";
const HEAD = "a4ce6ba8e1f7c3d29b6a5e4d8c1f0b7a2e9d3c46";
const GATE_REASON = "Background wiki jobs are disabled pending filesystem isolation and recovery review";

const PAGES = [
  { id: "overview", parentId: null, order: 1, title: "Overview", description: "What the plugin does and how it is wired",
    filePaths: ["lib/index.js:1-40"], markdown: "# Overview" },
  { id: "panel", parentId: null, order: 2, title: "Panel and views", description: "Sidebar entry, project grid, detail views",
    filePaths: ["lib/client.js:1300-1400"], markdown: "# Panel" },
  { id: "client", parentId: "panel", order: 3, title: "Client half", description: "Markdown renderer and React tree",
    filePaths: ["lib/client.js:290-420"], markdown: "# Client" },
  { id: "jobs", parentId: "panel", order: 4, title: "Background jobs", description: "Single-flight staging, validate, build, publish",
    filePaths: ["lib/jobs.js:1-120"], markdown: "# Jobs" },
  { id: "journal", parentId: "panel", order: 5, title: "Journal", description: "Append-only record of published candidates",
    filePaths: ["lib/journal.js:1-80"], markdown: "# Journal" },
  { id: "security", parentId: null, order: 6, title: "Security model", description: "Local only, no network, rollback on failure",
    filePaths: ["SECURITY.md:1-40"], markdown: "# Security" },
];
const CARDS = [
  { id: "gate", title: "Job gate", kind: "concept", summary: "Host-side switch that keeps background generation off until isolation lands.",
    keyFiles: ["lib/index.js:512-540"], related: [], tags: ["safety"], pageIds: ["jobs"] },
  { id: "staging", title: "Staging fence", kind: "mechanism", summary: "One in-flight run per project root, quarantined if a worker cannot be confirmed stopped.",
    keyFiles: ["lib/jobs.js:64-98"], related: ["gate"], tags: ["concurrency"], pageIds: ["jobs"] },
  { id: "render", title: "Safe markdown", kind: "mechanism", summary: "Markdown becomes React elements; inline SVG is shown as source, never injected.",
    keyFiles: ["lib/client.js:293-420"], related: [], tags: ["xss"], pageIds: ["client"] },
];
const WIKI = { root: ROOT, title: "dsh-wiki", language: "en", pages: PAGES, cards: CARDS };

const CATALOG = {
  phase: "ready", failures: [], def: { provider: "r9-fallback", model: "ds41-cmc-ccsonnet" },
  models: [
    { provider: "r9-fallback", model: "ds41-cmc-ccsonnet", label: "ds41-cmc-ccsonnet", providerLabel: "r9-fallback" },
    { provider: "r9-commandcode", model: "cc/claude-opus-5-5", label: "claude-opus-5-5", providerLabel: "r9-commandcode" },
  ],
};
const MODEL = { provider: "r9-fallback", model: "ds41-cmc-ccsonnet" };
const LANGS = { phase: "ready", tags: ["vi"], error: null };

const infoGenerated = {
  root: ROOT, title: "dsh-wiki", generated: true, hasSite: true, dir: ".dsh-wiki/site",
  pageCount: 31, cardCount: 25, language: "en", sourceCommit: SOURCE_COMMIT,
  updatedAt: UPDATED_AT, updateAvailable: true, head: HEAD, workspaceId: "w-dsh-ext",
};
const infoMissing = {
  root: ROOT, title: "dsh-ext", generated: false, hasSite: false, dir: null,
  pageCount: 0, cardCount: 0, language: "en", sourceCommit: null,
  updatedAt: null, updateAvailable: false, head: null, workspaceId: null,
};
// 已是最新（没有新提交）：第三次“重新生成”的常见情形，同时让 ok 药丸与“没有过期提示”都可见
const infoCurrent = { ...infoGenerated, updateAvailable: false, head: null };
const CLOSED_GATE = { known: true, disabled: true, reason: GATE_REASON };
const OPEN_GATE = { known: true, disabled: false, reason: "" };
// 作业在跑：stage=agent 是进度条上的真实阶段；startedAt 定成 83 秒前，让 elapsed 有意义
const RUNNING_JOB = {
  id: "job-7f3a", root: ROOT, action: "update", targetLang: "en", phase: "running", stage: "agent",
  model: { provider: "r9-fallback", model: "ds41-cmc-ccsonnet" },
  startedAt: new Date(Date.now() - 83000).toISOString(),
  sessionId: "sess-9c1a4f7b2e6d", pages: 12,
};
// 增量作业（spec 013）的公开事实形状取自 lib/jobs.js publicIncremental：只有增量作业带这个键，
// 全量作业的进度行/完成行因此与上面那个 RUNNING_JOB 完全一致。
// 数字用实测语料（DXVK_Project dd02d64..67a1131）：23 页 / 9 卡受影响、102 个变更文件没有页面覆盖。
// unmappedSample 故意包含 .dsh-wiki/：wiki 更新本身就会出现在未映射文件里。
const INCREMENTAL_FACTS = {
  mode: "incremental", baseline: SOURCE_COMMIT, head: HEAD,
  affectedPages: 23, affectedCards: 9, pagesRewritten: null, unmappedFiles: 102,
  unmappedSample: [".dsh-wiki/wiki.json", ".dsh-wiki/generation-meta.json"],
  sourceCommit: null, sourceCommitAdvanced: null,
};
const INCREMENTAL_RUNNING_JOB = { ...RUNNING_JOB, incremental: INCREMENTAL_FACTS };
const INCREMENTAL_DONE_JOB = {
  ...RUNNING_JOB, phase: "done", stage: "done", sessionId: null, pages: 31, published: true,
  incremental: { ...INCREMENTAL_FACTS, pagesRewritten: 21, sourceCommit: HEAD, sourceCommitAdvanced: true },
};
// 增量作业**删掉**一个页（D2）：完成行必须把这件事说出来，否则那一页只是从面板里静静消失。
// 计数用实测语料（受影响 23 页 / 9 卡、重写 2 页、删除 1 页、102 个变更文件没有页面覆盖）；
// removedSample 的 id 只进诊断，面板不显示。
const INCREMENTAL_REMOVED_JOB = {
  ...RUNNING_JOB, phase: "done", stage: "done", sessionId: null, pages: 30, published: true,
  incremental: {
    ...INCREMENTAL_FACTS, pagesRewritten: 2, pagesRemoved: 1, removedSample: ["journal"],
    sourceCommit: HEAD, sourceCommitAdvanced: true,
  },
};

const PANELS = [
  {
    caption: "a · light · gate closed · update available",
    dark: false,
    project: { root: ROOT, title: "dsh-wiki", generated: true, workspaceId: "w-dsh-ext" },
    data: { phase: "ready", info: infoGenerated, wiki: WIKI, missing: false, error: null },
    jobView: { active: null, last: null, gate: CLOSED_GATE },
  },
  {
    caption: "b · dark · gate closed · update available",
    dark: true,
    project: { root: ROOT, title: "dsh-wiki", generated: true, workspaceId: "w-dsh-ext" },
    data: { phase: "ready", info: infoGenerated, wiki: WIKI, missing: false, error: null },
    jobView: { active: null, last: null, gate: CLOSED_GATE },
  },
  {
    caption: "c · light · gate open · update job running · More actions open",
    dark: false,
    project: { root: ROOT, title: "dsh-wiki", generated: true, workspaceId: "w-dsh-ext" },
    data: { phase: "ready", info: infoCurrent, wiki: WIKI, missing: false, error: null },
    jobView: { active: RUNNING_JOB, last: null, gate: OPEN_GATE },
    // 菜单展开：证明它挂在自己的按钮下面（right:0），并且「在会话中…」真的在菜单里
    menu: true,
  },
  {
    caption: "d · light · gate open · project not generated yet",
    dark: false,
    project: { root: ROOT, title: "dsh-ext", generated: false, workspaceId: null },
    data: { phase: "ready", info: infoMissing, wiki: null, missing: false, error: null },
    jobView: { active: null, last: null, gate: OPEN_GATE },
  },
  // 停靠成窄面板是真实用法，也是闸门提示条最容易塌的地方：强制 460px，一眼就能看出原因
  // 是否还能按正常行宽换行（而不是一行一个词）。
  {
    caption: "e · light · 460px panel · gate closed · update available (narrow case)",
    width: 460,
    dark: false,
    project: { root: ROOT, title: "dsh-wiki", generated: true, workspaceId: "w-dsh-ext" },
    data: { phase: "ready", info: infoGenerated, wiki: WIKI, missing: false, error: null },
    jobView: { active: null, last: null, gate: CLOSED_GATE },
  },
  {
    caption: "f · dark · 464px panel · gate closed · update available (narrow case)",
    width: 464,
    dark: true,
    project: { root: ROOT, title: "dsh-wiki", generated: true, workspaceId: "w-dsh-ext" },
    data: { phase: "ready", info: infoGenerated, wiki: WIKI, missing: false, error: null },
    jobView: { active: null, last: null, gate: CLOSED_GATE },
  },
  // 闸门关闭 + 从未生成：桩件里唯一会显示「Generate wiki」的停用主按钮（主按钮文案按项目状态取，
  // 闸门关闭时同样可见，只是禁用）—— 这正是「生成入口去哪了」会指向的那一格。
  // 闸门关闭的每一格（a, b, e, f, g）都应该长成同一个形状：一条 .dw-notice，里面有被挡住的主按钮
  // 和「Copy command」兜底，并且没有任何 .dw-job 卡片（只有闸门开启的 c/d 才有卡片）。
  {
    caption: "g · light · gate closed · project not generated yet",
    dark: false,
    project: { root: ROOT, title: "dsh-ext", generated: false, workspaceId: null },
    data: { phase: "ready", info: infoMissing, wiki: null, missing: false, error: null },
    jobView: { active: null, last: null, gate: CLOSED_GATE },
  },
  // spec 013 §3：增量作业进行中 —— 进度区显示受影响范围（N 页 / M 卡）；卡片标题里的主按钮此时是
  // “Update wiki (incremental)”（自重写范围来自宿主作业状态，面板不猜）。
  {
    caption: "h · light · gate open · incremental update running (affected pages/cards)",
    dark: false,
    project: { root: ROOT, title: "dsh-wiki", generated: true, workspaceId: "w-dsh-ext" },
    data: { phase: "ready", info: infoCurrent, wiki: WIKI, missing: false, error: null },
    jobView: { active: INCREMENTAL_RUNNING_JOB, last: null, gate: OPEN_GATE },
  },
  // spec 013 §3：增量作业完成 —— 完成行报告“21 页已重写”和“102 个变更文件未被任何页面覆盖”。
  // 后者不是“没人写文档的代码”：.dsh-wiki/ 自己被提交，所以一次 wiki 更新也会落进这一项。
  {
    caption: "i · dark · gate open · incremental update finished (rewritten pages + uncovered changed files)",
    dark: true,
    project: { root: ROOT, title: "dsh-wiki", generated: true, workspaceId: "w-dsh-ext" },
    data: { phase: "ready", info: infoGenerated, wiki: WIKI, missing: false, error: null },
    jobView: { active: null, last: INCREMENTAL_DONE_JOB, gate: OPEN_GATE },
  },
  // spec 013 §3 / D2：增量作业删掉了一个页 —— 完成行除了“重写 2 页”还必须说“删除 1 页”，
  // 只报重写会让页面的消失无声（removedSample 的 id 只在诊断里，不进口袋面板）。
  {
    caption: "j · light · gate open · incremental update finished, removed a page",
    dark: false,
    project: { root: ROOT, title: "dsh-wiki", generated: true, workspaceId: "w-dsh-ext" },
    data: { phase: "ready", info: infoGenerated, wiki: WIKI, missing: false, error: null },
    jobView: { active: null, last: INCREMENTAL_REMOVED_JOB, gate: OPEN_GATE },
  },
];

// ---------- 渲染 ----------
function renderPanel(mod, hk, panel) {
  hk.at = 0;
  hk.effects.length = 0;
  // Detail 的 hook 顺序（与 client-smoke.mjs 一致）：
  // data, lang, sel, showSrc, q, open, menu, toast, useJobView, useLanguages
  hk.states = [panel.data, "en", null, false, "", Object.create(null), !!panel.menu, null,
    panel.jobView, LANGS];
  return renderToStaticMarkup(React.createElement(mod._test.Detail, {
    t: (k) => (Object.prototype.hasOwnProperty.call(mod._test.DICT.en, k) ? mod._test.DICT.en[k] : k),
    project: panel.project, back() {},
    catalog: CATALOG, model: MODEL, onModel() {},
  }))
    // ModelSelect 用 "\u0000" 拼 provider/model 的 option value（不影响显示）；NUL 不能出现在
    // HTML 里，所以在写文件前换成空格 —— 只影响这个不可见的属性，面板代码不动。
    .split("\u0000").join(" ");
}

// ---------- 页面外壳（含 token） ----------
// 宿主真实的 --dsw-alias-* 定义在 DSH 主题里；这里给出等价取值，便于离线看图。深色一栏是
// 本文件自选的深色取值（宿主深色主题的近似），只为验证组件在深色下不塌。
// 注意 --dsw-alias-link / --dsw-alias-interactive-bg-hover / --dsw-alias-label-tertiary
// 不在宿主对外公布的 token 列表里，但现有面板 CSS 已经在用，所以这里也必须定义，否则预览不忠实。
const PREVIEW_CSS = `
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:#101216;color:#e9eaee;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;padding:28px}
h1.pv-title{font-size:15px;font-weight:600;margin:0 0 4px;letter-spacing:.01em}
p.pv-note{margin:0 0 20px;font-size:12px;color:#9b9da6}
.pv-page{display:grid;grid-template-columns:repeat(2,minmax(0,1020px));gap:28px;justify-content:start;align-items:start}
.pv{display:flex;flex-direction:column;gap:8px;min-width:0}
.pv-cap{margin:0;font-size:11.5px;letter-spacing:.04em;text-transform:uppercase;color:#9b9da6}
.pv-body{border-radius:12px;overflow:hidden;box-shadow:0 8px 24px rgba(0,0,0,.45)}
/* 预览专用：面板高度由内容决定（真实 DSH 面板是 height:100%，截图时不想把内容裁掉） */
.pv-body .dw-root{height:auto;min-height:0;border-radius:12px}
.pv-body .dw-main{overflow:visible}
.pv-body .dw-tree{overflow:visible}

/* light */
.pv{
  --dsw-alias-bg-base:#ffffff;
  --dsw-alias-bg-layer-1:#f6f7f9;
  --dsw-alias-bg-layer-2:#eceef2;
  --dsw-alias-border-l1:#e3e5ea;
  --dsw-alias-border-l2:#d6d9e0;
  --dsw-alias-label-primary:#1b1d22;
  --dsw-alias-label-secondary:#63676f;
  --dsw-alias-label-tertiary:#9aa0aa;
  --dsw-alias-brand-primary:#2f6feb;
  --dsw-alias-link:#2f6feb;
  --dsw-alias-interactive-bg-hover:rgba(20,24,32,.06);
  --dsw-alias-state-success-primary:#1a7f4b;
  --dsw-alias-state-warn-primary:#a2650a;
  --dsw-alias-state-idle-primary:#8a8f99;
}
/* dark：自选取值（bg 由深到浅三层，label 由亮到暗三级） */
.pv-dark{
  --dsw-alias-bg-base:#16181d;
  --dsw-alias-bg-layer-1:#1e2128;
  --dsw-alias-bg-layer-2:#262a33;
  --dsw-alias-border-l1:#2c303a;
  --dsw-alias-border-l2:#3a3f4b;
  --dsw-alias-label-primary:#eceef3;
  --dsw-alias-label-secondary:#a2a7b4;
  --dsw-alias-label-tertiary:#767c8a;
  --dsw-alias-brand-primary:#7aa2ff;
  --dsw-alias-link:#7aa2ff;
  --dsw-alias-interactive-bg-hover:rgba(255,255,255,.07);
  --dsw-alias-state-success-primary:#4ec98a;
  --dsw-alias-state-warn-primary:#e0a33a;
  --dsw-alias-state-idle-primary:#9a9fb0;
}
`;

// ---------- 组装 ----------
function main() {
  const { hk, react } = makeHooks();
  const mod = loadClient(react);
  const body = PANELS.map((panel) => {
    const html = renderPanel(mod, hk, panel);
    // 有 width 的面板就是一个定宽容器（停靠窄面板）；没有的沿用网格单元的自然宽度
    const widthStyle = panel.width ? ' style="width:' + panel.width + "px\"" : "";
    return [
      '<section class="pv' + (panel.dark ? " pv-dark" : "") + '">',
      '<p class="pv-cap">' + panel.caption + "</p>",
      '<div class="pv-body dw-root"' + widthStyle + ">" + html + "</div>",
      "</section>",
    ].join("");
  }).join("\n");

  const out = [
    "<!DOCTYPE html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    "<title>dsh-wiki panel preview</title>",
    // 面板 CSS 原样取自 lib/client.js，页面外壳只补 token 与预览专用的高度覆盖
    "<style>" + PREVIEW_CSS + "\n" + mod._test.CSS + "</style>",
    "</head><body>",
    '<h1 class="pv-title">dsh-wiki · overview panel</h1>',
    '<p class="pv-note">Rendered from lib/client.js with canned state · zero external requests · ' + PANELS.length + " states · a–d, g, h, i, j at panel width, e/f forced to 460px/464px</p>",
    '<main class="pv-page">',
    body,
    "</main>",
    "</body></html>",
    "",
  ].join("\n");

  const target = process.argv[2] || path.join(os.tmpdir(), "dsh-wiki-ui-preview.html");
  writeFileSync(target, out, "utf8");
  console.log("wrote " + target + " (" + Buffer.byteLength(out, "utf8") + " bytes, " + PANELS.length + " panels)");
}

main();
