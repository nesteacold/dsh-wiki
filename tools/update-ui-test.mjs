// dsh-wiki 面板的版本卡片离线测试（spec 016 §3.6）：用真实 React 渲染卡片的每一个状态，
// 用假 fetch + 罐装 hook 状态驱动 useUpdateStatus / useUpdateApply，验证“只在用户动作时才请求”
// 和“安装成功只说需要重启插件”。用法：
//   node tools/update-ui-test.mjs <react 包目录> <react-dom 包目录>
// 没有 React 时打印 SKIP 并退出 0（与 client-smoke.mjs 相同的约定，无依赖的扫描里也是安全的）。
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import vm from "node:vm";
import { REASON_CODES } from "../lib/update.js";

const [reactDir, domDir] = process.argv.slice(2);
if (!reactDir || !domDir) { console.log("SKIP update UI test (pass react and react-dom dirs)"); process.exit(0); }
const req = createRequire(path.join(reactDir, "package.json"));
const React = req(reactDir);
const { renderToStaticMarkup } = createRequire(path.join(domDir, "package.json"))(path.join(domDir, "server"));

const FAILS = [];
const check = (n, ok, d = "") => { console.log((ok ? "PASS " : "FAIL ") + n + (ok ? "" : `  [${d}]`)); if (!ok) FAILS.push(n); };
const src = readFileSync(path.join(import.meta.dirname, "..", "lib", "client.js"), "utf8");
const flush = () => new Promise((r) => setTimeout(r, 0));

// ---------- 加载客户端模块 ----------
// 卡片是纯展示组件（没有 hook），所以可以带着真实 React 渲染；请求行为另用一份带罐装
// hook 状态的 React 驱动 —— 与 client-smoke.mjs 完全相同的两个手法。
const makeSandbox = (react, extra) => {
  const box = { mod: null };
  const sb = {
    window: {
      __ModuleLoader__: { load: (spec) => { box.mod = spec.factory((name) => {
        if (name === "react") return react;
        throw new Error("unexpected require " + name);
      }); } },
      dispatchEvent: () => true,
    },
    CustomEvent: function (type, init) { this.type = type; this.detail = (init && init.detail) || {}; },
    console, setTimeout, clearTimeout, Promise, Object, Array, String, Number, Math, Date, RegExp, JSON,
    ...extra,
  };
  vm.runInNewContext(src, sb);
  return box;
};
const applyNoop = (m) => m.apply({ effect: (fn) => fn(), locale: { register: () => () => {} },
  slots: { inject: (_k, fn) => fn(), register: () => () => {} } });

const mod = (() => {
  const box = makeSandbox(React, {});
  applyNoop(box.mod);
  return box.mod;
})();

const hk = { at: 0, states: [], effects: [] };
const fakeReact = {
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
const hookMod = (() => {
  const box = makeSandbox(fakeReact, { fetch: function () { return currentFetch.apply(null, arguments); } });
  applyNoop(box.mod);
  return box.mod;
})();

const DICT = mod._test.DICT;
const t = (k) => DICT.en[k] ?? k;
const jsonRes = (status, body) => ({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });

// ---------- 渲染与 DOM 断言的小工具 ----------
const render = (view, apply, onCheck, onUpdate) => renderToStaticMarkup(
  React.createElement(mod._test.VersionCard, { t, view, apply, onCheck: onCheck || (() => {}), onUpdate: onUpdate || (() => {}) }));
const textOf = (html) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const buttonsOf = (html) => [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
  .map((m) => ({ attrs: m[1], label: m[2].replace(/<[^>]*>/g, "").trim() }));
const findBtn = (html, label) => buttonsOf(html).find((b) => b.label === label);
// 主按钮按 class 找，不按标签找：安装中它的标签会变成 “Installing…”，禁用状态照样要断言
const primaryBtn = (html) => buttonsOf(html).find((b) => /class="dw-btn primary"/.test(b.attrs));
const isDisabled = (btn) => !!btn && /\sdisabled=""/.test(btn.attrs);
const ready = (raw) => ({ phase: "ready", status: mod._test.updateStatusFrom(raw) });
const IDLE = { phase: "idle", from: null, to: null, reason: null };
const ISO = "2026-11-11T05:34:00.000Z";
const LATEST = (v) => ({ version: v, checkedAt: ISO, source: "raw.githubusercontent.com" });
const RAW = {
  off: { ok: true, enabled: false, installed: { version: "0.3.0", installKind: "development-link" },
    latest: null, updateAvailable: false, canUpdate: false, reason: "update-disabled", reloadRequired: false },
  notChecked: { ok: true, enabled: true, installed: { version: "0.3.0", installKind: "install" },
    latest: null, updateAvailable: false, canUpdate: false, reason: null, reloadRequired: false },
  upToDate: { ok: true, enabled: true, installed: { version: "0.3.0", installKind: "install" },
    latest: LATEST("0.3.0"), updateAvailable: false, canUpdate: false, reason: null, reloadRequired: false },
  canUpdate: { ok: true, enabled: true, installed: { version: "0.3.0", installKind: "install" },
    latest: LATEST("0.4.0"), updateAvailable: true, canUpdate: true, reason: null, reloadRequired: false },
};
const blockedRaw = (code) => ({ ok: true, enabled: true, installed: { version: "0.3.0", installKind: "development-link" },
  latest: LATEST("0.4.0"), updateAvailable: true, canUpdate: false, reason: code, reloadRequired: false });

// 词汇表只有宿主一份（lib/update.js 导出的 REASON_CODES）。这里曾经手抄过一份 —— 抄本会在
// 宿主增删码时悄悄漂移，所以下面既按 SET 双向比对，也断言本文件里没有留下那份抄本。
// 探针拆成两段拼接：一条断言“源码里不含某个标识符”的检查，若把那个标识符原样写进来，自己就会失败。
const HAND_COPY = "SPEC_" + "REASONS";

// ================= 字典与构建约束 =================
{
  const en = DICT.en, zh = DICT.zh;
  const enKeys = Object.keys(en).sort(), zhKeys = Object.keys(zh).sort();
  const missingZh = enKeys.filter((k) => !Object.prototype.hasOwnProperty.call(zh, k));
  const missingEn = zhKeys.filter((k) => !Object.prototype.hasOwnProperty.call(en, k));
  check("dictionary: en and zh carry exactly the same keys (no half-translated version card)",
    enKeys.length === zhKeys.length && missingZh.length === 0 && missingEn.length === 0,
    JSON.stringify({ keyCounts: [enKeys.length, zhKeys.length], missingZh, missingEn }));
  check("dictionary: every new key is a version-card key (nothing leaked into other namespaces)",
    enKeys.filter((k) => /^upd\./.test(k)).length >= 20 && enKeys.filter((k) => /^upd\./.test(k)).every((k) => /^upd\./.test(k)),
    String(enKeys.filter((k) => /^upd\./.test(k)).length));

  const clientReasons = [...mod._test.UPDATE_REASONS];
  const hostReasons = [...REASON_CODES];
  const missingOnClient = hostReasons.filter((c) => clientReasons.indexOf(c) < 0);
  const missingOnHost = clientReasons.filter((c) => hostReasons.indexOf(c) < 0);
  check("reasons: the client's closed map is exactly the host vocabulary (both directions, no duplicates)",
    clientReasons.length === hostReasons.length && missingOnClient.length === 0 && missingOnHost.length === 0
    && new Set(clientReasons).size === clientReasons.length && new Set(hostReasons).size === hostReasons.length,
    JSON.stringify({ host: hostReasons, client: clientReasons, missingOnClient, missingOnHost }));
  // 第三个“手抄词汇表”的副本曾出现在这个文件里：读自身的源码，确认它没有回来。
  const selfSrc = readFileSync(new URL(import.meta.url), "utf8");
  check("reasons: the test holds no hand-copied vocabulary (only the host export is used)",
    !selfSrc.includes(HAND_COPY));
  const badSentences = [...hostReasons, "unknown"].filter((c) => {
    const s = en["upd.reason." + c], z = zh["upd.reason." + c];
    return typeof s !== "string" || !s.trim() || s === c || typeof z !== "string" || !z.trim();
  });
  check("reasons: every code (and the unknown fallback) has a fixed sentence in en + zh, never the raw token",
    badSentences.length === 0, JSON.stringify(badSentences));
  check("reasons: the sentences are distinct (no two codes collapse into one unreadable label)",
    new Set(hostReasons.map((c) => en["upd.reason." + c])).size === hostReasons.length
    && new Set(hostReasons.map((c) => zh["upd.reason." + c])).size === hostReasons.length);

  // §4.6：面板只渲染这些固定句子（updateReasonText 把未知码也映射到 upd.reason.unknown），所以句子里的
  // 一个路径没有任何别的闸门挡得住 —— 宿主侧的同一条规则已冻结在 tools/update-test.mjs:433。
  const PATH_SHAPED = /[\\/]/;
  const enReason = Object.keys(en).filter((k) => k.startsWith("upd.reason."));
  const zhReason = Object.keys(zh).filter((k) => k.startsWith("upd.reason."));
  const pathy = [...enReason.map((k) => ["en", k, en[k]]), ...zhReason.map((k) => ["zh", k, zh[k]])]
    .filter(([, , v]) => typeof v === "string" && PATH_SHAPED.test(v));
  const uncovered = [...REASON_CODES.map((c) => "upd.reason." + c), "upd.reason.unknown"]
    .filter((k) => !enReason.includes(k) || !zhReason.includes(k));
  check("reasons: no reason sentence contains a filesystem path (§4.6)",
    enReason.length > 0 && zhReason.length > 0 && enReason.length === zhReason.length
    && uncovered.length === 0 && pathy.length === 0,
    JSON.stringify({ enReasonKeys: enReason.length, zhReasonKeys: zhReason.length, uncovered, pathy }));

  check("build-free: lib/client.js has no import statement (DSH injects h and React)",
    !/^\s*import\b/m.test(src) && !/^\s*export\b/m.test(src));
  check("safety: no new network origin, no window.open, no dangerouslySetInnerHTML, no reload",
    !/https?:\/\//.test(src) && (src.match(/window\.open\(/g) || []).length === 1
    && !src.includes("dangerouslySetInnerHTML=") && !/location\.reload/.test(src));
  // 版本卡片的样式只用宿主 token：这三条规则里出现硬编码颜色就是错的
  const css = mod._test.CSS;
  const versionRules = css.split("\n").filter((line) => /^\.dw-version/.test(line));
  check("css: the version card uses theme tokens only (no hardcoded colours)",
    versionRules.length >= 2 && versionRules.every((r) => !/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(r))
    && versionRules.filter((r) => r.includes("--dsw-alias-")).length >= 2, versionRules.join(" | "));
  check("css: the card reuses the existing element vocabulary (.dw-jobrow, .dw-btn, .dw-badge, .dw-joberr, .dw-muted)",
    /^\.dw-version\{/m.test(css) && /^\.dw-version \.dw-badge\{/m.test(css) && /^\.dw-version \.dw-warn\{/m.test(css)
    && /h\("div", \{ className: "dw-jobrow" \}/.test(src) && /"dw-joberr", role: "alert"/.test(src));
}

// ================= 状态 1：loading =================
{
  const html = render({ phase: "loading", status: null }, IDLE);
  const text = textOf(html);
  check("loading: the first status request shows a checking line (never an empty card)",
    html.includes('class="dw-version"') && text.includes(t("upd.checking")), text);
  check("loading: both buttons are disabled while the first request is in flight",
    isDisabled(findBtn(html, t("upd.check"))) && isDisabled(findBtn(html, t("upd.update"))), text);
  check("loading: exactly the two card controls are rendered (Check + Update)",
    buttonsOf(html).length === 2 && !!findBtn(html, t("upd.check")) && !!findBtn(html, t("upd.update")));
}

// ================= 状态 2：enabled:false =================
{
  const html = render(ready(RAW.off), IDLE);
  const text = textOf(html);
  check("disabled: says checks are disabled AND how to enable them (update.enabled = true)",
    text.includes(t("upd.disabled")) && text.includes("update.enabled = true") && text.includes(t("upd.disabledHint")),
    text);
  check("disabled: the fact row shows the installed version and the development-link badge",
    text.includes("Installed v0.3.0") && text.includes(t("upd.devLink")) && html.includes('class="dw-badge"'), text);
  check("disabled: Check is disabled too — it is not a silent no-op button",
    isDisabled(findBtn(html, t("upd.check"))) && isDisabled(findBtn(html, t("upd.update"))), text);
  check("disabled: no 'not checked' line appears (it would be a lie while checks are off)",
    !text.includes(t("upd.notChecked")), text);
}

// ================= 状态 3：not checked yet =================
{
  const html = render(ready(RAW.notChecked), IDLE);
  const text = textOf(html);
  check("not checked: offers Check and says Not checked yet",
    text.includes(t("upd.notChecked")) && !isDisabled(findBtn(html, t("upd.check"))), text);
  check("not checked: Update is disabled (nothing to install was ever looked up)",
    isDisabled(findBtn(html, t("upd.update"))), text);
  check("not checked: no development-link badge for a real install",
    !text.includes(t("upd.devLink")) && !html.includes('class="dw-badge"'), text);
}

// ================= 状态 4：up to date =================
{
  const html = render(ready(RAW.upToDate), IDLE);
  const text = textOf(html);
  check("up to date: both versions are shown with the check time, and no Update action is enabled",
    text.includes("Installed v0.3.0") && text.includes("Latest v0.3.0") && /\b\d\d:\d\d\b/.test(text)
    && isDisabled(findBtn(html, t("upd.update"))), text);
  check("up to date: no reason sentence and no false 'up to date' claim about direction",
    !REASON_CODES.some((c) => text.includes(t("upd.reason." + c))) && !/up to date/i.test(text), text);
}

// ================= 状态 3b：检查失败（enabled，但 latest 为 null 且带原因） =================
{
  const failedCheck = { ok: true, enabled: true, installed: { version: "0.3.0", installKind: "install" },
    latest: null, updateAvailable: false, canUpdate: false, reason: "network-unavailable", reloadRequired: false };
  const html = render(ready(failedCheck), IDLE);
  const text = textOf(html);
  check("check failed: the reason is printed instead of pretending nothing happened",
    text.includes(t("upd.reason.network-unavailable")) && !text.includes(t("upd.notCheckedHint")), text);
  check("check failed: Check stays available to try again, Update stays disabled",
    !isDisabled(findBtn(html, t("upd.check"))) && isDisabled(findBtn(html, t("upd.update"))), text);
}

// ================= 状态 4b：本地比已发布版本还新（这台机器的真实状态） =================
{
  const aheadRaw = { ok: true, enabled: true, installed: { version: "0.3.0", installKind: "development-link" },
    latest: LATEST("0.2.0"), updateAvailable: false, canUpdate: false, reason: "latest-not-newer", reloadRequired: false };
  const html = render(ready(aheadRaw), IDLE);
  const text = textOf(html);
  check("ahead of upstream: both versions are shown and the latest-not-newer reason is explained",
    text.includes("Installed v0.3.0") && text.includes("Latest v0.2.0")
    && text.includes(t("upd.reason.latest-not-newer")) && isDisabled(findBtn(html, t("upd.update"))), text);
}

// ================= 状态 5：update available but blocked =================
{
  const html = render(ready(blockedRaw("install-is-development-link")), IDLE);
  const text = textOf(html);
  const sentence = t("upd.reason.install-is-development-link");
  check("blocked: shows the latest version and the reason as VISIBLE TEXT",
    text.includes("Latest v0.4.0") && text.includes(sentence), text);
  check("blocked: the reason is body text, not a tooltip",
    !new RegExp('title="[^"]*' + sentence.slice(0, 24).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(html));
  check("blocked: Update is disabled while Check stays available",
    isDisabled(findBtn(html, t("upd.update"))) && !isDisabled(findBtn(html, t("upd.check"))), text);
  check("blocked: the development link of this machine is shown as a badge, not as hidden state",
    text.includes(t("upd.devLink")), text);
}

// ================= 状态 6：can update =================
{
  const html = render(ready(RAW.canUpdate), IDLE);
  const text = textOf(html);
  check("can update: Update is enabled and labelled as its own action",
    !isDisabled(findBtn(html, t("upd.update"))) && !!findBtn(html, t("upd.update"))
    && t("upd.update") !== "Update", html);
  check("can update: both versions are visible and no refusal sentence is invented",
    text.includes("Installed v0.3.0") && text.includes("Latest v0.4.0")
    && !REASON_CODES.some((c) => text.includes(t("upd.reason." + c))), text);
}

// ================= 状态 7：in flight then applied =================
{
  const applying = render(ready(RAW.canUpdate), { phase: "applying", from: null, to: null, reason: null });
  check("in flight: the button says it is installing and no second action is possible",
    textOf(applying).includes(t("upd.applying")) && isDisabled(findBtn(applying, t("upd.applying")))
    && isDisabled(findBtn(applying, t("upd.check"))), textOf(applying));
  const applied = render(ready(RAW.canUpdate), { phase: "applied", from: "0.3.0", to: "0.4.0", reason: null });
  const text = textOf(applied);
  check("applied: reports from → to and that a reload is required",
    text.includes("0.3.0 → 0.4.0") && text.includes(t("upd.reload"))
    && /Reload the plugin to finish/.test(text), text);
  check("applied: never claims a restart happened, and Update cannot be pressed again",
    !/restart|restarted|reloaded the plugin|automatically/i.test(text)
    && isDisabled(findBtn(applied, t("upd.update"))), text);
  // 装好之后用户可能再按一次 Check：重启提示不能被“正在检查”挤掉（检查中由禁用按钮自己表达）
  const appliedChecking = render({ phase: "loading", status: mod._test.updateStatusFrom(RAW.canUpdate) },
    { phase: "applied", from: "0.3.0", to: "0.4.0", reason: null });
  check("applied: the reload instruction survives a follow-up check (it never flickers away)",
    textOf(appliedChecking).includes(t("upd.reload")) && textOf(appliedChecking).includes("0.3.0 → 0.4.0")
    && isDisabled(findBtn(appliedChecking, t("upd.check"))), textOf(appliedChecking));
  // 宿主自己带着 reloadRequired:true 回来（上一次安装还没重启）：面板重开也能说出来
  const pendingReload = render(ready({ ...RAW.upToDate, reloadRequired: true }), IDLE);
  check("applied: a status that still requires a reload says so after the panel is reopened",
    textOf(pendingReload).includes(t("upd.reload")) && textOf(pendingReload).includes(t("upd.applied")),
    textOf(pendingReload));
}

// ================= 状态 8：request failed =================
{
  let html = "", err = null;
  try { html = render({ phase: "error", status: null }, IDLE); } catch (e) { err = e; }
  const text = err ? "" : textOf(html);
  check("status failed: renders a readable error with role=alert instead of throwing",
    !err && /role="alert"/.test(html) && text.includes(t("upd.statusFailed")), err ? String(err.message || err) : text);
  check("status failed: the action becomes an explicit Retry, and Update stays disabled",
    !!findBtn(html, t("retry")) && !isDisabled(findBtn(html, t("retry")))
    && isDisabled(findBtn(html, t("upd.update"))), text);
  check("status failed: no spinner text is left behind and no Host text is printed",
    !text.includes(t("upd.checking")) && !/HTTP \d/.test(text), text);
}

// ================= 每一个 reason 码 → 固定句子，且绝不出现原始 token =================
{
  const leaks = [];
  const missing = [];
  for (const code of REASON_CODES) {
    const html = render(ready(blockedRaw(code)), IDLE);
    const text = textOf(html);
    if (!text.includes(t("upd.reason." + code))) missing.push(code);
    // 原始 token 一个字都不许出现在文本里（属性里也不行：卡片不给原因配 title）
    if (html.includes(code) || text.includes(code)) leaks.push(code);
    if (!isDisabled(findBtn(html, t("upd.update")))) missing.push(code + ":update-enabled");
  }
  check("reason map: every §3.5 code renders its own fixed sentence", missing.length === 0, JSON.stringify(missing));
  check("reason map: no raw reason token ever reaches the markup", leaks.length === 0, JSON.stringify(leaks));

  const unknownHtml = render(ready(blockedRaw("made-up-reason")), IDLE);
  const unknownText = textOf(unknownHtml);
  check("reason map: an unknown code renders the fixed fallback sentence, never the token",
    unknownText.includes(t("upd.reason.unknown")) && !unknownHtml.includes("made-up-reason"), unknownText);

  const nullHtml = render(ready(blockedRaw(null)), IDLE);
  check("reason map: a missing reason says the Host gave none instead of inventing one",
    textOf(nullHtml).includes(t("upd.noReason")), textOf(nullHtml));
}

// ================= Update 的启用规则：canUpdate 为 false 就一定是禁用 =================
{
  const fixtures = [
    ["disabled", ready(RAW.off)],
    ["not checked", ready(RAW.notChecked)],
    ["up to date", ready(RAW.upToDate)],
    ["blocked", ready(blockedRaw("install-dirty"))],
    ["loading", { phase: "loading", status: null }],
    ["status failed", { phase: "error", status: null }],
    ["applying", ready(RAW.canUpdate), { phase: "applying", from: null, to: null, reason: null }],
    ["applied", ready(RAW.canUpdate), { phase: "applied", from: "0.3.0", to: "0.4.0", reason: null }],
  ];
  const wrong = fixtures.filter(([, view, ap]) => !isDisabled(primaryBtn(render(view, ap || IDLE)))).map(([name]) => name);
  check("Update is disabled whenever canUpdate is false (delivered state, applied or in flight)",
    wrong.length === 0, JSON.stringify(wrong));

  // 矛盾载荷一律 fail closed：孤立的 canUpdate:true 不点亮按钮
  const contradictory = [
    mod._test.updateStatusFrom({ enabled: false, updateAvailable: true, canUpdate: true, latest: LATEST("0.4.0") }),
    mod._test.updateStatusFrom({ enabled: true, updateAvailable: false, canUpdate: true, latest: LATEST("0.3.0") }),
    mod._test.updateStatusFrom({ enabled: true, updateAvailable: true, canUpdate: true }),
    mod._test.updateStatusFrom({ enabled: true, updateAvailable: true, canUpdate: "true", latest: LATEST("0.4.0") }),
  ];
  check("status projection fails closed: canUpdate needs enabled + a newer latest + an explicit true",
    contradictory.every((s) => s.canUpdate === false), JSON.stringify(contradictory.map((s) => s.canUpdate)));
  const junk = mod._test.updateStatusFrom({ installed: "nope", latest: 7, reason: 42 });
  check("status projection survives a malformed payload (unknown install kind, no versions, no reason)",
    junk.installKind === "unknown" && junk.installedVersion === null && junk.latestVersion === null
    && junk.reason === null && junk.canUpdate === false, JSON.stringify(junk));
  check("status projection reads installKind only from the closed set",
    mod._test.updateStatusFrom({ installed: { installKind: "development-link" } }).installKind === "development-link"
    && mod._test.updateStatusFrom({ installed: { installKind: "install" } }).installKind === "install"
    && mod._test.updateStatusFrom({ installed: { installKind: "weird" } }).installKind === "unknown");
  check("check time: the card's clock is a compact local HH:mm, with — for unusable input",
    /^\d\d:\d\d$/.test(mod._test.fmtClock(ISO)) && mod._test.fmtClock(null) === "—"
    && mod._test.fmtClock("not a date") === "—");
}

// ================= Home 集成：卡片在 Home 里，且 Home 没有 fetch 也不炸 =================
{
  const catalog = { phase: "ready", def: { provider: "r9-fallback", model: "ds41" }, failures: [],
    models: [{ provider: "r9-fallback", model: "ds41", label: "DS41", providerLabel: "r9-fallback" }] };
  let html = "", err = null;
  try {
    html = renderToStaticMarkup(React.createElement(mod._test.Home,
      { t, open() {}, catalog, model: catalog.def, onModel() {} }));
  } catch (e) { err = e; }
  check("home: the version card is rendered on the panel's home screen",
    !err && html.includes('class="dw-version"') && textOf(html).includes(t("upd.title")), err ? String(err.message || err) : "");
  check("home: without a fetch global the card stays in its loading state instead of throwing",
    !err && textOf(html).includes(t("upd.checking")), err ? String(err.message || err) : textOf(html).slice(0, 200));
  check("home: the existing hero, model row and project grid are untouched (the card sits below the model row)",
    !err && textOf(html).includes("Turn code into Repo Wiki") && html.includes("dw-select")
    && html.indexOf('class="dw-select"') < html.indexOf('class="dw-version"')
    && textOf(html).includes("Loading…"), err ? String(err.message || err) : "");
}

// ================= 请求行为：一次挂载一次 GET，用户动作才再来一次 =================
const driveStatus = async (respond) => {
  const calls = [];
  currentFetch = (url, init) => { calls.push({ url: String(url), init: init || null }); return respond(String(url), init); };
  hk.at = 0; hk.effects.length = 0; hk.states = [];
  const r = hookMod._test.useUpdateStatus();
  const cleanups = hk.effects.map((fn) => fn());
  await flush();
  return { view: hk.states[0], refresh: r[1], calls, cleanups };
};
const driveApply = async (respond) => {
  const calls = [];
  currentFetch = (url, init) => { calls.push({ url: String(url), init: init || null }); return respond(String(url), init); };
  hk.at = 0; hk.effects.length = 0; hk.states = [];
  const r = hookMod._test.useUpdateApply();
  return { apply: () => hk.states[0], run: r[1], calls };
};

let mountResult = null;
{
  mountResult = await driveStatus(() => Promise.resolve(jsonRes(200, RAW.canUpdate)));
  const { view, refresh, calls, cleanups } = mountResult;
  const gets = calls.filter((c) => !c.init || !c.init.method || c.init.method === "GET");
  check("status: mounting the panel issues exactly one GET to the plugin-wide status route",
    gets.length === 1 && gets[0].url === "/dsh-wiki/api/update/status", JSON.stringify(calls.map((c) => c.url)));
  check("status: the status request carries no root and no query (the route is plugin-wide)",
    !/[?&]root=/.test(gets[0].url) && gets[0].url.indexOf("?") < 0, gets[0].url);
  check("status: mounting never POSTs (nothing is installed by opening the panel)",
    calls.every((c) => !c.init || c.init.method !== "POST"), JSON.stringify(calls.map((c) => (c.init || {}).method)));
  check("status: the projection keeps the host's facts (versions, availability, reason)",
    view.phase === "ready" && view.status.installedVersion === "0.3.0"
    && view.status.latestVersion === "0.4.0" && view.status.updateAvailable === true
    && view.status.canUpdate === true, JSON.stringify(view));

  // 不许轮询：等一个宏任务窗口后仍然只有那一次 GET
  await new Promise((r) => setTimeout(r, 30));
  check("status: the panel does not poll (still one GET after an idle window)", calls.length === 1,
    JSON.stringify(calls.map((c) => c.url)));

  await refresh();
  await flush();
  check("status: pressing Check issues exactly one more GET, and no POST",
    calls.length === 2 && calls[1].url === "/dsh-wiki/api/update/status"
    && calls.every((c) => !c.init || c.init.method !== "POST"), JSON.stringify(calls.map((c) => c.url)));
  cleanups.forEach((c) => { if (typeof c === "function") c(); });
}
{
  const { view } = await driveStatus(() => Promise.reject(new Error("host offline")));
  check("status: a network failure degrades to the error state without throwing",
    view.phase === "error" && view.status === null, JSON.stringify(view));
  check("status: the error state stores no Host text (it therefore cannot be printed)",
    Object.keys(view).sort().join(",") === "phase,status", JSON.stringify(Object.keys(view)));
}
{
  const { view } = await driveStatus(() => Promise.resolve(jsonRes(503, {})));
  check("status: a non-200 answer is also just the error state (readable, retryable)",
    view.phase === "error" && view.status === null, JSON.stringify(view));
}
{
  // 500 带一段宿主文本：面板不能把它背到任何地方
  const { view } = await driveStatus(() => Promise.resolve(jsonRes(500, { error: "cannot read C:\\secret\\package.json" })));
  const html = render(view, IDLE);
  check("status: a 500 with Host error text renders the fixed sentence, never that text",
    view.phase === "error" && !html.includes("secret") && !html.includes("package.json")
    && textOf(html).includes(t("upd.statusFailed")), textOf(html));
}

// ================= 安装：只在用户动作后 POST，body 只有确认 token =================
{
  const d = await driveApply(() => Promise.resolve(jsonRes(200, { ok: true, applied: true, from: "0.3.0", to: "0.4.0", reloadRequired: true })));
  const before = d.calls.length;
  check("update: creating the card sends no request at all (POST only follows a user action)", before === 0,
    JSON.stringify(d.calls.map((c) => c.url)));

  const out = await d.run();
  await flush();
  const posts = d.calls.filter((c) => c.init && c.init.method === "POST");
  check("update: pressing Update sends exactly one POST to the update route",
    posts.length === 1 && posts[0].url === "/dsh-wiki/api/update",
    JSON.stringify(d.calls.map((c) => [c.url, (c.init || {}).method])));
  const body = posts.length === 1 ? JSON.parse(posts[0].init.body) : null;
  check("update: the body is exactly the confirm token (no root, no path, no version)",
    !!body && Object.keys(body).join(",") === "confirm" && body.confirm === "install-update"
    && !/root|path|\\\\|[A-Za-z]:/.test(posts.length === 1 ? posts[0].init.body : "x"),
    posts.length === 1 ? posts[0].init.body : "no post");
  check("update: the request is JSON with the same content-type as the other panel POSTs",
    posts.length === 1 && /application\/json/.test((posts[0].init.headers || {})["content-type"] || ""),
    JSON.stringify(posts.length === 1 ? posts[0].init.headers : null));
  check("update: success records from → to and the applied phase from the Host answer",
    d.apply().phase === "applied" && d.apply().from === "0.3.0" && d.apply().to === "0.4.0" && !!out,
    JSON.stringify(d.apply()));
  const html = render(ready(RAW.canUpdate), d.apply());
  check("update: the applied card tells the owner to reload the plugin, and nothing else",
    textOf(html).includes("0.3.0 → 0.4.0") && textOf(html).includes("Reload the plugin to finish"),
    textOf(html));
}
{
  const HOST_SENTENCE = "the install directory is a development link";
  const d = await driveApply(() => Promise.resolve(jsonRes(409, { error: HOST_SENTENCE, code: "install-is-development-link" })));
  await d.run();
  await flush();
  const ap = d.apply();
  const html = render(ready(RAW.canUpdate), ap);
  const text = textOf(html);
  check("update refused: the fixed code sentence is shown and the raw code is not",
    ap.phase === "error" && ap.reason === "install-is-development-link"
    && text.includes(t("upd.reason.install-is-development-link"))
    && !html.includes("install-is-development-link"), text);
  check("update refused: the Host's own error text is never printed",
    !text.includes(HOST_SENTENCE), text);
  check("update refused: the failure line is an alert and the card stays usable",
    /role="alert"/.test(html) && !isDisabled(findBtn(html, t("upd.check"))), text);
}
{
  const d = await driveApply(() => Promise.reject(new Error("network down")));
  await d.run();
  await flush();
  const ap = d.apply();
  const html = render(ready(RAW.canUpdate), ap);
  check("update failed: a transport failure says the request did not complete (no invented outcome)",
    ap.phase === "error" && ap.reason === null
    && textOf(html).includes(t("upd.applyFailed"))
    && !textOf(html).includes(t("upd.reload")), textOf(html));
}

console.log(FAILS.length ? `\n${FAILS.length} FAILED` : "\nALL PASS");
process.exit(FAILS.length ? 1 : 0);
