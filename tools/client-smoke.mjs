// dsh-wiki 客户端半区离线冒烟：用真实 React 把 lib/client.js 的组件渲染成字符串，
// 检查项目网格 / 详情（概览、页面、卡片）可渲染、无注入。用法：
//   node tools/client-smoke.mjs <react 包目录> <react-dom 包目录>
// 没有 React 时打印 SKIP 并退出 0（CI 不强依赖）。
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import vm from "node:vm";

const [reactDir, domDir] = process.argv.slice(2);
if (!reactDir || !domDir) { console.log("SKIP client smoke (pass react and react-dom dirs)"); process.exit(0); }
const req = createRequire(path.join(reactDir, "package.json"));
const React = req(reactDir);
const { renderToStaticMarkup } = createRequire(path.join(domDir, "package.json"))(path.join(domDir, "server"));

const FAILS = [];
const check = (n, ok, d = "") => { console.log((ok ? "PASS " : "FAIL ") + n + (ok ? "" : `  [${d}]`)); if (!ok) FAILS.push(n); };

let mod = null;
// 面板选择退化路径用到的 window.dispatchEvent / CustomEvent：捕获派发，验证"只派发、不导航"
const dispatched = [];
const sandbox = {
  window: {
    __ModuleLoader__: { load: (spec) => { mod = spec.factory((name) => { if (name === "react") return React; throw new Error("unexpected require " + name); }); } },
    dispatchEvent: (e) => { dispatched.push(e); return true; },
  },
  CustomEvent: function (type, init) { this.type = type; this.detail = (init && init.detail) || {}; },
  console, setTimeout, clearTimeout, Promise, Object, Array, String, Number, Math, Date, RegExp, JSON,
};
vm.runInNewContext(readFileSync(path.join(import.meta.dirname, "..", "lib", "client.js"), "utf8"), sandbox);
check("client module loads and exports apply", typeof mod?.apply === "function");

// 捕获 slot 注册
const regs = [];
mod.apply({
  effect: (fn) => fn(),
  locale: { register: () => () => {}, bind: () => (k) => k },
  slots: { inject: (_k, fn) => fn(), register: (opts, comp) => { regs.push({ opts, comp }); return () => {}; } },
});
const names = regs.map((r) => r.opts.name + ":" + (r.opts.key ?? r.opts.id));
check("registers main + sidebar.panellist + header action", names.includes("main:dsh-wiki") && names.includes("sidebar.panellist:dsh-wiki")
  && names.includes("conversation.session.header.actions:dsh-wiki-open"), names.join(","));

const main = regs.find((r) => r.opts.name === "main").comp;
// zh only when the DSH locale snapshot says zh
const regsZh = [];
mod.apply({
  effect: (fn) => fn(),
  locale: { register: () => () => {}, getSnapshot: () => ({ active: "zh-CN" }) },
  slots: { inject: (_k, fn) => fn(), register: (opts, comp) => { regsZh.push({ opts, comp }); return () => {}; } },
});
const htmlZh = renderToStaticMarkup(React.createElement(regsZh.find((r) => r.opts.name === "main").comp, {}));
check("home view switches to Chinese when DSH locale is zh", htmlZh.includes("把代码变成 Repo Wiki"));
const regsJa = [];
mod.apply({
  effect: (fn) => fn(),
  locale: { register: () => () => {}, getSnapshot: () => ({ active: "ja" }) },
  slots: { inject: (_k, fn) => fn(), register: (opts, comp) => { regsJa.push({ opts, comp }); return () => {}; } },
});
const htmlJa = renderToStaticMarkup(React.createElement(regsJa.find((r) => r.opts.name === "main").comp, {}));
check("non-zh locale (ja) falls back to English", htmlJa.includes("Turn code into Repo Wiki"));
// reset to the no-locale context for the following checks
mod.apply({ effect: (fn) => fn(), locale: { register: () => () => {} }, slots: { inject: (_k, fn) => fn(), register: () => () => {} } });
const html = renderToStaticMarkup(React.createElement(main, {}));
check("home view renders English by default (no locale snapshot)", html.includes("Turn code into Repo Wiki") && html.includes("Not generated") && html.includes('placeholder="Search projects…"') && !/[\u4e00-\u9fff]/.test(html.replace(/<style>[\s\S]*?<\/style>/, "")));
check("home view embeds component-scoped <style> with theme tokens", html.includes("<style>") && html.includes("--dsw-alias-bg-base"));
check("no dangerouslySetInnerHTML use in client", !readFileSync(path.join(import.meta.dirname, "..", "lib", "client.js"), "utf8").includes("dangerouslySetInnerHTML="));

// markdown 渲染：安全子集 + 引用/卡片链接
const env = { t: (k) => k, hasCard: (id) => id === "c1", hasPage: (id) => id === "p2", openCard() {}, openPage() {}, cite() {} };
const md = [
  "# Title", "", "Text with `src/a.py:12` and `plain code` and **bold** and [card](#card-c1) and [gone](#card-x) and [ext](http://evil.example/x).",
  "", "<script>alert(1)</script>", "", "<svg onload=\"alert(1)\"><circle r=\"1\"/></svg>", "",
  "```mermaid", "flowchart LR", "a-->b", "```", "", "| A | B |", "|---|---|", "| 1 | <img src=x onerror=alert(1)> |", "",
  "- item `x.js:3`", "  - nested", "", "1. one", "", "> quote <b>x</b>",
].join("\n");
const out = renderToStaticMarkup(React.createElement("div", null, mod._test.renderMarkdown(md, env)));
check("md: script/img/svg text is escaped, never live markup",
  !/<script>alert/.test(out) && !/<img /.test(out) && !/<svg/.test(out) && !/<b>x<\/b>/.test(out)
  && out.includes("&lt;script&gt;alert(1)&lt;/script&gt;") && out.includes("&lt;svg onload"), out.slice(0, 400));
check("md: path:line citation becomes clickable code", /<code class="dw-cite"[^>]*>src\/a\.py:12<\/code>/.test(out) && out.includes("<code>plain code</code>"));
check("md: card link clickable, unknown and external links inert", /<a class="dw-link">card<\/a>/.test(out)
  && !out.includes('href="http://evil') && out.includes('title="http://evil.example/x"') && !/<a[^>]*>gone<\/a>/.test(out));
check("md: mermaid goes to sandboxed iframe", /<iframe[^>]*sandbox="allow-scripts"[^>]*src="\/dsh-wiki\/mermaid-frame"/.test(out)
  && !/allow-same-origin/.test(out));
check("md: tables, nested lists, blockquote render", out.includes("<table>") && /<ul><li>item .*<ul><li>nested<\/li><\/ul><\/li><\/ul>/.test(out)
  && out.includes("<ol>") && out.includes("<blockquote>"));

// regressions: list blocks keep their remainder and split on marker type; pathological
// blockquote nesting is bounded instead of overflowing the render stack.
{
  const render = (md) => renderToStaticMarkup(React.createElement("div", null, mod._test.renderMarkdown(md, env)));
  const indented = render("  - first\n- second");
  check("md: an indented first item no longer drops a shallower sibling",
    /<ul><li>first<\/li><li>second<\/li><\/ul>/.test(indented), indented);
  const mixed = render("- one\n1. two");
  check("md: switching from bullets to numbers starts a new list",
    /<ul><li>one<\/li><\/ul><ol><li>two<\/li><\/ol>/.test(mixed), mixed);
  const nested = render("- a\n  - nested\n- b");
  check("md: nested list keeps its parent and the following sibling",
    /<ul><li>a<ul><li>nested<\/li><\/ul><\/li><li>b<\/li><\/ul>/.test(nested), nested);
  const five = render("> ".repeat(5) + "five");
  check("md: blockquote nesting below the limit still nests",
    (five.match(/<blockquote\b/g) || []).length === 5 && five.includes("five"), five);
  let deep = "", deepErr = null;
  try { deep = render("> ".repeat(5000) + "deep-text"); } catch (e) { deepErr = e; }
  const depth = (deep.match(/<blockquote\b/g) || []).length;
  check("md: excessive blockquote nesting is bounded and falls back without throwing",
    !deepErr && deep.includes("deep-text") && depth > 0 && depth <= mod._test.MAX_BLOCKQUOTE_DEPTH,
    deepErr ? String((deepErr && deepErr.message) || deepErr) : `depth=${depth} len=${deep.length}`);
}

// mermaid presentation: gray panel, zoom button, sandboxed frame, scale floor constant, wide column
{
  const src = readFileSync(path.join(import.meta.dirname, "..", "lib", "client.js"), "utf8");
  check("mermaid: gray rounded panel + zoom button rendered",
    /class="dw-mwrap"[^>]*background:#f3f4f6/.test(out) && out.includes('class="dw-mzoom"'));
  check("mermaid: inline scale floor 0.75, 1200px column",
    src.includes("MIN_INLINE_SCALE = 0.75") && src.includes("max-width:1200px") && !src.includes("max-width:900px"));
  check("mermaid: frame never gets allow-same-origin", !/sandbox:\s*"[^"]*allow-same-origin/.test(src) && (src.match(/sandbox: "allow-scripts"/g) || []).length >= 1);

  // ---- defect 1: the zoom overlay is a floating toolbar INSIDE the wiki panel (never over the
  //      desktop titlebar), with toolbar buttons >= 44px, and only the diagram pane scrolls.
  const css = mod._test.CSS;
  const rule = (sel) => {
    const i = css.indexOf(sel + "{");
    return i < 0 ? "" : css.slice(i + sel.length + 1, css.indexOf("}", i));
  };
  check("zoom: overlay is absolute inset:0 inside a position:relative panel (not position:fixed)",
    /position:absolute;inset:0/.test(rule(".dw-zoom")) && !/position:fixed/.test(rule(".dw-zoom"))
    && /position:relative/.test(rule(".dw-root")));
  const bar = rule(".dw-zoombar");
  check("zoom: toolbar is a floating, centered, wrapping bar with a 16px+ safe top margin",
    /flex:none/.test(bar) && /align-self:center/.test(bar) && /flex-wrap:wrap/.test(bar)
    && /gap:8px/.test(bar) && /margin:16px/.test(bar) && /-webkit-app-region:no-drag/.test(bar));
  const btnRule = css.slice(css.indexOf(".dw-zoombar button{"), css.indexOf("}", css.indexOf(".dw-zoombar button{")));
  check("zoom: toolbar buttons are large and never shrink below 44px",
    /min-height:44px/.test(btnRule) && /min-width:44px/.test(btnRule) && /font-size:15px/.test(btnRule)
    && /flex:0 0 auto/.test(btnRule) && /white-space:nowrap/.test(btnRule), btnRule.slice(0, 160));
  check("zoom: icons 20px, zoom % is 16px, pane is the only scroller",
    /font-size:20px/.test(rule(".dw-zoomicon")) && /font-size:16px/.test(rule(".dw-zoompct"))
    && /overflow:auto/.test(rule(".dw-zoompane")) && !/overflow:auto/.test(bar));
  check("zoom: Close button is high contrast (inverse of the theme label/bg pair)",
    /\.dw-zoombar button\.dw-zoomclose\{background:var\(--dsw-alias-label-primary\);color:var\(--dsw-alias-bg-base\)/.test(css));

  // static render of the overlay: title/label, −, %, +, Fit, Reset, Copy code, Close ✕
  const zoomT = (k) => ({
    "zoom.title": "Diagram", "zoom.fit": "Fit", "zoom.reset": "Reset", "zoom.resetTitle": "Reset zoom to 100%",
    "zoom.copy": "Copy code", "zoom.copied": "✓ Copied", "zoom.copyFail": "⚠ Copy failed",
    "zoom.close": "Close", "zoom.zoomOut": "Zoom out", "zoom.zoomIn": "Zoom in",
  }[k] || k);
  const zoomHtml = renderToStaticMarkup(React.createElement(mod._test.MermaidZoom, {
    t: zoomT, src: "flowchart LR\n  a-->b", dark: false, size: { width: 800, height: 600 },
    label: "Overview", index: 2, onClose: () => {}, trigger: null,
  }));
  check("zoom: toolbar carries the diagram label, −, %, +, Fit, Reset, Copy code and Close ✕",
    zoomHtml.includes('class="dw-zoombar"') && zoomHtml.includes("Overview · Diagram 2")
    && zoomHtml.includes(">−<") && zoomHtml.includes(">+<") && zoomHtml.includes(">100%<")
    && zoomHtml.includes(">Fit<") && zoomHtml.includes(">Reset<") && zoomHtml.includes(">Copy code<")
    && /class="dw-zoomclose"[^>]*>Close\s*<span[^>]*>✕</.test(zoomHtml), zoomHtml.slice(-320));
  check("zoom: dialog semantics + Close button keeps an explicit accessible name",
    /role="dialog"/.test(zoomHtml) && /aria-modal="true"/.test(zoomHtml)
    && /class="dw-zoomclose"[^>]*title="Close \(Esc\)"/.test(zoomHtml));
  check("zoom: toolbar precedes the scrolling pane (scroll can never hide the toolbar)",
    zoomHtml.indexOf('class="dw-zoombar"') < zoomHtml.indexOf('class="dw-zoompane"'));
  check("zoom: Esc closes and focus returns to the trigger button",
    src.includes('e.key === "Escape"') && src.includes("props.trigger.focus()")
    && src.includes("trigger: (e && e.currentTarget)"));
  // 浮层必须由面板根渲染：挂在正文组件里会落进 .dw-main 的滚动容器，absolute 就不再以面板为基准
  const wikiAppSrc = src.slice(src.indexOf("function WikiApp"));
  const mermaidSrc = src.slice(src.indexOf("function Mermaid(props)"), src.indexOf("function MermaidZoom"));
  check("zoom: overlay is rendered by the panel root (WikiApp), not inside the scrolling page body",
    /function WikiApp[\s\S]*?h\(ZoomCtx\.Provider/.test(wikiAppSrc) && /zoom \? h\(MermaidZoom/.test(wikiAppSrc)
    && !mermaidSrc.includes("MermaidZoom"));
}

// ---- defect 2: conversation session header "Wiki" button selects the native panel, never navigates
{
  const calls = [];
  const mk = (svcs) => ({
    get: (n) => svcs[n],
    effect: (fn) => fn(),
    locale: { register: () => () => {} },
    slots: { inject: (_k, fn) => fn(), register: () => () => {} },
  });
  mod.apply(mk({ layout: { selectPanel: (p) => calls.push(["panel", p]) } }));
  const okPanel = mod._test.selectWikiPanel();
  check("header: Wiki button selects the native dsh-wiki panel via layout.selectPanel",
    okPanel === true && calls.some((c) => c[0] === "panel" && c[1] === "dsh-wiki"), JSON.stringify(calls));
  dispatched.length = 0;
  mod.apply(mk({}));
  const fallbackErrors = [];
  const okFallback = mod._test.selectWikiPanel((msg) => fallbackErrors.push(msg));
  check("header: without a layout service it reports a clear toast (no invented window event, no navigation)",
    okFallback === false && dispatched.length === 0 && fallbackErrors.length === 1 && /sidebar/i.test(fallbackErrors[0]),
    JSON.stringify({ dispatched: dispatched.map((e) => e.type), errors: fallbackErrors }));
  check("header: layout-missing toast text exists in both dictionaries",
    /sidebar/i.test(mod._test.DICT.en["nav.unavailable"]) && mod._test.DICT.zh["nav.unavailable"].includes("左侧栏"));
  // 失败路径：layout.selectPanel 抛错时也只是返回 false + 提示，绝不导航、绝不派发自造事件
  dispatched.length = 0;
  mod.apply(mk({ layout: { selectPanel: () => { throw new Error("boom"); } } }));
  const throwErrors = [];
  const okThrow = mod._test.selectWikiPanel((msg) => throwErrors.push(msg));
  check("header: a throwing selectPanel returns false, shows the toast and dispatches nothing",
    okThrow === false && dispatched.length === 0 && throwErrors.length === 1,
    JSON.stringify({ dispatched: dispatched.map((e) => e.type), errors: throwErrors }));
  dispatched.length = 0;
  mod.apply(mk({ layout: { selectPanel: () => false } }));
  const falseErrors = [];
  const okFalse = mod._test.selectWikiPanel((msg) => falseErrors.push(msg));
  check("header: a selectPanel returning false also shows the toast and dispatches nothing",
    okFalse === false && dispatched.length === 0 && falseErrors.length === 1,
    JSON.stringify({ dispatched: dispatched.map((e) => e.type), errors: falseErrors }));
  const src = readFileSync(path.join(import.meta.dirname, "..", "lib", "client.js"), "utf8");
  check("header: no window.open/location.assign for opening the wiki from the header button",
    !/window\.open\(ROUTE \+ "\/"/.test(src) && !/location\.assign\(ROUTE/.test(src)
    && /selectPanel\(PANEL_ID\)/.test(src));
  check("header: the unsupported dsh:select-panel fallback is gone from the client",
    !src.includes("dsh:select-panel"), src.slice(Math.max(0, src.indexOf("dsh:select-panel") - 80), src.indexOf("dsh:select-panel") + 80));
  const btnHtml = renderToStaticMarkup(React.createElement(mod._test.WikiButton, {}));
  check("header: button renders 📖 Wiki with a title", btnHtml.includes("Wiki") && btnHtml.includes("📖"));
}

// ---- defect 4: no misleading "Update" label while the in-panel update job does not exist
{
  const en = mod._test.DICT.en, zh = mod._test.DICT.zh;
  check("update: English action is 'Update in Chat…' / 'Generate in Chat…'",
    en["btn.update"] === "Update in Chat…" && en["btn.generate"] === "Generate in Chat…");
  check("update: Chinese action is '在会话中更新…' / '在会话中生成…'",
    zh["btn.update"] === "在会话中更新…" && zh["btn.generate"] === "在会话中生成…");
  const plain = Object.entries(en).filter(([, v]) => v === "Update" || v === "更新");
  check("update: no dictionary entry is a bare 'Update'/'更新' label", plain.length === 0, JSON.stringify(plain));
  check("update: hint explains that it opens a session and copies /wiki generate <root>",
    en["gen.hint"].includes("/wiki generate <root>") && /session/i.test(en["gen.hint"]) && /composer/.test(en["gen.hint"])
    && zh["gen.hint"].includes("/wiki generate <仓库路径>") && zh["gen.hint"].includes("会话"));
  check("update: 'Copy command' stays available in More actions",
    en["btn.copyCmd"] === "Copy command" && zh["btn.copyCmd"] === "复制命令"
    && en["btn.more"] === "More actions");
  const src = readFileSync(path.join(import.meta.dirname, "..", "lib", "client.js"), "utf8");
  check("update: action button uses the generated/not-generated labels and shows the hint",
    src.includes('info && info.generated ? t("btn.update") : t("btn.generate")')
    && src.includes('h("p", { className: "dw-hint" }, t("gen.hint"))')
    && src.includes('copy(genCommand(root), t("btn.copyCmd") + ": ")'));
}

// Update/Generate: optional client services (uiWorkspace / workspaces / layout); workspaces has no list()
const calls = [];
const mkCtx = (svcs) => ({
  get: (n) => svcs[n],
  effect: (fn) => fn(),
  locale: { register: () => () => {}, bind: () => (k) => k },
  slots: { inject: (_k, fn) => fn(), register: () => () => {} },
});
mod.apply(mkCtx({
  uiWorkspace: { startSession: async (id, o) => { calls.push(["start", id, o]); } },
  workspaces: { create: async () => { calls.push(["create"]); return { id: "new" }; } },
  layout: { selectPanel: (p) => calls.push(["panel", p]) },
}));
let ok = await mod._test.startGenerateSession("C:\\Repo", "w-repo");
check("generate: host workspaceId used directly (no create), conversation selected",
  ok === true && calls.some((c) => c[0] === "start" && c[1] === "w-repo") && calls.some((c) => c[0] === "panel" && c[1] === "conversation")
  && !calls.some((c) => c[0] === "create"), JSON.stringify(calls));
calls.length = 0;
mod.apply(mkCtx({
  uiWorkspace: { startSession: async (id) => { calls.push(["start", id]); } },
  workspaces: { create: async ({ path: p }) => { calls.push(["create", p]); return { id: "w-new" }; } },
}));
ok = await mod._test.startGenerateSession("C:\\Repo2", null);
check("generate: no workspaceId -> workspaces.create({path}) then startSession",
  ok === true && calls[0]?.[0] === "create" && calls[0][1] === "C:\\Repo2" && calls[1]?.[1] === "w-new", JSON.stringify(calls));
calls.length = 0;
mod.apply(mkCtx({
  uiWorkspace: { startSession: async (id) => { calls.push(["start", id]); } },
  workspaces: { create: async () => { throw new Error("workspace already exists"); } },
}));
ok = await mod._test.startGenerateSession("C:\\Repo3", null);
check("generate: create fails (exists) -> copy-only fallback, no session", ok === false && !calls.length, JSON.stringify(calls));
mod.apply(mkCtx({}));
ok = await mod._test.startGenerateSession("C:\\Repo4", "w");
check("generate: no services -> fallback", ok === false);
mod.apply(mkCtx({ uiWorkspace: { startSession: async () => { throw new Error("boom"); } } }));
ok = await mod._test.startGenerateSession("C:\\R", "w");
check("generate: startSession error -> fallback", ok === false);

// ---- spec 007 slice 1: model selector + in-panel job controls (panel stays open) ----
{
  const t = (k) => mod._test.DICT.en[k] ?? k;
  const catalog = {
    phase: "ready", def: { provider: "r9-fallback", model: "ds41" }, failures: [],
    models: [{ provider: "r9-fallback", model: "ds41", label: "DS41", providerLabel: "r9-fallback" },
             { provider: "r9-commandcode", model: "cc/opus", label: "Opus", providerLabel: "r9-commandcode" }],
  };
  const sel = renderToStaticMarkup(React.createElement(mod._test.ModelSelect, { t, catalog, model: catalog.def, onModel() {} }));
  check("model select: renders one option per real catalog model, default flagged",
    (sel.match(/<option/g) || []).length === 2 && sel.includes("DS41") && sel.includes("(default)")
    && sel.includes("cc/opus"), sel.slice(0, 300));
  const selEmpty = renderToStaticMarkup(React.createElement(mod._test.ModelSelect,
    { t, catalog: { phase: "error", models: [], failures: [], def: null, error: "no service" }, model: null, onModel() {} }));
  check("model select: unavailable catalog renders the reason and NO invented options",
    !/<option/.test(selEmpty) && selEmpty.includes("Model catalog unavailable"), selEmpty);

  const running = { id: "j1", root: "C:\\R", action: "generate", phase: "running", stage: "build",
    model: { provider: "r9-fallback", model: "ds41" }, startedAt: new Date().toISOString(), sessionId: "sess-abc123", pages: null };
  // A job that exists at all implies the gate is open: the Host answers active/last = null while it is
  // closed (lib/index.js GET /api/jobs), and the panel now renders only the notice in that branch.
  const OPEN_GATE = { known: true, disabled: false, reason: "" };
  const runningHtml = renderToStaticMarkup(React.createElement(mod._test.JobControls,
    { t, root: "C:\\R", generated: false, catalog, model: catalog.def, job: running, busy: true, gate: OPEN_GATE,
      onStart() {}, onCancel() {}, onOpenSession() {}, onCopy() {} }));
  check("job controls: running job shows a progress bar, the stage label, the model and Cancel",
    /role="progressbar"/.test(runningHtml) && runningHtml.includes("Building the site")
    && runningHtml.includes("r9-fallback") && runningHtml.includes("Cancel")
    && /width:\d+%/.test(runningHtml), runningHtml.slice(0, 400));
  check("job controls: the job's session is offered as a link + copy (panel stays open)",
    runningHtml.includes("Job session") && runningHtml.includes("Open session") && runningHtml.includes("Copy session id"));

  // The finished-job fixture carries an explicitly open gate: this block exercises the enabled
  // Update path, and a closed gate now renders a disabled primary button instead of none.
  const doneHtml = renderToStaticMarkup(React.createElement(mod._test.JobControls,
    { t, root: "C:\\R", generated: true, catalog, model: catalog.def, gate: { known: true, disabled: false, reason: "" },
      job: { ...running, phase: "done", stage: "done", pages: 12, sessionId: null }, busy: false,
      onStart() {}, onCancel() {}, onOpenSession() {}, onCopy() {} }));
  check("job controls: success shows the done line with the page count and the Update button",
    doneHtml.includes("Finished and published") && doneHtml.includes("12") && doneHtml.includes("Update wiki"));

  const failHtml = renderToStaticMarkup(React.createElement(mod._test.JobControls,
    { t, root: "C:\\R", generated: true, catalog, model: catalog.def, gate: OPEN_GATE,
      job: { ...running, phase: "failed", stage: "selfcheck", sessionId: null, error: { message: "selfcheck failed: bad citation" } },
      busy: false, onStart() {}, onCancel() {}, onOpenSession() {}, onCopy() {} }));
  check("job controls: failure shows the exact error text with role=alert",
    /role="alert"/.test(failHtml) && failHtml.includes("selfcheck failed: bad citation"));

  const cancelHtml = renderToStaticMarkup(React.createElement(mod._test.JobControls,
    { t, root: "C:\\R", generated: true, catalog, model: catalog.def, gate: OPEN_GATE,
      job: { ...running, phase: "canceled", sessionId: null }, busy: false, onStart() {}, onCancel() {}, onOpenSession() {}, onCopy() {} }));
  // 绝对保证已移除：取消文案只承诺“未发布候选时保持上一次已发布内容”，并说明模型权限限制。
  check("job controls: cancellation states the real guarantee (last published content kept, model not sandboxed)",
    /Canceled/.test(cancelHtml) && /last published content/.test(cancelHtml) && /not sandboxed/.test(cancelHtml)
    && !/untouched/.test(cancelHtml), cancelHtml.slice(0, 400));

  const html = renderToStaticMarkup(React.createElement(mod._test.Home, { t, open() {}, catalog, model: catalog.def, onModel() {} }));
  check("home: the model selector is part of the main screen",
    html.includes("dw-select") && html.includes("DS41") && html.includes(">Model<"), html.slice(0, 400));
  check("job stage order drives the progress percentage", mod._test.jobStageIndex("staging") === 0
    && mod._test.jobStageIndex("agent") > mod._test.jobStageIndex("staging")
    && mod._test.jobStageIndex("selfcheck") < mod._test.jobStageIndex("publish")
    && mod._test.jobStageIndex("nope") === 0);
}

// ---- P1: page/card id dictionaries must be prototype-free (constructor / toString / __proto__) ----
{
  const t = (k) => mod._test.DICT.en[k] ?? k;
  const pages = [
    { id: "constructor", parentId: null, order: 1, title: "Constructor page", description: "", filePaths: [],
      markdown: "# C\n\n[fake card](#card-constructor) and [real card](#card-valueOf) and [to child](#child)" },
    { id: "toString", parentId: null, order: 2, title: "ToString page", description: "", filePaths: [], markdown: "# T" },
    { id: "__proto__", parentId: null, order: 3, title: "Proto page", description: "", filePaths: [], markdown: "# P" },
    { id: "child", parentId: "constructor", order: 4, title: "Child page", description: "", filePaths: [], markdown: "# K" },
    { id: "hasOwnProperty", parentId: "toString", order: 5, title: "Own page", description: "", filePaths: [], markdown: "# O" },
  ];
  const cards = [
    { id: "valueOf", title: "ValueOf card", kind: "api", summary: "s", keyFiles: [], related: ["constructor"], tags: [], pageIds: ["constructor"] },
    { id: "toJSON", title: "ToJSON card", kind: "concept", summary: "s", keyFiles: [], related: [], tags: [], pageIds: [] },
  ];
  const info = { root: "C:\\R", title: "R", generated: true, hasSite: false, pageCount: pages.length, cardCount: cards.length,
    language: "en", sourceCommit: "0123456789abcdef", updatedAt: null, updateAvailable: false, head: null };
  const wiki = { root: "C:\\R", title: "R", language: "en", pages, cards };
  const src = readFileSync(path.join(import.meta.dirname, "..", "lib", "client.js"), "utf8");
  check("tree: page/card id dictionaries are prototype-free (Object.create(null))",
    /pageById = Object\.create\(null\)/.test(src) && /cardById = Object\.create\(null\)/.test(src)
    && /children = Object\.create\(null\)/.test(src) && !/pageById = \{\}/.test(src) && !/cardById = \{\}/.test(src)
    && !/children = \{\}/.test(src), src.slice(src.indexOf("var children ="), src.indexOf("var children =") + 60));
  check("tree: descendant search and open-state updates are prototype-free too (no 'constructor' false hit)",
    /renderNode\(p, 0, Object\.create\(null\)\)/.test(src) && /Object\.assign\(Object\.create\(null\), seen\)/.test(src)
    && /Object\.assign\(Object\.create\(null\), open\)/.test(src));

  // A second module instance with canned hooks: renderToStaticMarkup never runs effects, so
  // Detail would otherwise stay at "loading". Canned hook states let the real component render
  // loaded data and navigate pages/cards by hostile id without touching production code.
  const hookStates = [];
  let hookAt = 0;
  const fakeReact = {
    createElement: React.createElement,
    Fragment: React.Fragment,
    createContext: React.createContext,
    useState: function () { return [hookStates[hookAt++], function () {}]; },
    useRef: function (init) { return { current: init }; },
    useEffect: function () {},
    useCallback: function (fn) { return fn; },
    useMemo: function (fn) { return fn(); },
    useContext: function (ctx) { return React.useContext(ctx); },
  };
  let hookMod = null;
  const hookSandbox = {
    window: {
      __ModuleLoader__: { load: (spec) => { hookMod = spec.factory((name) => {
        if (name === "react") return fakeReact;
        throw new Error("unexpected require " + name);
      }); } },
      dispatchEvent: () => true,
    },
    CustomEvent: function (type, init) { this.type = type; this.detail = (init && init.detail) || {}; },
    console, setTimeout, clearTimeout, Promise, Object, Array, String, Number, Math, Date, RegExp, JSON,
  };
  vm.runInNewContext(src, hookSandbox);
  hookMod.apply({
    effect: (fn) => fn(),
    locale: { register: () => () => {}, bind: () => (k) => k },
    slots: { inject: (_k, fn) => fn(), register: () => () => {} },
  });
  // 10 canned hook states in Detail's order: data, lang, sel, showSrc, q, open, menu, toast,
  // useJobView, useLanguages
  const renderDetail = (sel, opts) => {
    opts = opts || {};
    hookAt = 0;
    hookStates.length = 0;
    hookStates.push({ phase: "ready", info, wiki, missing: false, error: null }, opts.lang || "en", sel, false, opts.q || "",
      opts.open || Object.create(null), false, null, { active: null, last: null },
      { phase: "ready", tags: opts.tags || [], error: null });
    return renderToStaticMarkup(React.createElement(hookMod._test.Detail, {
      t, project: { root: "C:\\R", title: "R", generated: true }, back() {},
      catalog: { phase: "ready", models: [], failures: [], def: null }, model: null, onModel() {},
    }));
  };
  const tryDetail = (sel, opts) => {
    try { return { html: renderDetail(sel, opts), err: null }; } catch (e) { return { html: "", err: e }; }
  };
  const detailErr = (r) => (r.err ? String((r.err && r.err.message) || r.err) : "");

  const pageConstructor = tryDetail({ type: "page", id: "constructor" });
  check("P1 render: page id 'constructor' renders with its child (children['constructor'] is not Object.prototype)",
    !pageConstructor.err && pageConstructor.html.includes("Constructor page") && pageConstructor.html.includes("Child page")
    && pageConstructor.html.includes("dw-detail"), detailErr(pageConstructor));
  check("P1 render: #card-constructor link without a real card stays inert text",
    !pageConstructor.err && !/class="dw-link"[^>]*>fake card</.test(pageConstructor.html) && pageConstructor.html.includes("fake card"),
    detailErr(pageConstructor));
  check("P1 render: real card and page links still navigate",
    !pageConstructor.err && /class="dw-link"[^>]*>real card</.test(pageConstructor.html)
    && /class="dw-link"[^>]*>to child</.test(pageConstructor.html), detailErr(pageConstructor));

  const protoPage = tryDetail({ type: "page", id: "__proto__" });
  check("P1 render: page id '__proto__' resolves to the real page, not Object.prototype",
    !protoPage.err && protoPage.html.includes("Proto page"), detailErr(protoPage));
  const toStringPage = tryDetail({ type: "page", id: "toString" });
  check("P1 render: page id 'toString' resolves to the real page",
    !toStringPage.err && toStringPage.html.includes("ToString page"), detailErr(toStringPage));
  const inheritedPage = tryDetail({ type: "page", id: "hasOwnProperty" });
  check("P1 render: page id 'hasOwnProperty' resolves to the real page",
    !inheritedPage.err && inheritedPage.html.includes("Own page"), detailErr(inheritedPage));
  const missPage = tryDetail({ type: "page", id: "valueOf" });
  check("P1 render: missing page id 'valueOf' shows Page not found without crashing",
    !missPage.err && missPage.html.includes("Page not found"), detailErr(missPage));
  const missPageConstructor = tryDetail({ type: "page", id: "constructor2" });
  check("P1 render: an absent page id still shows Page not found", !missPageConstructor.err && missPageConstructor.html.includes("Page not found"), detailErr(missPageConstructor));

  const cardValueOf = tryDetail({ type: "card", id: "valueOf" });
  check("P1 render: card id 'valueOf' renders",
    !cardValueOf.err && cardValueOf.html.includes("ValueOf card"), detailErr(cardValueOf));
  check("P1 render: inherited related id 'constructor' is not treated as a real card",
    !cardValueOf.err && !/>constructor<\/a>/.test(cardValueOf.html), detailErr(cardValueOf));
  const missCard = tryDetail({ type: "card", id: "toString" });
  check("P1 render: missing card id 'toString' shows Page not found without crashing",
    !missCard.err && missCard.html.includes("Page not found"), detailErr(missCard));
  const missCardConstructor = tryDetail({ type: "card", id: "constructor" });
  check("P1 render: missing card id 'constructor' (fake #card-constructor target) does not crash",
    !missCardConstructor.err && missCardConstructor.html.includes("Page not found"), detailErr(missCardConstructor));

  const filtered = tryDetail({ type: "page", id: "child" }, { q: "child" });
  check("P1 render: descendant search keeps ancestor roots (seen['constructor'] is not a false hit)",
    !filtered.err && filtered.html.includes("Constructor page") && filtered.html.includes("Child page")
    && !filtered.html.includes("ToString page"), detailErr(filtered));

  const collapsedOpen = Object.create(null);
  collapsedOpen["constructor"] = false;
  const collapsed = tryDetail({ type: "page", id: "toString" }, { open: collapsedOpen });
  check("P1 render: open state keyed by 'constructor' collapses only that subtree",
    !collapsed.err && collapsed.html.includes("Constructor page") && !collapsed.html.includes("Child page"), detailErr(collapsed));

  // The header button owns a local toast: rendering the error state must expose a clear alert.
  hookAt = 0; hookStates.length = 0; hookStates.push(mod._test.DICT.en["nav.unavailable"]);
  const toastHtml = renderToStaticMarkup(React.createElement(hookMod._test.WikiButton, {}));
  check("header: a failed panel switch renders a clear role=alert toast",
    /role="alert"/.test(toastHtml) && toastHtml.includes("Open it from the sidebar"), toastHtml);
}

// ---- P1: the zoom modal traps focus (Tab cycles inside the dialog) ----
{
  const src = readFileSync(path.join(import.meta.dirname, "..", "lib", "client.js"), "utf8");
  check("zoom: Tab/Shift+Tab are trapped inside the modal dialog",
    src.includes('e.key !== "Tab"') && src.includes("querySelectorAll(\"button, [href], input, select, textarea") &&
    src.includes("last.focus()") && src.includes("first.focus()"));
  check("zoom: the trap scope is the dialog element itself", /dialogRef/.test(src) && /ref: dialogRef/.test(src));
}
// ---- spec 007 gate: host GET /api/jobs disabled -> no enabled Generate/Update, exact reason shown ----
//
// Host contract (lib/index.js): while the background-job gate is closed, GET /api/jobs answers
// { ok, root, disabled: true, disabledReason, active: null, last: null } and POST returns 503.
// The panel therefore may not offer an enabled Generate/Update: it keeps exactly one primary button,
// visible but disabled, with the host's reason in its title (hiding it would make the capability look
// deleted instead of blocked). A missing or failed status counts as closed (fail closed) rather than
// falling back to "catalog ready = generate".
{
  const HOST_REASON = "Background wiki jobs are disabled pending filesystem isolation and recovery review";
  const t = (k) => mod._test.DICT.en[k] ?? k;
  const catalog = {
    phase: "ready", def: { provider: "r9-fallback", model: "ds41" }, failures: [],
    models: [{ provider: "r9-fallback", model: "ds41", label: "DS41", providerLabel: "r9-fallback" },
             { provider: "r9-commandcode", model: "cc/opus", label: "Opus", providerLabel: "r9-commandcode" }],
  };
  const model = { provider: "r9-fallback", model: "ds41" };
  const primaryButtons = (html) => (html.match(/<button\b[^>]*>/g) || []).filter((b) => /class="dw-btn primary"/.test(b));
  // 闸门关闭的契约：主按钮仍然渲染（能力可见），但禁用（不可执行），title 是宿主原文。
  // 返回那个唯一的按钮标签，长度不等于 1 或未禁用时返回 null —— 断言因此既非空转也非"消失即通过"。
  const closedPrimary = (html) => {
    const b = primaryButtons(html);
    return b.length === 1 && /disabled=""/.test(b[0]) ? b[0] : null;
  };
  // 闸门关闭时的动作区：按钮组就在提示条里（.dw-notice-actions 是提示条的最后一个子块），
  // 所以从组头切到组尾正好得到“提示条里的按钮”。空字符串即“提示条里没有动作区”。
  const noticeActions = (html) => {
    const at = html.indexOf('class="dw-notice-actions"');
    if (at < 0) return "";
    const end = html.indexOf("</div></div>", at);
    return end < 0 ? html.slice(at) : html.slice(at, end + "</div></div>".length);
  };
  const renderJobs = (extra) => renderToStaticMarkup(React.createElement(mod._test.JobControls,
    { t, root: "C:\\R", generated: true, catalog, model, job: null, busy: false,
      onStart() {}, onCancel() {}, onOpenSession() {}, onCopy() {}, onCopyCommand() {}, ...extra }));

  // 标签只留动作（命令不写进标签，否则窄面板里按钮宽度会挤掉原因）；
  // 命令原文放在同一个提示条条目的 title 里，所以信息没有减少。
  check("gate: dictionaries carry title, a short copy label with the command in its title, and hint in en + zh",
    /disabled/i.test(mod._test.DICT.en["job.gate.title"]) && /停用/.test(mod._test.DICT.zh["job.gate.title"])
    && mod._test.DICT.en["job.gate.copyCmd"] === "Copy command"
    && mod._test.DICT.zh["job.gate.copyCmd"] === "复制命令"
    && mod._test.DICT.en["job.gate.copyCmdTitle"].includes("/wiki generate")
    && mod._test.DICT.zh["job.gate.copyCmdTitle"].includes("/wiki generate")
    && !!mod._test.DICT.en["job.gate.hint"] && !!mod._test.DICT.zh["job.gate.hint"],
    JSON.stringify([mod._test.DICT.en["job.gate.title"], mod._test.DICT.zh["job.gate.title"]]));

  // The reported defect: catalog ready but the host gate is closed -> the panel enabled Generate.
  // 闸门关闭后的结构：不再有 .dw-job 卡片（宿主此时 active/last 恒为 null，卡片里只剩一个禁用按钮
  // 的空框），被挡住的主按钮搬进提示条，和「复制命令」兜底在同一组里 —— 两者都在 .dw-notice-actions
  // 之内，且提示条之外没有任何按钮，所以“组里恰好两个按钮”这条断言不会空转。
  const closed = renderJobs({ gate: { known: true, disabled: true, reason: HOST_REASON } });
  const closedBtn = closedPrimary(closed);
  const closedActions = noticeActions(closed);
  check("gate: disabled + catalog ready -> exactly one disabled Generate/Update, inside the notice, no job card",
    !!closedBtn && closedBtn.includes('title="' + HOST_REASON + '"')
    && /class="dw-notice-actions">[\s\S]*class="dw-btn primary"[\s\S]*>Copy command<\/button>/.test(closedActions)
    && (closedActions.match(/<button\b/g) || []).length === 2
    && !closed.includes('class="dw-job"') && !closed.includes('id="dw-model-select"'),
    closed.slice(0, 900));
  check("gate: the exact host disabledReason is shown verbatim and prominently",
    closed.includes('class="dw-notice"') && closed.includes(HOST_REASON)
    && /class="dw-notice-body">[\s\S]*<span>Background wiki jobs are disabled/.test(closed) && /role="status"/.test(closed));
  // 闸门关闭时模型选择器不再渲染（见下一条），仍留在界面上的唯一控件是复制按钮：
  // 命令原文折进它的 title，按钮因此不靠宽度说话，信息也没有丢。
  check("gate: the surviving control names the exact command in its title, not in its label",
    /<button[^>]*title="Copy the \/wiki generate command — [^"]*"[^>]*>Copy command<\/button>/.test(closed),
    closed.slice(0, 700));
  // 闸门关闭时，一个孤零零的只读模型下拉读起来像残留的杂物：卡片里不再渲染它，选中的模型
  // 作为提示条里的一行灰字保留 —— 信息没少，只是不再假装是一个可操作控件。卡片本身留着，
  // 里面只剩那一个禁用的主按钮（上一条已断言）。
  check("gate: the selected model stays visible as a notice line, with no stranded read-only selector",
    closed.includes("Model: r9-fallback / ds41") && !/<select/.test(closed) && !/<option/.test(closed),
    closed.slice(0, 700));
  check("gate: no false updating capability (no progress bar, no Cancel, no background-running claim)",
    !/role="progressbar"/.test(closed) && !closed.includes(">✕ ") && !closed.includes("keeps running in the background"));
  check("gate: an explicit copy-only foreground command is offered",
    closed.includes("Copy command") && /class="dw-notice"[\s\S]*>Copy command<\/button>/.test(closed));

  // Fail closed: status missing (not yet fetched / older host) or answered without a reason.
  // 三条都要求“一个禁用的主按钮 + 对应的原因写在 title 里”：之前 every() 在零按钮时也会真，等于放过消失。
  const missing = renderJobs({ gate: undefined });
  const missingBtn = closedPrimary(missing);
  check("gate: a missing gate status fails closed (Generate visible but disabled until the Host confirms)",
    !!missingBtn && missingBtn.includes('title="Checking whether background jobs are available')
    && missing.includes("Checking whether background jobs are available"),
    missing.slice(0, 700));
  const noReason = renderJobs({ gate: { known: true, disabled: true, reason: "" } });
  const noReasonBtn = closedPrimary(noReason);
  check("gate: disabled without a reason says so instead of inventing one",
    !!noReasonBtn && noReasonBtn.includes('title="The Host reported no reason.')
    && noReason.includes("The Host reported no reason."));
  const badStatus = renderJobs({ gate: { known: false, disabled: true, reason: "" } });
  const badStatusBtn = closedPrimary(badStatus);
  check("gate: an unconfirmed status (request failed) also fails closed",
    !!badStatusBtn && badStatusBtn.includes('title="Checking whether background jobs are available')
    && badStatus.includes("Checking whether background jobs are available"));

  // Guard against over-disabling: only an explicit disabled:false re-enables the real action.
  // 闸门开启时同样只有一个主按钮，只是启用 —— 恢复的是“唯一且始终可见”，不是多出一个控件。
  // 卡片也照旧：.dw-job 里是模型下拉 + 启用的主按钮，提示条在这个分支不该出现。
  const open = renderJobs({ gate: { known: true, disabled: false, reason: "" } });
  // 闸门开启时模型卡片照旧：下拉重新出现，模型选择没有变成永久只读的说明文字
  check("gate: an explicit disabled:false restores the normal Generate/Update button and the model card",
    primaryButtons(open).length === 1 && !/disabled=""/.test(primaryButtons(open)[0])
    && !open.includes('class="dw-gate"') && open.includes("keeps running in the background")
    && open.includes('class="dw-job"') && !open.includes('class="dw-notice"')
    && /<select id="dw-model-select"/.test(open), open.slice(0, 400));
  const noCatalog = renderJobs({ gate: { known: true, disabled: false, reason: "" }, model: null,
    catalog: { phase: "error", models: [], failures: [], def: null, error: "no service" } });
  check("gate: a broken model catalog still blocks generation independently of the gate",
    primaryButtons(noCatalog).length === 1 && /disabled=""/.test(primaryButtons(noCatalog)[0])
    && noCatalog.includes("Model catalog unavailable"));

  // ---- Detail render: the gate reaches the overview (catalog ready, host gate closed) ----
  const hk = { at: 0, states: [], effects: [] };
  const hookReact = {
    createElement: React.createElement, Fragment: React.Fragment, createContext: React.createContext,
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
  let currentFetch = () => Promise.reject(new Error("no fetch in this test"));
  const loadClient = (react, extra) => {
    let m = null;
    const sb = {
      window: {
        __ModuleLoader__: { load: (spec) => { m = spec.factory((name) => {
          if (name === "react") return react;
          throw new Error("unexpected require " + name);
        }); } },
        dispatchEvent: () => true,
      },
      CustomEvent: function (type, init) { this.type = type; this.detail = (init && init.detail) || {}; },
      console, setTimeout, clearTimeout, Promise, Object, Array, String, Number, Math, Date, RegExp, JSON, ...extra,
    };
    vm.runInNewContext(readFileSync(path.join(import.meta.dirname, "..", "lib", "client.js"), "utf8"), sb);
    return m;
  };
  const hookMod = loadClient(hookReact, { fetch: function () { return currentFetch.apply(null, arguments); } });
  hookMod.apply({ effect: (fn) => fn(), locale: { register: () => () => {} }, slots: { inject: (_k, fn) => fn(), register: () => () => {} } });

  const pages = [{ id: "p1", parentId: null, order: 1, title: "Page One", description: "", filePaths: [], markdown: "# Page One" }];
  const info = { root: "C:\\R", title: "R", generated: true, hasSite: false, pageCount: 1, cardCount: 0, language: "en",
    sourceCommit: "0123456789abcdef", updatedAt: null, updateAvailable: true, head: "feedfacecafe" };
  const wiki = { root: "C:\\R", title: "R", language: "en", pages, cards: [] };
  // `menu`: seed the "More actions" popover open so its items are in the markup (index 6 of Detail's
  // hook states). A closed menu renders no items at all, which would make "no such action" vacuous.
  const renderOverview = (gate, menu) => {
    hk.at = 0;
    hk.effects.length = 0;
    // 10 canned hook states in Detail's order: data, lang, sel, showSrc, q, open, menu, toast,
    // useJobView, useLanguages
    hk.states = [{ phase: "ready", info, wiki, missing: false, error: null }, "en", null, false, "", Object.create(null), !!menu, null,
      { active: null, last: null, gate }, { phase: "ready", tags: [], error: null }];
    return renderToStaticMarkup(React.createElement(hookMod._test.Detail, {
      t, project: { root: "C:\\R", title: "R", generated: true }, back() {},
      catalog, model, onModel() {},
    }));
  };

  const closedOverview = renderOverview({ known: true, disabled: true, reason: HOST_REASON });
  const closedMenu = renderOverview({ known: true, disabled: true, reason: HOST_REASON }, true);
  const closedOverviewBtn = closedPrimary(closedOverview);
  check("gate render: overview shows the exact host reason and a disabled (not hidden) Generate/Update",
    closedOverview.includes(HOST_REASON) && closedOverview.includes('class="dw-notice"')
    && !!closedOverviewBtn && closedOverviewBtn.includes('title="' + HOST_REASON + '"')
    && closedOverview.includes("↻ Update wiki")
    // 同一个提示条里：被挡住的主按钮 + 「复制命令」兜底；概览里没有任何空的 .dw-job 卡片
    && /class="dw-notice-actions">[\s\S]*class="dw-btn primary"[\s\S]*>Copy command<\/button>/.test(noticeActions(closedOverview))
    && !closedOverview.includes('class="dw-job"'), closedOverview.slice(0, 900));
  check("gate render: the update-available banner action is disabled too (no false update capability)",
    !closedOverview.includes('class="dw-banner"') && !/class="dw-btn[^"]*"[^>]*>Update wiki</.test(closedOverview)
    && /class="dw-hero-sub">[^<]*new commits[^<]*\(HEAD feedfac\)/.test(closedOverview), closedOverview.slice(0, 900));
  check("gate render: background-job claims are gone while the gate is closed",
    !closedOverview.includes("stays on the selected model") && !closedOverview.includes("keeps running in the background"));
  // 前台兜底只能是“复制命令”：闸门关闭时 UI 里不存在任何会自己开会话的入口（菜单展开也一样）
  check("gate render: no session-opening 'in Chat' action is offered while the gate is closed",
    !closedMenu.includes("Update in Chat") && !closedMenu.includes("Generate in Chat")
    && closedOverview.includes('class="dw-notice"') && closedOverview.includes("Copy command"),
    closedMenu.slice(0, 700));
  const openOverview = renderOverview({ known: true, disabled: false, reason: "" }, true);
  check("gate render: with the gate explicitly open the overview keeps the working Generate/Update affordance",
    !openOverview.includes('class="dw-notice"') && !primaryButtons(openOverview).every((b) => /disabled=""/.test(b))
    && openOverview.includes("stays on the selected model")
    && /class="dw-more">[\s\S]*>Update in Chat…<\/button>/.test(openOverview), openOverview.slice(0, 500));

  // The copy-command fallback must only write the clipboard — never open/steal a session.
  const copyCmdLine = (readFileSync(path.join(import.meta.dirname, "..", "lib", "client.js"), "utf8")
    .match(/onCopyCommand:[^\n]*/) || [""])[0];
  check("gate: the foreground copy-command fallback never calls startGenerateSession",
    copyCmdLine.includes("copy(genCommand(root)") && !copyCmdLine.includes("startGenerateSession"), copyCmdLine);

  // ---- useJobView must preserve the gate; missing/broken status fails closed ----
  const driveJobView = async (fetchImpl) => {
    currentFetch = fetchImpl;
    hk.at = 0;
    hk.effects.length = 0;
    hk.states = [];
    hookMod._test.useJobView("C:\\R");
    const cleanups = hk.effects.map((fn) => fn());
    await new Promise((r) => setTimeout(r, 0));
    cleanups.forEach((c) => { if (typeof c === "function") c(); });
    return hk.states[0];
  };
  const jsonOk = (body) => () => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });

  let jv = await driveJobView(jsonOk({ ok: true, disabled: true, disabledReason: HOST_REASON, active: null, last: null }));
  check("gate: useJobView preserves disabled:true and the exact disabledReason",
    jv.gate.disabled === true && jv.gate.known === true && jv.gate.reason === HOST_REASON
    && jv.active === null && jv.last === null, JSON.stringify(jv));
  jv = await driveJobView(jsonOk({ ok: true, active: null, last: null }));
  check("gate: a status payload without a disabled flag keeps generation closed (fail closed)",
    jv.gate.disabled === true && jv.gate.known === true && jv.gate.reason === "", JSON.stringify(jv.gate));
  jv = await driveJobView(() => Promise.reject(new Error("host offline")));
  check("gate: a failed status request keeps generation closed and unconfirmed",
    jv.gate.disabled === true && jv.gate.known === false, JSON.stringify(jv.gate));
  jv = await driveJobView(jsonOk({ ok: true, disabled: false, active: { id: "j1", phase: "running" }, last: null }));
  check("gate: only an explicit disabled:false opens generation, and active jobs still flow through",
    jv.gate.disabled === false && jv.gate.known === true && !!jv.active && jv.active.id === "j1", JSON.stringify(jv));
}

// ---- T017b: language control (en + translated languages), per-root persistence, untranslated
//      state and its translate action, and the refresh after a translate job succeeds ----
{
  const src = readFileSync(path.join(import.meta.dirname, "..", "lib", "client.js"), "utf8");
  const t = (k) => mod._test.DICT.en[k] ?? k;
  const zh = mod._test.DICT.zh;
  const HOST_REASON = "Background wiki jobs are disabled pending filesystem isolation and recovery review";
  const ROOT = "C:\\R";

  // ---- labels: tag itself + a human name for known tags, raw tag otherwise, never a throw ----
  check("lang: en and vi get human names, unknown tags show the raw tag, nothing throws",
    mod._test.langLabel("en") === "en — English" && mod._test.langLabel("vi") === "vi — Tiếng Việt"
    && mod._test.langLabel("pt-BR") === "pt-BR" && mod._test.langLabel(null) === ""
    && mod._test.langLabel(undefined) === "" && mod._test.langLabel(42) === "42");
  check("lang: the control's strings exist in both dictionaries",
    !!zh["lang.label"] && !!zh["lang.missing.title"] && !!zh["lang.missing.body"] && zh["lang.translate"].includes("翻译")
    && !!t("lang.label") && !!t("lang.missing.title") && !!t("lang.listFail"));

  // ---- per-root persistence (localStorage keyed by root; en clears it; no storage never throws) ----
  const store = new Map();
  const ls = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
  const loadClient = (react, extra, winExtra) => {
    let m = null;
    const sb = {
      window: {
        __ModuleLoader__: { load: (spec) => { m = spec.factory((name) => {
          if (name === "react") return react;
          throw new Error("unexpected require " + name);
        }); } },
        dispatchEvent: () => true, ...(winExtra || {}),
      },
      CustomEvent: function (type, init) { this.type = type; this.detail = (init && init.detail) || {}; },
      console, setTimeout, clearTimeout, Promise, Object, Array, String, Number, Math, Date, RegExp, JSON, ...extra,
    };
    vm.runInNewContext(src, sb);
    return m;
  };
  // Canned-state React: renderToStaticMarkup runs no effects and gives components no real state,
  // so each useState gets a slot the test seeds (the setter mutates it, so effect results are visible).
  const mkHookReact = (hk) => ({
    createElement: React.createElement, Fragment: React.Fragment, createContext: React.createContext,
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
  });
  const hk = { at: 0, states: [], effects: [] };
  const langMod = loadClient(mkHookReact(hk), {}, { localStorage: ls });
  langMod.apply({ effect: (fn) => fn(), locale: { register: () => () => {} }, slots: { inject: (_k, fn) => fn(), register: () => () => {} } });

  check("lang: the module without any storage still answers en instead of throwing",
    mod._test.readStoredLang("C:\\NoStorage") === "en");
  check("lang: the choice is remembered per project root and en clears it",
    langMod._test.readStoredLang("C:\\A") === "en"
    && (langMod._test.storeLang("C:\\A", "vi"), langMod._test.readStoredLang("C:\\A") === "vi")
    && langMod._test.readStoredLang("C:\\B") === "en"
    && [...store.keys()].join(",") === langMod._test.LANG_STORE_PREFIX + "C:\\A"
    && (langMod._test.storeLang("C:\\A", "en"), langMod._test.readStoredLang("C:\\A") === "en" && store.size === 0),
    JSON.stringify([...store.keys()]));

  // ---- the selector: en always offered, translated tags listed, — when there is none ----
  const pick = [];
  const renderSel = (props) => renderToStaticMarkup(React.createElement(langMod._test.LanguageSelect,
    { t, onPick: (tag) => pick.push(tag), ...props }));
  const selVi = renderSel({ lang: "vi", tags: ["vi"], phase: "ready" });
  check("lang select: en plus every translated tag, current tag selected, human names shown",
    (selVi.match(/<option/g) || []).length === 2 && selVi.includes(">en — English<")
    && /<option value="vi" selected="">vi — Tiếng Việt<\/option>/.test(selVi) && !/dw-langnone/.test(selVi), selVi);
  check("lang select: it has an associated <label> (keyboard reachable, labelled)",
    /<label for="dw-lang-select" class="dw-sr">Wiki language<\/label>/.test(selVi) && /<select id="dw-lang-select"/.test(selVi));
  const selEmpty = renderSel({ lang: "en", tags: [], phase: "ready" });
  check("lang select: no translated language -> a dash instead of an empty-looking control",
    (selEmpty.match(/<option/g) || []).length === 1 && /class="dw-langnone"[^>]*>—</.test(selEmpty)
    && !selEmpty.includes("Could not read"), selEmpty);
  const selFail = renderSel({ lang: "en", tags: [], phase: "error" });
  check("lang select: a failed language list shows the dash and its reason as the title",
    /class="dw-langnone" title="Could not read the language list from the Host."/.test(selFail), selFail);
  const selStale = renderSel({ lang: "pt-BR", tags: [], phase: "loading" });
  check("lang select: a persisted tag not in the list yet stays visible instead of silently showing en",
    /<option value="pt-BR" selected="">pt-BR<\/option>/.test(selStale), selStale);

  // ---- untranslated panel: message, translate action, gate handling ----
  const elements = (node, out = []) => {
    if (node === null || node === undefined || node === false) return out;
    if (Array.isArray(node)) { node.forEach((n) => elements(n, out)); return out; }
    if (typeof node === "object" && node.props) { out.push(node); elements(node.props.children, out); }
    return out;
  };
  const buttonsIn = (el) => elements(el).filter((n) => n.type === "button");
  const posted = [];
  const panelProps = {
    t, lang: "vi", job: null, busy: false, catalogPhase: "ready", hasModel: true,
    onTranslate: (tag) => posted.push(tag), onCancel: () => posted.push("cancel"),
  };
  const closedPanel = langMod._test.UntranslatedPanel({ ...panelProps, gate: { known: true, disabled: true, reason: HOST_REASON } });
  const closedHtml = renderToStaticMarkup(closedPanel);
  const disabledButtons = buttonsIn(closedPanel).filter((b) => b.props.disabled === true);
  check("untranslated: a clear, non-alarming message names the language and says only English exists",
    closedHtml.includes("No translation in this language yet") && closedHtml.includes("only in English")
    && closedHtml.includes("vi — Tiếng Việt") && !/Failed|error/i.test(closedHtml.replace(/<style>[\s\S]*?<\/style>/, "")),
    closedHtml.slice(0, 500));
  check("untranslated: the action says 'Translate to <tag>' and is disabled while the job gate is closed",
    /<button[^>]*disabled=""[^>]*>🌐 Translate to vi<\/button>/.test(closedHtml)
    && /title="Background wiki jobs are disabled/.test(closedHtml), closedHtml.slice(0, 700));
  check("untranslated: the closed gate shows the Host's exact reason (same explanation as Generate/Update)",
    /class="dw-notice-body">[\s\S]*<span>Background wiki jobs are disabled/.test(closedHtml) && closedHtml.includes(HOST_REASON) && /role="status"/.test(closedHtml));
  check("untranslated: a disabled action posts nothing even if its handler runs",
    disabledButtons.length > 0 && (disabledButtons.forEach((b) => b.props.onClick()), posted.length === 0),
    JSON.stringify(posted));

  const openPanel = langMod._test.UntranslatedPanel({ ...panelProps, gate: { known: true, disabled: false, reason: "" } });
  const openHtml = renderToStaticMarkup(openPanel);
  const openTranslate = buttonsIn(openPanel).filter((b) => b.props.disabled !== true && String(b.props.className).includes("primary"));
  check("untranslated: with the gate open the action is enabled and starts a translate for this tag",
    !/<button[^>]*disabled=""[^>]*>🌐/.test(openHtml) && !openHtml.includes('class="dw-gate"') && openTranslate.length === 1
    && (openTranslate[0].props.onClick(), posted.join(",") === "vi"), JSON.stringify(posted));
  const noCatalogPanel = langMod._test.UntranslatedPanel({ ...panelProps, catalogPhase: "error",
    gate: { known: true, disabled: false, reason: "" }, onTranslate: () => posted.push("should-not") });
  check("untranslated: without a model catalog the action stays disabled (no doomed job)",
    /<button[^>]*disabled=""[^>]*>🌐 Translate to vi<\/button>/.test(renderToStaticMarkup(noCatalogPanel)));
  const runningPanel = langMod._test.UntranslatedPanel({ ...panelProps,
    gate: { known: true, disabled: false, reason: "" },
    job: { id: "j9", action: "translate", targetLang: "vi", phase: "running", stage: "agent", model: { provider: "p", model: "m" } }, busy: true });
  const runningHtml = renderToStaticMarkup(runningPanel);
  check("untranslated: a running translate shows its progress and Cancel instead of a second start",
    /role="progressbar"/.test(runningHtml) && runningHtml.includes("Running · Writing pages and cards")
    && runningHtml.includes("Cancel") && !runningHtml.includes("🌐"), runningHtml.slice(0, 500));
  const failedHtml = renderToStaticMarkup(langMod._test.UntranslatedPanel({ ...panelProps,
    gate: { known: true, disabled: false, reason: "" },
    job: { id: "j9", action: "translate", targetLang: "vi", phase: "failed", stage: "agent", model: { provider: "p", model: "m" },
      error: { code: "job-failed", message: "the job failed" } }, busy: false }));
  check("untranslated: a failed translate is reported in place (not silently back to the idle action)",
    /role="alert"/.test(failedHtml) && failedHtml.includes("the job failed") && failedHtml.includes("🌐 Translate to vi"), failedHtml.slice(0, 500));

  // ---- Detail: the language fetch, the untranslated branch, and the en fallback ----
  const info = { root: ROOT, title: "R", generated: true, hasSite: false, pageCount: 1, cardCount: 0, language: "en",
    sourceCommit: "0123456789abcdef", updatedAt: null, updateAvailable: false, head: null };
  const canonical = { ok: true, root: ROOT, title: "R", language: "en",
    pages: [{ id: "p1", parentId: null, order: 1, title: "Page One", description: "", filePaths: [], markdown: "# Page One" }], cards: [] };
  const translated = { ok: true, title: "R", language: "vi",
    pages: [{ id: "p1", parentId: null, order: 1, title: "Trang một", description: "", filePaths: [], markdown: "# Trang một" }], cards: [] };
  const jsonRes = (status, body) => ({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
  const urls = [];
  let wikiStatus = 200;
  const fetchImpl = function (url) {
    const u = String(url); urls.push(u);
    if (u.indexOf("/api/project") >= 0) return Promise.resolve(jsonRes(200, { ok: true, project: info }));
    if (u.indexOf("/api/wiki") >= 0) {
      const wantsLang = /[?&]lang=/.test(u);
      if (!wantsLang) return Promise.resolve(jsonRes(200, canonical));
      if (wikiStatus === 404) return Promise.resolve(jsonRes(404, { error: "no translation is available for this language", code: "translation-missing" }));
      if (wikiStatus === 500) return Promise.resolve(jsonRes(500, { error: "boom" }));
      return Promise.resolve(jsonRes(200, translated));
    }
    if (u.indexOf("/api/languages") >= 0) {
      return Promise.resolve(jsonRes(200, { ok: true, canonical: "en", languages: [{ tag: "vi", units: true }, { tag: "de", units: false }] }));
    }
    if (u.indexOf("/api/jobs") >= 0) return Promise.resolve(jsonRes(200, { ok: true, disabled: false, active: null, last: null }));
    return Promise.resolve(jsonRes(404, {}));
  };
  const fetchMod = loadClient(mkHookReact(hk), { fetch: function () { return fetchImpl.apply(null, arguments); } }, { localStorage: ls });
  fetchMod.apply({ effect: (fn) => fn(), locale: { register: () => () => {} }, slots: { inject: (_k, fn) => fn(), register: () => () => {} } });

  const renderDetail = async (states) => {
    hk.at = 0; hk.effects.length = 0; hk.states = states;
    const html = renderToStaticMarkup(React.createElement(fetchMod._test.Detail, {
      t, project: { root: ROOT, title: "R", generated: true }, back() {},
      catalog: { phase: "ready", models: [], failures: [], def: null }, model: { provider: "p", model: "m" }, onModel() {},
    }));
    const cleanups = hk.effects.map((fn) => fn());
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    cleanups.forEach((c) => { if (typeof c === "function") c(); });
    return html;
  };
  // Detail hook order: data, lang, sel, showSrc, q, open, menu, toast, useJobView, useLanguages
  const states = (data, lang, sel, jobView, langView) =>
    [data, lang, sel, false, "", Object.create(null), false, null, jobView, langView];

  urls.length = 0;
  wikiStatus = 404;
  const missHtml = await renderDetail(states(
    { phase: "ready", info, wiki: null, missing: true, error: null }, "vi", { type: "page", id: "p1" },
    { active: null, last: null, gate: { known: true, disabled: false, reason: "" } },
    { phase: "ready", tags: ["vi"], error: null }));
  check("detail: choosing a language re-fetches /api/wiki with lang=<tag>",
    urls.some((u) => u.indexOf("/api/wiki?root=C%3A%5CR&lang=vi") >= 0), urls.join(" | "));
  check("detail: a 404 translation-missing becomes the untranslated state, not a load error",
    hk.states[0].phase === "ready" && hk.states[0].missing === true && hk.states[0].wiki === null
    && !hk.states[0].error, JSON.stringify(hk.states[0]));
  check("detail: the untranslated state renders its message and the translate action for this tag",
    missHtml.includes("No translation in this language yet") && missHtml.includes("Translate to vi")
    && !missHtml.includes("Page One"), missHtml.slice(0, 500));
  check("detail: the language selector is in the detail header (crumb) and lists the translated tags",
    /class="dw-crumb"[\s\S]*dw-lang-select[\s\S]*vi — Tiếng Việt/.test(missHtml), missHtml.slice(0, 600));

  wikiStatus = 200;
  urls.length = 0;
  const trHtml = await renderDetail(states(
    { phase: "ready", info, wiki: translated, missing: false, error: null }, "vi", null,
    { active: null, last: null, gate: { known: true, disabled: false, reason: "" } },
    { phase: "ready", tags: ["vi"], error: null }));
  check("detail: a translated payload renders through the existing page/card path (same shape, no root)",
    hk.states[0].missing === false && !!hk.states[0].wiki && trHtml.includes("Trang một")
    && trHtml.includes("Overview") && urls.some((u) => u.indexOf("lang=vi") >= 0), trHtml.slice(0, 500));

  wikiStatus = 200;
  urls.length = 0;
  const enHtml = await renderDetail(states(
    { phase: "loading", info: null, wiki: null, missing: false, error: null }, "en", null,
    { active: null, last: null, gate: { known: true, disabled: false, reason: "" } },
    { phase: "ready", tags: ["vi"], error: null }));
  check("detail: en (the canonical choice) fetches without a lang parameter",
    urls.some((u) => u === "/dsh-wiki/api/wiki?root=C%3A%5CR")
    && !urls.some((u) => u.indexOf("/api/wiki") >= 0 && /[?&]lang=/.test(u))
    && !!hk.states[0].wiki && hk.states[0].wiki.title === "R" && enHtml.includes("Loading"),
    urls.join(" | "));

  wikiStatus = 500;
  await renderDetail(states(
    { phase: "loading", info: null, wiki: null, missing: false, error: null }, "vi", null,
    { active: null, last: null, gate: { known: true, disabled: false, reason: "" } },
    { phase: "ready", tags: ["vi"], error: null }));
  check("detail: any other translated-language failure is still a real error (not masked as untranslated)",
    hk.states[0].phase === "error" && hk.states[0].missing === false, JSON.stringify(hk.states[0]));

  // a persisted tag the Host no longer offers -> back to canonical en, stale value cleared
  store.clear();
  ls.setItem(fetchMod._test.LANG_STORE_PREFIX + ROOT, "de");
  wikiStatus = 200;
  await renderDetail(states(
    { phase: "loading", info: null, wiki: null, missing: false, error: null }, "de", null,
    { active: null, last: null, gate: { known: true, disabled: false, reason: "" } },
    { phase: "ready", tags: ["vi"], error: null }));
  check("detail: a persisted language the Host no longer lists falls back to en and clears the stored tag",
    hk.states[1] === "en" && !store.has(fetchMod._test.LANG_STORE_PREFIX + ROOT), JSON.stringify([hk.states[1], [...store.keys()]]));

  // ---- the refresh hook after a translate job ----
  check("refresh: a finished translate job refetches the language list through the existing poller",
    /previous === "running" && jobPhase !== "running"[\s\S]{0,400}finished\.action === "translate"\) refreshLanguages\(\)/.test(src)
    && /finished\.phase === "done"/.test(src) && /if \(previous === "running" && jobPhase !== "running"\) \{\s*load\(\);/.test(src));
  check("refresh: the translate action reuses the job POST with action:translate + targetLang",
    /startJob\("translate", tag\)/.test(src) && /action: action, targetLang: targetLang \|\| "en"/.test(src)
    && /postJson\(ROUTE \+ "\/api\/jobs"/.test(src));
  check("lang: no new network origin and no new window.open in the client",
    !/https?:\/\//.test(src) && (src.match(/window\.open\(/g) || []).length === 1);
}

console.log(FAILS.length ? `\n${FAILS.length} FAILED` : "\nALL PASS");
process.exit(FAILS.length ? 1 : 0);
