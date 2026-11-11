// dsh-wiki — 纯本地 Repo Wiki（DeepWiki 式）宿主半区。
// 职责：注册 agent 技能（生成协议）、/wiki 命令、本机站点路由 /dsh-wiki。
// 只用 node 内建模块；宿主服务全部通过 ctx 名称解析，不直接 import DSH 包。
import { readFile, writeFile, rename, mkdir, lstat, realpath, open, readdir } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync, lstatSync, realpathSync, openSync, fstatSync, closeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execFile } from "node:child_process";
// 后台作业（spec 007）：作业管理器、journal store、worker guard 与 worker prompt 在 jobs.enabled=false
// （默认）时保持休眠——不构造、不落盘、不注册 preset；只有显式开启才接线。
import {
  createJobManager, JOB_ACTIONS, PUBLIC_ERROR_MESSAGES as PUBLIC_JOB_ERRORS, WORKER_PRESET_DEFINITION, WORKER_PRESET_ID,
  evaluateContentGate,
  isJsonContentType, isLoopbackHostname, isSameOrigin, normalizeCatalog, parseHostHeader, publicErrorCode, publicJobView,
  publicJournalState, readBoundedJson,
} from "./jobs.js";
import { openJournalStore } from "./journal-store.js";
import { assertCanonicalDir, identityOf } from "./fs-contain.js";
import { createWorkerGuard } from "./worker-guard.js";
import { buildTranslationPrompt, buildWorkerPrompt } from "./worker-protocol.js";
// 存活证明（spec 007 / T028）：每个宿主实例一份 host epoch 记录，裁决按“记录属主实例”分别求证。
// 它只回答“那条记录的宿主进程还在不在”，worker 是否停下依赖“workers 是宿主进程内子代理”这一假设
//（见 host-liveness.js 顶部；调用方不得把这句升级成更强的断言）。
import { acquireHostEpoch, proveEpochFor } from "./host-liveness.js";
// 知识面（spec 014）：wiki 作为 agent 的知识库——三个纯函数模块 + 五个原生工具定义。
// 二者都不 import 任何 DSH 包；工具定义是普通对象，宿主注册面靠 ctx.tools 按名取得。
import {
  cards as wikiCards, freshnessOf, getPage as wikiGetPage, impact as wikiImpact, parseSnapshot,
  search as wikiSearch,
} from "./wiki-knowledge.js";
import { buildToolDefinitions, computeFreshness, createGitProbe, registerWikiTools } from "./wiki-tools.js";
// 面板内版本检查与安全自更新（spec 016）。服务本身完全注入化（fetch/git/clock 都是接缝，见
// lib/update.js 顶部），所以测试不触网、不碰真实仓库；本文件只负责配置、HTTP 围栏、请求校验与公开投影。
import {
  CONFIRM_TOKEN as UPDATE_CONFIRM_TOKEN,
  REASON_MESSAGES as UPDATE_REASON_MESSAGES,
  createUpdateService,
} from "./update.js";

// 内部测试接缝（tools/harness-test.mjs 用它替换依赖并断言「默认什么都不构造」）。
// 生产路径只经由这个对象调用上面的实现，替换它不会改变默认行为。
export const __jobsInternals = { openJournalStore, createJobManager, createWorkerGuard, buildWorkerPrompt, buildTranslationPrompt };
// 第二个接缝只覆盖读盘入口：harness 用它注入一次 open 失败，证明路由回的是固定 JSON 错误形状，
// 而不是把 fs 异常抛给 Host。open 是所有受控读的入口（读路径只从**句柄**读字节，见 readContainedFile）。
export const __siteInternals = { open };
// 存活证明接缝（spec 007 / T028）：与 __jobsInternals 同样的规矩——生产路径只经过这个对象，
// 测试替换它不改变默认行为。
export const __livenessInternals = { acquireHostEpoch, proveEpochFor };
// 工具面接缝（spec 014 / T011）：与上面两个接缝同样的规矩——生产路径只经过这个对象调用实现，
// 测试替换它不改变默认行为（默认值就是真实实现）。
export const __wikiToolInternals = {
  createGitProbe, computeFreshness, registerWikiTools, buildToolDefinitions,
  parseSnapshot, search: wikiSearch, getPage: wikiGetPage, cards: wikiCards, impact: wikiImpact, freshnessOf,
};
// 更新服务接缝（spec 016 测试）：与上面几个接缝同规矩——生产路径只经由这个对象构造服务；
// 测试把注入的 fetchImpl/gitRunner 换成假实现（或整体换掉工厂）不改变默认行为。
export const __updateInternals = { createUpdateService, resolveInstallPath };

export const name = "dsh-wiki";
// inject 只列**硬依赖**。实测（asar 内 cordis lib/index.js 的 Fiber._refresh，2026-11-11）inject 是
// **全有全无**的：任一注入的服务没有实现，插件就被判为 INACTIVE，apply() 一次都不会被调用——skill、/wiki、
// 路由会一起消失；cordis 也没有 { required, optional } 形式。因此 tools **不**在这里：它在 apply() 里用
// ctx.get("tools") 惰性解析（同 profile 的 @deepseek-ai/dsh-tool-subagent 就是这样取 llm，llm 同样不在它的
// inject 里）。没有 tools 服务的 Host 于是只少五个工具，其余表面照旧。
export const inject = ["skills", "commands", "webServer"];

const NS = "dsh-wiki";
const ROUTE = "/dsh-wiki";
// host epoch 记录所在的子目录，位于 journal store 目录内部（spec 007 / T028）。
const HOST_EPOCH_DIRNAME = "host-epoch";
const REGISTRY_VERSION = 1;
// 临时发布闸门（reviewer 2026-11-09）：后台作业在文件系统隔离与恢复评审通过前关闭。
// 客户端拿到 503 / disabled 后应禁用「后台 generate/update」，改走会话内 /wiki generate。
const JOBS_DISABLED_MESSAGE = "Background wiki jobs are disabled pending filesystem isolation and recovery review";
// 作业请求体上限：一个 { root, action, model, targetLang } 远小于此。
const JOB_BODY_LIMIT_BYTES = 32 * 1024;
// 客户端可见的错误：稳定 code + 固定短句，表与投影都在 jobs.js（PUBLIC_ERROR_MESSAGES / publicJobView）。
// storeDir、staging/journal 路径、provider/builder stderr 一律只进 logger，绝不进 HTTP 响应体。
/** 作业请求（POST /api/jobs*）允许的字段：本切片不认识的字段一律显式拒绝，绝不静默丢弃。 */
const JOB_REQUEST_FIELDS = Object.freeze({
  [`${ROUTE}/api/jobs`]: new Set(["root", "action", "model", "targetLang", "incremental"]),
  [`${ROUTE}/api/jobs/cancel`]: new Set(["root"]),
  [`${ROUTE}/api/jobs/recovery-execute`]: new Set(["root", "confirm"]),
});
// 恢复执行只认这个字面量：没有它，路由既不执行计划也不撤销内存栅栏（只带 root 的请求永远如此）。
const RECOVERY_EXECUTE_CONFIRM = "execute-recovery";
// status 与 code 的公开投影（reviewer 2026-11-10）：publicErrorCode 只是“token 形状”正则，不认识的
// hex/内部标识符同样匹配，会被原样带出——8 键投影限制的是属性名，不是值。本路由因此改用显式
// allowlist：只有这里列出的值可以原样公开，其余（含缺省）一律落到文档化的 fallback，绝不反射
// 管理器/调用方的输入。
const STATUS_ALLOWED = Object.freeze(new Set([
  "executed", "planned", "refused", "no-record", "execute-failed", "error",
]));
// ---------- 恢复计划码（生产者：lib/journal.js 的 planRecovery） ----------
// POST /api/jobs/recovery-execute 把计划器的 `code` 原样带出（执行器每个返回点都是 `code: plan.code`），
// 所以这条路由需要**规划器的整个值域**；漏一个成员不是安全漏洞，但会把一次成功的恢复报成
// internal-error，让「无事可做」和「宿主坏了」在响应里无法区分。
//
// 为什么列在这里而不是 import 进来：journal.js 的导出面被 tools/journal-test.mjs 钉死为九个名字
// （那条断言守的是「没有任何导出能让调用方自己给记录发牌」），新增导出会破坏它。所以这是唯一一份副本，
// 由 tools/recovery-code-projection-test.mjs 从**生产者源码**重算后逐项比对：规划器多一个码或这里多
// 一个码，测试都失败。模板码按规划器自己的绑定展开，不抄具体值：终止相位来自它 terminal 分支的相位
// 绑定，artifact 家族来自它三个观测 helper 的调用实参。
const TERMINAL_PLAN_PHASES = Object.freeze(["rolled-back", "aborted"]);
const TERMINAL_PLAN_CODE_SUFFIXES = Object.freeze(["-clean", "-staging", "-staging-already-removed"]);
// `missing(...)` 只被这两个 artifact 调用；`live-missing` 是它旁边分支的字面量码，所以只出现一次。
const OBSERVED_ARTIFACTS = Object.freeze(["staging", "live", "backup"]);
const ABSENT_ARTIFACTS = Object.freeze(["staging", "backup"]);
/** planRecovery 能返回的每一个 code（冻结）。与生产者源码的对账在投影测试里。 */
const PLAN_CODES = Object.freeze([
  // planRecovery 的 `return result(...)` 字面量码，按源码顺序。
  "worker-alive",
  "worker-liveness-unknown",
  "worker-proof-missing",
  "worker-proof-session-id-only",
  "worker-proof-not-independent",
  "root-observation-unknown",
  "root-missing",
  "root-identity-mismatch",
  "artifact-observation-unknown",
  "pre-mutation",
  "transaction-incomplete",
  "publication-not-started",
  "crash-between-renames",
  "live-missing",
  "publication-incomplete",
  "rollback-gap",
  "published-live-missing",
  "published",
  "backup-already-removed",
  "stale-backup",
  // `${artifact}-identity-drift` / `unexpected-${artifact}` / `${artifact}-missing` 三个 helper。
  ...OBSERVED_ARTIFACTS.map((artifact) => `${artifact}-identity-drift`),
  ...OBSERVED_ARTIFACTS.map((artifact) => `unexpected-${artifact}`),
  ...ABSENT_ARTIFACTS.map((artifact) => `${artifact}-missing`),
  // 终止分支：`${terminal}-clean` / `${terminal}-staging` / `${terminal}-staging-already-removed`。
  ...TERMINAL_PLAN_PHASES.flatMap((terminal) => TERMINAL_PLAN_CODE_SUFFIXES.map((suffix) => `${terminal}${suffix}`)),
]);
// code 是**闭合**的公开集合：本路由会如实公开的每一个 code 都在这里，名单之外一律收敛为
// internal-error（fail closed）。两个来源：
//   1. 规划器的返回码 —— 上面的 PLAN_CODES，执行器每个返回点原样带出；
//   2. 本路由自己的接线/执行拒绝码 —— 恢复执行真的会返回的那些（别的路由/别的作业阶段的拒绝码不属于它）。
// 注意 storeCode() 取的是 `error.code` 原文，不是闭集：store/fs 层的内部错误码（如 scan-link、
// record-invalid）不属于公开契约，因此仍按名单外处理。PLAN_CODES 由
// tools/recovery-code-projection-test.mjs 从生产者源码重算比对。
const CODE_ALLOWED = Object.freeze(new Set([
  "job-active", "worker-not-stopped", "root-not-allowed", "no-record", "refused", "no-action",
  "plan-not-executed", "record-replaced", "record-not-terminal", "worker-not-proven-stopped",
  "verify-failed", "execute-failed", "journal-store-unavailable", "journal-store-locked",
  "journal-not-terminal", "journal-commit-uncertain", "journal-live-move-uncertain", "internal-error",
  // 恢复执行的两种“接线不对”：未钉死的 store 没有显式 recovery:true，或覆盖的 store 形状不可用。
  "recovery-not-declared", "recovery-store-invalid",
  // 规划器的全部返回码（上面的冻结列表）。
  ...PLAN_CODES,
]));
// releaseReason 只描述“为什么没有释放”：它没有 internal-error 这一说，所以 fallback 是 null。
// `reconciled` 是成功路径（栅栏真的撤销了），`no-fence` 是“这个 root 本来就没有栅栏”——两者都必须
// 如实带出，否则“恢复了”和“宿主坏了”在响应里无法区分。
const RELEASE_REASON_ALLOWED = Object.freeze(new Set([
  "job-active", "no-action", "plan-not-executed", "record-replaced", "record-not-terminal",
  "worker-not-proven-stopped", "execute-failed", "verify-failed",
  "no-fence", "reconciled",
]));
// releaseCode 与 code 是同一张表（任务规定的集合）；语义不同，所以单独命名再去引用它。
const RELEASE_CODE_ALLOWED = CODE_ALLOWED;

/** 必选字段投影：不认识的值（含缺省）-> fallback（status 缺省即 "error"）。 */
const projectAllowedValue = (value, allowed, fallback) => (
  typeof value === "string" && allowed.has(value) ? value : fallback
);

/** 可选字段投影：缺省/null/空串 => null；给了但不认识 -> fallback（绝不回显原值）。 */
const projectOptionalValue = (value, allowed, fallback) => (
  value === undefined || value === null || value === ""
    ? null
    : (typeof value === "string" && allowed.has(value) ? value : fallback)
);
// 恢复执行的公开投影接缝（tools/recovery-code-projection-test.mjs）：测试要从**生产者源码**重算
// code/releaseReason 的取值面，再证明名单外的值仍然 fail closed。不导出这些引用，测试就只能自己
// 再抄一份 allowlist 去自证——那种断言永远通过，正是本缺陷要关掉的类。与上面三个接缝同规矩：
// 只读引用，替换它不改变默认行为。
export const __recoveryProjectionInternals = {
  statusAllowed: STATUS_ALLOWED,
  planCodes: PLAN_CODES,
  codeAllowed: CODE_ALLOWED,
  releaseCodeAllowed: RELEASE_CODE_ALLOWED,
  releaseReasonAllowed: RELEASE_REASON_ALLOWED,
  projectAllowedValue,
  projectOptionalValue,
};
/**
 * 把任意内部异常映射成稳定的公开错误体：{ status, code, error }。
 * status/code 来自 JobError（保持原映射），message 只取固定短句；完整细节由调用方写入 logger。
 * @returns {{status: number, code: string, error: string}}
 */
function publicJobError(error, fallbackStatus = 500) {
  const rawStatus = Number.isInteger(error?.status) ? error.status : null;
  // 只有自带 4xx/5xx status 的结构化错误（JobError）才保留自己的 status/code；其余（含 fs 的
  // EACCES/ENOENT 之类）一律收敛成内部错误，绝不把实现细节当作公开契约。
  const structured = rawStatus !== null && rawStatus >= 400 && rawStatus <= 599;
  const status = structured ? rawStatus : fallbackStatus;
  const code = structured && typeof error?.code === "string" && error.code
    ? publicErrorCode(error.code)
    : (status >= 500 ? "internal-error" : "request-refused");
  const message = PUBLIC_JOB_ERRORS[code]
    ?? (status >= 500 ? PUBLIC_JOB_ERRORS["internal-error"] : PUBLIC_JOB_ERRORS["request-refused"]);
  return { status, code, error: message };
}

// ---------- 作业请求字段校验（T011） ----------
// targetLang 省略 = 规范 en；显式给出的值绝不被静默归一化：
//   类型/格式非法（null、""、数字、对象、控制字符、超长、非 BCP 47）=> 400
//   结构合法但本切片不支持的 locale / translate => 501
const LANG_TAG_RE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;
const LANG_TAG_MAX = 35;
const ROOT_MAX = 4096;
const MODEL_TOKEN_MAX = 256;
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;
const isCanonicalToken = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max
  && value === value.trim() && !CONTROL_CHARS_RE.test(value);
const refused = (status, code) => ({ ok: false, status, code, error: PUBLIC_JOB_ERRORS[code] });

function validateJobRequest(value, pathname) {
  if (!Object.hasOwn(value, "root") || typeof value.root !== "string" || value.root.length === 0
    || value.root.length > ROOT_MAX || CONTROL_CHARS_RE.test(value.root) || !path.isAbsolute(value.root)) {
    return refused(400, "invalid-root");
  }
  const root = value.root;
  if (pathname === `${ROUTE}/api/jobs/cancel`) return { ok: true, value: { root } };
  if (!Object.hasOwn(value, "action") || typeof value.action !== "string" || !JOB_ACTIONS.includes(value.action)) {
    return refused(400, "invalid-action");
  }
  if (!Object.hasOwn(value, "model") || !isPlainRecord(value.model)
    || !isCanonicalToken(value.model.provider, MODEL_TOKEN_MAX) || !isCanonicalToken(value.model.model, MODEL_TOKEN_MAX)) {
    return refused(400, "invalid-model");
  }
  // 增量（spec 013 §2.1）：只有 update 接受它，非布尔值、首建与翻译都在这里显式拒绝，绝不静默归一化，
  // 也绝不在后面悄悄降级成全量重建。基线/diff 的 409 拒绝在路由里（需要读盘与 git），这一次只看形状。
  let incremental = false;
  if (Object.hasOwn(value, "incremental")) {
    if (typeof value.incremental !== "boolean") return refused(400, "invalid-incremental");
    if (value.incremental === true) {
      if (value.action === "generate") return refused(400, "incremental-not-for-generate");
      if (value.action === "translate") return refused(400, "incremental-not-for-translate");
      incremental = true;
    }
  }
  // translate 是唯一接受非 en 语言的动作：targetLang 缺失或为 en 都是 400，绝不当成 generate。
  const translate = value.action === "translate";
  let targetLang = "en";
  if (Object.hasOwn(value, "targetLang")) {
    const raw = value.targetLang;
    if (typeof raw !== "string" || raw.length === 0 || raw.length > LANG_TAG_MAX || !LANG_TAG_RE.test(raw)) {
      return refused(400, "invalid-target-lang");
    }
    if (translate) {
      if (raw === "en") return refused(400, "invalid-target-lang");
    } else if (raw !== "en") {
      return refused(501, "language-unsupported");
    }
    targetLang = raw;
  } else if (translate) {
    return refused(400, "invalid-target-lang");
  }
  return {
    ok: true,
    value: { root, action: value.action, model: { provider: value.model.provider, model: value.model.model }, targetLang, incremental },
  };
}
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
let activeLocale = "en";
const t = (key) => LOCALE[activeLocale]?.[key] ?? LOCALE.en[key] ?? key;

// 后台作业默认值（spec 007）：enabled=false 是发布闸门，任何默认值都不得打开它。
const JOB_DEFAULTS = Object.freeze({
  enabled: false,
  // null => <profile home>/dsh-wiki/journal（在任何 allowlist 项目根之外）
  storeDir: null,
  // 一次 worker dispose 的上限；jobs.js 缺省时退回它自己的 idle grace
  disposeTimeoutMs: 15000,
  presetId: WORKER_PRESET_ID,
});
const JOB_TIMEOUT_MAX_MS = 60 * 60 * 1000;
// 面板内版本检查与安全自更新默认值（spec 016）：enabled=false 是默认面——关闭时插件仍然不发任何
// 外发请求，版本状态照常回答。网络是显式选择，不是默认行为。
const UPDATE_DEFAULTS = Object.freeze({ enabled: false });
// 更新请求体只可能是 { confirm: "install-update" }，远小于此。
const UPDATE_BODY_LIMIT_BYTES = 4 * 1024;

const DEFAULT_CONFIG = {
  wikiDirName: ".dsh-wiki", wikiRoots: [],
  // 面板内后台作业（spec 007）：python 解释器与各项超时都由配置覆盖，测试用短超时
  pythonPath: undefined, jobTimeoutMs: 45 * 60 * 1000, buildTimeoutMs: 10 * 60 * 1000,
  selfcheckTimeoutMs: 10 * 60 * 1000, pollMs: 500,
  jobs: JOB_DEFAULTS,
  update: UPDATE_DEFAULTS,
};
const cleanRoots = (roots) =>
  Array.isArray(roots) ? roots.filter((r) => typeof r === "string" && path.isAbsolute(r)) : [];

const normalize = (p) => (p.endsWith(path.sep) ? p.slice(0, -1) : p);

/**
 * 每次 apply 的宿主实例标识。它必须同时满足 journal-store 的 token 规则
 * `/^[A-Za-z0-9][A-Za-z0-9._-]*$/`（openJournalStore 会把它钉进每条记录）；
 * 冒号是**非法**字符——`dsh-wiki:<uuid>` 会让 openJournalStore 以 invalid-options 拒绝，
 * 整个作业运行时随构造失败。因此分隔符用 "."，唯一性由 randomUUID 保证。
 */
export function makeHostInstanceId() {
  return `dsh-wiki.${globalThis.crypto.randomUUID()}`;
}

// ---------- 配置校验 ----------
// cordis 只用 Standard Schema 接口校验插件配置（runtime.Config["~standard"].validate），schemastery 是
// 官方实现。但本插件通常以「链接目录」安装：裸 import '@deepseek-ai/schemastery' 在仓库路径和 profile
// 符号链接下都解析不到（实测 ERR_MODULE_NOT_FOUND），静态 import 会让模块整个加载失败、并打断
// tools/harness-test.mjs。因此 schema 只在能解析到时挂上；解析不到时 normalizeJobConfig() 对同一批字段
// 做同样的拒绝，非法配置依旧不会被接受（只是拒绝点从 Loader 移到 apply）。
const Schema = await (async () => {
  try {
    const mod = await import("@deepseek-ai/schemastery");
    return typeof mod?.default?.object === "function" ? mod.default : null;
  } catch {
    return null;
  }
})();

export const Config = Schema
  ? Schema.object({
      // 【固定】wiki 输出目录名（仓库相对）
      wikiDirName: Schema.string().default(DEFAULT_CONFIG.wikiDirName),
      // 【固定】额外 wiki 根（绝对路径）；会话工作区及其兄弟/子目录自动发现
      wikiRoots: Schema.array(Schema.string()).default([]),
      pythonPath: Schema.string(),
      jobTimeoutMs: Schema.natural().default(DEFAULT_CONFIG.jobTimeoutMs),
      buildTimeoutMs: Schema.natural().default(DEFAULT_CONFIG.buildTimeoutMs),
      selfcheckTimeoutMs: Schema.natural().default(DEFAULT_CONFIG.selfcheckTimeoutMs),
      pollMs: Schema.natural().default(DEFAULT_CONFIG.pollMs),
      // 【固定】面板内后台作业（spec 007）。默认关闭：开启前必须通过 T018–T020 闸门。
      jobs: Schema.object({
        enabled: Schema.boolean().default(JOB_DEFAULTS.enabled),
        // null => <profile home>/dsh-wiki/journal；只接受绝对路径
        storeDir: Schema.union([Schema.string(), Schema.const(null)]).default(null),
        disposeTimeoutMs: Schema.natural().min(1).max(JOB_TIMEOUT_MAX_MS).default(JOB_DEFAULTS.disposeTimeoutMs),
        // 【固定】worker 的 preset id 不可配置：注册与挂载必须是同一个 id（normalizeJobConfig 拒绝其它值）。
        presetId: Schema.string().min(1).default(JOB_DEFAULTS.presetId),
      }).default({}),
      // 【固定】面板内版本检查与安全自更新（spec 016）。默认关闭：开启前不发出任何外发请求。
      update: Schema.object({
        enabled: Schema.boolean().default(UPDATE_DEFAULTS.enabled),
      }).default({}),
    })
  : undefined;

const isPlainRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * jobs 配置的显式校验，规则与上面的 Config schema 一致：schema 不可用时配置错误同样被拒绝。
 * presetId 只允许固定值：注册（register(WORKER_PRESET_DEFINITION)）与挂载（mount）必须指向同一个
 * preset；允许配置改 id 就等于允许把 worker 挂到另一个（可能无关或缺失的）preset 上。
 * @returns {{enabled: boolean, storeDir: string|null, disposeTimeoutMs: number, presetId: string}}
 */
function normalizeJobConfig(raw) {
  // null 与缺省等价（schemastery 也把 null 当作「用默认值」）。
  const value = raw === undefined || raw === null ? {} : raw;
  if (!isPlainRecord(value)) throw new TypeError("dsh-wiki: config.jobs must be an object");
  const enabled = value.enabled ?? JOB_DEFAULTS.enabled;
  if (typeof enabled !== "boolean") throw new TypeError("dsh-wiki: config.jobs.enabled must be a boolean");
  const storeDir = value.storeDir ?? JOB_DEFAULTS.storeDir;
  if (storeDir !== null && (typeof storeDir !== "string" || storeDir.length === 0
    || !path.isAbsolute(storeDir) || storeDir.includes("\u0000"))) {
    throw new TypeError("dsh-wiki: config.jobs.storeDir must be null or an absolute path");
  }
  const disposeTimeoutMs = value.disposeTimeoutMs ?? JOB_DEFAULTS.disposeTimeoutMs;
  if (!Number.isSafeInteger(disposeTimeoutMs) || disposeTimeoutMs < 1 || disposeTimeoutMs > JOB_TIMEOUT_MAX_MS) {
    throw new TypeError(`dsh-wiki: config.jobs.disposeTimeoutMs must be an integer from 1 to ${JOB_TIMEOUT_MAX_MS}`);
  }
  const presetId = value.presetId ?? JOB_DEFAULTS.presetId;
  if (typeof presetId !== "string" || presetId.trim().length === 0 || presetId.length > 128) {
    throw new TypeError("dsh-wiki: config.jobs.presetId must be a non-empty string of at most 128 characters");
  }
  if (presetId.trim() !== WORKER_PRESET_ID) {
    throw new TypeError(`dsh-wiki: config.jobs.presetId is fixed to "${WORKER_PRESET_ID}"; the worker preset identity cannot be overridden`);
  }
  return { enabled, storeDir, disposeTimeoutMs, presetId: WORKER_PRESET_ID };
}

/**
 * 安装路径（spec 016 §3.2 / §3.4.3）：ESM loader 把模块解析到 realpath，所以从插件内部看不到 profile 里的
 * 安装链接（path.resolve(libDir, "..") 只是开发树）。候选路径按两种布局收集，顺序固定：
 *   1. <profileContext.home>/node_modules/@dsh-ext/dsh-wiki（包直接装在 data root 的布局）；
 *   2. <profileContext.home>/profiles/<name>/node_modules/@dsh-ext/dsh-wiki（本机实测布局：每个 profile
 *      各有一份 node_modules，data root 下没有 node_modules）。
 * 只有 `lstat` 成功的候选才算存在——符号链接也算存在，§3.4.3 正是**要拒绝**它，但必须先找到它；这一步
 * 不跟随链接。真正判定“是不是我们这一份”的是 realpath：候选的 realpath 必须等于模块根的 realpath。
 * 开发链接的 realpath 就是加载模块的开发树（= moduleRoot），真实安装的 realpath 就是安装目录本身
 *（模块正是从那里加载的），两种布局因此都成立；而同名却指向别处的包不会被误认成我们的安装。多个 profile
 * 同时匹配时按排序取第一个，结果不依赖 readdir 的返回顺序。
 *
 * **绝不回退到模块根（fail closed）**：模块根本身是开发树（或经链接解析出的真实安装），把它当安装路径会
 * 绕过 §4.2 的链接检查，让开发树变成可写目标。所以没有匹配、profile home 不可用（缺失、空、非字符串、
 * 相对路径）、或模块根无法 realpath 时一律返回 null；服务据此回答 installKind:"unknown" +
 * install-not-found，并且零 git 调用、零联网。模块根在这里只参与一次 realpath 比较，既不是 lstat 目标，
 * 也不是 git cwd，更不是写目标（`installed.version` 的只读来源由服务自己读）。
 * @param {unknown} home profileContext.home
 * @param {unknown} moduleRoot 本模块根（ESM 只暴露 realpath，开发链接正是靠它匹配）
 * @param {{ lstat?: Function, readdir?: Function, realpath?: Function }} [deps] 仅测试接缝：默认真实 fs
 * @returns {string|null}
 */
function resolveInstallPath(home, moduleRoot, deps = {}) {
  const seam = deps ?? {};
  const lstat = seam.lstat ?? lstatSync;
  const readdir = seam.readdir ?? readdirSync;
  const realpath = seam.realpath ?? realpathSync;
  if (typeof home !== "string" || home.length === 0 || !path.isAbsolute(home)) return null;
  if (typeof moduleRoot !== "string" || moduleRoot.length === 0) return null;
  const candidates = [path.join(home, "node_modules", "@dsh-ext", "dsh-wiki")];
  try {
    for (const entry of readdir(path.join(home, "profiles"))) {
      candidates.push(path.join(home, "profiles", String(entry), "node_modules", "@dsh-ext", "dsh-wiki"));
    }
  } catch {
    // 没有 profiles 目录（或不可读）=> 只保留布局 1 的候选；这不是错误。
  }
  const existing = candidates.filter((candidate) => {
    try {
      lstat(candidate);
      return true;
    } catch {
      return false;
    }
  });
  if (existing.length === 0) return null;
  let moduleRealPath;
  try {
    moduleRealPath = realpath(moduleRoot);
  } catch {
    return null; // 模块根不可 realpath => 无法证明任何候选就是我们这一份
  }
  // 排序只为一件事：多个 profile 同时匹配时选哪个是确定的，而不是随 readdir 顺序变化。
  for (const candidate of [...existing].sort()) {
    try {
      if (realpath(candidate) === moduleRealPath) return candidate;
    } catch {
      // 候选 realpath 不可用（断链等）=> 不是匹配项，继续看下一个。
    }
  }
  return null;
}

/** storeDir 默认值：<profileContext.home>/dsh-wiki/journal；拿不到 profile home 时返回 null（=> fail closed）。 */
function resolveJobStoreDir(configured, ctx) {
  if (configured) return path.resolve(configured);
  const home = ctx.get?.("profileContext")?.home;
  const base = typeof home === "string" && home.length > 0
    ? home
    : typeof process.env.DSH_HOME === "string" && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : null;
  return base ? path.join(base, NS, "journal") : null;
}

/**
 * update 配置的显式校验（spec 016 §3.1），规则与上面的 schema 一致：schema 不可用时配置错误同样被拒绝。
 *
 * 与 normalizeJobConfig 有一处刻意的差异：**未知键被拒绝**。§3.1 只允许 `enabled` 一个键，仓库/分支/
 * 超时/字节上限都固定不可配；静默忽略未知键会把“我以为某个开关能改”的误解留在配置里，而这几个开关
 * 每一个都会扩大网络或写盘面。所以多一个键就是配置错误。
 * @returns {{enabled: boolean}}
 */
function normalizeUpdateConfig(raw) {
  // null 与缺省等价（schemastery 也把 null 当作「用默认值」）。
  const value = raw === undefined || raw === null ? {} : raw;
  if (!isPlainRecord(value)) throw new TypeError("dsh-wiki: config.update must be an object");
  const unknownKeys = Object.keys(value).filter((key) => key !== "enabled");
  if (unknownKeys.length > 0) {
    throw new TypeError(`dsh-wiki: config.update has unsupported key "${unknownKeys[0]}"; only "enabled" may be configured`);
  }
  const enabled = value.enabled ?? UPDATE_DEFAULTS.enabled;
  if (typeof enabled !== "boolean") throw new TypeError("dsh-wiki: config.update.enabled must be a boolean");
  return { enabled };
}

// ---------- 请求信任围栏：只放行回环 Host（桌面端绑定 127.0.0.1） ----------
// Host 头按 URI 语法解析（parseHostHeader）：方括号 IPv6 `[::1]:port` 必须被识别为回环，
// 而 `::1` 这种未加方括号的写法是非法 Host，直接拒绝。这里只做“请求来自回环接口”的判断，
// 不是调用方身份认证（见 jobs.js isSameOrigin 的说明）。
function isLoopbackRequest(req) {
  const parsed = parseHostHeader(req.headers?.host);
  return parsed !== null && isLoopbackHostname(parsed.hostname);
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
// 请求体被放弃（413/408/中止）之后，socket 只能在响应 flush **之后**关闭：readBoundedJson 不再
// destroy 请求（在同一 socket 上写响应之前 destroy，chunked 请求没有 content-length，对端拿到的
// 是 ECONNRESET 而不是响应体——review 实测 handler=413 destroyed=true => peer-error=ECONNRESET）。
// 这里用 `finish`（字节已交给内核）而非 `close`，所以 413/408 的 JSON 体一定先发出去。
function closeAfterResponse(req, res) {
  res.once("finish", () => { try { req.destroy(); } catch { /* already closed */ } });
}

// ---------- 受控读的固定拒绝形状（reviewer 2026-11-10 defect） ----------
// 词法路径授权 + 普通 readFile 会被 junction/symlink 骗过：仓库内容是攻击者可控的，`.dsh-wiki`
// 或它的任何一级链接都能把读重定向到仓库之外，而且不需要任何 race。因此每个读路径先证明
// 「规范项目根 + 逐级无链接 + 普通文件 + 打开后的句柄身份」，失败时只回下面这几个固定体：
// 真实路径、realpath 与 fs 异常文本一律不进响应体。
const UNSAFE_PATH = Object.freeze({
  code: "unsafe-path",
  error: "the requested path is not a regular file inside a trusted project",
});
const UNKNOWN_PROJECT = Object.freeze({ code: "unknown-project", error: "unknown project root" });
// 翻译缺失（T017a）：locale 目录或它的 wiki.json 不存在时**唯一**可见的 404 形状。
// 短句与其它公开错误同表（jobs.js），因此这里不留第二份文字。
const TRANSLATION_MISSING = Object.freeze({ code: "translation-missing", error: PUBLIC_JOB_ERRORS["translation-missing"] });
// 目标不存在（或路径中途不是目录）：保持既有的“未生成 / 没有站点”404 形状，不算攻击。
const ABSENT_READ_CODES = new Set([
  "path-not-found", "path-not-directory", "ancestor-not-directory", "ENOENT", "ENOTDIR",
]);
// 链接、别名/大小写重解析、非普通文件、身份不符、畸形路径：403 unsafe-path。
const UNSAFE_READ_CODES = new Set([
  "unsafe-path", "path-link", "ancestor-link", "path-not-canonical", "kind-mismatch", "identity-mismatch",
  "identity-invalid", "malformed-path", "path-not-absolute", "invalid-input",
]);

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
        // 登记文件写失败只记日志；logger 自己抛异常也不能变成未处理的 rejection。
        try { logWarn(`dsh-wiki: failed to write registry file ${err?.message ?? err}`); } catch { /* 忽略 */ }
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
// 只做**结构**探测（站点是否存在），绝不在这里读内容：词法路径 + readFileSync 会跟随
// junction/symlink 读到仓库之外。标题由 apply() 里的 readContainedFileSync 受控读取，不可信时退回目录名。
function wikiFor(root, wikiDirName) {
  const dir = path.join(root, wikiDirName);
  const site = path.join(dir, "site", "index.html");
  if (!existsSync(site)) return null;
  return { root, dir, site, title: path.basename(root) };
}

export function apply(ctx, rawConfig) {
  const config = { ...DEFAULT_CONFIG, ...(rawConfig && typeof rawConfig === "object" ? rawConfig : {}) };
  // 每一条日志都必须“不许失败”：回滚/卸载用日志报告保留的围栏，如果 logger.warn 自己抛异常，
  // 清理就会半途中断（这正是 reviewer 2026-11-09 记录的缺陷）。原始细节只走这里，绝不进响应体。
  const logWarn = (message) => {
    try {
      const sink = ctx.logger?.warn;
      if (typeof sink === "function") sink(message);
    } catch { /* 日志失败绝不打断回滚/卸载 */ }
  };
  const wikiDirName = typeof config.wikiDirName === "string" && config.wikiDirName.startsWith(".")
    ? config.wikiDirName
    : DEFAULT_CONFIG.wikiDirName;
  const extraRoots = cleanRoots(config.wikiRoots);

  const pluginRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const builderPath = path.join(pluginRoot, "scripts", "build_wiki_site.py");
  // 插件身份只来自本包 package.json，且经过 token 校验：/api/status 只回报 name/version，
  // 绝不回报安装路径（builder/clientPath/storeDir 之类都只属于 logger）。
  const pluginMeta = (() => {
    try {
      const pkg = JSON.parse(readFileSync(path.join(pluginRoot, "package.json"), "utf8"));
      const name = typeof pkg?.name === "string" && /^[@a-z0-9][a-z0-9@/._-]{0,127}$/i.test(pkg.name) ? pkg.name : NS;
      const version = typeof pkg?.version === "string" && /^[0-9][0-9A-Za-z.+-]{0,63}$/.test(pkg.version) ? pkg.version : null;
      return { name, version };
    } catch {
      return { name: NS, version: null };
    }
  })();

  // 0) 后台作业（spec 007 generate/update）：默认关闭，闸门语义与 reviewer 2026-11-09 的结论一致。
  //    jobs.enabled=false（默认）时不构造管理器/guard/journal store、不建目录：
  //    POST /api/jobs|cancel 一律 503、GET /api/jobs 只回报 disabled、只读路由绝不调用 recover()。
  //    enabled=true 才接线（T018 journal 事务 + guard + preset），构造失败一律 fail closed。
  //    真正的开闸仍取决于 T018–T020 的独立验证，本文件不改变那个结论。
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
      "Local Repo Wiki (nothing uploaded). Use when the user says \"repo wiki\", \"generate a wiki\", \"repository knowledge base\", " +
      "\"deepwiki\", \"import the legacy wiki\", or wants deep paged documentation of a repository. Produces an evidence-cited " +
      "(path:line) paged wiki (page tree + diagrams) and builds a single self-contained site, fully local with zero network.",
    whenToUse: "User asks to generate/refresh/import a repository wiki or wants deep, evidence-cited repo documentation locally.",
    source: "runtime",
    content: skillContent,
    resourceBase: { kind: "opaque", description: "dsh-wiki generation protocol (skills/wiki-protocol.md)" },
  }), "dsh-wiki: skill");

  // 1b) agent 技能：知识检索协议（spec 014）。与生成协议**分开**的一条：生成不变，检索也不改生成。
  //     技能与工具是同一件事的两半——工具给出有界结果，技能说清“先检索、再读页、最后回代码核对引用”。
  const knowledgeSkillFile = path.join(pluginRoot, "skills", "wiki-knowledge.md");
  const knowledgeSkillContent = readFileSync(knowledgeSkillFile, "utf8");
  ctx.effect(() => ctx.skills.register({
    name: "wiki-knowledge",
    description:
      "Consult this repository's generated local wiki as an agent knowledge base: search its pages and knowledge cards, read " +
      "one page or filtered cards, map changed files to the pages and cards that cover them, and check whether the wiki still " +
      "matches git HEAD. Use it BEFORE changing an unfamiliar module and AFTER a change to check impact. The wiki is a map, not " +
      "the source of truth: verify every cited path:line in the code.",
    whenToUse:
      "Before modifying an unfamiliar module (what does the repo already document about these files?), after a change (which " +
      "pages/cards cover them, and is the wiki still current?), or when you need the repo's documented invariants with citations.",
    source: "runtime",
    content: knowledgeSkillContent,
    resourceBase: { kind: "opaque", description: "dsh-wiki knowledge consult protocol (skills/wiki-knowledge.md)" },
  }), "dsh-wiki: skill wiki-knowledge");

  // 2) 工作区登记
  const home = ctx.get?.("profileContext")?.home;
  const persistPath = home ? path.join(home, NS, "registry.json") : null;
  const book = createWorkspaceBook(ctx, persistPath);
  void book.load();
  const stopWatch = ctx.on("session/event", (session) => {
    // session.header.cwd 是会话的**创建目录**，不是可变的当前工作目录（本插件自己的 worker-guard.js:22,348
    // 把这一点写成不可变事实）。这里只用它登记“这个会话曾经在哪个仓库里”，作为已知根的来源之一。
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
    // 子目录一层：DSH 工作区常是仓库的父目录（如 <workspace>/ → <repo>/），同样非递归、跳过点目录
    for (const r of siblingRoots(base)) set.add(normalize(r));
    return [...set].filter((r) => existsSync(r));
  };
  // 3b) 原生 UI 的项目列表：已知根 ∪ DSH 工作区登记（workspaceRegistry，可选服务）。
  //     路径参数只接受这里列出的根（精确匹配），杜绝任意文件读取。
  const workspaceRoots = () => {
    const reg = ctx.get?.("workspaceRegistry");
    if (!reg || typeof reg.list !== "function") return [];
    let items = [];
    try { items = reg.list() ?? []; } catch { return []; }
    const out = [];
    for (const w of items) {
      const p = [w?.path, w?.directory, w?.cwd, w?.root].find((x) => typeof x === "string" && path.isAbsolute(x));
      if (p) out.push({ root: normalize(path.resolve(p)), title: typeof w?.title === "string" ? w.title : null,
        workspaceId: typeof w?.id === "string" ? w.id : null });
    }
    return out;
  };
  const knownProjects = () => {
    const map = new Map();
    for (const r of knownRoots()) map.set(normalize(path.resolve(r)), { root: normalize(path.resolve(r)), title: null, workspaceId: null });
    const cmp = process.platform === "win32" ? (s) => s.toLowerCase() : (s) => s;
    for (const w of workspaceRoots()) {
      if (!existsSync(w.root)) continue;
      const key = [...map.keys()].find((k) => cmp(k) === cmp(w.root)) ?? w.root;
      const prev = map.get(key);
      map.set(key, { root: key, title: prev?.title ?? w.title, workspaceId: prev?.workspaceId ?? w.workspaceId });
    }
    return [...map.values()];
  };
  /**
   * 项目授权（reviewer 2026-11-10 defect）：比较**规范**路径，且不接受任何链接分量。
   * 旧实现只做 normalize + 大小写无关的词法比较：`<任意目录>/link`（link 是 junction）词法上不是
   * 已登记根，但 `projectFor(path.dirname(<root>/.dsh-wiki))` 用的还是词法父目录；而一个被判为
   * “已登记”的根本身也可能是指向别处的 junction。canonicalProjectRoot 要求 realpath 与词法路径
   * 一致（大小写不敏感）并逐级 lstat 证明无链接，因此链接、8.3 别名、`..` 换位都解析成别的路径
   * => 不匹配任何已登记根。返回的 `root` 是规范路径（on-disk casing），后续读盘只从它组合相对名。
   */
  const projectFor = async (rawRoot) => {
    const canonical = await canonicalProjectRoot(rawRoot);
    if (!canonical) return null;
    // 候选已经证明是规范路径（realpath == 词法、逐级无链接），因此与已登记根比较只需要**词法**相等
    //（Windows 大小写不敏感）：一个“靠链接/别名才等于已登记根”的候选在上一步就会被拒。
    // 这样每次请求只走一条链，不会按已知根数量放大。
    const key = pathKey(canonical);
    const known = knownProjects().find((p) => pathKey(p.root) === key);
    return known ? { ...known, root: canonical } : null;
  };

  // ---------- 后台作业运行时（spec 007）：默认不构造任何东西 ----------
  // jobs.enabled=false 时 jobState 保持 "disabled"：没有管理器、没有 worker guard、没有 journal store，
  // 不创建 store 目录，GET 也不做任何写操作；POST /api/jobs|cancel 与 GET /api/jobs 的禁用契约逐字节不变。
  // 开启后任何一步构造失败都 fail closed：记一条警告、路由继续 503 并给出真实原因、绝不运行作业。
  const jobConfig = normalizeJobConfig(config.jobs);
  const jobsEnabled = jobConfig.enabled === true;
  // 版本检查/自更新（spec 016）：构造本身不读盘、不联网、不跑 git，所以 enabled=false 不违反
  // 「默认零外发请求」；只有 status()/apply() 才会观测安装目录，且前者在关闭时也不触网。
  const updateConfig = normalizeUpdateConfig(config.update);
  // 安装路径按 profile 布局解析，并用 pluginRoot 证明“这一份就是我们”（realpath 相等，见
  // resolveInstallPath）；解析不到就是 null（fail closed）：服务以 installKind:"unknown" +
  // install-not-found 拒绝，且不跑 git、不联网。pluginRoot 仍是**只读**的 installed.version 来源——
  // 既不是写目标，也不是 git cwd。
  const updateInstallPath = __updateInternals.resolveInstallPath(home, pluginRoot);
  const updateService = __updateInternals.createUpdateService({
    pluginRoot,
    installPath: updateInstallPath,
    enabled: updateConfig.enabled,
  });
  const jobStoreDir = resolveJobStoreDir(jobConfig.storeDir, ctx);
  const jobState = {
    status: jobsEnabled ? "starting" : "disabled",
    // reason 是给客户端的固定短句（不含路径/内部细节）；reasonDetail 只进 logger。
    reason: null,
    // reasonCode 是稳定的公开 code（preset 前提缺失等），缺省 => jobs-initialization-failed。
    reasonCode: null,
    reasonDetail: null,
    ready: null,
    error: null,
    manager: null,
    guard: null,
    disposePreset: null,
    // 每次 apply 一个实例标识：journal 记录据此判定“是不是本进程写的”。
    hostInstanceId: makeHostInstanceId(),
    storePromise: null,
    // 恢复专用的第二个 store（未钉死实例）：只有 recovery-execute 路由用，见 openRecoveryStore。
    recoveryStorePromise: null,
  };
  // 本进程的 host epoch（spec 007 / T028）。记录落在 journal store 目录内部的子目录里，只在 store
  // 真正打开时领取一次——默认配置与“还没有可信根”的构造阶段一律不落盘，沿用“jobs.enabled=false
  // 不创建 store 目录”“GET 不写盘”的既有契约（harness 20a/20g/T011 都在守这两条）。
  // 领取被拒或抛错只记一条警告，provider 从此永久 unknown（fail closed）：绝不重试，更不因为存活
  // 证明失败而让插件加载或作业运行时失败。
  // previousVerdict 已删除：裁决必须按 journal 记录的属主实例分别求证，一个全局裁决会把“某个宿主死了”
  // 误当成“这条记录的主人死了”（见 host-liveness.js 顶部的缺陷说明）。记录按实例分文件保存，acquire
  // 只覆盖本实例自己那一份，因此也不需要“覆盖之前先捕获”的顺序。
  const hostEpoch = { epochId: null, dir: null, attempted: false };
  // 作业与路由共用同一份已知根白名单（精确匹配；不做任何目录发现）。
  const jobAllowedRoots = () => knownProjects().map((p) => p.root);
  const pathKey = (value) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const pathWithin = (candidate, ancestor) => {
    const child = pathKey(candidate);
    const parent = pathKey(ancestor);
    return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`);
  };

  // ---------- 受控读（reviewer 2026-11-10 defect） ----------
  // 规范路径比较：Windows 大小写不敏感、尾分隔符无关。fs-contain 内部的 samePath 没有导出，
  // 所以这里本地实现一份（行为与它一致）。
  const sameCanonicalPath = (left, right) => {
    const trim = (value) => {
      const resolved = path.normalize(value);
      const root = path.parse(resolved).root;
      const trimmed = resolved.length > root.length ? resolved.replace(/[\\/]+$/, "") : resolved;
      return process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
    };
    return typeof left === "string" && typeof right === "string" && trim(left) === trim(right);
  };
  /** 读到不该读的东西时抛出：调用方映射成固定 403 unsafe-path，绝不回显路径或异常文本。 */
  const unsafePath = (message) => Object.assign(new Error(message ?? "unsafe path"), { code: "unsafe-path" });

  /**
   * 解析**可信**的项目根：realpath 必须与词法路径一致（Windows 上大小写不敏感），且整条祖先链
   * 没有任何 symlink/junction/reparse point（assertCanonicalDir 从盘符根逐级 lstat）。
   *
   * 为什么要先 realpath 再 assertCanonicalDir：assertCanonicalDir 也要求“词法 == realpath”，
   * 但它在 Windows 上会因为 on-disk casing（或 8.3 别名）与调用方写法不同而拒绝一个**合法**根。
   * 先用 realpath 归一化大小写/别名，再让它证明整条链无链接：两者一致的根才可信。
   * 链接会让 realpath 解析到另一个路径 => 两条路径不相等 => 直接不可信，fail closed。
   * @returns {Promise<string|null>} 规范路径（on-disk casing），不可信/不存在 => null
   */
  const canonicalProjectRoot = async (rawRoot) => {
    if (typeof rawRoot !== "string" || rawRoot.length === 0 || rawRoot.length > 4096
      || !path.isAbsolute(rawRoot)) return null;
    const lexical = normalize(path.resolve(rawRoot));
    let real;
    try { real = await realpath(lexical); } catch { return null; }
    if (!sameCanonicalPath(lexical, real)) return null;
    try { return (await assertCanonicalDir(real)).path; } catch { return null; }
  };

  /** 已登记且可证明规范的项目根（按规范路径去重）。不可信的根直接不出现。 */
  const trustedProjects = async () => {
    const byCanonical = new Map();
    for (const p of knownProjects()) {
      const root = await canonicalProjectRoot(p.root);
      if (!root) continue;
      const key = pathKey(root);
      if (!byCanonical.has(key)) byCanonical.set(key, { ...p, root });
    }
    return [...byCanonical.values()];
  };

  // 已经记过“不可信 wiki 条目”警告的根：/api/projects 会被轮询，日志必须有界（与 untrustedRootWarned 同策略）。
  const untrustedWikiWarned = new Set();
  const warnUntrustedWiki = (root, error) => {
    const code = typeof error?.code === "string" ? error.code : "";
    if (ABSENT_READ_CODES.has(code)) return;
    const key = pathKey(root);
    if (untrustedWikiWarned.has(key)) return;
    untrustedWikiWarned.add(key);
    logWarn(`dsh-wiki: a wiki entry under ${root} is not a regular file inside the project (${code || "error"}); it is reported as not generated`);
  };

  /**
   * 在**已授权的规范项目根**之下读取一个普通文件。步骤顺序本身就是安全属性：
   *   1) identityOf 先证明「盘符根 → 目标」每一级都不是 symlink/junction，realpath 与词法路径一致
   *      （8.3 别名、大小写重解析同样被拒），并给出 dev/ino/kind；
   *   2) 目标必须是**单链接**普通文件：目录、FIFO、设备、硬链接（nlink !== 1）一律拒绝。硬链接是
   *      独立于符号链接的绕过：仓库外的名字与仓库内的名字是同一个文件，规范路径、逐级无链接、
   *      dev/ino 全部一致，只有链接数能说明“这个文件还有另一个、仓库外的名字”；
   *   3) open 之后立刻 fstat：句柄的 dev/ino 必须与第 1 步一致——**授权的是这个文件，读的也是它**；
   *      链接数也必须在**句柄**上再验一次（检查与 open 之间可以被加一个硬链接）；
   *      不一致说明检查之后被换掉 => 固定拒绝，绝不退回“按路径重读一遍”；
   *   4) 只有第 3 步通过后才从**句柄**读字节，因此第 1 步之后路径被换掉也读不到别的内容。
   * 任何拒绝都发生在读到第一个字节之前。
   * @returns {Promise<{text: string|Buffer, mtime: Date}>}
   */
  const readContainedFile = async (root, relative, encoding) => {
    const target = path.join(root, relative);
    const identity = await identityOf(target);
    if (identity.kind !== "file") throw unsafePath("not a regular file");
    // 硬链接绕过：仓库内的名字与仓库外的名字是**同一个文件**，所以规范路径、逐级无链接、dev/ino
    // 三道证明都会通过。authorisation 时就必须要求 nlink === 1（identityOf 给出的是规范化字符串）。
    if (identity.nlink !== "1") throw unsafePath("file has more than one link");
    const handle = await __siteInternals.open(target, "r");
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || String(opened.dev) !== identity.dev || String(opened.ino) !== identity.ino) {
        throw unsafePath("opened file is not the checked file");
      }
      // 句柄上的链接数再验一次：证明阶段之后、open 之前仍然可以给同一个文件加一个硬链接。
      if (String(opened.nlink) !== "1") throw unsafePath("opened file has more than one link");
      return { text: await handle.readFile(encoding), mtime: opened.mtime };
    } finally {
      await handle.close().catch(() => { /* 关闭失败不改变已经做出的判断 */ });
    }
  };

  /**
   * 同步版的同一套证明，只给同步调用方用（/dsh-wiki/ 索引页与 /wiki list 读 wiki.json 标题——
   * 命令 handler 是同步契约，不能因此变成 Promise）。逐级 bigint lstat 拒绝链接，realpath 必须与
   * 词法路径一致，目标必须是**单链接**普通文件（nlink === 1），open 后 fstat 绑定身份并**再次**
   * 要求单链接（硬链接与符号链接是两条独立的绕过路径），只从句柄读字节；目标必须留在 root 之下。
   */
  const readContainedFileSync = (root, relative, encoding) => {
    const abs = normalize(path.resolve(root, relative));
    const rel = path.relative(root, abs);
    if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw unsafePath("target escapes the project root");
    }
    const fsRoot = path.parse(abs).root;
    let stats = lstatSync(fsRoot, { bigint: true });
    if (stats.isSymbolicLink()) throw unsafePath("filesystem root is a link");
    let current = fsRoot;
    // 从盘符根逐级走到底（不是从 root 走）：root 自身及其上方的每一级也必须是真实目录。
    for (const segment of path.relative(fsRoot, abs).split(path.sep)) {
      if (!segment) continue;
      current = path.join(current, segment);
      stats = lstatSync(current, { bigint: true });
      if (stats.isSymbolicLink()) throw unsafePath("link in the path");
    }
    if (!stats.isFile()) throw unsafePath("not a regular file");
    // 硬链接：仓库外的名字与仓库内的名字是同一个文件，逐级无链接与 realpath 一致性都骗得过去。
    if (String(stats.nlink) !== "1") throw unsafePath("file has more than one link");
    if (!sameCanonicalPath(abs, realpathSync(abs))) throw unsafePath("path is not canonical");
    const fd = openSync(abs, "r");
    try {
      const opened = fstatSync(fd, { bigint: true });
      if (!opened.isFile() || String(opened.dev) !== String(stats.dev) || String(opened.ino) !== String(stats.ino)) {
        throw unsafePath("opened file is not the checked file");
      }
      // 句柄上再验一次链接数：lstat 之后、open 之前仍然可以加一个硬链接。
      if (String(opened.nlink) !== "1") throw unsafePath("opened file has more than one link");
      return readFileSync(fd, encoding);
    } finally {
      try { closeSync(fd); } catch { /* 关闭失败不改变已经做出的判断 */ }
    }
  };

  /** hasSite 的判定必须与 /site 一致：链接换掉的站点不算“已构建”。 */
  const containedFileExists = async (root, relative) => {
    try { return (await identityOf(path.join(root, relative))).kind === "file"; } catch { return false; }
  };

  /** wiki.json 的标题（title/repoId）：不可信或缺失一律退回目录名，绝不回显外部内容。 */
  const wikiTitle = (root) => {
    try {
      const parsed = JSON.parse(readContainedFileSync(root, path.join(wikiDirName, "wiki.json"), "utf8"));
      if (typeof parsed?.title === "string" && parsed.title) return parsed.title;
      if (typeof parsed?.repoId === "string" && parsed.repoId) return parsed.repoId;
      return null;
    } catch {
      return null;
    }
  };

  /**
   * 受控读失败的唯一出口：固定 JSON、固定 code，绝不回显异常文本或真实路径。
   *   不存在（读完前消失/本来没有）=> 调用方给的 404 短语（既有形状）；absentCode 显式给出时
   *      带上稳定 code（翻译缺失需要它来区分“没有 wiki”与“没有该语言的翻译”）
   *   链接/别名/非普通文件/身份不符 => 403 unsafe-path（原因只进 logger）
   *   其余（EACCES/EBUSY/未知）=> 500 internal-error（原因只进 logger）
   */
  const refuseRead = (res, error, absentMessage, target, absentCode) => {
    const code = typeof error?.code === "string" ? error.code : "";
    if (ABSENT_READ_CODES.has(code)) {
      return writeJson(res, 404, absentCode === undefined ? { error: absentMessage } : { error: absentMessage, code: absentCode });
    }
    const unsafe = UNSAFE_READ_CODES.has(code);
    logWarn(unsafe
      ? `dsh-wiki: refused an unsafe read of ${target} (${code})`
      : `dsh-wiki: could not read ${target}: ${error?.message ?? error}`);
    if (unsafe) return writeJson(res, 403, UNSAFE_PATH);
    return writeJson(res, 500, { error: PUBLIC_JOB_ERRORS["internal-error"], code: "internal-error" });
  };

  // 已经记过“不可信根”警告的根（按 pathKey 去重）：同一个根在一次 apply 里最多一条日志，日志有界。
  const untrustedRootWarned = new Set();
  /**
   * 解析**可信**的作业根白名单：只用 assertCanonicalDir 能证明的根（规范、祖先链无符号链接/junction）。
   *
   * 一个不可信的根不再让整个运行时失败（历史上：任一已知根是 junction/别名，ensureJobStoreDir 就整体
   * 抛错 => jobState=failed）。现在它被跳过、记一条有界警告（路径只进 logger），其余白名单照常使用；
   * 一个都不剩时由调用方 fail closed（root-untrusted）。
   * 作业侧保证没有放松：这份清单既是交给 manager 的 allowedRoots（jobs.js createJournal 再验根的
   * 规范性与白名单，才允许绑定 journal 记录），也是交给 openJournalStore 的 allowedRoots
   * （store 只允许记录绑定这份清单里的根）。被跳过的根因此永远无法成为作业的可信根。
   * @returns {Promise<string[]>} 规范路径（on-disk casing）
   */
  const resolveTrustedJobRoots = async () => {
    const trusted = [];
    const skipped = [];
    for (const root of jobAllowedRoots()) {
      try {
        const entry = await assertCanonicalDir(root);
        trusted.push(entry.path);
      } catch (error) {
        skipped.push({ root, code: typeof error?.code === "string" && error.code ? error.code : "error" });
      }
    }
    const fresh = skipped.filter(({ root }) => {
      const key = pathKey(root);
      if (untrustedRootWarned.has(key)) return false;
      untrustedRootWarned.add(key);
      return true;
    });
    if (fresh.length > 0) {
      // 有界：最多列 5 个根，每个根一条固定短语；同一次 apply 内每个根只出现一次。
      const shown = fresh.slice(0, 5)
        .map(({ root, code }) => `${root} is not a trusted canonical directory (${code})`)
        .join("; ");
      logWarn(
        `dsh-wiki: ${fresh.length} known repository root(s) are excluded from background jobs (${trusted.length} trusted root(s) remain): ${shown}${fresh.length > 5 ? "; …" : ""}`,
      );
    }
    return trusted;
  };

  /**
   * 确保 journal store 目录存在，但绝不在链接/junction 之下创建任何东西（reviewer 2026-11-09 defect 4）。
   *
   * 顺序本身就是安全属性：所有检查都在第一次 mkdir 之前完成。
   *   1) 找到最深的已存在祖先（不跟随任何链接地 lstat 探测）；
   *   2) 用 assertCanonicalDir 验证整条祖先链：每一级都不是 symlink/junction，realpath 与词法路径一致；
   *   3) 用“规范祖先 + 缺失分量”得到 store 的规范路径，要求它与每个 allowlist 根互不包含
   *      （词法路径与规范路径都比一遍：storeDir 可能是 <temp>/link/journal，词法上在根外、实际上在根内）；
   *      任一 allowlist 根无法规范化 => 直接拒绝（不退回词法比较），仍然在 mkdir 之前；
   *   4) 逐级 mkdir（单层、非递归）并在每一级之后复验它是规范目录；
   *   5) 调用方随后用 openJournalStore 再验证 leaf 的规范性与 dev/ino 身份。
   * 任何一步失败都抛出（调用方映射成固定的 503），绝不留下一个“通过链接创建”的目录。
   * 这些检查只覆盖它们执行的那一刻；检查与后续使用之间的并发改动由第 5 步的身份校验兜住，
   * 这里不声称 TOCTOU 安全。
   * @param {string} dir 绝对路径（词法）
   * @param {string[]} roots allowlist 仓库根
   * @returns {Promise<string>} 规范、已存在且验证过的 store 目录
   */
  const ensureJobStoreDir = async (dir, roots) => {
    const missing = [];
    let existing = path.resolve(dir);
    for (;;) {
      try {
        await lstat(existing);
        break;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        const parent = path.dirname(existing);
        if (parent === existing) throw new Error("jobs.storeDir has no existing ancestor to verify");
        missing.unshift(path.basename(existing));
        existing = parent;
      }
    }
    const ancestor = await assertCanonicalDir(existing);
    for (const part of missing) {
      if (!part || part === "." || part === ".." || part.includes(path.sep) || part.includes("\u0000")) {
        throw new Error("jobs.storeDir contains a non-canonical path component");
      }
    }
    const canonicalStore = path.join(ancestor.path, ...missing);
    // allowlist 根的规范化是前置条件，不是“尽力而为”：根解不开（链接/junction/别名）就无法证明
    // storeDir 在它之外。此时绝不退回词法比较，而是在任何 mkdir 之前拒绝。
    const canonicalRoots = [];
    for (const root of roots) {
      let canonicalRoot;
      try {
        canonicalRoot = await assertCanonicalDir(root);
      } catch (error) {
        throw new Error(`jobs.storeDir cannot be verified: the allowlisted root ${root} is not a trusted canonical directory (${error?.code ?? "error"}: ${error?.message ?? error})`);
      }
      canonicalRoots.push(canonicalRoot.path);
    }
    for (const root of [...roots, ...canonicalRoots]) {
      if (pathWithin(canonicalStore, root) || pathWithin(root, canonicalStore)) {
        throw new Error(`jobs.storeDir must live outside every allowlisted repository root (it overlaps ${root})`);
      }
    }
    let current = ancestor.path;
    for (const part of missing) {
      const next = path.join(current, part);
      try { await mkdir(next); } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
      // 创建之后立刻复验这一级：如果它现在不是规范目录（例如被并发替换成链接），立即失败。
      // 这不能证明“检查与使用之间绝不会被并发改动”——那需要 openJournalStore 的 dev/ino 身份校验。
      const entry = await assertCanonicalDir(next);
      if (pathKey(entry.path) !== pathKey(next)) throw new Error("jobs.storeDir component is not canonical (a link was introduced)");
      current = entry.path;
    }
    return current;
  };

  // Each host instance's epoch record is the ONLY evidence that instance existed, so it MUST outlive a
  // plugin reload: an unload kills neither this process nor the worker activations retained until
  // process exit. Death is proven by the OS instead - pid gone => dead/process-gone, pid alive with
  // different start ticks => dead/pid-reused - so a stale record is safe in both directions and must
  // never be deleted by our own cleanup (not on unload, not on process exit).
  /**
   * 领取本实例的 host epoch（spec 007 / T028）：<journal store>/host-epoch/<hostInstanceId>.json 里的
   * `{ epochId, hostInstanceId, pid, procStart, procStartTicks, startedAt }`（`procStart` 仅供人读，
   * `procStartTicks` 是 OS 起始时刻、以字符串保存，因为数值超过 2^53）。
   * 目录用 ensureJobStoreDir 创建，因此与 store 目录适用同一套
   * “规范、逐级无链接、位于所有 allowlist 根之外”的验证——存活证明不能成为绕过文件系统围栏的路径。
   *
   * 文件名就是实例 token，所以领取只覆盖本实例自己那一份；别的实例的记录是另一个文件，永远不会被本进程
   * 覆盖或删除。因此“覆盖之前先捕获上一个宿主的裁决”那一步不再存在——裁决按记录属主分别求证（见 provider
   * 与 host-liveness.js 顶部的缺陷说明）。takeover 也不做兜底传 true：acquire 只按本实例自己那条记录的
   * 具体裁决决定是否覆盖，且记录缺席不是拒绝（本实例还没在这里落过盘，没有自己的东西要覆盖）。
   *
   * 只尝试一次：被拒（本实例的记录没被证明死掉）或抛错都只记一条警告，provider 永久 unknown。
   * 绝不抛出：epoch 是存活证明的附加物，它失败不得连带作业运行时或插件加载。
   * @param {string[]} trustedRoots 已验证的 allowlist 根（与 openJournalStore 的同一份）
   */
  const claimHostEpoch = async (trustedRoots) => {
    if (hostEpoch.attempted) return;
    hostEpoch.attempted = true;
    try {
      if (!jobStoreDir) throw new Error("jobs.storeDir is unavailable");
      if (!Array.isArray(trustedRoots) || trustedRoots.length === 0) {
        throw new Error("no trusted allowlisted repository root is known");
      }
      const epochDir = path.join(jobStoreDir, HOST_EPOCH_DIRNAME);
      await ensureJobStoreDir(epochDir, trustedRoots);
      // 不传 takeover：acquireHostEpoch 只按本实例自己那条记录的裁决放行（缺席或已证明 dead）。
      const acquired = await __livenessInternals.acquireHostEpoch({ dir: epochDir, hostInstanceId: jobState.hostInstanceId });
      if (!acquired || acquired.refused === true) {
        const previous = acquired?.previous;
        throw new Error(`this host instance's epoch record is not proven dead (${previous?.verdict ?? "unknown"}/${previous?.reason ?? "no-reason"})`);
      }
      if (typeof acquired.epochId !== "string" || acquired.epochId.length === 0) {
        throw new Error("acquireHostEpoch returned no epochId");
      }
      hostEpoch.epochId = acquired.epochId;
      // provider 需要这个目录来按记录属主求证；领取成功才有可信来源。
      hostEpoch.dir = epochDir;
    } catch (error) {
      // fail closed：没有可信 epoch => provider 一律 unknown（reconcile 因此保持隔离）。
      hostEpoch.epochId = null;
      hostEpoch.dir = null;
      logWarn(`dsh-wiki: no trusted host epoch was acquired, so worker liveness stays fail-closed (unknown): ${error?.message ?? error}`);
    }
  };

  /** 前提缺失：带稳定的公开 code（客户端看到固定短句），细节只进 logger。 */
  const prerequisite = (code, message) => Object.assign(new Error(message), { prerequisiteCode: code });

  /**
   * 打开可信 journal store（T018）。目录必须位于所有 allowlist 项目根之外；首次成功打开后固定复用，
   * 因为 store 的 snapshot 只对打开它的实例有效，运行中重开会让 CAS 失败（=> 仓库被栅栏）。
   * 失败后清掉 promise，允许下一次调用重试。
   *
   * 失败原因带自己的稳定公开 code（prerequisiteCode），不再一律折叠成 jobs-initialization-failed：
   *   - journal-store-unavailable：store 目录/身份/token/权限等构造问题；
   *   - root-untrusted：一个可信根都不剩（见 resolveTrustedJobRoots）。
   * 细节（路径、原始错误文本）只进 logger 与 jobState.reasonDetail。
   */
  const openStoreInstance = (slot, storeHostInstanceId, claimEpoch) => {
    if (jobState[slot]) return jobState[slot];
    const opening = (async () => {
      const roots = jobAllowedRoots();
      if (roots.length === 0) {
        throw new Error("no allowlisted repository root is known yet; jobs stay unavailable until one is discovered");
      }
      if (!jobStoreDir) {
        throw prerequisite("journal-store-unavailable",
          "jobs.storeDir is unset and no profile home is available to derive <profileContext.home>/dsh-wiki/journal");
      }
      for (const root of roots) {
        if (pathWithin(jobStoreDir, root) || pathWithin(root, jobStoreDir)) {
          throw prerequisite("journal-store-unavailable",
            `jobs.storeDir must live outside every allowlisted repository root (it overlaps ${root})`);
        }
      }
      // 不可信的根不再拖垮整个运行时：跳过它并记一条有界警告，其余白名单照常使用。
      const trusted = await resolveTrustedJobRoots();
      if (trusted.length === 0) {
        throw prerequisite("root-untrusted",
          `none of the ${roots.length} known repository root(s) is a trusted canonical directory, so no journal record can bind a repository`);
      }
      try {
        // 目录不存在时先建出来；journal store 只接受已存在的规范目录。创建发生在
        // “祖先链规范、无链接、在根外”验证之后，且逐级复验；最后 openJournalStore 再验一次身份。
        await ensureJobStoreDir(jobStoreDir, trusted);
        const store = await __jobsInternals.openJournalStore({
          storeDir: jobStoreDir,
          allowedRoots: trusted,
          // 注意：未钉死必须是**省略该键**，不是 hostInstanceId: null——readOptions 的 present 判定
          // 是 Object.hasOwn，显式 null 会走 readToken 并被拒为 "must be a string"。
          ...(storeHostInstanceId === null ? {} : { hostInstanceId: storeHostInstanceId }),
        });
        // 存活凭据只在 store 真正就绪之后领取，且写在同一个 storeDir 内部；领取失败只关闭 provider。
        // 恢复专用实例**不**再领取：epoch 记录归本进程所有，一个未钉死的 store 没有资格替它宣称存活。
        if (claimEpoch) await claimHostEpoch(trusted);
        return store;
      } catch (error) {
        if (typeof error?.prerequisiteCode === "string") throw error;
        throw prerequisite("journal-store-unavailable", `the trusted journal store could not be opened: ${error?.message ?? error}`);
      }
    })();
    jobState[slot] = opening.catch((error) => {
      jobState[slot] = null;
      throw error;
    });
    return jobState[slot];
  };

  /**
   * 打开可信 journal store（T018）。目录必须位于所有 allowlist 项目根之外；首次成功打开后固定复用，
   * 因为 store 的 snapshot 只对打开它的实例有效，运行中重开会让 CAS 失败（=> 仓库被栅栏）。
   * 失败后清掉 promise，允许下一次调用重试。
   *
   * 失败原因带自己的稳定公开 code（prerequisiteCode），不再一律折叠成 jobs-initialization-failed：
   *   - journal-store-unavailable：store 目录/身份/token/权限等构造问题；
   *   - root-untrusted：一个可信根都不剩（见 resolveTrustedJobRoots）。
   * 细节（路径、原始错误文本）只进 logger 与 jobState.reasonDetail。
   *
   * 普通实例钉死在本进程的 hostInstanceId 上：一个实例绝不通过这个 store 采纳/推进另一个实例的记录。
   */
  const openJobStore = () => openStoreInstance("storePromise", jobState.hostInstanceId, true);

  /**
   * 恢复专用的第二个 store 实例（spec 007 / T029）：与普通实例**同一** storeDir、同一份
   * resolveTrustedJobRoots 白名单、同一条 ensureJobStoreDir 校验路径，因此不绕过任何路径检查；
   * 唯一差别是 hostInstanceId: null = 未钉死（journal-store.js 的 assertHostPin 对 null 立即返回）。
   *
   * 为什么需要它：makeHostInstanceId() 每次 apply 都造一个新 UUID，宿主重启之后普通 store 的 pin
   * 永远配不上前一个实例写的记录，执行器会在 rename 之前以 host-pin-mismatch 拒绝；而恢复恰恰只
   * 在“上一个宿主已经死了”时才被计划出来。放宽 pin 不会放宽安全性——真正的闸门是规划器：
   * 跨重启场景里它只接受 proof="process-exit"（lib/journal.js 的 liveness gate），其余一律
   * quarantine 且零动作；再加执行器要求调用方显式传 recovery:true，未钉死的 store 无法被误接线使用。
   * 只有 handleRecoveryExecutePost 用它，且只在 execute 路径上（见 manager.reconcile 的 store 覆盖）。
   */
  const openRecoveryStore = () => openStoreInstance("recoveryStorePromise", null, false);

  // 管理器只需要 store 的四个方法；打开推迟到第一次真正需要时，这样 apply 时还没有已知工作区
  // 也不会让插件构造失败。
  const jobJournalStore = {
    load: (root) => openJobStore().then((store) => store.load(root)),
    create: (record) => openJobStore().then((store) => store.create(record)),
    advance: (previous, next) => openJobStore().then((store) => store.advance(previous, next)),
    replaceTerminal: (previous, next) => openJobStore().then((store) => store.replaceTerminal(previous, next)),
  };

  /**
   * null = 可用；否则是给客户端的固定禁用原因（503）：稳定的 code + 固定短句。
   * 构造失败的原始原因只存在 jobState.reasonDetail 里进 logger，绝不进响应体。
   */
  const jobUnavailable = async () => {
    if (jobState.status === "disabled") return { code: "jobs-disabled", error: JOBS_DISABLED_MESSAGE };
    if (jobState.ready) await jobState.ready.catch(() => {});
    if (jobState.status === "ready") return null;
    if (jobState.status === "disposed") {
      return { code: "plugin-unloaded", error: PUBLIC_JOB_ERRORS["plugin-unloaded"] };
    }
    // 真实前提缺失（例如 preset 无法证明已挂载）用自己的稳定 code 报告，绝不伪造成“通用启动失败”。
    const code = typeof jobState.reasonCode === "string" && PUBLIC_JOB_ERRORS[jobState.reasonCode]
      ? jobState.reasonCode
      : "jobs-initialization-failed";
    return {
      code,
      error: PUBLIC_JOB_ERRORS[code] ?? PUBLIC_JOB_ERRORS["jobs-initialization-failed"],
    };
  };

  /**
   * 释放 manager（幂等、绝不抛出）：先把 jobState.manager 置空再 await dispose，
   * 因此构造回滚与卸载不会把同一个管理器 dispose 两次。
   * @returns {Promise<{reported: boolean, unresolved: Array<{root: string, jobId: string, sessionId: string|null}>}>}
   *   reported=false => 管理器没能报告哪些 worker 仍在运行（dispose 抛错或未实现报告）：调用方必须 fail closed。
   */
  const disposeJobManager = async () => {
    const manager = jobState.manager;
    jobState.manager = null;
    if (!manager) return { reported: true, unresolved: [] };
    try {
      const outcome = typeof manager.dispose === "function" ? await manager.dispose() : undefined;
      const list = Array.isArray(outcome?.unresolved) ? outcome.unresolved
        : typeof manager.unresolvedWorkers === "function" ? manager.unresolvedWorkers() : null;
      if (!Array.isArray(list)) return { reported: false, unresolved: [] };
      return { reported: true, unresolved: list };
    } catch (error) {
      logWarn(`dsh-wiki: could not dispose the job manager: ${error?.message ?? error}`);
      return { reported: false, unresolved: [] };
    }
  };

  /**
   * 释放 worker guard 的 activation。**只**释放管理器报告为“确认停下”的 worker：
   * 一个仍在运行（或无法证明停下）的 worker 必须保留它的 activation，否则卸载会把它的工具围栏
   * 一起清掉，留下一个失去隔离的活进程（reviewer 2026-11-09 defect 1）。保留下来的 activation
   * 由 worker 自己的 tools.guard 闭包持有，直到进程退出；释放它们属于 reconcile 的职责。
   */
  const releaseWorkerGuard = ({ reported, unresolved }) => {
    const guard = jobState.guard;
    jobState.guard = null;
    if (!guard) return;
    try {
      if (reported && unresolved.length === 0) {
        guard.releaseAll?.();
        return;
      }
      // 无法证明“哪些 worker 已停下”时不能假设安全：全部保留。
      const keep = new Set();
      let unattributable = !reported;
      for (const entry of unresolved) {
        const sessionId = typeof entry?.sessionId === "string" && entry.sessionId ? entry.sessionId : null;
        if (sessionId) keep.add(sessionId);
        else unattributable = true;
      }
      if (!unattributable && typeof guard.activeAgentIds === "function" && typeof guard.release === "function") {
        const activeIds = guard.activeAgentIds();
        for (const agentId of activeIds) {
          if (keep.has(agentId)) continue;
          try { guard.release(agentId); } catch { /* 保险：保留给 reconcile */ }
        }
        const retained = activeIds.filter((agentId) => keep.has(agentId));
        const count = reported ? String(unresolved.length) : "an unknown number of";
        if (retained.length === 0) {
          // 没有任何 activation 可保留（例如 worker 的 setup 从未完成）：不要说“已保留围栏”。
          logWarn(
            `dsh-wiki: ${count} background wiki job worker(s) could not be confirmed stopped and no guard activation is held for them; no tool confinement is retained — reconcile is required for the affected repositories`,
          );
          return;
        }
        logWarn(
          `dsh-wiki: ${count} background wiki job worker(s) could not be confirmed stopped; tool confinement for agent id(s) ${retained.join(", ")} is retained until process exit — reconcile is required for the affected repositories`,
        );
        return;
      }
      const ids = keep.size > 0 ? [...keep].join(", ") : "(unknown)";
      const count = reported ? String(unresolved.length) : "an unknown number of";
      logWarn(
        `dsh-wiki: ${count} background wiki job worker(s) could not be confirmed stopped; tool confinement for agent id(s) ${ids} is retained until process exit — reconcile is required for the affected repositories`,
      );
    } catch (error) {
      logWarn(`dsh-wiki: could not release the worker guard: ${error?.message ?? error}; confinement is retained until process exit — reconcile is required`);
    }
  };

  /**
   * 构造 guard/preset/管理器；任何失败都 fail closed（警告 + 503），并回滚已经拿到的注册。
   *
   * preset 是不可绕过的前提，而且每一步都要能被证明（dsh-agent-preset-registry, dsh-v0.2.2-rc.1）：
   *   1) register(WORKER_PRESET_DEFINITION) 注册的 id 与 mount 用的 id 必须是同一个固定值；
   *   2) register 的 disposer 必须存在（否则无法在回滚/卸载时撤销注册）；
   *   3) resolve(WORKER_PRESET_ID) 必须在 roster 里报告该 id，且不带 broken 诊断——activation 失败
   *      在注册接口里是“可见但不会抛”的，所以必须主动读一次；
   *   4) composedPreset 必须存在：没有它就无法在每个 worker 上证明 preset 真的绑定成功。
   * 任一条件不满足都不创建任何会话，路由报固定 code（preset-*），而不是 202。
   *
   * 这里证明的是“registry 报告该 preset 已注册、未损坏、且这个 agent 组合了它”——即结构性前提。
   * 它不是 T019 的运行时隔离证明：worker 实际被限制在暂存目录这件事仍需运行期验证，本检查不放宽
   * T018–T020 任何一个闸门。
   */
  const startJobRuntime = async () => {
    try {
      const agents = ctx.get?.("agents");
      const agentPresets = ctx.get?.("agentPresets");
      const workingDirectory = ctx.get?.("workingDirectory");
      if (typeof agents?.create !== "function") throw new Error("the agents service is unavailable");
      if (typeof agentPresets?.register !== "function" || typeof agentPresets?.mount !== "function") {
        throw new Error("the agentPresets service is unavailable");
      }
      if (typeof agentPresets?.resolve !== "function") {
        throw prerequisite("preset-activation-failed",
          "the agentPresets service exposes no resolve(); the registered worker preset activation cannot be verified, so no worker session is ever created");
      }
      if (typeof agentPresets?.composedPreset !== "function") {
        throw prerequisite("preset-unverifiable",
          "the agentPresets service exposes no composedPreset(); the worker preset binding cannot be verified for an agent, so no worker session is ever created");
      }
      if (typeof workingDirectory?.get !== "function") throw new Error("the workingDirectory service is unavailable");
      const guard = __jobsInternals.createWorkerGuard({
        getEffectiveCwd: (agent) => workingDirectory.get(agent.session),
      });
      jobState.guard = guard;
      // 注册与挂载是同一个固定 id：没有第二条“指向别的 preset”的路径。
      const disposePreset = await agentPresets.register(WORKER_PRESET_DEFINITION);
      if (typeof disposePreset !== "function") {
        throw prerequisite("preset-activation-failed", "agentPresets.register() returned no disposer");
      }
      jobState.disposePreset = disposePreset;
      let registered;
      try {
        registered = await agentPresets.resolve(WORKER_PRESET_ID);
      } catch (error) {
        throw prerequisite("preset-activation-failed",
          `agentPresets.resolve(${WORKER_PRESET_ID}) failed: ${error?.message ?? error}`);
      }
      if (!registered || typeof registered !== "object" || registered.id !== WORKER_PRESET_ID) {
        throw prerequisite("preset-activation-failed",
          `agentPresets.resolve(${WORKER_PRESET_ID}) did not report the worker preset (got ${JSON.stringify(registered?.id ?? null)})`);
      }
      if (registered.broken !== undefined && registered.broken !== null && registered.broken !== false) {
        throw prerequisite("preset-activation-failed",
          `the worker preset activation is reported broken: ${typeof registered.broken === "string" ? registered.broken : JSON.stringify(registered.broken)}`);
      }
      jobState.manager = __jobsInternals.createJobManager({
        agents,
        agentPresets,
        workingDirectory,
        workerGuard: guard,
        presetId: WORKER_PRESET_ID,
        buildWorkerPrompt,
        buildTranslationPrompt,
        journalStore: jobJournalStore,
        hostInstanceId: jobState.hostInstanceId,
        // 只把**可信**的根交给管理器：jobs.js createJournal 会再验根的规范性与这份白名单，
        // 因此被 resolveTrustedJobRoots 跳过的根永远无法绑定 journal 记录（root-untrusted /
        // root-not-allowed），而不是“因为一个坏根拒绝所有作业”。
        allowedRoots: resolveTrustedJobRoots,
        // 存活证明（spec 007 / T028）。journal 记录里的 hostInstanceId 是管理器在这里钉死的实例
        // token（jobState.hostInstanceId），不是 epoch 记录里的 epochId——记录从不携带 epochId，
        // 两者各自生成。分支按顺序是：
        //   没有 epoch                    -> unknown（没有可信来源，永久 fail closed）
        //   本进程实例写的记录             -> alive（宿主活着，它的记录不可能属于“已停下的 worker”；
        //                                    jobs.js 只接受 alive/stopped/unknown，任何别的值都会被
        //                                    折成 unknown，所以这里必须是 alive，不能是 "running"）
        //   别的实例写的记录               -> 按**该记录的属主**求证：proveEpochFor({ dir, hostInstanceId:
        //                                    record.hostInstanceId })，只有那条记录自己的裁决是 dead 才
        //                                    stopped（workers 是宿主的进程内子代理，宿主死 => worker 死；
        //                                    这是 host-liveness.js 头顶写明的假设，不得升级成更强断言）。
        //                                    绝不套用“上一个宿主”的全局裁决：某个实例死了不能证明别人的
        //                                    worker 停了，那条记录缺席也只是 unknown（absence is not death）。
        // 其它一切（alive/unknown/异常）一律 unknown：provider 绝不把“不确知”降级成 stopped，
        // 那正是 T027 在栅栏处防的错误。
        //
        // proof 的取值必须是 journal.js 的 WORKER_PROOFS 成员（缺陷：这里曾返回 "epoch-host-dead"，
        // 规划器不认这个词 => planRecovery 抛 invalid-observations => reconcile 变成 status:"error"，
        // 恢复恰好在对它存在的那种场景里永远不可能执行）。dead 裁决由 host-liveness.js 给出，它的依据
        // 只有 PID 消失或进程启动时刻不匹配——那正是“该宿主进程已退出”，所以诚实的 proof 是
        // "process-exit"：不声称更强的东西（不是注册表、也不是 worker 会话 id）。
        workerLiveness: async (record) => {
          try {
            // 没领到 epoch => 没有存活证明来源。连本进程自己的记录也只能 unknown（fail closed）。
            if (!hostEpoch.epochId || !hostEpoch.dir) return { state: "unknown" };
            if (record && record.hostInstanceId === jobState.hostInstanceId) return { state: "alive" };
            if (!record || typeof record.hostInstanceId !== "string" || record.hostInstanceId.length === 0) {
              return { state: "unknown" };
            }
            const proof = await __livenessInternals.proveEpochFor({
              dir: hostEpoch.dir,
              hostInstanceId: record.hostInstanceId,
            });
            if (proof?.verdict === "dead") return { state: "stopped", proof: "process-exit" };
            return { state: "unknown" };
          } catch {
            // 探测抛错同样不是 stopped：unknown 才是诚实的答案。
            return { state: "unknown" };
          }
        },
        // 内容闸门必须注入：jobs.js 在未注入时不判定（等于没有质量门），宿主这里永远给出真实实现，
        // 用 resolve-config 的同一份有效配置判定字数/引用/图/known-issues/页数，不达标即 content-gate-failed。
        contentGate: evaluateContentGate,
        logger: ctx.logger,
        wikiDirName,
        builderPath,
        jobTimeoutMs: config.jobTimeoutMs,
        buildTimeoutMs: config.buildTimeoutMs,
        selfcheckTimeoutMs: config.selfcheckTimeoutMs,
        pollMs: config.pollMs,
        disposeTimeoutMs: jobConfig.disposeTimeoutMs,
        ...(typeof config.pythonPath === "string" && config.pythonPath ? { pythonPath: config.pythonPath } : {}),
      });
      // 已知根存在时提前打开 store：构造失败要在运行任何作业之前暴露。
      if (jobAllowedRoots().length > 0) await openJobStore();
      jobState.status = "ready";
    } catch (error) {
      // 回滚，严格逆构造顺序：manager → guard → preset。每一步都不许抛出（回滚永远不掩盖
      // 原始构造错误），manager 先置空再 dispose，保证 dispose 恰好一次——包括卸载路径。
      await disposeJobManager();
      if (jobState.guard) {
        const guard = jobState.guard;
        jobState.guard = null;
        try { guard.releaseAll?.(); } catch (rollbackError) {
          logWarn(`dsh-wiki: could not release the worker guard during rollback: ${rollbackError?.message ?? rollbackError}`);
        }
      }
      if (jobState.disposePreset) {
        const dispose = jobState.disposePreset;
        jobState.disposePreset = null;
        try { await dispose(); } catch (rollbackError) {
          logWarn(`dsh-wiki: could not unregister the worker preset during rollback: ${rollbackError?.message ?? rollbackError}`);
        }
      }
      jobState.status = "failed";
      jobState.error = error;
      jobState.reasonDetail = error?.message ?? String(error);
      jobState.reasonCode = typeof error?.prerequisiteCode === "string" && PUBLIC_JOB_ERRORS[error.prerequisiteCode]
        ? error.prerequisiteCode
        : "jobs-initialization-failed";
      jobState.reason = PUBLIC_JOB_ERRORS[jobState.reasonCode];
      // 唯一一条警告：完整原因（含路径/内部细节）只进 logger。
      logWarn(`dsh-wiki: background wiki jobs could not start (${jobState.reasonCode}): ${jobState.reasonDetail}`);
    }
  };

  if (jobsEnabled) {
    jobState.ready = startJobRuntime();
    // 卸载顺序：管理器（终止 worker、遵守 journal 栅栏）→ guard → preset。任何一步都不许抛出。
    // guard 只释放确认停下的 worker：管理器报告的“未证明停下”的 worker 保留其 activation（见
    // releaseWorkerGuard）；释放它们必然要由 reconcile 在确认 worker 消失之后完成。
    // 每个作业的清理顺序（journal 栅栏 / 暂存 / 记录）由管理器自己保证。
    ctx.effect(() => async () => {
      await jobState.ready?.catch?.(() => {});
      const outcome = await disposeJobManager();
      releaseWorkerGuard(outcome);
      if (jobState.disposePreset) {
        const dispose = jobState.disposePreset;
        jobState.disposePreset = null;
        try { await dispose(); } catch (error) {
          // 保留栅栏给 reconcile：卸载只记警告，不重试、不删除任何目录。
          logWarn(`dsh-wiki: could not unregister the worker preset: ${error?.message ?? error}`);
        }
      }
      jobState.status = "disposed";
    }, "dsh-wiki: jobs");
  }

  // HEAD lookups drive the grid's "update available" badge. /api/projects is polled and can
  // cover many roots, so spawn git without a shell, cache per root (failures included), and
  // bound both the number of concurrent git processes and the cache size.
  const GIT_HEAD_TTL = 10000;
  const GIT_HEAD_CACHE_MAX = 64;
  const GIT_HEAD_CONCURRENCY = 4;
  const gitHeadCache = new Map(); // root -> { sha, at, pending? }
  let gitHeadRunning = 0;
  const gitHeadQueue = [];
  const runGitHead = (root) => new Promise((resolve) => {
    // execFile（无 shell）+ 超时；只读 HEAD 指针，不读对象内容
    try {
      execFile("git", ["-C", root, "rev-parse", "HEAD"], { timeout: 2000, windowsHide: true, maxBuffer: 4096 }, (err, stdout) => {
        const sha = String(stdout ?? "").trim();
        resolve(!err && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha) ? sha : null);
      });
    } catch { resolve(null); }
  });
  const pumpGitHead = () => {
    while (gitHeadRunning < GIT_HEAD_CONCURRENCY && gitHeadQueue.length) gitHeadQueue.shift()();
  };
  const limitedGitHead = (root) => new Promise((resolve) => {
    const task = () => {
      gitHeadRunning++;
      runGitHead(root).then((sha) => resolve(sha), () => resolve(null)).finally(() => {
        gitHeadRunning--;
        pumpGitHead();
      });
    };
    if (gitHeadRunning < GIT_HEAD_CONCURRENCY) task();
    else gitHeadQueue.push(task);
  });
  const trimGitHeadCache = () => {
    while (gitHeadCache.size > GIT_HEAD_CACHE_MAX) gitHeadCache.delete(gitHeadCache.keys().next().value);
  };
  const gitHead = (root) => {
    const now = Date.now();
    const hit = gitHeadCache.get(root);
    if (hit?.pending) return hit.pending; // one git process per root at a time
    if (hit && now - hit.at < GIT_HEAD_TTL) return Promise.resolve(hit.sha);
    const pending = limitedGitHead(root).then((sha) => {
      gitHeadCache.delete(root); // re-insert so a resolved entry is the newest, not the oldest
      gitHeadCache.set(root, { sha, at: Date.now() });
      trimGitHeadCache();
      return sha;
    });
    gitHeadCache.delete(root);
    gitHeadCache.set(root, { sha: null, at: now, pending });
    trimGitHeadCache();
    return pending;
  };

  // ---------- agent 工具面（spec 014）：五个原生工具 + 同一套新鲜度 ----------
  // 仓库解析顺序（FR-004）：显式 repo（必须已经是发现列表里的根，或真的含 <wikiDirName>/wiki.json）>
  // 会话工作区 > 唯一已发现的 wiki 根。歧义与未知都是定型错误，绝不猜一个仓库。
  // 候选只报**名字**（basename）：工具结果里除已解析的根以外不出现别的绝对路径。
  const candidateNames = (roots) => [...new Set(roots.map((root) => path.basename(root)))]
    .sort()
    .slice(0, 10);
  const knownRootIndex = () => {
    const map = new Map();
    for (const project of knownProjects()) map.set(pathKey(project.root), project.root);
    return map;
  };
  /** 该根下是否有**受控可读**的 wiki.json（链接/别名/非普通文件一律不算）。 */
  const hasWikiFile = async (root) => {
    try {
      return (await identityOf(path.join(root, wikiDirName, "wiki.json"))).kind === "file";
    } catch {
      return false;
    }
  };
  const WIKI_REL = path.join(wikiDirName, "wiki.json");
  const resolveWikiRepo = async ({ explicit, sessionCwd } = {}) => {
    const known = knownRootIndex();
    const isKnown = (root) => known.has(pathKey(root));
    const accept = async (raw) => {
      if (typeof raw !== "string" || raw.length === 0 || raw.length > 4096 || raw.includes("\u0000") || !path.isAbsolute(raw)) {
        return { ok: false, code: "repo-invalid", error: "repo must be an absolute repository path" };
      }
      const canonical = await canonicalProjectRoot(raw);
      if (!canonical) {
        return { ok: false, code: "repo-not-trusted", error: "that path is not a trusted project root (a link, an alias or an unknown location)" };
      }
      if (isKnown(canonical) || await hasWikiFile(canonical)) return { ok: true, root: canonical };
      return {
        ok: false,
        code: "repo-unknown",
        error: `that path is neither a known wiki root nor a repository that contains ${WIKI_REL}`,
        candidates: candidateNames([...known.values()]),
      };
    };
    if (typeof explicit === "string" && explicit.length > 0) return accept(explicit);
    if (typeof sessionCwd === "string" && path.isAbsolute(sessionCwd)) {
      const canonical = await canonicalProjectRoot(sessionCwd);
      if (canonical && (isKnown(canonical) || await hasWikiFile(canonical))) return { ok: true, root: canonical };
    }
    // 唯一已发现的 wiki 根：只有“恰好一个”才能被当成默认目标。
    const withWiki = [];
    const seen = new Set();
    for (const project of knownProjects()) {
      const canonical = await canonicalProjectRoot(project.root);
      if (!canonical) continue;
      const key = pathKey(canonical);
      if (seen.has(key)) continue;
      seen.add(key);
      if (await hasWikiFile(canonical)) withWiki.push(canonical);
    }
    if (withWiki.length === 1) return { ok: true, root: withWiki[0] };
    if (withWiki.length === 0) {
      return {
        ok: false,
        code: "repo-unknown",
        error: `no repository with a readable ${WIKI_REL} was discovered; pass repo explicitly`,
        candidates: candidateNames([...known.values()]),
      };
    }
    return {
      ok: false,
      code: "repo-ambiguous",
      error: "more than one repository has a wiki; pass repo explicitly",
      candidates: candidateNames(withWiki),
    };
  };
  /**
   * 读并解析一个仓库的 wiki。两个文件都在 <root>/<wikiDirName>/ 之内，都走受控读
   *（逐级无链接 + 单链接普通文件 + 句柄身份），失败只给固定 code/短句。
   * generation-meta.json 是 sourceCommit 的唯一来源（实测 wiki.json 没有这个键）。
   */
  const loadWikiSnapshot = async (root) => {
    const wikiPath = path.join(root, WIKI_REL);
    let wikiText;
    try {
      wikiText = (await readContainedFile(root, WIKI_REL, "utf8")).text;
    } catch (error) {
      const code = typeof error?.code === "string" ? error.code : "";
      if (ABSENT_READ_CODES.has(code)) {
        // error 是**给模型看的**短句：只出现 wiki 相对路径（<wikiDirName>/wiki.json）。绝对宿主路径在这里
        // 既没有用处，又会把宿主目录布局带进工具结果。结构化字段 wikiPath 仍是绝对形式，供内部调用方使用。
        return {
          ok: false,
          code: "wiki-not-generated",
          error: `no wiki for this repository; expected ${WIKI_REL} (generate it with /wiki generate)`,
          wikiPath,
        };
      }
      warnUntrustedWiki(root, error);
      return {
        ok: false,
        code: "wiki-unreadable",
        error: "the wiki file is not a regular file inside this project, so it is not readable",
        wikiPath,
      };
    }
    let metaText = null;
    try {
      metaText = (await readContainedFile(root, path.join(wikiDirName, "generation-meta.json"), "utf8")).text;
    } catch {
      // 元数据缺失只影响新鲜度（=> unknown），不影响检索。
      metaText = null;
    }
    return __wikiToolInternals.parseSnapshot(wikiText, { root, wikiDirName, metaText });
  };
  // 新鲜度：HEAD 走本文件既有的一枚缓存探针（/api/projects 也用它），behind/changedFiles 由
  // wiki-tools 的 git 探针补；算术只在一处（wiki-knowledge.freshnessOf），因此面板与工具不可能给出两个答案。
  const gitProbe = __wikiToolInternals.createGitProbe({ execFile });
  const sharedGit = { ...gitProbe, head: (root) => gitHead(root) };
  const wikiFreshness = (root, sourceCommit) => __wikiToolInternals.computeFreshness(sharedGit, { root, sourceCommit });
  const wikiToolDeps = {
    wikiDirName,
    logWarn,
    resolveRepo: resolveWikiRepo,
    loadSnapshot: loadWikiSnapshot,
    freshness: wikiFreshness,
  };
  // tools 服务**惰性**解析（见文件顶部 inject 的说明）：`tools` 不是硬依赖，所以这里可能拿到 undefined；
  // ctx.get 本身不存在（更老的 Host）同样只是一条降级路径，绝不让 apply() 抛错。
  const toolsService = typeof ctx.get === "function" ? ctx.get("tools") : undefined;
  // 注册与释放都留在同一个 effect 里：插件卸载时五个工具一起撤掉（register() 返回的就是精确 disposer）。
  // 没有 tools 服务时 registerWikiTools 自己只记一条 warning 并返回 []，其余表面照旧工作。
  ctx.effect(() => {
    const disposers = __wikiToolInternals.registerWikiTools(toolsService, wikiToolDeps);
    return () => {
      for (const dispose of disposers) {
        try { dispose(); } catch (error) {
          logWarn(`dsh-wiki: could not unregister a wiki tool: ${String(error?.message ?? error)}`);
        }
      }
    };
  }, "dsh-wiki: tools");
  /**
   * 项目摘要只读元数据：一律走受控读（链接换掉的 .dsh-wiki 不得提供内容）。
   * 不存在 => null（正常）；不可信/读失败 => null + 一条有界警告，并把它报告成“未生成”。
   * updatedAt 取**打开后句柄**的 mtime：与读到的字节同源，不是再 stat 一次路径。
   */
  const readProjectJson = async (root, name) => {
    try {
      const read = await readContainedFile(root, path.join(wikiDirName, name), "utf8");
      let json = null;
      try { json = JSON.parse(read.text); } catch { json = null; }
      return { json, mtime: read.mtime };
    } catch (error) {
      warnUntrustedWiki(root, error);
      return null;
    }
  };
  /**
   * @param {object} p 已授权的项目
   * @param {boolean} withHead 是否解析 HEAD（/api/projects 轮询用得到）
   * @param {boolean} withFreshness 是否补 stale/behind/changedFiles（与 wiki_status 工具同一个函数；
   *   /api/project 用，/api/projects 不用——一轮轮询不该为每个根多跑两个 git 进程）
   */
  const projectSummary = async (p, withHead, withFreshness = false) => {
    const dir = path.join(p.root, wikiDirName);
    const wikiRead = await readProjectJson(p.root, "wiki.json");
    const metaRead = await readProjectJson(p.root, "generation-meta.json");
    const wiki = wikiRead?.json ?? null;
    const meta = metaRead?.json ?? null;
    const updatedAt = wikiRead?.mtime instanceof Date ? wikiRead.mtime.toISOString() : null;
    const generated = !!(wiki && typeof wiki === "object" && Array.isArray(wiki.pages));
    const sourceCommit = typeof meta?.sourceCommit === "string" ? meta.sourceCommit : null;
    // 需要完整新鲜度时由同一个函数给出 head，保证 head/updateAvailable 与 stale 不可能彼此矛盾。
    const fresh = withFreshness ? await wikiFreshness(p.root, generated ? sourceCommit : null) : null;
    // No recorded sourceCommit means updateAvailable can never be true: skip the git process.
    const head = fresh?.head ?? (withHead && generated && sourceCommit ? await gitHead(p.root) : null);
    return {
      root: p.root,
      title: (generated && typeof wiki.title === "string" && wiki.title) || p.title || path.basename(p.root),
      generated,
      pageCount: generated ? wiki.pages.length : 0,
      cardCount: generated && Array.isArray(wiki.cards) ? wiki.cards.length : 0,
      language: generated && typeof wiki.language === "string" ? wiki.language : null,
      updatedAt,
      sourceCommit,
      head,
      updateAvailable: !!(generated && head && sourceCommit && head !== sourceCommit),
      // 新鲜度闸门（spec 014）：面板与 wiki_status 工具由同一个函数计算，两者不可能给出不同答案。
      stale: fresh ? fresh.stale : null,
      behind: fresh ? fresh.behind : null,
      changedFiles: fresh ? fresh.changedFiles : [],
      hasSite: await containedFileExists(p.root, path.join(wikiDirName, "site", "index.html")),
      dir,
      // DSH 工作区 id（workspaceRegistry 知道该路径时）：客户端据此 startSession，免去按路径查找
      workspaceId: p.workspaceId ?? null,
    };
  };
  const mermaidAsset = path.join(pluginRoot, "assets", "mermaid.min.js");
  // Mermaid renders inside a sandboxed iframe (sandbox="allow-scripts", no allow-same-origin): the
  // frame runs in an opaque origin, so CSP 'self' and same-origin script URLs are unreliable there.
  // The runtime and the bootstrap are therefore inlined into the frame response and allowed by a
  // per-response nonce. Source arrives via postMessage; the frame posts back height or an error.
  let mermaidJsCache = null;
  const mermaidJs = async () => {
    if (mermaidJsCache !== null) return mermaidJsCache;
    let js = "";
    try { js = await readFile(mermaidAsset, "utf8"); } catch { js = ""; }
    // break script-closing and comment-opening sequences so the inline <script> cannot end early
    mermaidJsCache = js.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");
    return mermaidJsCache;
  };
  // Qoder-like look: 16px system font, white rounded nodes, light borders, gray arrows; natural size
  // (useMaxWidth:false) so the parent decides scaling. The frame reports the SVG's natural width/height.
  const mermaidFrame = (nonce, js) => `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>html,body{margin:0;background:transparent;overflow:hidden}#o{display:inline-block;padding:0}#o svg{max-width:none!important;display:block}</style>
</head><body><div id="o"></div>
<script nonce="${nonce}">${js}</script>
<script nonce="${nonce}">(function(){var ns=window.__esbuild_esm_mermaid_nm;var m=(ns&&ns.mermaid)&&(ns.mermaid.default||ns.mermaid);
var post=function(d){try{parent.postMessage(Object.assign({dshWikiMermaid:1},d),"*")}catch(e){}};
var FONT='-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif';
var vars=function(dark){return dark
 ?{background:"transparent",primaryColor:"#111827",primaryBorderColor:"#374151",primaryTextColor:"#f3f4f6",secondaryColor:"#1f2937",tertiaryColor:"#1f2937",lineColor:"#6b7280",textColor:"#e5e7eb",mainBkg:"#111827",nodeBorder:"#374151",clusterBkg:"#111827",clusterBorder:"#374151",edgeLabelBackground:"#1f2937",fontFamily:FONT,fontSize:"16px"}
 :{background:"transparent",primaryColor:"#ffffff",primaryBorderColor:"#e5e7eb",primaryTextColor:"#111827",secondaryColor:"#f9fafb",tertiaryColor:"#f9fafb",lineColor:"#9ca3af",textColor:"#374151",mainBkg:"#ffffff",nodeBorder:"#e5e7eb",clusterBkg:"#ffffff",clusterBorder:"#e5e7eb",edgeLabelBackground:"#f3f4f6",fontFamily:FONT,fontSize:"16px"};};
window.addEventListener("message",function(e){if(e.source!==parent)return;var d=e.data||{};if(!d.dshWikiRender)return;
if(!m){post({id:d.id,error:"mermaid runtime unavailable"});return;}
try{m.initialize({startOnLoad:false,securityLevel:"strict",theme:"base",themeVariables:vars(!!d.dark),fontSize:16,
 flowchart:{useMaxWidth:false,htmlLabels:true,padding:16,nodeSpacing:50,rankSpacing:60,curve:"basis"},
 sequence:{useMaxWidth:false},class:{useMaxWidth:false},state:{useMaxWidth:false},er:{useMaxWidth:false},gantt:{useMaxWidth:false}});
m.render("g"+Date.now(),String(d.src||"")).then(function(r){var o=document.getElementById("o");o.innerHTML=r.svg;
var s=o.querySelector("svg");if(s){s.querySelectorAll("rect.basic,.node rect").forEach(function(n){n.setAttribute("rx","8");n.setAttribute("ry","8")});}
var b=s?s.getBoundingClientRect():o.getBoundingClientRect();
post({id:d.id,width:Math.ceil(b.width),height:Math.ceil(b.height)})}).catch(function(err){post({id:d.id,error:String(err&&err.message||err)})});}
catch(err){post({id:d.id,error:String(err&&err.message||err)})}});
post({ready:1,mermaid:!!m});})();</script></body></html>`;
  const knownWikis = () =>
    knownRoots()
      .map((r) => wikiFor(r, wikiDirName))
      .filter(Boolean)
      .map((w) => ({ ...w, title: wikiTitle(w.root) ?? w.title }))
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
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>dsh-wiki · local wiki index</title>
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
<div class="sub">Local Repo Wiki · generate with <code>/wiki generate</code> · output in the repository's <code>${escapeHtml(wikiDirName)}/</code> · sibling and child folders of session workspaces are discovered automatically</div>
<ul>${rows}</ul>
</main>${backBarScript()}</body></html>`;
  };
  const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  // 独立窗口打开时的返回入口：桌面端窗口标题栏（caption 按钮）覆盖页面顶部 ~40px，
  // 所以按钮固定在左上角、留 44px 安全边距，高对比、最小点击高度 40px，并标记 no-drag
  //（Electron 可拖拽标题区会吞掉点击）。
  // 点击语义：先试 window.close()（window.open 出来的窗口直接关掉）；关不掉时——
  // 存在同源历史（referrer 同源且 history.length>1）就 history.back() 回到 DSH，
  // 否则 location.assign("/") 回宿主根路径。
  // 若已被嵌入 iframe（侧栏面板内嵌阅读），直接跳过——那时「返回」应由面板自身承担，
  // 兜底 location.assign("/") 会把 iframe 导航成应用套应用。
  const backBarScript = () =>
    `<script>(function(){if(window.self!==window.top)return;` +
    `var b=document.createElement("button");b.type="button";b.textContent="← Back to DSH";` +
    `b.setAttribute("aria-label","Back to DSH");` +
    `b.onclick=function(){try{window.close();}catch(e){}` +
    `setTimeout(function(){` +
    `var sameOrigin=false;try{sameOrigin=!!(document.referrer&&document.referrer.indexOf(location.origin)===0);}catch(e){sameOrigin=false;}` +
    `if(sameOrigin&&history.length>1){try{history.back();return;}catch(e){}}` +
    `try{location.assign("/");}catch(e){}},120)};` +
    `b.style.cssText="position:fixed;left:16px;top:44px;z-index:2147483647;display:inline-flex;align-items:center;` +
    `min-height:40px;padding:0 16px;border-radius:9px;border:1px solid #94a3b8;` +
    `background:#111318;color:#f8fafc;font:600 14px/1.2 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;` +
    `cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.35);-webkit-app-region:no-drag";` +
    `document.body.appendChild(b)})()</script>`;

  // ---------- /api/status：显式 allowlist 投影（默认 jobs-disabled surface） ----------
  // 默认 surface 是诊断面，不是文件清单：old 实现把 builder 绝对路径、clientPath 以及
  // clientModules.graph() 的 JSON 片段直接放进响应体，于是 graph 条目里的 provider/builder
  // error/stack/stderr（例如 PRIVATE_BUILDER_STDERR、C:\private\.dsh-wiki.staging-secret）
  // 会被逐字回显。graph() 的内容完全不可信，这里只读取条目的 id 形状并与固定 id 比较：
  // 绝不序列化 graph、绝不回显任何字段值；失败时的原始文本只进 logger，响应只有稳定 code。
  const CLIENT_MODULE_ID = "@dsh-ext/dsh-wiki";
  const graphHasClientModule = (graph) => {
    const ids = [];
    const addId = (entry) => {
      // 只读 id 的“形状”，不序列化、不回显值；长度上限避免把一条不可信的巨大 id 拖进比较。
      if (typeof entry === "string") { if (entry.length <= 256) ids.push(entry); return; }
      if (entry && typeof entry === "object" && typeof entry.id === "string" && entry.id.length <= 256) ids.push(entry.id);
    };
    for (const list of [graph?.entries, graph?.modules, Array.isArray(graph) ? graph : null]) {
      if (Array.isArray(list)) for (const entry of list) addId(entry);
    }
    if (graph instanceof Map) for (const key of graph.keys()) addId(key);
    return ids.includes(CLIENT_MODULE_ID);
  };
  const clientModuleStatus = () => {
    let cm;
    try {
      cm = ctx.get?.("clientModules");
    } catch (error) {
      logWarn(`dsh-wiki: client module diagnostics unavailable: ${String(error?.message ?? error)}`);
      return { service: false, loaded: false, code: "client-module-unavailable" };
    }
    if (!cm || typeof cm !== "object") return { service: false, loaded: false, code: "client-module-unavailable" };
    if (typeof cm.graph !== "function") return { service: true, loaded: false, code: "client-module-graph-unavailable" };
    try {
      const loaded = graphHasClientModule(cm.graph());
      return { service: true, loaded, code: loaded ? null : "client-module-not-loaded" };
    } catch (error) {
      // 异常文本可能带路径/stack：只进 logger，客户端只拿到固定 code。
      logWarn(`dsh-wiki: client module diagnostics failed: ${String(error?.message ?? error)}`);
      return { service: true, loaded: false, code: "client-module-diagnostics-failed" };
    }
  };
  // 作业可用性：只回报 enabled/available/state + 稳定 code；reasonDetail、storeDir、preset 与
  // 构造期异常文本一律只进 logger（state 是本文件自己的固定枚举，不是外部输入）。
  const jobsAvailability = () => {
    const state = jobState.status;
    const code = state === "disabled" ? "jobs-disabled"
      : state === "disposed" ? "plugin-unloaded"
        : state === "failed"
          ? (typeof jobState.reasonCode === "string" && PUBLIC_JOB_ERRORS[jobState.reasonCode]
            ? jobState.reasonCode : "jobs-initialization-failed")
          : null;
    return { enabled: jobsEnabled, available: state === "ready", state, code };
  };

  /**
   * POST /api/jobs 与 /api/jobs/cancel。默认（jobs.enabled=false）根本走不到这里——路由在上面直接返回
   * 与今天逐字节相同的 503。开启后：同源 → 可用性 → content-type → 有界 JSON → 字段/模式 → 白名单根 →
   * 管理器。本切片不认识的字段与模式一律**显式拒绝**（绝不静默丢弃调用方请求：把 incremental 悄悄
   * 降级成全量生成会让调用方以为增量语义生效）。JobError 的 status/code 原样映射；响应体永远只有固定
   * 短句，路径/journal 细节与 fs 错误文本只进 logger。
   * 同源语义：Origin 的 scheme 必须等于请求实际到达的传输（socket 是否 TLS），host:port 必须与 Host 头
   * 逐字符一致；Host 头本身决定不了 scheme，所以 https 的 Origin 在明文回环监听上一律不信任
   * （详见 jobs.js isSameOrigin）。
   *
   * 契约（如实）：作业被管理器接纳时同步返回 202，此后才发生的 mount/worker/构建失败只会出现在作业
   * 视图里（failed/quarantined），不会把已经发出的 202 改写成错误。202 只表示“已接纳”，
   * 既不代表 worker 已被隔离，也不代表 T019 的运行时证明成立。
   */
  const handleJobPost = async (req, res, pathname) => {
    if (!isSameOrigin(req)) {
      return writeJson(res, 403, { error: "the request is not a loopback same-origin request", code: "cross-origin" });
    }
    const unavailable = await jobUnavailable();
    if (unavailable) return writeJson(res, 503, { error: unavailable.error, code: unavailable.code, disabled: true });
    if (!isJsonContentType(req?.headers?.["content-type"])) {
      return writeJson(res, 415, { error: "content-type must be application/json", code: "content-type" });
    }
    const body = await readBoundedJson(req, JOB_BODY_LIMIT_BYTES);
    if (!body.ok) {
      // 只有被放弃的读取（超时/溢出/中止）才需要调用方关闭 socket；普通 400 要把连接留着。
      if (body.abandoned === true) closeAfterResponse(req, res);
      return writeJson(res, body.status, { error: body.error });
    }
    const value = isPlainRecord(body.value) ? body.value : null;
    if (!value) return writeJson(res, 400, { error: "request body must be a JSON object", code: "invalid-request" });
    const allowedFields = JOB_REQUEST_FIELDS[pathname] ?? JOB_REQUEST_FIELDS[`${ROUTE}/api/jobs`];
    const unknownFields = Object.keys(value).filter((key) => !allowedFields.has(key));
    if (unknownFields.length > 0) {
      return writeJson(res, 400, {
        error: `${PUBLIC_JOB_ERRORS["unsupported-field"]}: ${unknownFields.join(", ")}`,
        code: "unsupported-field",
        unsupportedFields: unknownFields,
      });
    }
    // 嵌套 model 的未知字段与顶层同一规则：显式拒绝，绝不丢弃。
    if (isPlainRecord(value.model)) {
      const unknownModelFields = Object.keys(value.model).filter((key) => key !== "provider" && key !== "model");
      if (unknownModelFields.length > 0) {
        return writeJson(res, 400, {
          error: `${PUBLIC_JOB_ERRORS["unsupported-field"]}: ${unknownModelFields.map((key) => `model.${key}`).join(", ")}`,
          code: "unsupported-field",
          unsupportedFields: unknownModelFields.map((key) => `model.${key}`),
        });
      }
    }
    // 严格字段校验（T011）：全部在 store 打开、manager.start 与任何写盘之前完成。
    const validated = validateJobRequest(value, pathname);
    if (!validated.ok) return writeJson(res, validated.status, { error: validated.error, code: validated.code });
    // 白名单根必须能被证明是规范根（无链接分量）：junction 换掉的根不再接受作业。
    const project = await projectFor(validated.value.root);
    if (!project) return writeJson(res, 403, { error: PUBLIC_JOB_ERRORS["unknown-root"], code: "unknown-root" });
    const manager = jobState.manager;
    if (!manager) {
      return writeJson(res, 503, { error: PUBLIC_JOB_ERRORS["jobs-unavailable"], code: "jobs-unavailable", disabled: true });
    }
    try {
      if (pathname === `${ROUTE}/api/jobs/cancel`) {
        return writeJson(res, 200, { ok: true, ...manager.cancel(project.root) });
      }
      // 增量前置解析（spec 013 §2.2 步骤 1–4）必须在 manager.start **之前**完成，也放在打开 journal
      // store 之前：调用方要求增量时，要么真的增量，要么一个明确的 409 拒绝——绝不是一个“已接纳、随后
      // 失败”的作业，也绝不是静默的全量重建，更不能留下任何运行时副作用。这段解析只读（live 元数据、
      // HEAD、祖先关系、diff-impact），不写盘、不建作业。
      let incrementalPlan = null;
      if (validated.value.incremental === true) {
        if (typeof manager.incrementalPlan !== "function") {
          logWarn("dsh-wiki: the job manager cannot resolve an incremental plan; refusing instead of rebuilding the whole wiki");
          return writeJson(res, 409, { error: PUBLIC_JOB_ERRORS["incremental-unavailable"], code: "incremental-unavailable" });
        }
        try {
          incrementalPlan = await manager.incrementalPlan(project.root);
        } catch (error) {
          const mapped = publicJobError(error);
          // detail 只放**去路径**的有界首行（fixed 短句仍是 error 字段本身）；原始首行只进 logger。
          const builderLine = typeof error?.builderLine === "string" && error.builderLine.length > 0 ? error.builderLine : null;
          const builderRaw = typeof error?.builderRaw === "string" && error.builderRaw.length > 0 ? ` (builder: ${error.builderRaw})` : "";
          logWarn(`dsh-wiki: incremental update refused (${mapped.code}): ${error?.message ?? error}${builderRaw}`);
          return writeJson(res, mapped.status, {
            error: mapped.error,
            code: mapped.code,
            ...(builderLine === null ? {} : { detail: builderLine }),
          });
        }
      }
      // 可信 journal 必须在任何作业运行之前就绪；打不开就是 503，不会是“半途失败”。
      try {
        await openJobStore();
      } catch (error) {
        logWarn(`dsh-wiki: the trusted journal store is unavailable: ${error?.message ?? error}`);
        // 原因自带稳定 code（journal-store-unavailable / root-untrusted）：如实回报，不再统一折叠成
        // “store 不可用”。响应体仍然只有固定短句，路径与原始文本只进 logger。
        const code = typeof error?.prerequisiteCode === "string" && PUBLIC_JOB_ERRORS[error.prerequisiteCode]
          ? error.prerequisiteCode
          : "journal-store-unavailable";
        return writeJson(res, 503, { error: PUBLIC_JOB_ERRORS[code], code, disabled: true });
      }
      const job = manager.start({
        root: project.root,
        action: validated.value.action,
        model: validated.value.model,
        targetLang: validated.value.targetLang,
        // 增量：只有这里带键。plan 是**已解析**的（基线/HEAD/祖先/影响映射），作业自己还会再解析一次。
        ...(incrementalPlan === null ? {} : { incremental: incrementalPlan }),
      });
      // 202 = 已接纳（同步返回）。之后的 mount/worker 失败在作业视图里体现，不会回写这个 202；
      // 202 不声称 worker 已被隔离，也不声称 T019 运行时证明成立。
      return writeJson(res, 202, { ok: true, job: publicJobView(job) });
    } catch (error) {
      const mapped = publicJobError(error);
      logWarn(`dsh-wiki: background wiki job request failed (${mapped.code}): ${error?.message ?? error}`);
      return writeJson(res, mapped.status, { error: mapped.error, code: mapped.code });
    }
  };

  /**
   * POST /api/jobs/recovery-execute（T018）：journal 恢复的**执行**入口；只读计划仍是
   * GET /api/jobs/recovery-plan。
   *
   * 为什么是进程内路由而不是 CLI 脚本：待释放的是管理器 `jobs` Map 里的**内存**栅栏，
   * 进程外的脚本永远撤销不了它，reconcile({execute:true}) 只能由本进程调用（见 jobs.js 的
   * reconcile 注释）。为什么必须显式 confirm：本路由会执行计划、改盘并释放栅栏，一次跨站或手滑
   * 的 fetch 不得触发它，所以 confirm 必须是字面量 "execute-recovery"——只带 root 的请求永远
   * 400 confirmation-required，绝不执行。
   *
   * 前导顺序与 handleJobPost 相同：同源 → 可用性 → content-type → 有界 JSON → 字段白名单 →
   * root/confirm → 白名单根 → store。响应只有固定键与稳定 code；result 里的 root/jobId/message/
   * observations/plan 一概不回显，路径与原始文本只进 logger。
   */
  const handleRecoveryExecutePost = async (req, res) => {
    if (!isSameOrigin(req)) {
      return writeJson(res, 403, { error: PUBLIC_JOB_ERRORS["cross-origin"], code: "cross-origin" });
    }
    const unavailable = await jobUnavailable();
    if (unavailable) return writeJson(res, 503, { error: unavailable.error, code: unavailable.code, disabled: true });
    if (!isJsonContentType(req?.headers?.["content-type"])) {
      return writeJson(res, 415, { error: PUBLIC_JOB_ERRORS["content-type"], code: "content-type" });
    }
    const body = await readBoundedJson(req, JOB_BODY_LIMIT_BYTES);
    if (!body.ok) {
      // 与 handleJobPost 同一约定：放弃读取的请求由调用方在响应 flush 之后关闭 socket。
      if (body.abandoned === true) closeAfterResponse(req, res);
      return writeJson(res, body.status, { error: body.error });
    }
    const value = isPlainRecord(body.value) ? body.value : null;
    if (!value) return writeJson(res, 400, { error: PUBLIC_JOB_ERRORS["invalid-request"], code: "invalid-request" });
    const allowedFields = JOB_REQUEST_FIELDS[`${ROUTE}/api/jobs/recovery-execute`];
    const unknownFields = Object.keys(value).filter((key) => !allowedFields.has(key));
    if (unknownFields.length > 0) {
      // 本路由不反射调用方输入：键名可能是一条路径，所以只回固定短句与稳定 code，
      // 不给 unsupportedFields（其它作业路由的既有形状不变）。
      return writeJson(res, 400, {
        error: PUBLIC_JOB_ERRORS["unsupported-field"],
        code: "unsupported-field",
      });
    }
    // root 与其它作业 POST 用同一形状规则；confirm 只认字面量（见上方说明）。
    if (!Object.hasOwn(value, "root") || typeof value.root !== "string" || value.root.length === 0
      || value.root.length > ROOT_MAX || CONTROL_CHARS_RE.test(value.root) || !path.isAbsolute(value.root)) {
      return writeJson(res, 400, { error: PUBLIC_JOB_ERRORS["invalid-root"], code: "invalid-root" });
    }
    if (!Object.hasOwn(value, "confirm") || value.confirm !== RECOVERY_EXECUTE_CONFIRM) {
      // PUBLIC_JOB_ERRORS 在 jobs.js 里（本切片不改它），所以短句在这里就地固定：不含任何动态文本。
      return writeJson(res, 400, { error: "confirm must be the literal string execute-recovery", code: "confirmation-required" });
    }
    // 根的授权与其它作业路由完全相同：规范根 + 已登记根（链接/别名/未知根 => 403 unknown-root）。
    const project = await projectFor(value.root);
    if (!project) return writeJson(res, 403, { error: PUBLIC_JOB_ERRORS["unknown-root"], code: "unknown-root" });
    const manager = jobState.manager;
    if (!manager) {
      return writeJson(res, 503, { error: PUBLIC_JOB_ERRORS["jobs-unavailable"], code: "jobs-unavailable", disabled: true });
    }
    // 与 handleJobPost 同一前提：可信 journal 必须在任何执行之前就绪，打不开就是 503（不会是“半途失败”）。
    // 恢复还需要第二个、**未钉死**的 store 实例：宿主重启后普通 store 的 pin 必然配不上上一条记录，
    // 执行器会在 rename 之前拒绝（见 openRecoveryStore）。两者都在执行之前打开，失败一律 503。
    let recoveryStore;
    try {
      await openJobStore();
      recoveryStore = await openRecoveryStore();
    } catch (error) {
      logWarn(`dsh-wiki: the trusted journal store is unavailable: ${error?.message ?? error}`);
      const code = typeof error?.prerequisiteCode === "string" && PUBLIC_JOB_ERRORS[error.prerequisiteCode]
        ? error.prerequisiteCode
        : "journal-store-unavailable";
      return writeJson(res, 503, { error: PUBLIC_JOB_ERRORS[code], code, disabled: true });
    }
    let result;
    try {
      // 唯一一次执行入口：execute:true 才计划->执行->复验->释放内存栅栏（其余决定零副作用）。
      // recovery:true 是给未钉死 store 的显式授权：执行器拒绝在没有它的情况下用未钉死的 store 做
      // restore-backup，因此这个组合无法被别的接线顺手复用。
      result = await manager.reconcile(project.root, { execute: true, recovery: true, store: recoveryStore });
    } catch (error) {
      // 管理器抛错（例如缺依赖的 services-unavailable）：与其它作业 POST 同一投影，原文只进上方 logger。
      const mapped = publicJobError(error);
      result = { status: "error", code: mapped.code };
    }
    // 公开投影：只保留固定键；每个字段都只经白名单投影，未识别的值落到文档化的 fallback，
    // 所以 token 形状的内部标识符也不会被带出去。HTTP status 由投影后的 status 驱动。
    const status = projectAllowedValue(result?.status, STATUS_ALLOWED, "error");
    const httpStatus = status === "no-record" ? 404
      : status === "refused" ? 409
        : status === "execute-failed" || status === "error" ? 500
          : 200;
    // 缺省 code 表示“没有错误码”，回显 null；给了却不认识的值收敛为 internal-error，
    // 否则成功的执行会把 undefined 误报成 internal-error。
    const code = status === "no-record" ? "no-record"
      : projectOptionalValue(result?.code, CODE_ALLOWED, "internal-error");
    const released = result?.released === true;
    // releaseReason 与 releaseCode 同样过白名单：管理器给的任意字符串（可能含路径或内部 id）
    // 绝不进响应体，releaseReason 的 fallback 是 null（它没有 internal-error 这一说）。
    const releaseReason = projectOptionalValue(result?.releaseReason, RELEASE_REASON_ALLOWED, null);
    const releaseCode = projectOptionalValue(result?.releaseCode, RELEASE_CODE_ALLOWED, "internal-error");
    // 每次执行尝试恰好一条 warn：只有投影后的 status/code/布尔，永不带路径。
    logWarn(`dsh-wiki: recovery execute status=${status} code=${code} released=${released}`);
    return writeJson(res, httpStatus, {
      ok: httpStatus === 200,
      status,
      code,
      executed: result?.executed === true,
      effects: Number.isInteger(result?.effects) ? result.effects : 0,
      released,
      releaseReason,
      releaseCode,
    });
  };

  /**
   * POST /api/update（spec 016 §3.3）：把**已安装**的插件切换到上游更新的版本。
   *
   * 为什么必须显式 confirm：这条路由会请求上游并在安装目录里 `git checkout --detach` 另一个版本，
   * 一次跨站或手滑的 fetch 不得触发它。所以 confirm 必须是字面量 "install-update"，形状与
   * recovery-execute 的 "execute-recovery" 相同；没有它、或带了别的值，**服务一次都不会被调用**
   *（不是“先调用再拒绝”），所以坏 token 不产生任何网络请求、git 调用或磁盘动作。
   *
   * 前导顺序与其它写路由相同：同源 → content-type → 有界 JSON → 字段白名单 → confirm。之后服务按
   * §3.4 的固定顺序 preflight，首个失败即拒绝。响应体只有固定短句与 §3.5 的封闭 code：路径、git
   * stderr、上游错误文本一律不进响应体（服务根本不会返回它们，这里再按 code 白名单收敛一次）。
   * 本路由绝不 reload/restart 插件：成功只回答 reloadRequired，由 owner 决定何时重启。
   */
  const handleUpdatePost = async (req, res) => {
    if (!isSameOrigin(req)) {
      return writeJson(res, 403, { error: PUBLIC_JOB_ERRORS["cross-origin"], code: "cross-origin" });
    }
    if (!isJsonContentType(req?.headers?.["content-type"])) {
      return writeJson(res, 415, { error: PUBLIC_JOB_ERRORS["content-type"], code: "content-type" });
    }
    const body = await readBoundedJson(req, UPDATE_BODY_LIMIT_BYTES);
    if (!body.ok) {
      // 与作业 POST 同一约定：放弃读取（超时/溢出/中止）的请求由调用方在响应 flush 之后关 socket。
      if (body.abandoned === true) closeAfterResponse(req, res);
      return writeJson(res, body.status, { error: body.error });
    }
    const value = isPlainRecord(body.value) ? body.value : null;
    if (!value) return writeJson(res, 400, { error: PUBLIC_JOB_ERRORS["invalid-request"], code: "invalid-request" });
    // 未知字段不回显（键名可能是一条路径）：只回固定短句与稳定 code，与 recovery-execute 相同。
    if (Object.keys(value).some((key) => key !== "confirm")) {
      return writeJson(res, 400, { error: PUBLIC_JOB_ERRORS["unsupported-field"], code: "unsupported-field" });
    }
    if (!Object.hasOwn(value, "confirm") || value.confirm !== UPDATE_CONFIRM_TOKEN) {
      // 短句就地固定（UPDATE_REASON_MESSAGES 只描述 §3.5 的原因码，不含请求形状错误）。
      return writeJson(res, 400, {
        error: "confirm must be the literal string install-update",
        code: "confirmation-required",
      });
    }
    let result;
    try {
      result = await updateService.apply();
    } catch {
      // 服务的契约是“永不 throw”；真抛出来也绝不把异常文本带给调用方。
      result = null;
    }
    if (!result || result.ok !== true) {
      const code = typeof result?.code === "string" && Object.hasOwn(UPDATE_REASON_MESSAGES, result.code)
        ? result.code
        : "internal-error";
      const status = Number.isInteger(result?.status) && result.status >= 400 && result.status <= 599
        ? result.status
        : 500;
      const restored = typeof result?.restored === "boolean" ? result.restored : null;
      // 只记封闭 code 与布尔：版本号是 X.Y.Z，路径/stderr 从不进日志的这一句。
      logWarn(`dsh-wiki: update refused code=${code}${restored === null ? "" : ` restored=${restored}`}`);
      return writeJson(res, status, {
        error: UPDATE_REASON_MESSAGES[code],
        code,
        ...(restored === null ? {} : { restored }),
      });
    }
    logWarn(`dsh-wiki: update applied from=${result.from ?? "unknown"} to=${result.to} reloadRequired=true`);
    return writeJson(res, 200, {
      ok: true,
      applied: true,
      from: result.from ?? null,
      to: result.to,
      reloadRequired: true,
    });
  };

  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: ROUTE,
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) return writeJson(res, 403, { error: "untrusted host" });
      const url = new URL(req.url ?? "/", "http://localhost");
      const pathname = url.pathname.replace(/\/+$/, "") || ROUTE;
      // 只有两个面板作业接口、恢复执行与版本更新接受 POST；其余仍只读。
      const isJobPost = (pathname === `${ROUTE}/api/jobs` || pathname === `${ROUTE}/api/jobs/cancel`
        || pathname === `${ROUTE}/api/jobs/recovery-execute`) && req.method === "POST";
      // 安装更新只有 POST 一种形态（spec 016 §3.3）：GET/HEAD 与其它方法一样是 405，只读状态在
      // /api/update/status 上。
      const isUpdatePost = pathname === `${ROUTE}/api/update` && req.method === "POST";
      // 恢复执行只有 POST 一种形态：对它的 GET/HEAD 与其它方法一样是 405（只读计划走 recovery-plan）。
      if (pathname === `${ROUTE}/api/jobs/recovery-execute` && !isJobPost) {
        return writeJson(res, 405, { error: "method not allowed" });
      }
      if (pathname === `${ROUTE}/api/update` && !isUpdatePost) {
        return writeJson(res, 405, { error: "method not allowed" });
      }
      if (!isJobPost && !isUpdatePost && req.method !== "GET" && req.method !== "HEAD") {
        return writeJson(res, 405, { error: "method not allowed" });
      }

      // ---- 面板作业写路径：默认关闭（jobs.enabled=false）----
      // 关闭时保持今天的契约逐字节不变：在读取请求体、解析 JSON、解析 Host 服务和触碰任何路径之前
      // 直接 503。只有显式开启后才交给 handleJobPost。
      if (isJobPost) {
        if (!jobsEnabled) return writeJson(res, 503, { error: JOBS_DISABLED_MESSAGE, disabled: true });
        if (pathname === `${ROUTE}/api/jobs/recovery-execute`) return handleRecoveryExecutePost(req, res);
        return handleJobPost(req, res, pathname);
      }

      // ---- 版本检查/自更新（spec 016）写路径 ----
      // 与作业不同，这里**没有**总开关形态的 503：关闭时状态路由照常回答（update-disabled），
      // 而 POST 由服务的 preflight 第 1 步拒绝——两条路径共用同一套 §3.4 顺序，不会各说一套。
      if (isUpdatePost) return handleUpdatePost(req, res);

      // ---- 版本状态（只读，spec 016 §3.2）----
      // **插件级**路由：没有 root 参数、也不走 knownProjects 白名单——它描述的安装不是某个仓库。
      // 这里只要求回环 Host（前缀处理开头已经判过），不要求 Origin：浏览器对同源 GET 本来就不发
      // Origin（发 Origin 的是 POST 与跨源请求），要求它只会让面板自己的状态请求 403。真正会改盘的
      // 只有上面的 POST，那条路径保留了同源围栏。
      // enabled=false 时服务不做任何网络请求，只回答 update-disabled 与安装形态。
      if (pathname === `${ROUTE}/api/update/status`) {
        try {
          return writeJson(res, 200, await updateService.status());
        } catch {
          logWarn("dsh-wiki: update status failed (internal-error)");
          return writeJson(res, 500, { error: UPDATE_REASON_MESSAGES["internal-error"], code: "internal-error" });
        }
      }

      // ---- 模型目录（只读）：面板选择器只列出这里返回的模型 ----
      if (pathname === `${ROUTE}/api/models`) {
        const sc = ctx.get?.("sessionController");
        if (!sc || typeof sc.modelCatalog !== "function") {
          return writeJson(res, 503, { error: PUBLIC_JOB_ERRORS["model-catalog-unavailable"], code: "model-catalog-unavailable" });
        }
        try {
          const catalog = await sc.modelCatalog();
          return writeJson(res, 200, { ok: true, ...normalizeCatalog(catalog) });
        } catch (err) {
          // 原始错误可能带服务内部细节：只进 logger。
          logWarn(`dsh-wiki: model catalog unavailable: ${String(err?.message ?? err)}`);
          return writeJson(res, 503, { error: PUBLIC_JOB_ERRORS["model-catalog-unavailable"], code: "model-catalog-unavailable" });
        }
      }

      if (pathname === ROUTE || pathname === `${ROUTE}/index.html`) {
        return writeText(res, 200, indexPage(knownWikis()));
      }
      if (pathname === `${ROUTE}/api/status`) {
        // 允许列表：只回答“能用/不能用”。builder/wikis/clientPath/graph 片段等内部诊断不在契约里，
        // 路径与错误文本只进 logger（见 clientModuleStatus 的说明）。
        return writeJson(res, 200, {
          ok: true,
          plugin: pluginMeta,
          jobs: jobsAvailability(),
          clientModule: clientModuleStatus(),
        });
      }
      // ---- 原生 UI 数据接口（只读、回环、路径白名单） ----
      if (pathname === `${ROUTE}/api/jobs`) {
        const project = await projectFor(url.searchParams.get("root"));
        if (!project) return writeJson(res, 403, UNKNOWN_PROJECT);
        // 关闭时（默认）不构造作业管理器、不调用 recover()：只回报禁用状态（客户端据此禁用按钮）。
        // 形状保持 active/last 以兼容客户端轮询代码，但永远是 null。
        if (!jobsEnabled) {
          return writeJson(res, 200, {
            ok: true, root: project.root, disabled: true, disabledReason: JOBS_DISABLED_MESSAGE,
            active: null, last: null,
          });
        }
        const unavailable = await jobUnavailable();
        if (unavailable) return writeJson(res, 503, { error: unavailable.error, code: unavailable.code, disabled: true });
        // 只读：GET 不恢复、不打开 store、不创建目录；reconcile 永远不暴露在 HTTP 上。
        // 出站前统一走公开投影（管理器可能是任意实现）：固定 code/短句，丢弃路径与原始文本。
        const view = jobState.manager.view(project.root, { public: true });
        return writeJson(res, 200, {
          ok: true, root: project.root, disabled: false,
          active: publicJobView(view?.active), last: publicJobView(view?.last),
          journal: publicJournalState(typeof jobState.manager.journalState === "function" ? jobState.manager.journalState() : null),
        });
      }
      // ---- 只读：作业恢复计划状态（GET /api/jobs/recovery-plan） ----
      // 只回答“这个根是否被 fenced、worker 是否仍未证明停下”。严格只读：不打开 store、不领取 host
      // epoch、不 reconcile、不推进 journal、不建目录。执行是**另一个**入口，即
      // POST /api/jobs/recovery-execute：它对同一个根调用 reconcile({execute:true})，因此会把计划
      // 执行掉并撤销内存栅栏，正是本路由不能承担的动作；它要求字面量 confirm:"execute-recovery"，
      // 免得一次跨站/手滑的 fetch 释放栅栏。这里的计划字段仍然是计划视图，不是执行结果。
      // decision/code/reason/actionCount 是计划字段：plan-only reconcile 会经 openJournalStore 打开
      // store（可能建目录并领取 epoch），那就破坏了“GET 不写盘”的既有契约，所以本切片不调用它，
      // 按契约固定为 null/0——计划不可得绝不表现为路由失败。
      if (pathname === `${ROUTE}/api/jobs/recovery-plan`) {
        // 根的授权与其它读路由完全相同：规范根 + 已登记根；链接/别名/未知根 => 403 unknown-project。
        const project = await projectFor(url.searchParams.get("root"));
        if (!project) return writeJson(res, 403, UNKNOWN_PROJECT);
        // 管理器不可用（默认 jobs.enabled=false）=> 与其它作业路由相同的固定 503 形状。
        const unavailable = await jobUnavailable();
        if (unavailable) return writeJson(res, 503, { error: unavailable.error, code: unavailable.code, disabled: true });
        const manager = jobState.manager;
        if (!manager) {
          return writeJson(res, 503, { error: PUBLIC_JOB_ERRORS["jobs-unavailable"], code: "jobs-unavailable", disabled: true });
        }
        const key = pathKey(project.root);
        // journalState() 的 fenced 条目带 root/jobId（内部诊断）：只在本根上取判定与公开 reason，绝不回显。
        let fence = null;
        try {
          const journalState = typeof manager.journalState === "function" ? manager.journalState() : null;
          const fences = Array.isArray(journalState?.fenced) ? journalState.fenced : [];
          fence = fences.find((entry) => typeof entry?.root === "string" && pathKey(entry.root) === key) ?? null;
        } catch {
          fence = null;
        }
        // worker 是否仍未证明停下：unresolvedWorkers() 是内存里的同步只读清单（不探测、不写盘）。
        let workerState = null;
        try {
          const unresolved = typeof manager.unresolvedWorkers === "function" ? manager.unresolvedWorkers() : [];
          if (Array.isArray(unresolved) && unresolved.some((entry) => typeof entry?.root === "string" && pathKey(entry.root) === key)) {
            workerState = "unknown";
          }
        } catch {
          workerState = null;
        }
        return writeJson(res, 200, {
          ok: true,
          fenced: fence !== null,
          fenceReason: fence === null || typeof fence.reason !== "string" ? null : fence.reason,
          decision: null,
          code: null,
          reason: null,
          actionCount: 0,
          workerState,
        });
      }
      if (pathname === `${ROUTE}/api/projects`) {
        // 只列**可证明规范**的根：junction/symlink 换掉的根与指向别处的别名一律不出现（列表与 /site 一致）。
        const roots = await trustedProjects();
        // 只读：绝不在这里调用 recover()（旧实现会在查看时改名任意备份目录）。
        const projects = await Promise.all(roots.map((p) => projectSummary(p, true)));
        projects.sort((a, b) => a.title.localeCompare(b.title));
        return writeJson(res, 200, { ok: true, wikiDirName, projects });
      }
      // ---- 只读：可用语言（GET /api/languages，T017a） ----
      // 只回答“哪些 locale 真的作为目录存在于本项目内”。目录名先过同一套 LANG_TAG_RE（不认识的名字
      // 跳过而不是回显），目录本身要经 identityOf 证明是项目内的真实目录；units 只在
      // locales/<tag>/wiki.json 能经受控读打开（普通、单链接）时为 true。只读：不打开 store、
      // 不写盘、不启动作业，响应里没有任何文件系统路径。
      if (pathname === `${ROUTE}/api/languages`) {
        const p = await projectFor(url.searchParams.get("root"));
        if (!p) return writeJson(res, 403, UNKNOWN_PROJECT);
        const localesRel = path.join(wikiDirName, "locales");
        let names = [];
        // 目录缺失、不可列、或被链接换掉时这里只可能是“没有语言”，不是路由失败。
        try {
          names = (await readdir(path.join(p.root, localesRel), { withFileTypes: true })).map((entry) => entry.name);
        } catch { names = []; }
        const languages = [];
        for (const tag of names.filter((name) => name.length <= LANG_TAG_MAX && LANG_TAG_RE.test(name)).sort()) {
          // 只有 proven-contained 的真实目录才算一种语言：链接/别名/普通文件一律不列。
          try {
            if ((await identityOf(path.join(p.root, localesRel, tag))).kind !== "dir") continue;
          } catch { continue; }
          let units = false;
          try {
            await readContainedFile(p.root, path.join(localesRel, tag, "wiki.json"), "utf8");
            units = true;
          } catch { units = false; }
          languages.push({ tag, units });
        }
        return writeJson(res, 200, { ok: true, canonical: "en", languages });
      }
      if (pathname === `${ROUTE}/api/project` || pathname === `${ROUTE}/api/wiki`) {
        const p = await projectFor(url.searchParams.get("root"));
        if (!p) return writeJson(res, 403, UNKNOWN_PROJECT);
        // 只读：旧实现在这里 await jobs.recover(p.root)（会把崩溃遗留的 .dsh-wiki.bak-* 改名）。
        // 恢复需要先过隔离+恢复评审，读接口不再承担写操作。
        // 新鲜度闸门（spec 014）：stale/behind/changedFiles 与 wiki_status 工具同源（同一个函数）。
        if (pathname === `${ROUTE}/api/project`) return writeJson(res, 200, { ok: true, project: await projectSummary(p, true, true) });
        // 语言选择（T017a）：lang 缺席或字面量 "en" 都走 canonical；显式给出的其它值必须先是合法
        // tag，绝不静默归一化（否则拼错的语言会悄悄回 en 内容）。
        const requested = url.searchParams.get("lang");
        const lang = requested === null || requested === "en" ? null : requested;
        if (lang !== null && (lang.length > LANG_TAG_MAX || !LANG_TAG_RE.test(lang))) {
          return writeJson(res, 400, { error: PUBLIC_JOB_ERRORS["invalid-target-lang"], code: "invalid-target-lang" });
        }
        // wiki.json 必须在**已授权的规范根**之下重新证明（junction 换掉 .dsh-wiki、链接 wiki.json、
        // 非普通文件都拒绝），并且只从句柄读：绝不“授权路径 A、再按路径 A 重读”。
        // 翻译载荷取自 locales/<tag>/wiki.json：同一个受控读、同一套规范化，缺失只回固定 404。
        const rel = lang === null
          ? path.join(wikiDirName, "wiki.json")
          : path.join(wikiDirName, "locales", lang, "wiki.json");
        let wiki = null;
        try {
          const read = await readContainedFile(p.root, rel, "utf8");
          try { wiki = JSON.parse(read.text); } catch { wiki = null; }
        } catch (error) {
          return lang === null
            ? refuseRead(res, error, "wiki not generated", path.join(p.root, rel))
            : refuseRead(res, error, TRANSLATION_MISSING.error, path.join(p.root, rel), TRANSLATION_MISSING.code);
        }
        if (!wiki || typeof wiki !== "object" || !Array.isArray(wiki.pages)) {
          return writeJson(res, 404, lang === null ? { error: "wiki not generated" } : TRANSLATION_MISSING);
        }
        const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
        const strs = (v) => (Array.isArray(v) ? v.filter((x) => x != null).map(str) : typeof v === "string" ? [v] : []);
        const fields = {
          title: str(wiki.title) || path.basename(p.root),
          language: str(wiki.language),
          pages: wiki.pages.filter((x) => x && typeof x === "object").map((x) => ({
            id: str(x.id), parentId: x.parentId == null ? null : str(x.parentId),
            order: typeof x.order === "number" ? x.order : null, title: str(x.title),
            description: str(x.description), filePaths: strs(x.filePaths), markdown: str(x.markdown),
          })),
          cards: Array.isArray(wiki.cards) ? wiki.cards.filter((x) => x && typeof x === "object").map((x) => ({
            id: str(x.id), title: str(x.title), kind: str(x.kind), summary: str(x.summary),
            keyFiles: strs(x.keyFiles), related: strs(x.related), tags: strs(x.tags), pageIds: strs(x.pageIds),
          })) : [],
        };
        // canonical 响应保持既有形状（root 在第二位）；翻译载荷不回任何文件系统路径。
        return writeJson(res, 200, lang === null ? { ok: true, root: p.root, ...fields } : { ok: true, ...fields });
      }
      if (pathname === `${ROUTE}/mermaid-frame`) {
        const nonce = globalThis.crypto.randomUUID().replace(/-/g, "");
        const js = await mermaidJs();
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
          // 'unsafe-eval' is kept because mermaid's bundle may construct functions; no network of any kind
          "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'`,
        });
        return res.end(mermaidFrame(nonce, js));
      }
      if (pathname === `${ROUTE}/assets/mermaid.min.js`) {
        try {
          const js = await readFile(mermaidAsset);
          res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "max-age=3600" });
          return res.end(js);
        } catch {
          return writeJson(res, 404, { error: "mermaid asset missing" });
        }
      }
      if (pathname === `${ROUTE}/site`) {
        const target = url.searchParams.get("path");
        if (!target || !path.isAbsolute(target)) return writeJson(res, 400, { error: "path query must be an absolute site dir" });
        const dir = normalize(path.resolve(target));
        if (path.basename(dir) !== wikiDirName) return writeJson(res, 403, { error: `not a ${wikiDirName} directory` });
        // 读盘前必须先确认站点父目录是已登记的**规范**项目根：否则任意 <任意目录>/.dsh-wiki 都能
        // 借 /site 被读取，而一个 junction 换掉的父目录在词法上也能“匹配”已登记根。
        // 闸门期间这里也不再调用 recover()——浏览站点不得改动文件系统。
        const project = await projectFor(path.dirname(dir));
        if (!project) return writeJson(res, 403, UNKNOWN_PROJECT);
        // 之后不再使用调用方给的词法 dir：相对名从**规范项目根**重新组合，`.dsh-wiki` 这一级与
        // site/index.html 一起重新证明，所以整个 .dsh-wiki 被 junction 换掉也会被拒绝。
        const rel = path.join(wikiDirName, "site", "index.html");
        let html;
        try {
          // 受控读（链接/别名/非普通文件/身份不符 => 固定拒绝）在读第一个字节之前完成；
          // 读失败（消失/EACCES/EBUSY）同样是“没有可用站点”，必须以固定 JSON 作答，绝不把 fs 异常抛给 Host。
          html = (await readContainedFile(project.root, rel, "utf8")).text;
        } catch (error) {
          return refuseRead(res, error, "site/index.html not found — run /wiki generate first", path.join(project.root, rel));
        }
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
        return { kind: "success", text: `${t("siteReady")}${siteUrl(w)}\n(on disk: ${w.site})` };
      }
      if (verb === "list") {
        const wikis = knownWikis();
        if (!wikis.length) return { kind: "success", text: t("listEmpty") };
        return { kind: "success", text: `${t("listHeader")}\n${wikis.map((w) => `- ${w.title} — ${siteUrl(w)}`).join("\n")}` };
      }
      if (verb === "generate") {
        const target = argAbs ?? sessionCwd(invocation);
        if (!target || !existsSync(target)) return { kind: "error", text: `generate needs an existing repository path, got: ${argPath || "(none)"}` };
        return startGeneration(invocation, target);
      }
      return { kind: "error", text: `Unknown subcommand "${verb}". Usage: ${t("commandHint")}` };
    },
  }), "dsh-wiki: command");

  // fork 子代理执行生成；兼容 startActivation（新）与 start（旧）两条路
  function startGeneration(invocation, target) {
    const subagents = ctx.get?.("subagents");
    if (!subagents) return { kind: "error", text: t("startFailed") + "subagents service unavailable (headless profiles do not support /wiki generate)" };
    const provider = subagents.getProvider?.("fork");
    if (!provider?.inheritsParentContext) return { kind: "error", text: t("startFailed") + "fork provider lacks inheritsParentContext" };
    const label = `dsh-wiki:${globalThis.crypto.randomUUID()}`;
    const prompt = [
      {
        type: "text",
        text:
          `Use the dsh-wiki skill to generate a complete wiki for the repository ${target}.\n` +
          "Follow the skill protocol exactly: resolve-config -> phases (inventory/config/language/plan/write/save) -> build + selfcheck both green.\n" +
          "When done, report: absolute path of site/index.html, page count, page-tree summary, open questions, and the local site URL (/dsh-wiki/site?path=<.dsh-wiki dir>).",
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
    run.catch((err) => logWarn(`dsh-wiki: generation task failed ${err?.message ?? err}`));
    return { kind: "success", text: t("started") };
  }
}
