// dsh-wiki 宿主半区：面板内后台生成/更新任务的作业管理器（spec 007）。
//
// 状态：DORMANT。lib/index.js 的发布闸门（503）不变，本模块不被 index.js 构造；
// 本文件不注册 preset、不安装 guard、不写 profile、不联网。
// 发布只走「可信 journal 事务 + 身份校验 rename」：调用方必须注入 journalStore（openJournalStore，
// storeDir 在所有 repo 之外）、hostInstanceId、allowedRoots；缺任一项 start() 即 503，不存在
// 「无 journal 兼容发布」路径。执行器见同目录 publish-executor.js。reconcile(root) 是仅依赖 journal
// 的启动恢复入口——不被任何 GET 调用，index.js 也未接线。T019（运行时证明）、上下文加载器/
// claudeCodeMods 仍是开放闸门。发布不是原子操作：两次 rename 之间存在 live 缺失窗口，断电持久性
// 不保证（store 在 Windows 上报告 durability: "file-flushed"）。
//
// 设计约束：
// - 候选 wiki 先写到 <root>/.dsh-wiki.staging-<jobId>，绝不写进 live；build + selfcheck 都退出 0 才发布。
// - journal 模式下事务记录严格按 journal.js 的 REQUIRED WRITE ORDER 推进：
//   created（建 staging 之前）→ worker-running（mkdir 之后）→ worker-stopped（dispose 之后）
//   → validated（Host assemble/validate/build/selfcheck + scanTree 之后，第一次 rename 之前）
//   → live-moved（第一次 rename 之后）→ published（提升之后）。失败前移 => aborted；
//   rename 之间失败 => 回滚并 rolled-back。journal/store 出错一律 fail closed（隔离、保留栅栏）。
// - 顺序闸门（review 缺陷）：每个读取或写入暂存的宿主阶段（assemble / 内容闸门 / generation-meta /
//   validate / build / selfcheck / 宿主条目保留）之前，都按 journal 绑定的身份重证 root 与 staging
//   并 scanTree 一次；最后的整树扫描保留。事后的扫描无法撤销更早阶段已经发生的读或写。
// - 遗留 recover()（按文件名/mtime 发现备份并改名）已删除：那是被禁止的“发现式恢复”，
//   恢复只能来自可信 journal 的 planRecovery + publish-executor。
// - 每个 root 同一时刻只允许一个作业；栅栏在任何 await 之前同步插入。
// - worker = ctx.agents.create({... setup}) 里一次性完成：preset mount（固定 id，且必须用
//   agentPresets.composedPreset() 证明该 agent 真的组合了这个 preset）→ tools.restrict(5 工具)
//   → 校验 definitions 恰为 5 个 → 钉住 executable 身份 → workerGuard.activate（释放绑在 agentCtx effect）
//   → tools.guard → 模型选择。任何 setup 失败 = 作业失败，绝不发 followup。不用 guard.install() 全局路径。
//   preset 无法证明已挂载 = 致命：绝不带着未证实的组合去跑工具或发 followup。
// - 停止语义：只有 handle.dispose() resolve 才算 worker 停下（此时 guard/activation 才释放）；
//   dispose 超时/抛错 => 隔离（保留暂存与栅栏）。
// - 绝对预算：一个作业只有一个 deadlineAt（start() 里算一次，之后绝不重算）。supervise、输入等待、
//   启动竞速、python 探测、配置、assemble/validate/build/selfcheck/preserve/publish 都只读它：
//   阶段开始前剩余 <= 0 就拒绝，子进程/探测的超时取“自己上限”与“剩余量”的较小者，异步准备与它竞速。
// - 清理预算：终止/清理用独立的有界预算 cleanupTimeoutMs（不是 deadlineAt），因为执行预算已经过期的
//   作业仍然必须能把 worker 停下、记 aborted、删暂存；隔离语义不变（证明不了停下就保留暂存与栅栏）。
// - 宿主自己运行 resolve-config / assemble / 写 generation-meta.json；worker 无执行能力。
// - 翻译作业（T014a-rev）：worker 的写域是 locales/<lang>/ 镜像（canonical 的英文字节副本），
//   canonical 树在 worker 停下之后一律从 live 重新播种（按定义必须逐字节相同），再由翻译后的
//   Markdown 组装 locales/<lang>/wiki.json。canonical 的不变性是结构性的，不依赖模型的克制。
// - context-leak 绊线：worker 会话出现 agent-instructions / skill-invocation / skill-catalog 来源的
//   user 消息 => 取消并以 context-leak 失败；会话不可读则 fail-closed。
// - 增量更新（spec 013）：只有 action=update + incremental=true 才走。基线（generation-meta.json 优先，
//   其次 wiki.json 的 sourceCommit）→ 祖先校验 → diff-impact → 严格解析 → 从 live 播种 → prompt 只列
//   受影响 id。请求阶段由路由调用 incrementalPlan() 求拒绝（409），作业自己再解析一次；任何一步失败
//   都是硬失败，绝不静默降级成全量重建。worker 一页都没改写时 sourceCommit 绝不推进到 HEAD。
//   基线 == HEAD（没有新提交）是 incremental-up-to-date 的显式拒绝，不发一个没有事做的作业。
//   受影响 id 必须与已发布文件一一对应（`pages/<id>.md` 且 front-matter 的 id 就是它），否则
//   incremental-id-mismatch 拒绝整个计划（导入的 wiki 可以两者不一致，那会让合法重写变成假失败，
//   也会让一个 id 落到携带另一个 id 的文件上）。
//   worker 停下之后先复核**授权范围**：播种时对**整棵暂存树**记原始字节哈希（目录记 kind），受影响
//   集合之外任何条目被改写/新增/删除 => incremental-unexpected-write，发布之前硬失败（guard 允许写在
//   整个暂存目录下，所以“别动别的页”只能是检查，不是提示语）；wiki.json 额外按顶层键逐键比较
//   （assemble 之后才重写 pages/cards，比较发生在它之前）。
//
// 只用 node 内建模块；宿主服务全部由调用方注入，不 import DSH 包。
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertCanonicalDir, guardedRename, identityOf, scanTree, verifySame } from "./fs-contain.js";
// 增量上限与 commit 形状：与 lib/worker-protocol.js 共用同一份叶子模块定义（它不 import 任何模块）。
// 这不放松 dormant 规则：本文件仍然不 import ./worker-protocol.js（prompt 构造器由宿主注入）。
import { COMMIT_RE, INCREMENTAL_LIMITS } from "./incremental-limits.js";
import { planRecovery } from "./journal.js";
import { TERMINAL_PHASES } from "./journal-store.js";
import { executeRecoveryPlan, identityJson, observePath, removeVerifiedTree } from "./publish-executor.js";

export const JOB_ACTIONS = ["generate", "update", "translate"];

// targetLang 的形状与 index.js 的 LANG_TAG_RE 完全一致：request 校验已拒绝非法值，这里只为
// 直接调用 manager.start() 的测试/内部调用保持同一条规则（绝不静默归一化）。
const LANG_TAG_RE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;
const LANG_TAG_MAX = 35;

// 发布时由宿主拥有、绝不随候选替换的 live 条目：repo 配置层与翻译目录。
export const PROTECTED_LIVE_ENTRIES = ["config.json", "locales"];

// ---------- 校验工具（路由层复用） ----------
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);
const DEFAULT_PORTS = Object.freeze({ "http:": "80", "https:": "443" });
const PORT_RE = /^[0-9]{1,5}$/;
const REG_NAME_RE = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const IPV6_LITERAL_RE = /^[0-9a-fA-F:.]+$/;

/** 是否回环主机名（`::1` 不带方括号）。 */
export function isLoopbackHostname(value) {
  return typeof value === "string" && LOOPBACK_HOSTNAMES.has(value.toLowerCase());
}

/**
 * 解析 Host 头（可带端口），非法返回 null。方括号 IPv6（`[::1]:8080`）按 URI 语法解析，
 * 未加方括号的 `::1:8080` 之类是非法 Host，一律拒绝。
 *
 * 显式写出的端口按原样保留（字符串），绝不在本函数里替换成某种 scheme 的默认端口：
 * 本函数不知道也没有办法知道传输（TLS 与否），而“先按 http 解析、顺手剥掉 :80”正是旧的
 * 跨 scheme 缺陷来源——剥掉之后，调用方只能把空端口再当成某个 scheme 的默认值，于是
 * `Host: 127.0.0.1:80` 会在 TLS 监听上被读成 443。
 * @returns {{host: string, hostname: string, port: string}|null} hostname 已去掉方括号、已小写；
 *   `port` 为 "" 仅当 Host 头本身就省略了端口。
 */
export function parseHostHeader(host) {
  if (typeof host !== "string" || host.length === 0 || host.length > 255) return null;
  if (/[\u0000-\u001f\u007f]/.test(host)) return null;
  let hostname;
  let port = "";
  if (host.startsWith("[")) {
    const close = host.indexOf("]");
    if (close <= 1) return null;
    const literal = host.slice(1, close);
    if (!IPV6_LITERAL_RE.test(literal) || !literal.includes(":")) return null;
    hostname = literal.toLowerCase();
    const rest = host.slice(close + 1);
    if (rest !== "") {
      if (!rest.startsWith(":")) return null;
      port = rest.slice(1);
    }
  } else {
    const firstColon = host.indexOf(":");
    const lastColon = host.lastIndexOf(":");
    // 多个冒号（未加方括号的 IPv6、或 `host:80:90`）不是合法 Host authority。
    if (firstColon !== lastColon) return null;
    hostname = (lastColon === -1 ? host : host.slice(0, lastColon)).toLowerCase();
    if (!REG_NAME_RE.test(hostname)) return null;
    if (lastColon !== -1) port = host.slice(lastColon + 1);
  }
  if (port !== "") {
    if (!PORT_RE.test(port)) return null;
    const numeric = Number(port);
    if (!Number.isSafeInteger(numeric) || numeric < 1 || numeric > 65535) return null;
  }
  const authority = hostname.includes(":") ? `[${hostname}]${port ? `:${port}` : ""}` : `${hostname}${port ? `:${port}` : ""}`;
  return { host: authority, hostname, port };
}

/**
 * 某一侧的有效端口：省略（`""`）才取**该侧自己的 scheme** 的默认端口；显式写出的端口按数值使用。
 * 两侧各自传入真正适用的 scheme，空端口因此不可能被解读成另一种 scheme 的默认值。
 * @returns {number|null}
 */
const effectivePort = (scheme, port) => {
  const raw = port === "" ? DEFAULT_PORTS[scheme] : port;
  if (typeof raw !== "string" || !PORT_RE.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1 && value <= 65535 ? value : null;
};

/**
 * 同源校验（**仅**用于拒绝跨源浏览器请求，也就是 CSRF 防线；它不是调用方身份认证）。
 * Origin 必须存在、可解析、主机名是严格回环、scheme 与本次请求实际使用的传输一致，
 * 且 scheme + host + port 与 Host 头逐项相等。缺失/`null`/跨源/非回环一律拒绝
 * （跨源 POST 是 CSRF 的主要入口）。
 *
 * scheme 语义（显式选择，不靠 Host 头推断）：Host 头只带 host:port，永远说不出 scheme，所以“同源”
 * 的 scheme 取请求实际到达的传输（`req.socket.encrypted`）——本插件的路由由回环明文 Host 提供，
 * 因此 `https:` 的 Origin 一律视为跨源并拒绝；将来若挂在 TLS 监听上，同一份代码自动要求 `https:`。
 * 默认端口只从**当前请求的 scheme** 派生：`Host: 127.0.0.1` 与 `Origin: http://127.0.0.1` 同源；
 * `Host: 127.0.0.1:443` 与 `Origin: https://127.0.0.1`（省略默认端口）在 TLS 下同源；
 * 反过来 `Host: 127.0.0.1:80` 在 TLS 下**不是** 443（显式端口原样比较），明文监听上的
 * `Origin: https://127.0.0.1` 也一律拒绝。只比较 host 的实现会把不同 scheme 当成同源，那是错的。
 *
 * 无论本函数返回什么，它都不能证明调用者是本机的真实用户：任何非浏览器客户端都可以伪造这两个头。
 * 写路径的认证/授权不属于本函数，也不属于这个插件。
 */
export function isSameOrigin(req) {
  const headers = req?.headers ?? {};
  const host = parseHostHeader(headers.host);
  if (!host || !isLoopbackHostname(host.hostname)) return false;
  // 先定 scheme（来自传输），再派生默认端口；Host 头本身不参与 scheme 推断。
  const requestScheme = req?.socket?.encrypted === true ? "https:" : "http:";
  const rawOrigin = headers.origin;
  if (typeof rawOrigin !== "string" || rawOrigin.length === 0 || rawOrigin === "null") return false;
  let origin;
  try {
    origin = new URL(rawOrigin);
  } catch {
    return false;
  }
  if (origin.protocol !== requestScheme) return false;
  // Origin 不应携带 userinfo；带着就说明它不是浏览器同源请求。
  if (origin.username || origin.password) return false;
  const originName = origin.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!isLoopbackHostname(originName)) return false;
  const originPort = effectivePort(origin.protocol, origin.port);
  const hostPort = effectivePort(requestScheme, host.port);
  if (originPort === null || hostPort === null) return false;
  return originName === host.hostname && originPort === hostPort;
}

/** content-type 必须是 JSON（可带 charset）。返回 false 时调用方应答 415。 */
export function isJsonContentType(value) {
  if (typeof value !== "string") return false;
  const [type] = value.split(";");
  return type.trim().toLowerCase() === "application/json";
}

// 请求体的墙钟上限：字节上限不限制时间。一个只发了一个分片就停住的客户端会让 `for await (const chunk
// of req)` 永远等下去，把处理函数和它的 socket 一起钉住（占用是真实的，不是理论上的）。
const JOB_BODY_TIMEOUT_MS = 10_000;

// 单调时钟：Date.now() 会被系统时间的调整影响，performance.now() 不会。期限判断用它。
const monotonicNow = typeof globalThis.performance?.now === "function"
  ? () => globalThis.performance.now()
  : () => Date.now();

/**
 * 有界读取请求体并解析 JSON：字节有界（limitBytes），**时间**也有界（options.timeoutMs）。
 *
 * 时间上限由两个机制同时兜住，缺一不可：
 *  1. 每次迭代**同步**比较单调时钟与起始时刻。一个 `next()` 立即结算（resolved promise）的
 *     iterable 会让循环一直停在微任务里，宏任务队列上的定时器回调永远轮不到——review 实测：
 *     零字节无限流 + timeoutMs=15 永不结算，只能靠 250ms 看门狗 SIGTERM；“绝对期限”因此必须是
 *     同步检查，不能只依赖定时器。
 *  2. 定时器竞速（giveUp）仍然保留：一个永不结算的 `next()`（客户端只发一个分片就停住）是 pending
 *     promise，同步检查根本没有执行的机会，只有定时器能在等待中把控制权拿回来。
 *
 * 放弃读取（超时 / 字节溢出 / 调用方中止 / 无法使用的分片）时**绝不**在这里 destroy 请求：调用方还要在同一 socket 上
 * 写 413/408 的响应体，在这里 destroy 会让 chunked 请求（无 content-length）的对端拿到
 * ECONNRESET 而不是响应体（review 实测：handler=413 destroyed=true => peer-error=ECONNRESET）。
 * 函数只停止读取并回报 `abandoned: true`，由调用方在响应 flush 之后关闭 socket。
 * 清理（`iterator.return()`）只发起、不等待：一个永不结算的 return() 否则会让读取永远挂住，使时间
 * 上限对“任何 async iterable”都不成立；返回的 promise 当场挂上拒绝处理器，晚到的拒绝不会变成
 * unhandled rejection。零长度分片不累积（无限零字节流否则会让数组无限增长），由期限检查结束循环。
 * 计时器在 finally 里 clearTimeout，且 unref()，所以它绝不会拖住进程退出。
 *
 * @param {object} req Node 的 http.IncomingMessage（任何 async iterable 都可以，测试用 Readable）
 * @param {number} [limitBytes] 字节上限
 * @param {{timeoutMs?: number, signal?: AbortSignal}} [options] 缺省超时 10s；signal 中止时同 400
 * @returns {{ok:true,value:any}|{ok:false,status:number,error:string,abandoned?:true}}
 */
export async function readBoundedJson(req, limitBytes = 32 * 1024, options = {}) {
  const declared = Number(req?.headers?.["content-length"]);
  if (Number.isFinite(declared) && declared > limitBytes) {
    return { ok: false, status: 413, error: `request body exceeds ${limitBytes} bytes` };
  }
  const timeoutMs = Number.isFinite(options?.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : JOB_BODY_TIMEOUT_MS;
  const signal = options?.signal ?? null;
  let iterator;
  try {
    iterator = req[Symbol.asyncIterator]();
  } catch {
    return { ok: false, status: 400, error: "request body could not be read" };
  }
  const chunks = [];
  let size = 0;
  const startedAt = monotonicNow();
  const expired = () => monotonicNow() - startedAt >= timeoutMs;
  // 放弃这份请求体：只停止读取，不碰 socket（调用方 flush 响应之后才关），清理只发起、不等待。
  const abandon = (status, error) => {
    try {
      const closed = iterator.return?.();
      if (closed && typeof closed.then === "function") closed.then(() => {}, () => {});
    } catch { /* already closed */ }
    return { ok: false, status, error, abandoned: true };
  };
  // 分片归一化：本函数的契约是失败**必须 return**，绝不 throw。一个 null / 普通对象 / 外来 thenable
  // 分片也不能让异常逃出去，所以只接受 Node 流真正会产出的三种类型（string、Buffer、Uint8Array），
  // 其余一律 null 交给调用处走 400；类型探测本身也放在 try 里（`instanceof` 会触发 getPrototypeOf）。
  // `buf.length` 可能是分片上自定义的会抛访问器，那一次读取在调用处单独兜住。
  const chunkBuffer = (chunk) => {
    try {
      if (typeof chunk === "string") return Buffer.from(chunk, "utf8");
      if (Buffer.isBuffer(chunk)) return chunk;
      if (chunk instanceof Uint8Array) return Buffer.from(chunk);
      return null;
    } catch {
      return null;
    }
  };
  // 一个只结算一次的“放弃读取”信号：超时或调用方中止。
  let timer = null;
  let onAbort = null;
  const giveUp = new Promise((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
    timer.unref?.();
    if (signal) {
      onAbort = () => resolve("aborted");
      if (signal.aborted === true) onAbort();
      else signal.addEventListener?.("abort", onAbort, { once: true });
    }
  });
  try {
    for (;;) {
      // 同步期限检查（微任务饥饿时定时器回调永远不跑，只有这一步能结束循环）。
      if (expired()) return abandon(408, "request body was not received in time");
      // `next()` 只承诺返回“像 promise 的东西”：返回普通对象（没有 .then）会让直接 `.then(...)` 抛
      // TypeError，返回一个 then 返回 undefined 的外来 thenable 会让竞速结算成 undefined，紧接着
      // `step.kind` 再从函数里抛出去。先经 Promise.resolve 归一化再挂处理器：任何 thenable / 普通值
      // 都被安全取值，同步 throw 也转成拒绝，与真实拒绝走同一条 400 路径。
      let pending;
      try {
        pending = Promise.resolve(iterator.next());
      } catch {
        pending = Promise.reject(new Error("request body could not be read"));
      }
      const step = await Promise.race([
        pending.then((result) => ({ kind: "step", result }), (error) => ({ kind: "error", error })),
        giveUp,
      ]);
      if (step === "timeout" || step === "aborted") {
        // 到期：不等待那个停住的迭代器。已经挂在迭代 promise 上的处理器保证晚到的分片/拒绝被吞掉。
        return step === "aborted"
          ? abandon(400, "request body could not be read")
          : abandon(408, "request body was not received in time");
      }
      // 竞速结果既不是哨兵也不是 {kind,...} 时不能直接解引用 `step.kind`（那会 throw 出函数）。
      // 这不是任何一种成功的读取，按 400 放弃。
      if (step === null || typeof step !== "object" || (step.kind !== "step" && step.kind !== "error")) {
        return abandon(400, "request body could not be read");
      }
      if (step.kind === "error") return { ok: false, status: 400, error: "request body could not be read" };
      const { result } = step;
      if (result?.done === true) break;
      const buf = chunkBuffer(result?.value);
      if (buf === null) return abandon(400, "request body could not be read");
      let bufLength;
      try {
        // `length` 可能是会抛的 getter（自己定义在分片上的访问器），读取本身也必须兜住。
        bufLength = buf.length;
      } catch {
        return abandon(400, "request body could not be read");
      }
      // 零长度分片不累积：一个无限零字节流否则会让 chunks 无限增长。期限检查负责结束这个循环。
      if (bufLength === 0) continue;
      size += bufLength;
      if (size > limitBytes) {
        // 413 表示放弃这份请求体：与超时路径同一处理——停止读取、不等待清理、把 socket 留给调用方。
        return abandon(413, `request body exceeds ${limitBytes} bytes`);
      }
      chunks.push(buf);
    }
  } finally {
    clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener?.("abort", onAbort);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return { ok: false, status: 400, error: "request body must be JSON" };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400, error: "request body is not valid JSON" };
  }
}

// ---------- 公开错误投影（唯一出口） ----------
// 任何离开 Host 的错误文本只能来自这张表：稳定 code + 固定短句。provider/builder stderr、fs 错误、
// 路径与 stack 只进 logger，绝不进入 HTTP 响应（作业摘要、模型目录失败、请求拒绝共用同一份）。
export const PUBLIC_ERROR_MESSAGES = Object.freeze({
  "cross-origin": "the request is not a loopback same-origin request",
  "content-type": "content-type must be application/json",
  "invalid-request": "request body must be a JSON object",
  "unsupported-field": "the request carries a field this slice does not support",
  "invalid-root": "root must be an absolute path string",
  "invalid-action": "action must be generate or update",
  "invalid-model": "model must be { provider, model } with non-empty strings",
  "invalid-target-lang": "targetLang must be a BCP 47 language tag",
  "invalid-incremental": "incremental must be a boolean",
  "language-unsupported": "only the canonical en wiki is generated in this slice",
  "translate-unsupported": "wiki translation is not supported in this slice",
  // 增量更新（spec 013 §2.1）：一条请求要么真的增量，要么被显式拒绝，绝不静默降级成全量重建。
  "incremental-not-for-generate": "a first build has no published baseline to update; generate the whole wiki instead",
  "incremental-not-for-translate": "an incremental update applies to the canonical wiki, never to a translation",
  "incremental-no-baseline": "there is no published wiki with a usable sourceCommit to update incrementally; run a full update first",
  "incremental-unavailable": "the changed files since the published baseline could not be determined; run a full update instead",
  "incremental-baseline-diverged": "the published wiki's baseline is not an ancestor of the current revision; run a full update instead",
  "incremental-up-to-date": "the published wiki already matches HEAD; run a full update if the wiki is stale for another reason",
  // worker 越权写入（review MAJOR）：受影响的页之外任何条目被改写/新增/删除，候选一律不发布。
  "incremental-unexpected-write": "the staged candidate could not be confirmed to match what the update authorised; the candidate was refused and nothing was published",
  // 受影响 id 与已发布文件名不一致（review minor）：受影响集合按 id 拼 `pages/<id>.md`，而导入的 wiki
  // 可以两者不一致——那会让受影响页的合法重写被判成越权（假失败），也会让一个 id 落到携带**另一个**
  // id 的文件上（改写那一页）。这里不猜、不解析 front-matter 的其余部分：直接拒绝，全量更新照常可用。
  "incremental-id-mismatch": "the published wiki's ids and file names disagree, so an incremental update is not safe for it; run a full update instead",
  "unknown-root": "unknown project root",
  "jobs-unavailable": "background wiki jobs are unavailable",
  "jobs-initialization-failed": "background wiki jobs could not start",
  "model-catalog-unavailable": "the model catalog is unavailable",
  "model-catalog-failure": "a model provider catalog entry could not be listed",
  "plugin-unloaded": "the dsh-wiki plugin has been unloaded",
  "services-unavailable": "a required Host service is unavailable",
  // worker preset：注册/挂载/证明失败都是致命前提缺失，绝不降级成“照常运行”。
  "preset-mismatch": "the worker agent preset identity is fixed and cannot be overridden",
  "preset-mount-failed": "the worker agent preset could not be mounted; the job was refused",
  "preset-unverifiable": "this Host cannot confirm that the worker agent preset is mounted; background jobs stay disabled",
  "preset-activation-failed": "the worker agent preset could not be activated; background jobs stay disabled",
  "job-busy": "a background wiki job is already running for this repository",
  "job-quarantined": "a previous job for this repository is quarantined until its worker is confirmed stopped",
  "job-failed": "the background job failed",
  "job-timeout": "the job exceeded its time limit",
  "input-timeout": "the job waited for human input until its input budget ran out",
  "startup-timeout": "the worker session could not be created in time",
  "worker-not-stopped": "the job worker could not be confirmed stopped",
  "context-leak": "the worker received loader context; the candidate was refused",
  "assemble-failed": "the candidate wiki could not be assembled",
  // 内容闸门：候选自身与解析后的配置矛盾（字数/引用/图/known-issues/页数），细节只在 logger。
  "content-gate-failed": "the candidate wiki does not meet the resolved content requirements",
  // 翻译完整性闸门：canonical 之外的语言由宿主复查，细节只在 logger，公开短句里没有任何路径。
  "translation-gate-failed": "the candidate wiki failed its translation integrity check",
  "translation-gate-timeout": "the translation integrity check did not finish within the job's time limit",
  "translation-gate-unavailable": "the translation integrity check is unavailable",
  // 翻译作业（T014a）：源 wiki 必须已发布、播种必须可证明、骨架必须由宿主自己创建。
  "translation-unsupported": "the translation prompt builder is unavailable on this Host",
  "live-missing": "the published canonical wiki to translate does not exist",
  "seed-untrusted": "the published canonical wiki could not be seeded safely into the candidate",
  "locales-init-failed": "the translation units skeleton could not be created",
  // 读路由（T017a）：该语言的翻译目录或 units 不存在时唯一的 404 形状，路径只进 logger。
  "translation-missing": "no translation is available for this language",
  "build-failed": "the candidate wiki site could not be built",
  "selfcheck-failed": "the candidate wiki failed its own checks",
  "staging-exists": "the job could not reserve its staging directory",
  "config-failed": "the wiki configuration could not be resolved",
  "live-not-canonical": "the live wiki is not the canonical en wiki",
  "live-untrusted": "the live wiki is not a trusted canonical directory",
  "candidate-missing": "the candidate wiki is missing",
  "candidate-invalid": "the candidate wiki is invalid",
  "candidate-language": "the candidate wiki is not the canonical en wiki",
  "candidate-repo-mismatch": "the candidate wiki does not belong to this repository",
  "candidate-untrusted": "the candidate wiki is not a link-free tree",
  "python-missing": "no usable python interpreter is available",
  "prompt-failed": "the worker prompt could not be built",
  "root-untrusted": "the repository root is not a trusted canonical directory",
  "root-not-allowed": "the repository root is not allowed",
  "publish-failed": "the candidate wiki could not be published",
  "rollback-failed": "the previous wiki could not be restored",
  "journal-fence": "this repository is fenced by the trusted journal; run reconcile",
  "journal-store-unavailable": "the trusted journal store is unavailable",
  "journal-store-locked": "the trusted journal store is locked",
  "journal-not-terminal": "the trusted journal holds an unfinished transaction for this repository",
  "journal-commit-uncertain": "the trusted journal could not confirm its last write",
  "journal-live-move-uncertain": "the journal cannot confirm where the live wiki is",
  "internal-error": "the request could not be completed",
  "request-refused": "the request was refused",
});

const PUBLIC_CODE_RE = /^[a-z][a-z0-9._-]{0,63}$/;
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;
const publicString = (value, max) => (typeof value === "string" && value.length > 0 && value.length <= max
  && !CONTROL_CHARS_RE.test(value) ? value : null);
const publicToken = (value, max) => (publicString(value, max) !== null && value === value.trim() ? value : null);
const publicSha = (value) => (typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : null);

/** 公开错误码：只接受稳定 token，其它一律收敛为 internal-error（绝不回显任意文本）。 */
export function publicErrorCode(value) {
  if (typeof value !== "string") return "internal-error";
  const token = value.trim().toLowerCase();
  return PUBLIC_CODE_RE.test(token) ? token : "internal-error";
}

/** 固定公开短句；未知 code 回退到固定短句，绝不使用原始错误文本。 */
export function publicErrorMessage(code, fallback = "internal-error") {
  return PUBLIC_ERROR_MESSAGES[code] ?? PUBLIC_ERROR_MESSAGES[fallback] ?? PUBLIC_ERROR_MESSAGES["internal-error"];
}

/** 作业错误 → { code, message }；原始 message/stack/status/stderr 全部丢弃。 */
export function publicError(error) {
  if (error === null || error === undefined) return null;
  const code = typeof error === "object" && typeof error.code === "string" && error.code
    ? publicErrorCode(error.code)
    : "job-failed";
  return { code, message: publicErrorMessage(code, "job-failed") };
}

/** blocked 只公开稳定原因与 journal 标志；staging 是宿主路径，绝不公开。 */
export function publicJobBlocked(blocked) {
  if (!blocked || typeof blocked !== "object" || Array.isArray(blocked)) return null;
  const reason = publicErrorCode(blocked.reason);
  return blocked.journal === true ? { reason, journal: true } : { reason };
}

// ---------- 增量更新（spec 013）：形状上限与公开投影 ----------
// 上限是 fail-closed 的一部分：prompt 里的受影响集合绝不能无限增长，超过上限的请求被拒绝，绝不被截成
// 一份“看起来更小”的增量。选 500：实测唯一真实语料（DXVK_Project）一次改动波及 23 页 / 9 卡，
// 而“500 页受影响”已经不是增量更新，应该走全量。
//
// 上限与 commit 形状只有**一份定义**：lib/incremental-limits.js（一个不 import 任何东西的叶子模块），
// 由本文件与 lib/worker-protocol.js 各自 import。为什么不是让本文件 import prompt 构造器那边：
// owner 批准的 dormant 规则要求 prompt 构造器由宿主注入、本文件不 import ./worker-protocol.js
// （tools/worker-protocol-test.mjs 与 tools/jobs-worker-test.mjs 各有一条断言钉住它）。叶子模块让
// 那条规则原样成立，同时“两份拷贝不能漂移”的比对测试不再需要——它们已经不可能不同。
// git 的两种对象格式：sha1（40）与 sha256（64）。两者都是“一个确定的对象名”，不接受缩写/引用名。
const isCommitSha = (value) => typeof value === "string" && COMMIT_RE.test(value);
// Unicode 行/段分隔符、双向控制与 BOM：一个 id 会进 prompt（行导向文本），这些字符一律不接受。
const UNSAFE_INVISIBLE_RE = /[\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/;
const isBoundedText = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max
  && !CONTROL_CHARS_RE.test(value) && value === value.trim();
/**
 * 页/卡片 id 同时是暂存文件名（`pages/<id>.md`）：必须是单个路径段。字符集刻意比“任意文件名”宽
 * （真实的 wiki 可以用非 ASCII 的 id），但分隔符、`.`/`..` 与不可见控制字符一律拒绝。
 */
const isPageId = (value) => isBoundedText(value, INCREMENTAL_LIMITS.maxIdLength)
  && !/[\\/]/.test(value) && !UNSAFE_INVISIBLE_RE.test(value) && value !== "." && value !== "..";
/** 仓库相对路径（git 输出的形状）：不允许绝对路径、不允许 `..` 段、不允许控制字符。 */
const isRepoRelativePath = (value) => {
  if (!isBoundedText(value, INCREMENTAL_LIMITS.maxPathLength)) return false;
  if (value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/.test(value)) return false;
  return !value.split(/[\\/]+/).some((segment) => segment === ".." || segment === "");
};
const nonNegativeInt = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);

/**
 * 增量事实的公开投影（allowlist，绝不 spread）：只有 sha、计数与 ≤5 条有界的未映射样例。
 * 非增量作业返回 null，因此 HTTP 投影在那种作业上**一个键都不多**（固定键集保持不变）。
 */
export function publicIncremental(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const sample = Array.isArray(value.unmappedSample)
    ? value.unmappedSample.filter((entry) => isBoundedText(entry, INCREMENTAL_LIMITS.maxPathLength)).slice(0, 5)
    : null;
  // 被删除的受影响页（D2）：删除必须**看得见**，但它是删除，不是改写——两个计数绝不互相顶替。
  const removed = Array.isArray(value.removedSample)
    ? value.removedSample.filter((entry) => isPageId(entry)).slice(0, 5)
    : null;
  return {
    mode: value.mode === "incremental" ? "incremental" : null,
    baseline: isCommitSha(value.baseline) ? value.baseline : null,
    head: isCommitSha(value.head) ? value.head : null,
    affectedPages: nonNegativeInt(value.affectedPages),
    affectedCards: nonNegativeInt(value.affectedCards),
    pagesRewritten: nonNegativeInt(value.pagesRewritten),
    pagesRemoved: nonNegativeInt(value.pagesRemoved),
    removedSample: removed,
    unmappedFiles: nonNegativeInt(value.unmappedFiles),
    unmappedSample: sample,
    // spec 013 §5.1：写进 generation-meta.json 的 sourceCommit 与“是否真的推进到 HEAD”。
    sourceCommit: isCommitSha(value.sourceCommit) ? value.sourceCommit : null,
    sourceCommitAdvanced: typeof value.sourceCommitAdvanced === "boolean" ? value.sourceCommitAdvanced : null,
  };
}

/**
 * 校验一份“增量请求”携带的前置解析结果（spec 013）。路由传入的就是 planIncremental() 的返回值，
 * 但管理器绝不因此信任调用方：形状不对就是 400 invalid-incremental（绝不当成全量继续跑）。
 * 只保留作业真正需要的字段；其余（liveDir 等内部路径）不进入作业记录。
 */
export function normalizeIncrementalRequest(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new JobError(400, "invalid-incremental", "incremental must be the resolved plan of an incremental update");
  }
  if (value.mode !== "incremental") {
    throw new JobError(400, "invalid-incremental", "incremental.mode must be exactly \"incremental\"");
  }
  if (!isCommitSha(value.baseline) || !isCommitSha(value.head)) {
    throw new JobError(400, "invalid-incremental", "incremental.baseline and incremental.head must be full commit hashes");
  }
  const listOfEntries = (raw, label) => {
    if (!Array.isArray(raw) || raw.length > INCREMENTAL_LIMITS.maxEntries) {
      throw new JobError(400, "invalid-incremental", `incremental.${label} must be an array of at most ${INCREMENTAL_LIMITS.maxEntries} entries`);
    }
    return raw.map((entry) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry) || !isPageId(entry.id)) {
        throw new JobError(400, "invalid-incremental", `incremental.${label} entries must be { id, filePaths } with a usable id`);
      }
      const filePaths = Array.isArray(entry.filePaths) ? entry.filePaths : null;
      if (filePaths === null || filePaths.length > INCREMENTAL_LIMITS.maxFilePaths
        || !filePaths.every((filePath) => isRepoRelativePath(filePath))) {
        throw new JobError(400, "invalid-incremental", `incremental.${label} entries must carry repository-relative filePaths`);
      }
      return { id: entry.id, filePaths: [...filePaths] };
    });
  };
  const pages = listOfEntries(value.pages, "pages");
  const cards = listOfEntries(value.cards, "cards");
  const unmapped = value.unmappedFiles;
  if (!Array.isArray(unmapped) || !unmapped.every((filePath) => isRepoRelativePath(filePath))) {
    throw new JobError(400, "invalid-incremental", "incremental.unmappedFiles must be an array of repository-relative paths");
  }
  return {
    mode: "incremental",
    baseline: value.baseline,
    head: value.head,
    pages,
    cards,
    // prompt 与记录都要有界：超出上限的未映射文件只保留前 500 条，总数由 unmappedFiles 计数如实反映。
    unmappedFiles: unmapped.slice(0, INCREMENTAL_LIMITS.maxEntries),
    unmappedTotal: unmapped.length,
  };
}

const PUBLIC_ACTIONS = ["generate", "update", "translate"];
const publicJobAction = (value) => (typeof value === "string" && PUBLIC_ACTIONS.includes(value) ? value : null);
const publicLanguageTag = (value) => (typeof value === "string" && value.length <= LANG_TAG_MAX && LANG_TAG_RE.test(value)
  ? value : null);

/**
 * 作业摘要的公开投影（allowlist，绝不 spread）：action/phase/时间戳/model 等非敏感字段保留，
 * error 只留固定 code + 短句，staging 路径、engine 与任何未知字段一律丢弃。
 */
export function publicJobView(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const provider = publicToken(value.model?.provider, 256);
  const modelId = publicToken(value.model?.model, 256);
  // 增量事实只在增量作业上出现：全量作业的 HTTP 投影键集一个字都不变（jobs-worker-test 钉住的就是它）。
  const incremental = publicIncremental(value.incremental);
  return {
    id: publicString(value.id, 64),
    root: publicString(value.root, 4096),
    action: publicJobAction(value.action),
    model: provider && modelId ? { provider, model: modelId } : null,
    targetLang: publicLanguageTag(value.targetLang),
    phase: publicString(value.phase, 32),
    stage: publicString(value.stage, 32),
    startedAt: publicString(value.startedAt, 40),
    updatedAt: publicString(value.updatedAt, 40),
    sessionId: publicString(value.sessionId, 256),
    error: publicError(value.error),
    published: value.published === true,
    pages: Number.isSafeInteger(value.pages) && value.pages >= 0 ? value.pages : null,
    waitingFor: Array.isArray(value.waitingFor)
      ? value.waitingFor.filter((entry) => publicString(entry, 200) !== null).slice(0, 20)
      : null,
    blocked: publicJobBlocked(value.blocked),
    journalPhase: publicString(value.journalPhase, 32),
    journalJobId: publicString(value.journalJobId, 64),
    promptSha256: publicSha(value.promptSha256),
    protocolSha256: publicSha(value.protocolSha256),
    ...(incremental === null ? {} : { incremental }),
  };
}

/** journalState() 的公开投影：只留模式与固定依赖名。 */
export function publicJournalState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    mode: value.mode === "journal" ? "journal" : "unknown",
    missing: Array.isArray(value.missing)
      ? value.missing.filter((entry) => typeof entry === "string" && /^[A-Za-z][A-Za-z0-9]{0,31}$/.test(entry)).slice(0, 16)
      : [],
  };
}

/** 模型目录 failures[] 的公开投影：id/name 保留，provider 的错误文本换成固定 code + 短句。 */
export function publicCatalogFailure(failure) {
  if (!failure || typeof failure !== "object" || Array.isArray(failure)) return null;
  const id = publicString(failure.id, 128);
  if (id === null) return null;
  return {
    id,
    name: publicString(failure.name, 256) ?? id,
    code: "model-catalog-failure",
    message: publicErrorMessage("model-catalog-failure"),
  };
}

/** 把 modelCatalog() 结果收敛成 UI 可用的形状；绝不发明目录里没有的模型。 */
export function normalizeCatalog(catalog) {
  const groups = Array.isArray(catalog?.groups) ? catalog.groups : [];
  const models = [];
  for (const group of groups) {
    const provider = publicToken(group?.id, 128);
    if (!provider) continue;
    for (const model of Array.isArray(group.models) ? group.models : []) {
      const modelId = publicToken(model?.id, 128);
      if (!modelId) continue;
      const description = publicString(model.description, 2000);
      models.push({
        provider,
        model: modelId,
        label: publicString(model.name, 256) ?? modelId,
        providerLabel: publicString(group.name, 256) ?? provider,
        ...(description ? { description } : {}),
      });
    }
  }
  const defProvider = publicToken(catalog?.default?.provider, 128);
  const defModel = publicToken(catalog?.default?.model, 128);
  const def = defProvider && defModel ? { provider: defProvider, model: defModel } : null;
  const failures = Array.isArray(catalog?.failures)
    ? catalog.failures.map((failure) => publicCatalogFailure(failure)).filter(Boolean)
    : [];
  return {
    default: def,
    models,
    groups: groups
      .map((group) => ({ id: publicToken(group?.id, 128), name: publicString(group?.name, 256) }))
      .filter((group) => group.id !== null)
      .map((group) => ({ id: group.id, name: group.name ?? group.id })),
    failures,
  };
}

/** 精确匹配目录中的 provider/model；返回 null 表示不在目录里。 */
export function matchCatalogModel(catalog, selection) {
  if (!selection || typeof selection.provider !== "string" || typeof selection.model !== "string") return null;
  const normalized = normalizeCatalog(catalog);
  return normalized.models.find((m) => m.provider === selection.provider && m.model === selection.model) ?? null;
}

/** 会话日志里最后一个 turn/end 的 data；拿不到返回 null。 */
export function lastTurnEnd(agent) {
  try {
    const events = agent?.session?.snapshotEvents?.();
    if (!Array.isArray(events)) return null;
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event && event.type === "turn/end") return { turn: event.data?.turn ?? null, reason: event.data?.reason ?? null };
    }
  } catch {
    /* 会话不可读时按未知处理 */
  }
  return null;
}

/** turn/end 原因 → 作业结论。只有 completed 算成功。 */
export function turnOutcome(turnEnd) {
  const reason = turnEnd?.reason;
  if (!reason || typeof reason.kind !== "string") return { ok: false, error: { message: "the agent turn ended without a recorded reason" } };
  if (reason.kind === "completed") return { ok: true };
  if (reason.kind === "error") {
    const failure = reason.error ?? {};
    const message = typeof failure.message === "string" && failure.message ? failure.message : "the agent turn failed";
    return { ok: false, error: { message, ...(typeof failure.code === "string" ? { code: failure.code } : {}), ...(typeof failure.status === "number" ? { status: failure.status } : {}) } };
  }
  if (reason.kind === "aborted") {
    const cause = reason.reason?.kind ?? "unknown";
    return { ok: false, canceled: cause === "user", error: { message: `the agent turn was aborted (${cause})` } };
  }
  return { ok: false, error: { message: `the agent turn ended as "${reason.kind}"` } };
}

// ---------- content gate (publication quality gate) ----------
// 发布前的内容闸门：一个候选 wiki 只有在与 resolve-config 解析出的同一份有效配置一致时才允许发布。
// 纯函数 evaluateContentGate(wiki, config) 只读入参与固定规则，不碰文件系统、不读环境、不记日志，
// 因此可以单测；拒绝由调用方（宿主接线）转成 content-gate-failed，而 warnings 只是建议信息，
// 绝不影响 ok（今天通过的 wiki 必须继续通过）。阈值全部来自传入的配置对象——没有硬编码默认值：
// 配置缺项或非法本身就是一条 config 失败（fail closed），绝不用一个“大概的”默认值顶替。
//
// 字数上限的显式容差：允许超出 wordsPerPage[1] 至多 15%（四舍五入到整词），下限没有容差。
// 严重性按方向分开：低于下限是真实的质量损失（必须拒绝），高于上限只是“内容膨胀”的格式偏好，
// 因此只记 warning、绝不拒绝发布——一次真实 run（28 页 + 20 卡、页数/图/known-issues/所有下限都满足）
// 曾因 known-issues 页 1185 词（上限 900+15%=1035）被整次拒绝，而“尽量详尽”正是协议对该页的要求。
export const CONTENT_GATE_OVER_TOLERANCE = 0.15;
// citations 是“覆盖率”问题而非逐页问题：只有大量页面完全没有引用才致命，否则只记 warning。
// 规则（固定、可复现，两条取“或”）：
//   1) uncited > CITATION_UNCITED_MAX_ABSOLUTE：整份 wiki 至多容忍 3 个缺引用页面；
//   2) uncited > pages.length * CITATION_UNCITED_MAX_SHARE：缺引用页面不得超过页面的 10%。
// 绝对上限让 28 页里 2 页缺引用存活（2 > 3 为假、2 > 2.8 为假）；相对上限防止小 wiki 里
// 少数页面其实是“多数页面”（2 页里 1 页=50% 仍致命）。真实 run 的 2/28 正是被这条规则救回的形态。
export const CITATION_UNCITED_MAX_ABSOLUTE = 3;
export const CITATION_UNCITED_MAX_SHARE = 0.1;
// 必须带图的页面分类（固定、可复现）：page.id 或 page.title 命中 architecture / data-flow /
// module-boundary / overview 的页面，在 diagrams=minimal|rich 时每页至少一张 mermaid 图。
export const DIAGRAM_PAGE_PATTERN = /architectur|data[-\s]?flow|module|overview/i;
// 专门的 known-issues 页：id 或标题命中 known-issues / known issues / knownissues。
export const KNOWN_ISSUES_PAGE_PATTERN = /known[-\s]?issues?/i;
// mermaid 围栏（```mermaid / ~~~mermaid），行首可有缩进。
const MERMAID_FENCE_RE = /^[ \t]*(?:```+|~~~+)[ \t]*mermaid\b/im;
// `path:line` 引用与 selfcheck 的 _REF_RE 同一形状、同一扩展名白名单：行内代码里的 相对路径:行号。
const CITATION_EXTS = "ts|tsx|js|jsx|cjs|mjs|json|md|wxml|py|go|rs|swift|kt|java|vue|yml|yaml|toml"
  + "|cpp|cc|hpp|hxx|cs|css|scss|less|html|htm|xml|sql|rb|php|lua|dart|mm|pl"
  + "|sh|bash|zsh|c|h|m|txt|ini|cfg|conf|env|properties|gradle|proto|graphql|tf";
const CITATION_RE = new RegExp("`[A-Za-z0-9._\\-/]+\\.(?:" + CITATION_EXTS + "):\\d+(?:-\\d+)?`", "gi");
const REPO_FILE_RE = new RegExp("[A-Za-z0-9._\\-/]+\\.(?:" + CITATION_EXTS + ")", "i");
const WORD_RE = /[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu;

/** 字数：markdown 里的词元数（含代码，确定性；短横线/撇号连接的算一个词）。 */
export function countWords(markdown) {
  const words = String(markdown ?? "").match(WORD_RE);
  return words === null ? 0 : words.length;
}

/** 页面是否带至少一张 mermaid 图（围栏代码块）。 */
export function pageHasDiagram(page) {
  return MERMAID_FENCE_RE.test(String(page?.markdown ?? ""));
}

/** 页面里的 `path:line` 引用条数。 */
export function countCitations(markdown) {
  const matches = String(markdown ?? "").match(CITATION_RE);
  return matches === null ? 0 : matches.length;
}

/** citations=relaxed 时的要求：页面至少点名一个仓库文件（filePaths 或 markdown 里的路径）。 */
export function pageNamesRepoFile(page) {
  if (Array.isArray(page?.filePaths) && page.filePaths.some((value) => typeof value === "string" && value.trim() !== "")) return true;
  return REPO_FILE_RE.test(String(page?.markdown ?? ""));
}

const pageLabelOf = (page) => `${typeof page?.id === "string" ? page.id : ""} ${typeof page?.title === "string" ? page.title : ""}`;

// ---------- coverage inventory (advisory warning, never a gate) ----------
// 协议要求根页面自己带一份计数清单：每个顶层目录 + 它的递归文件数 + covered/excluded
// （skills/worker-protocol.md "Cover the repository, not only its main directory"）。worker 只自查，
// 真实的 run 曾静默漏掉 specs/（50,605 文件）——这里把“清单缺席”变成机器可观测的 warning，但它
// **永远不影响 ok**：今天通过的 wiki 必须继续通过，任何 run 都不能因为这个检查失败。
// 判据是形态识别而非解析器，刻意保守——漏报可接受，误报（噪音、被当成闸门）不可接受：
//   1) 只认结构化条目：markdown 表格行，或 * / - / + / 1. 列表项；页首 front-matter 先剔除；
//   2) 计数必须是条目里真正与目录 token 配对的裸整数（允许 1,234 千分位与 files/file 计数词），
//      且路径引用里的行号（foo.ts:12）、ISO 日期、版本号先剔除，因此散文里一句“仓库有 50,605 个文件”不算；
//      表格要求目录单元格与计数单元格各自独立，列表要求计数紧跟在目录 token 之后；
//   3) 至少 MIN_INVENTORY_ENTRIES 条这样的条目才算“看起来有清单”（表格与列表可混合）。
// 想把启发式收紧或放宽，改下面的常量和三个谓词即可。
export const MIN_INVENTORY_ENTRIES = 3;
const FRONT_MATTER_RE = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;
const INVENTORY_TABLE_ROW_RE = /^[ \t]*\|/;
const INVENTORY_LIST_ITEM_RE = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/;
// 条目里“看起来像计数、但不是文件数”的数字：path:line 引用、ISO 日期、版本号。
const INVENTORY_NOISE_RES = [
  /\b[A-Za-z0-9_.\-/]+\.[A-Za-z0-9]{1,8}:\d+(?:-\d+)?\b/g,
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /\bv?\d+\.\d+(?:\.\d+)*\b/g,
];
const INVENTORY_COUNT_WORD = "files?|file|items?|entries|个文件|文件|个|条";
// 表格里的计数单元格：整个格子就是一个计数（可带计数词）。
const INVENTORY_COUNT_CELL_RE = new RegExp(`^(?:\\d{1,3}(?:[,_\\u00a0 ]\\d{3})+|\\d+)(?:\\s+(?:${INVENTORY_COUNT_WORD}))?$`, "i");
// 列表项的计数必须紧跟目录 token（最多一个分隔符），后接条目末尾/标点/计数词——"1 of 6 areas" 这类散文不算。
const INVENTORY_LIST_COUNT_RE = new RegExp(
  `^(?:\\d{1,3}(?:[,_\\u00a0 ]\\d{3})+|\\d+)(?:\\s*(?:${INVENTORY_COUNT_WORD}))?(?=\\s*(?:$|[|),;\\]]|[—–]|-\\s|,))`,
  "i",
);

const stripInventoryNoise = (text) => INVENTORY_NOISE_RES.reduce((acc, re) => acc.replace(re, " "), String(text ?? ""));

/** 目录样 token：`specs/`、`apps/mobile-companion`、`plugins`；末段带扩展名（AGENTS.md）是文件，不是目录。 */
const isDirectoryToken = (raw) => {
  const token = String(raw ?? "").trim().replace(/[.,;:]+$/, "").replace(/^[`*_\s]+|[`*_\s]+$/g, "");
  if (!token || /\s/.test(token) || token.includes("..") || token.startsWith("/") || !/[A-Za-z0-9_]/.test(token)) return false;
  if (/^\d+$/.test(token)) return false;
  if (token.endsWith("/")) return token.length > 1;
  const last = token.slice(token.lastIndexOf("/") + 1);
  return !/\.[A-Za-z0-9]{1,8}$/.test(last);
};

const isInventoryCountCell = (raw) => INVENTORY_COUNT_CELL_RE.test(String(raw ?? "").trim().replace(/^[`*_\s]+|[`*_\s]+$/g, ""));

const lineHasInventoryEntry = (line) => {
  if (INVENTORY_TABLE_ROW_RE.test(line)) {
    const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
    return cells.some(isDirectoryToken) && cells.some(isInventoryCountCell);
  }
  if (!INVENTORY_LIST_ITEM_RE.test(line)) return false;
  const body = stripInventoryNoise(line.replace(INVENTORY_LIST_ITEM_RE, "")).trim();
  const [token, ...rest] = body.split(/\s+/);
  if (!isDirectoryToken(token)) return false;
  return INVENTORY_LIST_COUNT_RE.test(rest.join(" ").replace(/^[—–\-:|,：]\s*/, ""));
};

const stripFrontMatter = (markdown) => String(markdown ?? "").replace(FRONT_MATTER_RE, "");

/** 根页面 markdown 是否“看起来”带了一份计数的目录清单（至少 MIN_INVENTORY_ENTRIES 条配对条目）。 */
const hasDirectoryInventory = (markdown) => {
  let entries = 0;
  for (const line of stripInventoryNoise(stripFrontMatter(markdown)).split(/\r?\n/)) {
    if (!lineHasInventoryEntry(line)) continue;
    entries += 1;
    if (entries >= MIN_INVENTORY_ENTRIES) return true;
  }
  return false;
};

/**
 * 候选 wiki 对有效配置的确定性判定。
 * @param {object} wiki 已 assemble 的候选 wiki.json（只读 pages[]）
 * @param {object} config resolve-config 的 stdout（language/granularity/pages/wordsPerPage/diagrams/citations/skeleton）
 * @returns {{ok: boolean, failures: Array<{category: string, count: number, detail: string}>, warnings: Array<{category: string, detail: string}>}}
 *   failures 每个 category 至多一条；detail 只含计数与阈值，绝不含路径或页面内容。
 *   warnings 是纯建议信息（words-above-max、低占比的 citations、coverage-inventory），**绝不影响 ok**：
 *   ok 只由 failures 决定，而 failures 只装真正的质量失败（下限、页数、known-issues、diagrams、config 与超阈值的 citations）。
 */
export function evaluateContentGate(wiki, config) {
  const pages = Array.isArray(wiki?.pages) ? wiki.pages.filter((page) => page && typeof page === "object") : [];
  const wordsPerPage = Array.isArray(config?.wordsPerPage) ? config.wordsPerPage : null;
  const pagesConfig = config?.pages && typeof config.pages === "object" ? config.pages : null;
  const invalid = [];
  if (!wordsPerPage || wordsPerPage.length !== 2 || !wordsPerPage.every((n) => Number.isSafeInteger(n)) || wordsPerPage[0] > wordsPerPage[1]) {
    invalid.push("wordsPerPage");
  }
  if (!pagesConfig || !Number.isSafeInteger(pagesConfig.min) || !Number.isSafeInteger(pagesConfig.max) || pagesConfig.min > pagesConfig.max) {
    invalid.push("pages");
  }
  if (config?.diagrams !== "none" && config?.diagrams !== "minimal" && config?.diagrams !== "rich") invalid.push("diagrams");
  if (config?.citations !== "strict" && config?.citations !== "relaxed") invalid.push("citations");
  if (typeof config?.skeleton?.knownIssues !== "boolean") invalid.push("skeleton.knownIssues");
  if (invalid.length > 0) {
    // 解析后的配置不可用：闸门无法判定，按失败处理（fail closed），绝不用硬编码默认值顶替。
    return { ok: false, failures: [{ category: "config", count: invalid.length, detail: `the resolved config does not provide ${invalid.join(", ")}` }], warnings: [] };
  }

  const failures = [];
  // 建议性条目（words-above-max、低占比的 citations、coverage-inventory）只在这里累积，绝不影响 ok。
  const warnings = [];
  const minWords = wordsPerPage[0];
  const maxWords = wordsPerPage[1];
  const maxAllowed = Math.round(maxWords * (1 + CONTENT_GATE_OVER_TOLERANCE));
  let below = 0;
  let above = 0;
  let uncited = 0;
  for (const page of pages) {
    const words = countWords(page.markdown);
    if (words < minWords) below += 1;
    else if (words > maxAllowed) above += 1;
    if (config.citations === "strict") {
      if (countCitations(page.markdown) < 1) uncited += 1;
    } else if (!pageNamesRepoFile(page)) {
      uncited += 1;
    }
  }
  if (below > 0) {
    failures.push({ category: "words-below-min", count: below, detail: `${below} page(s) below wordsPerPage[0]=${minWords}` });
  }
  if (above > 0) {
    // 上限是格式偏好，不是质量失败：只警告（detail 措辞保持原样，便于既有日志检索）。
    warnings.push({
      category: "words-above-max",
      detail: `${above} page(s) above ${maxAllowed} words (wordsPerPage[1]=${maxWords} + ${Math.round(CONTENT_GATE_OVER_TOLERANCE * 100)}% tolerance)`,
    });
  }
  if (uncited > 0) {
    const requirement = config.citations === "strict" ? "a path:line citation" : "a repository file reference";
    const detail = `${uncited} page(s) carry no ${requirement} under citations=${config.citations}`;
    if (uncited > CITATION_UNCITED_MAX_ABSOLUTE || uncited > pages.length * CITATION_UNCITED_MAX_SHARE) {
      failures.push({ category: "citations", count: uncited, detail });
    } else {
      warnings.push({ category: "citations", detail });
    }
  }
  if (config.diagrams !== "none") {
    const diagramPages = pages.filter((page) => DIAGRAM_PAGE_PATTERN.test(pageLabelOf(page)));
    const missing = diagramPages.filter((page) => !pageHasDiagram(page)).length;
    if (missing > 0) {
      failures.push({
        category: "diagrams",
        count: missing,
        detail: `${missing} of ${diagramPages.length} architecture/data-flow/module/overview page(s) carry no diagram under diagrams=${config.diagrams}`,
      });
    }
  }
  if (config.skeleton.knownIssues === true && !pages.some((page) => KNOWN_ISSUES_PAGE_PATTERN.test(pageLabelOf(page)))) {
    failures.push({ category: "known-issues", count: 1, detail: `no dedicated known-issues page in ${pages.length} page(s) while skeleton.knownIssues=true` });
  }
  if (pages.length < pagesConfig.min || pages.length > pagesConfig.max) {
    failures.push({
      category: "page-count",
      count: pages.length,
      detail: `${pages.length} page(s) outside pages.min=${pagesConfig.min}..pages.max=${pagesConfig.max}`,
    });
  }

  // 仅建议，不入 failures：root 页面（parentId == null）应自带计数清单，缺席只记账、不拒绝。
  const rootPages = pages.filter((page) => page.parentId === null || page.parentId === undefined);
  const missingInventory = rootPages.filter((page) => !hasDirectoryInventory(page.markdown)).length;
  if (rootPages.length === 0) {
    warnings.push({ category: "coverage-inventory", detail: `no root page (parentId == null) among ${pages.length} page(s), so no counted directory inventory could be checked` });
  } else if (missingInventory > 0) {
    warnings.push({
      category: "coverage-inventory",
      detail: `${missingInventory} of ${rootPages.length} root page(s) carry no counted directory inventory (at least ${MIN_INVENTORY_ENTRIES} table/list entries pairing a directory with its file count)`,
    });
  }
  return { ok: failures.length === 0, failures, warnings };
}

const sleep = (ms) => new Promise((resolve) => { const timer = setTimeout(resolve, Math.max(1, ms)); if (typeof timer.unref === "function") timer.unref(); });

const asPathKey = (value) => {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

function execFileResult(file, args, options) {
  return new Promise((resolve) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      resolve({ error, code: error ? (typeof error.code === "number" ? error.code : null) : 0, code_: error?.code ?? null, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

export class JobError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "JobError";
    this.status = status;
    this.code = code;
  }
}

// ---------- worker contract (spec 007 R&D design; DORMANT, see header) ----------

/** The only tools a worker session may expose. Mirrors worker-guard ALLOWED_TOOLS (kept local so jobs.js has no direct worker-* import). */
export const WORKER_TOOL_NAMES = Object.freeze(["read", "glob", "grep", "write", "edit"]);

/** Preset id the caller registers (NOT registered here). */
export const WORKER_PRESET_ID = "dsh-wiki-worker";

const deepFreeze = (value) => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
};

/**
 * Agent-preset definition for the worker: complete persona, no runtime context, tool-fs (read/write/edit)
 * and tool-fs-search (glob/grep) only. DATA ONLY for tests and a future, separately approved registration
 * (`agentPresets.register(definition)`); nothing in this module registers it.
 */
export const WORKER_PRESET_DEFINITION = deepFreeze({
  id: WORKER_PRESET_ID,
  name: "dsh-wiki worker",
  description: "Background Repo Wiki worker: read, glob, grep, write, edit only.",
  plugins: [
    {
      id: "persona",
      name: "@deepseek-ai/dsh-persona",
      config: {
        prefix: "You are the documentation worker for one Repo Wiki job. Follow only the task message supplied by the Host.",
        suffix: "",
        complete: true,
        includeRuntimeContext: false,
      },
    },
    { id: "tool-fs", name: "@deepseek-ai/dsh-tool-fs", config: { readImage: false, applyPatch: false } },
    { id: "tool-fs-search", name: "@deepseek-ai/dsh-tool-fs-search", config: { sampleOverCapGlobResults: false } },
  ],
});

/**
 * `user/message` source kinds that mean a context loader injected text into the worker session
 * (names verified in the installed Host: dsh-agent-instructions, dsh-tool-skill).
 */
export const CONTEXT_LEAK_SOURCE_KINDS = Object.freeze(["agent-instructions", "skill-invocation", "skill-catalog"]);

/**
 * Context-leak tripwire. Returns null (clean) or { kind, seq? }. FAIL CLOSED: a session whose events
 * cannot be read is reported as { kind: "unreadable" }, never as clean.
 */
export function findContextLeak(agent) {
  let events;
  try { events = agent?.session?.snapshotEvents?.(); } catch { return { kind: "unreadable" }; }
  if (!Array.isArray(events)) return { kind: "unreadable" };
  for (const event of events) {
    if (event?.type !== "user/message") continue;
    const kind = event.data?.source?.kind;
    if (CONTEXT_LEAK_SOURCE_KINDS.includes(kind)) return { kind, seq: event.seq ?? null };
  }
  return null;
}

const turnEndCount = (agent) => {
  try {
    const events = agent?.session?.snapshotEvents?.();
    return Array.isArray(events) ? events.filter((e) => e?.type === "turn/end").length : 0;
  } catch { return 0; }
};

const sameNames = (names) => names.length === WORKER_TOOL_NAMES.length && WORKER_TOOL_NAMES.every((n) => names.includes(n)) && new Set(names).size === names.length;

/**
 * A mount result may only be accepted when it is a plain identity. The installed registry
 * (dsh-agent-preset-registry, dsh-v0.2.2-rc.1) THROWS for an unknown or broken preset and resolves
 * `{ id }`; any failure/diagnostic shape in the result is a truthful statement that nothing usable
 * was bound, so it must never be mistaken for success.
 * @returns {string|null} a problem description, or null when the shape is acceptable
 */
export function presetBindingProblem(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "agentPresets.mount() returned no preset identity";
  if (value.ok === false) return "agentPresets.mount() reported ok:false";
  if (value.status !== undefined && value.status !== null) {
    const status = String(value.status).toLowerCase();
    if (!["ok", "active", "mounted", "ready"].includes(status)) {
      return `agentPresets.mount() reported status ${JSON.stringify(String(value.status))}`;
    }
  }
  if (value.broken !== undefined && value.broken !== null && value.broken !== false) {
    return "the worker agent preset is reported broken";
  }
  if (value.error !== undefined && value.error !== null) return "agentPresets.mount() returned an error";
  if (value.failure !== undefined && value.failure !== null) return "agentPresets.mount() returned a failure";
  if (value.diagnostics !== undefined && value.diagnostics !== null) {
    if (!Array.isArray(value.diagnostics)) return "agentPresets.mount() returned non-array diagnostics";
    if (value.diagnostics.length > 0) return `agentPresets.mount() returned ${value.diagnostics.length} diagnostic(s)`;
  }
  return null;
}

/**
 * Bind the FIXED worker preset to the unpublished Agent and prove the binding took effect, before any
 * tool call, guard activation or turn. There is no supported "mount once and hope" mode:
 *   - the mount result must be the fixed identity and must not carry a failure/diagnostic shape;
 *   - `agentPresets.composedPreset(ctx)` (the registry's own read of the preset a live Agent uses) must
 *     report the same fixed id — without that API the binding is unprovable, so we refuse (fail closed).
 * Any failure rejects agents.create(): the job fails before followup instead of running unconfined.
 * @returns {Promise<string>} the verified preset id
 */
export async function mountVerifiedWorkerPreset(agentPresets, agentCtx) {
  if (typeof agentPresets?.mount !== "function") {
    throw new JobError(502, "preset-mount-failed", "the agentPresets service exposes no mount()");
  }
  if (typeof agentPresets?.composedPreset !== "function") {
    throw new JobError(502, "preset-unverifiable",
      "the agentPresets service exposes no composedPreset(); the worker preset binding cannot be verified, so no worker session is started");
  }
  let mounted;
  try {
    mounted = await agentPresets.mount(agentCtx, WORKER_PRESET_ID);
  } catch (error) {
    throw new JobError(502, "preset-mount-failed", `agentPresets.mount(${WORKER_PRESET_ID}) failed: ${error?.message ?? error}`);
  }
  const problem = presetBindingProblem(mounted);
  if (problem) throw new JobError(502, "preset-mount-failed", problem);
  if (mounted.id !== WORKER_PRESET_ID) {
    throw new JobError(502, "preset-mount-failed",
      `agentPresets.mount() bound ${JSON.stringify(mounted.id)} instead of the fixed worker preset ${WORKER_PRESET_ID}`);
  }
  let composed;
  try {
    composed = agentPresets.composedPreset(agentCtx);
  } catch (error) {
    throw new JobError(502, "preset-unverifiable", `composedPreset() failed (${error?.message ?? error}); the worker preset binding cannot be verified`);
  }
  if (composed !== WORKER_PRESET_ID) {
    throw new JobError(502, "preset-mount-failed",
      `the worker agent context is composed with ${JSON.stringify(composed ?? null)} instead of the fixed worker preset ${WORKER_PRESET_ID}`);
  }
  return mounted.id;
}

/**
 * Create the worker agent with every confinement step done INSIDE setup (before the agent is published).
 * Order: verified preset mount → tools.restrict → definitions == exactly 5 → pin executable identities →
 * workerGuard.activate (release tied to agentCtx effect) → tools.guard → model select.
 * Any failure rejects the create (the Host factory then disposes the half-built agent); no followup is sent.
 *
 * `request.writeRoot` is the guard's write scope instead of the whole staging directory. A translate job
 * passes `locales/<lang>/` here: the guard already allows exactly `pages/<name>.md` and `cards/<name>.md`
 * below its root, so the worker translates the locale mirror in place and the canonical tree at the
 * staging root is not writable by it at all (the post-worker re-seed covers a guard that does not hold).
 * @returns the AgentHandle `{ agent, dispose }`; the guard + activation live until `dispose()` resolves.
 */
export async function startGuardedWorker(deps, request) {
  const { agents, agentPresets, workerGuard, presetId } = deps;
  const { sessionId, root, stageDir, model, signal, writeRoot } = request;
  let activationRelease = null;
  // 注册与挂载必须是同一个固定 id：调用方不能把 worker 指向另一个（可能无关或缺失的）preset。
  if (presetId !== WORKER_PRESET_ID) {
    throw new JobError(502, "preset-mismatch", `the worker preset is fixed to ${WORKER_PRESET_ID}; refusing ${JSON.stringify(presetId ?? null)}`);
  }
  try {
    const handle = await agents.create({
      sessionId,
      agentOptions: { provider: model.provider, model: model.model },
      meta: { cwd: root, agentPreset: WORKER_PRESET_ID },
      ...(signal ? { signal } : {}),
      setup: async (agentCtx, agent) => {
        await mountVerifiedWorkerPreset(agentPresets, agentCtx);
        const tools = agentCtx?.tools;
        for (const method of ["restrict", "definitions", "executable", "guard"]) {
          if (typeof tools?.[method] !== "function") throw new JobError(502, "worker-tools-unavailable", `the worker context exposes no tools.${method}()`);
        }
        try { tools.restrict({ allow: [...WORKER_TOOL_NAMES] }); } catch (error) {
          throw new JobError(502, "worker-restrict-failed", `tools.restrict() refused: ${error?.message ?? error}`);
        }
        const names = tools.definitions(agent).map((d) => d?.name);
        if (!sameNames(names)) {
          throw new JobError(502, "worker-tools-mismatch", `the worker must expose exactly ${WORKER_TOOL_NAMES.join(", ")}; it exposes ${JSON.stringify(names)}`);
        }
        const pinned = new Map();
        for (const name of WORKER_TOOL_NAMES) {
          const definition = tools.executable(name, agent);
          if (!definition) throw new JobError(502, "worker-tools-mismatch", `no executable identity could be pinned for "${name}"`);
          pinned.set(name, definition);
        }
        // 写域默认是整个暂存目录；翻译作业传进来的是 locales/<lang>/ 镜像（canonical 树因此不在
        // worker 的可写范围内——guard 的写策略只允许 <root>/pages/*.md 与 <root>/cards/*.md）。
        const activationRoot = writeRoot === undefined ? stageDir : writeRoot;
        activationRelease = workerGuard.activate(agent.id, { repoRoot: root, stagingRoot: activationRoot, cwd: root });
        const release = activationRelease;
        // Released with the agent context: only agent teardown (handle.dispose) ends the confinement.
        agentCtx.effect(() => release, "dsh-wiki.worker-guard-activation");
        const disposeGuard = tools.guard((exec) => {
          let agentId = null;
          try { agentId = exec?.agent?.id ?? null; } catch { agentId = null; }
          if (agentId === agent.id) {
            let current;
            try { current = tools.executable(exec.name, agent); } catch { current = undefined; }
            const expected = pinned.get(exec.name);
            if (expected !== undefined && current !== expected) {
              return `dsh-wiki worker guard: tool "${String(exec.name)}" no longer resolves to the pinned executable (shadowed or re-registered)`;
            }
          }
          const decision = workerGuard.authorizeSync(exec);
          return decision.allow ? undefined : decision.reason;
        });
        if (typeof disposeGuard !== "function") throw new JobError(502, "guard-install-failed", "tools.guard() did not return a disposer function");
        if (typeof agent.model?.select !== "function") throw new JobError(502, "model-pin-failed", "the worker agent exposes no model selection API");
        agent.model.select({ provider: model.provider, model: model.model });
      },
    });
    if (!handle || !handle.agent || typeof handle.dispose !== "function") {
      throw new JobError(502, "worker-handle-invalid", "agents.create() did not return an { agent, dispose } handle");
    }
    return handle;
  } catch (error) {
    // create() rejected: the factory already disposed the half-built agent, so the activation can go.
    try { activationRelease?.(); } catch { /* idempotent */ }
    throw error;
  }
}

// ---------- 失败诊断（本地证据，绝不出 HTTP） ----------
// 终态失败的作业只对外给出固定短句；真正的失败原因（builder stderr、内容闸门的分类细节）在这里落到
// <journalStoreDir>/failures/<jobId>.json，供本机运维直接读，而不必解压 worker transcript。
// 只在本机磁盘上：没有任何路由或响应投影读这个目录（见 publicJobView，它按 allowlist 重建字段）。
const FAILURE_DIR_NAME = "failures";
const FAILURE_DETAIL_MAX_BYTES = 8 * 1024;
const FAILURE_FILES_MAX = 50;
// 作业内存里只保留最近一段 builder/worker 输出：诊断尾部本身有界，作业也不会随输出增长。
const FAILURE_EVIDENCE_RETAIN = 64 * 1024;
const FAILURE_TRUNCATION_MARKER = "...[truncated: only the tail is kept]\n";

/**
 * Create the job manager. All Host services are INJECTED (no ctx.get discovery).
 * @param options.agents Host `agents` service (create)
 * @param options.agentPresets Host `agentPresets` service (mount + composedPreset; without composedPreset
 *   the worker preset binding is unprovable and start() is 503)
 * @param options.workingDirectory Host `workingDirectory` service (the caller builds workerGuard with getEffectiveCwd: a => workingDirectory.get(a.session))
 * @param options.workerGuard createWorkerGuard() instance (activate/authorizeSync); never installed globally
 * @param options.presetId MUST be WORKER_PRESET_ID: registration and mounting are pinned to the fixed
 *   worker preset, so a manager wired to any other id refuses to start (503)
 * @param options.buildWorkerPrompt worker-protocol.js buildWorkerPrompt (injected: jobs.js stays dormant w.r.t. that module)
 * @param options.runBuilder optional (job, args, timeoutMs) => {ok, code, output, stdout}; default runs build_wiki_site.py
 * @param options.contentGate optional (wiki, resolvedConfig) => {ok, failures[]}: the host's publication gate,
 *   applied to the assembled candidate after `assemble` and before the `validated` journal phase. The canonical
 *   implementation is evaluateContentGate(); the dsh-wiki plugin always supplies it. It is injected (like every
 *   other Host dependency) so a harness driving the pipeline with synthetic candidates decides its own policy.
 * @param options.startGuardedWorker optional override of the exported startGuardedWorker (tests)
 * @param options.pendingInput optional sync (agent) => array of pending human inputs (none known in the Host API; absent = never waiting)
 * @param options.getSourceCommit optional async (root) => sha|null
 * @param options.journalStore REQUIRED trusted journal store from openJournalStore({ storeDir outside every repo });
 *   journalStore, hostInstanceId and allowedRoots are always mandatory — a missing or partial set makes start() 503
 * @param options.hostInstanceId REQUIRED this Host instance token; pinned into every record this manager writes
 * @param options.allowedRoots REQUIRED array or () => array|Promise<array> of canonical repository roots the host authorized
 * @param options.workerLiveness optional trusted (record) => { state, proof?, sessionId? }; absent = "unknown",
 *   which makes reconcile() quarantine. A session id is never proof (see journal.js).
 */
export function createJobManager(options) {
  const cfg = options ?? {};
  const wikiDirName = typeof cfg.wikiDirName === "string" && cfg.wikiDirName ? cfg.wikiDirName : ".dsh-wiki";
  const builderPath = cfg.builderPath;
  const logger = cfg.logger ?? null;
  const jobTimeoutMs = Number.isFinite(cfg.jobTimeoutMs) ? cfg.jobTimeoutMs : 45 * 60 * 1000;
  // 一次“等待人工输入”的上限。后台作业没有人能回答，所以等待只能有界；它与作业的绝对预算取小
  // （见 waitWhileInputPending），因此暂停既不会无限等待，也不能把作业的结束时间往后推。
  const inputTimeoutMs = Number.isFinite(cfg.inputTimeoutMs) ? cfg.inputTimeoutMs : 10 * 60 * 1000;
  const buildTimeoutMs = Number.isFinite(cfg.buildTimeoutMs) ? cfg.buildTimeoutMs : 10 * 60 * 1000;
  const selfcheckTimeoutMs = Number.isFinite(cfg.selfcheckTimeoutMs) ? cfg.selfcheckTimeoutMs : 10 * 60 * 1000;
  const pollMs = Number.isFinite(cfg.pollMs) ? cfg.pollMs : 500;
  const idleGraceMs = Number.isFinite(cfg.idleGraceMs) ? cfg.idleGraceMs : 15000;
  const disposeTimeoutMs = Number.isFinite(cfg.disposeTimeoutMs) ? cfg.disposeTimeoutMs : idleGraceMs;
  // 终止/清理有自己**独立**的有界预算（cleanupTimeoutMs），绝不从作业的执行预算 deadlineAt 推导：
  // 执行预算已经过期的作业仍然必须能把 worker 停下、记 aborted、删暂存；否则“过期”本身就会留下
  // 一个停不下来的 worker。缺省沿用既有的 disposeTimeoutMs / idleGraceMs 语义（同一量级、同一边界）。
  const cleanupTimeoutMs = Number.isFinite(cfg.cleanupTimeoutMs)
    ? cfg.cleanupTimeoutMs
    : (Number.isFinite(cfg.disposeTimeoutMs) ? cfg.disposeTimeoutMs : idleGraceMs);
  const pythonCandidates = Array.isArray(cfg.pythonCandidates) && cfg.pythonCandidates.length
    ? cfg.pythonCandidates
    : [cfg.pythonPath, process.env.DSH_WIKI_PYTHON, "python3", "python", "py"].filter((v) => typeof v === "string" && v);

  const jobs = new Map(); // rootKey -> job
  const lastByRoot = new Map(); // rootKey -> summary
  const locks = new Map(); // rootKey -> Promise
  let disposed = false;

  // ---- trusted journal transaction (T018) ----
  // 三个依赖永远是必需的：任一缺失 => 503（fail closed），绝不存在“无 journal / 半 journal”发布。
  const journalStore = cfg.journalStore ?? null;
  const hostInstanceId = typeof cfg.hostInstanceId === "string" && cfg.hostInstanceId ? cfg.hostInstanceId : null;
  const allowedRootsProvider = cfg.allowedRoots ?? null;
  // 可选：可信 worker 存活证明提供者 (record) => { state, proof?, sessionId? }。缺省 = unknown => 隔离。
  const workerLiveness = typeof cfg.workerLiveness === "function" ? cfg.workerLiveness : null;

  const journalDepsMissing = () => {
    const missing = [];
    if (typeof journalStore?.load !== "function" || typeof journalStore?.create !== "function"
      || typeof journalStore?.advance !== "function" || typeof journalStore?.replaceTerminal !== "function") missing.push("journalStore");
    if (!hostInstanceId) missing.push("hostInstanceId");
    if (allowedRootsProvider === null) missing.push("allowedRoots");
    return missing;
  };

  const storeCode = (error) => (typeof error?.code === "string" && error.code ? error.code : "error");
  /** Store/journal 错误一律升级为致命：隔离、保留栅栏、禁止继续任何 rename。 */
  const journalFatal = (step, error) => {
    const code = storeCode(error);
    const failure = new JobError(0, `journal-${code}`, `the trusted journal ${step} step failed (${code}): ${error?.message ?? error}; nothing further is renamed and the repository fence stays raised`);
    failure.journalStep = step;
    failure.journalCode = code;
    failure.failClosed = true;
    return failure;
  };

  const resolveAllowedRoots = async () => {
    const raw = typeof allowedRootsProvider === "function" ? await allowedRootsProvider() : allowedRootsProvider;
    if (!Array.isArray(raw) || raw.length === 0) throw new JobError(503, "journal-roots-unavailable", "the allowedRoots provider did not return a non-empty array of canonical repository roots");
    return raw.filter((value) => typeof value === "string" && path.isAbsolute(value));
  };

  const warn = (message) => {
    try { logger?.warn?.(`dsh-wiki: ${message}`); } catch { /* 日志失败不影响作业 */ }
  };

  /**
   * 记下宿主最近一次拿到的 builder/worker 输出。只留一个尾部窗口（FAILURE_EVIDENCE_RETAIN），
   * 所以失败诊断有界、作业内存也不随子进程输出增长；真正的 8 KiB 截断发生在写文件时。
   */
  const recordOutput = (job, text) => {
    if (typeof text !== "string" || text.length === 0) return;
    const combined = job.evidence ? `${job.evidence}\n${text}` : text;
    job.evidence = combined.length > FAILURE_EVIDENCE_RETAIN
      ? combined.slice(combined.length - FAILURE_EVIDENCE_RETAIN)
      : combined;
  };

  /** 尾部截断：按 UTF-8 字节计数、切在字节边界上，并在开头显式标出“已截断”（绝不悄悄丢内容）。 */
  const boundedFailureDetail = (text) => {
    const buffer = Buffer.from(text, "utf8");
    if (buffer.length <= FAILURE_DETAIL_MAX_BYTES) return text;
    const marker = Buffer.from(FAILURE_TRUNCATION_MARKER, "utf8");
    const kept = buffer.subarray(buffer.length - (FAILURE_DETAIL_MAX_BYTES - marker.length));
    let start = 0; // 被切开的 UTF-8 续字节不能留在开头
    while (start < kept.length && (kept[start] & 0xc0) === 0x80) start += 1;
    return `${FAILURE_TRUNCATION_MARKER}${kept.subarray(start).toString("utf8")}`;
  };

  /** 只保留最近 FAILURE_FILES_MAX 个失败文件（按 mtime）：证据目录不能无限增长。 */
  const pruneFailureFiles = async (dir) => {
    const names = (await readdir(dir)).filter((name) => name.endsWith(".json"));
    const entries = [];
    for (const name of names) {
      try {
        const stats = await stat(path.join(dir, name));
        if (stats.isFile()) entries.push({ name, mtimeMs: stats.mtimeMs });
      } catch { /* 已经消失的文件不必计入 */ }
    }
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const stale of entries.slice(FAILURE_FILES_MAX)) {
      await rm(path.join(dir, stale.name), { force: true });
    }
  };

  /**
   * 终态失败写一份本地诊断（<journalStoreDir>/failures/<jobId>.json）：稳定字段 + 有界的输出尾部
   * （最近一次 builder/worker 输出，末尾附上失败消息）。路径与原始文本留在这台机器上是允许的，
   * 因为没有任何 HTTP 出口读它。全程 best effort：目录不可写只警告，绝不改变作业结果或抛出。
   */
  const writeFailureDiagnostic = async (job) => {
    const storeDir = typeof journalStore?.storeDir === "string" ? journalStore.storeDir : null;
    if (!storeDir) return;
    let temp = null;
    try {
      const dir = path.join(storeDir, FAILURE_DIR_NAME);
      await mkdir(dir, { recursive: true });
      const message = typeof job.error?.message === "string" ? job.error.message : "";
      const detail = boundedFailureDetail([job.evidence, message].filter((part) => typeof part === "string" && part.length > 0).join("\n"));
      const payload = {
        jobId: job.id,
        action: job.action,
        targetLang: job.targetLang ?? null,
        phase: job.phase,
        stage: typeof job.stage === "string" ? job.stage : null,
        errorCode: publicErrorCode(job.error?.code),
        finishedAt: new Date().toISOString(),
        detail,
      };
      const target = path.join(dir, `${job.id}.json`);
      // 临时文件 + rename：崩溃只会留下一个 .tmp，不会留下一份半截 JSON。
      temp = path.join(dir, `${job.id}.${globalThis.crypto.randomUUID()}.tmp`);
      await writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      await rename(temp, target);
      temp = null;
      await pruneFailureFiles(dir);
    } catch (error) {
      if (temp !== null) await rm(temp, { force: true }).catch(() => { /* 清理失败不改变结果 */ });
      warn(`could not write the failure diagnostic for job ${job.id}: ${error?.message ?? error}`);
    }
  };

  /** 单 root 串行锁：发布互斥。 */
  const withLock = (rootKey, task) => {
    const previous = locks.get(rootKey) ?? Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.then(() => {}, () => {});
    locks.set(rootKey, tail);
    tail.then(() => { if (locks.get(rootKey) === tail) locks.delete(rootKey); });
    return run;
  };

  const stagingDirFor = (root, jobId) => path.join(root, `${wikiDirName}.staging-${jobId}`);
  const backupDirFor = (root, jobId) => path.join(root, `${wikiDirName}.bak-${jobId}`);

  const summarize = (job) => ({
    id: job.id,
    root: job.root,
    action: job.action,
    model: { ...job.model },
    targetLang: job.targetLang,
    phase: job.phase,
    stage: job.stage,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    sessionId: job.sessionId,
    // 默认视图与公开投影同一条规则：错误只留固定 code + 固定短句。provider/builder 的原始文本、
    // 路径与 stack 只进 logger（run() 的失败分支），任何离开 Host 的载荷都不携带它们。
    error: publicError(job.error),
    published: job.published === true,
    pages: Number.isSafeInteger(job.pages) && job.pages >= 0 ? job.pages : null,
    promptSha256: publicSha(job.promptSha256),
    protocolSha256: publicSha(job.protocolSha256),
    waitingFor: Array.isArray(job.waitingFor)
      ? job.waitingFor.filter((entry) => publicString(entry, 200) !== null).slice(0, 20)
      : null,
    // staging 是宿主路径，绝不进入任何摘要；blocked 只留稳定原因码与 journal 标志。
    blocked: publicJobBlocked(job.blocked),
    journalPhase: publicString(job.journalPhase, 32),
    journalJobId: publicString(job.snapshot?.record?.jobId, 64),
    // 增量事实（spec 013 §2.2 步骤 8）：非增量作业恒为 null，键本身始终存在，形状因此不随作业类型变化。
    incremental: publicIncremental(job.incremental),
  });

  const setStage = (job, stage) => {
    job.stage = stage;
    job.updatedAt = new Date().toISOString();
  };

  /**
   * 作业的绝对预算剩余毫秒。deadlineAt 只在 start() 里算一次（startedAt + jobTimeoutMs），
   * 之后没有任何地方重算它：supervise、输入等待、启动竞速全都只读这同一个值。
   * 旧实现每次回到 supervise() 都新开一个 jobTimeoutMs 窗口，于是每次输入暂停都能把执行预算
   * 续上一次——作业可以永久占住 journal 栅栏、暂存与单飞栅栏。
   */
  const remainingJobMs = (job) => job.deadlineAt - Date.now();

  /**
   * 绝对预算闸门（T031 跟进）：同一个 deadlineAt 的剩余量，在每一个宿主阶段 / 子命令 / 异步准备
   * 之前检查。剩余 <= 0 就拒绝开始——绝不开始一个注定越过截止时间的阶段。稳定 code 沿用既有的
   * job-timeout（公开短句由 PUBLIC_ERROR_MESSAGES 决定，这里的细节只进 logger）。
   * 终止/清理**不**经过这里：它们有自己的有界清理预算 cleanupTimeoutMs（见 terminateWorker）。
   */
  const requireJobBudget = (job, phase) => {
    const remaining = remainingJobMs(job);
    if (remaining <= 0) {
      throw new JobError(0, "job-timeout", `the job's absolute budget ran out at the ${phase} phase`);
    }
    return remaining;
  };

  /** 子进程/探测调用自己的上限绝不能越过作业的绝对预算：取二者较小者（ms，至少 1 才不会变成“无上限”）。 */
  const budgetedTimeoutMs = (job, limitMs) => Math.max(1, Math.min(limitMs, remainingJobMs(job)));

  const BUDGET_EXPIRED = Symbol("job-budget-expired");

  /**
   * 异步准备（注入的宿主函数可能永不 settle）与同一个绝对预算竞速；到期即 job-timeout，
   * 由调用方走既有失败→终止→清理路径，而不是让作业永远挂在准备阶段。
   * @param {() => Promise<any>} start 只在闸门通过之后才调用，确保没有“已经开跑才被告知超限”的步骤。
   */
  const withinJobBudget = async (job, phase, start) => {
    const remaining = requireJobBudget(job, phase);
    let timer;
    const expiry = new Promise((resolve) => {
      timer = setTimeout(() => resolve(BUDGET_EXPIRED), remaining);
      if (typeof timer.unref === "function") timer.unref();
    });
    try {
      const result = await Promise.race([Promise.resolve().then(start), expiry]);
      if (result === BUDGET_EXPIRED) {
        throw new JobError(0, "job-timeout", `the job's absolute budget ran out at the ${phase} phase`);
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
  };

  /** 注入的宿主服务；缺任何一项都 503（作业不会半途发现服务）。 */
  const missingDeps = () => {
    const missing = [];
    if (typeof cfg.agents?.create !== "function") missing.push("agents");
    if (typeof cfg.agentPresets?.mount !== "function") missing.push("agentPresets");
    // 没有 composedPreset() 就无法证明 preset 真的绑定到了这个 agent：宁可 503，也不跑一个未证实的组合。
    if (typeof cfg.agentPresets?.composedPreset !== "function") missing.push("agentPresets.composedPreset");
    if (typeof cfg.workingDirectory?.get !== "function") missing.push("workingDirectory");
    if (typeof cfg.workerGuard?.activate !== "function" || typeof cfg.workerGuard?.authorizeSync !== "function") missing.push("workerGuard");
    // preset id 是固定的（注册与挂载必须同一个）：任何别的值都不构成可用依赖。
    if (cfg.presetId !== WORKER_PRESET_ID) missing.push("presetId");
    if (typeof cfg.buildWorkerPrompt !== "function") missing.push("buildWorkerPrompt");
    // journal 依赖永远必需：不允许无 journal / 半 journal 发布。
    missing.push(...journalDepsMissing());
    return missing;
  };

  const requireServices = () => {
    const missing = missingDeps();
    if (missing.length) throw new JobError(503, "services-unavailable", `background jobs need the ${missing.join(", ")} dependency`);
  };

  const readPending = (agent) => {
    if (typeof cfg.pendingInput !== "function") return [];
    try {
      const pending = cfg.pendingInput(agent);
      return Array.isArray(pending) ? pending : [];
    } catch { return []; }
  };

  /** 探测一个可用的 python 解释器（每次探测最长 5s，且不超过作业的绝对预算；无 shell）；返回展示用的命令名或 null。 */
  const resolvePython = async (job) => {
    for (const candidate of pythonCandidates) {
      const [file, prefix] = candidate === "py" ? ["py", ["-3"]] : [candidate, []];
      const probe = await execFileResult(file, [...prefix, "-c", "print(1)"], {
        timeout: budgetedTimeoutMs(job, 5000), windowsHide: true, shell: false, maxBuffer: 64 * 1024,
      });
      if (probe.code === 0) return { candidate, file, prefix };
    }
    return null;
  };

  /**
   * 宿主运行一个 builder 子命令；无 shell、逐个尝试 python 候选。
   * 超时取“调用方给的上限”与作业绝对预算剩余量的较小者：配置 / assemble / build / selfcheck
   * 的单次调用都不能越过同一个 deadlineAt（buildTimeoutMs 只是阶段自己的上限，不是作业的上限）。
   * stdout 单独返回（resolve-config 的 JSON 只在 stdout，告警在 stderr）。
   * @returns {{ok:boolean, code:number|null, output:string, stdout:string}}
   */
  const runBuilder = async (job, args, limitMs) => {
    const timeoutMs = budgetedTimeoutMs(job, limitMs);
    if (typeof cfg.runBuilder === "function") {
      const result = await cfg.runBuilder(job, args, timeoutMs);
      // 注入的执行器同样收进失败证据：终态失败时它的 output 就是运维需要的那段尾迹。
      recordOutput(job, result?.output);
      return result;
    }
    const failures = [];
    const ordered = job.python ? [job.python.candidate, ...pythonCandidates.filter((c) => c !== job.python.candidate)] : pythonCandidates;
    for (const candidate of ordered) {
      const [file, prefix] = candidate === "py" ? ["py", ["-3"]] : [candidate, []];
      const result = await execFileResult(file, [...prefix, builderPath, ...args], {
        timeout: timeoutMs, windowsHide: true, shell: false, maxBuffer: 8 * 1024 * 1024, cwd: job.root,
      });
      if (result.code_ === "ENOENT") { failures.push(`${file}: not found`); continue; }
      job.engine = file;
      const output = `${result.stdout}${result.stderr}`.trim();
      recordOutput(job, output);
      return { ok: result.code === 0, code: result.code, output: output.slice(0, 4000), stdout: result.stdout };
    }
    const missing = `no python interpreter found (tried ${pythonCandidates.join(", ")}; ${failures.join("; ")})`;
    recordOutput(job, missing);
    return { ok: false, code: null, output: missing, stdout: "" };
  };

  const sourceCommit = async (root) => {
    if (typeof cfg.getSourceCommit === "function") {
      try { return (await cfg.getSourceCommit(root)) ?? null; } catch { return null; }
    }
    const result = await execFileResult("git", ["-C", root, "rev-parse", "HEAD"], { timeout: 5000, windowsHide: true, shell: false, maxBuffer: 64 * 1024 });
    const sha = result.stdout.trim();
    return result.code === 0 && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
  };

  /**
   * 读一个已经由 fs-contain 证明过身份的普通文件，并把这份身份绑到真正打开的句柄上。
   *
   * identityOf 与“按路径 readFile”之间没有原子性：并发的写入者可以把文件或某一级祖先换掉，于是
   * 仓库外的字节在读进来之前没有任何东西能拦；事后的 verifySame 只能拒绝，无法撤销已经发生的读。
   * 所以与 lib/index.js 的 readContainedFile 走同一模式：open 之后立刻 fstat 句柄，dev/ino 与
   * kind 必须与证明一致，不一致立即拒绝；通过之后才从句柄读。任何拒绝都发生在读到第一个字节之前。
   *
   * @param {string|null} [encoding="utf8"] 传 null 表示读原始字节（Buffer）：内容比较必须用字节，
   *   解码会把不同的非法序列折叠成同一个 U+FFFD（见 shaOfStagedEntry）。
   */
  const readProvenFile = async (target, identity, encoding = "utf8") => {
    const handle = await open(target, "r");
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || String(opened.dev) !== identity.dev || String(opened.ino) !== identity.ino) {
        const mismatch = new Error(`the opened handle is not the proven file (proven dev/ino ${identity.dev}/${identity.ino}, opened ${opened.dev}/${opened.ino})`);
        mismatch.code = "identity-mismatch";
        throw mismatch;
      }
      return encoding === null ? await handle.readFile() : await handle.readFile(encoding);
    } finally {
      await handle.close().catch(() => { /* 关闭失败不改变已经做出的判断 */ });
    }
  };

  /**
   * live wiki 声明的语言；没有 wiki.json / 不可解析 / 无 language 时返回 null。
   *
   * 读取前必须有包含性证明（review 缺陷）：live 是仓库里由攻击者控制的目录，`.dsh-wiki` 本身或它的
   * 某一级祖先被换成 junction/符号链接时，裸 readFile 会读到仓库外的字节。所以先用 fs-contain 证明
   * root 与 live 都是规范目录、wiki.json 是单链接常规文件（记住这份身份），再按 readProvenFile 把
   * 同一身份绑到打开的句柄上读；证明不了就拒绝（live-untrusted），绝不把“看不清”当成“没有 live wiki”。
   */
  const liveLanguage = async (root) => {
    let repoDir;
    try {
      repoDir = (await assertCanonicalDir(root)).path;
    } catch (error) {
      throw new JobError(409, "root-untrusted", `the repository root ${root} is not a trusted canonical directory (${error?.code ?? "error"}): ${error?.message ?? error}`);
    }
    const live = path.join(repoDir, wikiDirName);
    let liveDir;
    try {
      liveDir = (await assertCanonicalDir(live)).path;
    } catch (error) {
      if (error?.code === "path-not-found") return null;
      throw new JobError(409, "live-untrusted", `the live ${wikiDirName} of ${root} is not a trusted canonical directory (${error?.code ?? "error"}): ${error?.message ?? error}`);
    }
    const wikiJson = path.join(liveDir, "wiki.json");
    let wikiIdentity;
    try {
      wikiIdentity = await identityOf(wikiJson);
    } catch (error) {
      if (error?.code === "path-not-found") return null;
      throw new JobError(409, "live-untrusted", `the live ${wikiDirName}/wiki.json of ${root} cannot be proven a contained regular file (${error?.code ?? "error"}): ${error?.message ?? error}`);
    }
    if (wikiIdentity.kind !== "file" || wikiIdentity.nlink !== "1") {
      throw new JobError(409, "live-untrusted", `the live ${wikiDirName}/wiki.json of ${root} is not a single-link regular file`);
    }
    let raw;
    try {
      raw = await readProvenFile(wikiJson, wikiIdentity);
    } catch (error) {
      throw new JobError(409, "live-untrusted", `the live ${wikiDirName}/wiki.json of ${root} could not be read as the file that was proven (${error?.code ?? "error"})`);
    }
    try {
      const wiki = JSON.parse(raw);
      return wiki && typeof wiki === "object" && typeof wiki.language === "string" ? wiki.language : null;
    } catch {
      return null;
    }
  };

  /**
   * 读取暂存候选的 wiki.json；缺失/非 JSON 都以固定 code 失败（从不静默跳过）。
   * 同一原则：先证明这个路径本身是单链接常规文件（fs-contain 会逐级 lstat 并比对 realpath），
   * 再按 readProvenFile 把同一身份绑到打开的句柄上读，绝不顺着候选里的链接去读。
   */
  const readCandidateWiki = async (job) => {
    const target = path.join(job.stageDir, "wiki.json");
    let wikiIdentity;
    try {
      wikiIdentity = await identityOf(target);
    } catch (error) {
      if (error?.code === "path-not-found") throw new JobError(0, "candidate-missing", `the candidate wiki is missing ${target}`);
      throw new JobError(0, "candidate-untrusted", `the candidate ${path.basename(target)} cannot be proven a contained regular file (${error?.code ?? "error"})`);
    }
    if (wikiIdentity.kind !== "file" || wikiIdentity.nlink !== "1") {
      throw new JobError(0, "candidate-untrusted", `the candidate ${path.basename(target)} is not a single-link regular file`);
    }
    let raw;
    try {
      raw = await readProvenFile(target, wikiIdentity);
    } catch (error) {
      throw new JobError(0, "candidate-untrusted", `the candidate ${path.basename(target)} could not be read as the file that was proven (${error?.code ?? "error"})`);
    }
    try { return JSON.parse(raw); } catch { throw new JobError(0, "candidate-invalid", "candidate wiki.json is not valid JSON"); }
  };

  const CONTENT_GATE_WARN_MAX = 8;

  /**
   * 内容闸门（owner-visible 质量门）：assemble 之后、validated 之前，用 resolve-config 的同一份有效配置
   * 判定候选。失败时每个 category 恰好一条有界警告（细节只进 logger），并以 "content-gate-failed"
   * 拒绝发布；公开错误只读 PUBLIC_ERROR_MESSAGES，载荷里没有任何路径或页面内容。
   * 建议性 warnings（如 coverage-inventory）同样只进 logger：通过时也要发（否则算了等于没算），
   * detail 原样透传（只含计数与阈值），绝不改 phase/journal、绝不拒绝发布。
   * 宿主未注入 contentGate 时不判定（dsh-wiki 插件永远注入 evaluateContentGate）。
   */
  const applyContentGate = async (job) => {
    if (typeof cfg.contentGate !== "function") return;
    const wiki = await readCandidateWiki(job);
    let verdict;
    try {
      verdict = cfg.contentGate(wiki, job.config);
    } catch (error) {
      throw new JobError(0, "content-gate-failed", `the content gate could not evaluate the candidate: ${error?.message ?? error}`);
    }
    if (verdict === null || verdict === undefined) return;
    const failed = verdict.ok !== true;
    const failures = failed && Array.isArray(verdict.failures) ? verdict.failures.slice(0, CONTENT_GATE_WARN_MAX) : [];
    for (const failure of failures) {
      const category = typeof failure?.category === "string" ? failure.category : "unknown";
      const count = Number.isSafeInteger(failure?.count) ? failure.count : 0;
      const detail = typeof failure?.detail === "string" ? failure.detail : "";
      warn(`content gate refused the candidate for job ${job.id} [${category}] ${count}: ${detail}`);
    }
    // 建议性 warnings 排在失败之后：失败的闸门先把自己的失败报完，建议信息既不遮蔽也不重排它们。
    const warnings = Array.isArray(verdict.warnings) ? verdict.warnings.slice(0, CONTENT_GATE_WARN_MAX) : [];
    for (const warning of warnings) {
      const category = typeof warning?.category === "string" ? warning.category : "unknown";
      const detail = typeof warning?.detail === "string" ? warning.detail : "";
      warn(`content gate advisory for job ${job.id} [${category}]: ${detail}`);
    }
    if (!failed) return;
    // 闸门拒绝的真实原因（分类、计数与只进 logger 的细节）同样进失败证据：固定公开短句里没有它，
    // 而它正是运维唯一能据以复现的线索。
    recordOutput(job, failures
      .map((failure) => `${failure?.category ?? "unknown"}: ${Number.isSafeInteger(failure?.count) ? failure.count : 0} ${typeof failure?.detail === "string" ? failure.detail : ""}`.trim())
      .join("\n"));
    const summary = failures.map((failure) => `${failure?.category ?? "unknown"}: ${Number.isSafeInteger(failure?.count) ? failure.count : 0}`).join(", ");
    throw new JobError(0, "content-gate-failed",
      `the candidate wiki does not meet the resolved content requirements${summary ? ` (${summary})` : ""}`);
  };

  /**
   * non-en 语言真的到达这里时：对候选执行 check-translation，失败即 fail closed，
   * 分别抛 translation-gate-failed / translation-gate-timeout / translation-gate-unavailable。
   *
   * 但它在生产里当前不可达：所有非 en 语言都在进入本流水线之前就被拒绝
   * （index.js 501 language-unsupported、manager.start 501、buildWorkerPrompt invalid-config
   * “canonical English only”），所以今天它只会走 en 的 no-op 路径。
   *
   * 保留而不删除：翻译开启后（T014/T017）它就是必需的完整性闸门，且它的 no-op 路径已有测试覆盖。
   *
   * 警告：不要把它算作当前的一层保护 —— 在非 en 语言能进入本流水线之前，它保护不了任何东西。
   */
  /**
   * 翻译完整性闸门（宿主所有）：canonical 之外的每种语言在发布前由宿主用 check-translation 复查。
   * en 在这里直接返回（零扫描、零子进程）；其余语言失败即拒绝发布。
   * 失败顺序是固定的 fail closed 契约：超时 / 查不了（没有 exit code、stdout 不是对象）各有独立 code，
   * 绝不把“查不了”降级成“通过”；公开错误只读 PUBLIC_ERROR_MESSAGES，载荷里没有任何路径或页面内容。
   */
  const applyTranslationGate = async (job) => {
    const language = job.config?.language;
    if (typeof language !== "string" || language === "en") return;
    requireJobBudget(job, "translation gate");
    setStage(job, "translation gate");
    await guardHostPhase(job, "translation gate");
    // 检查器脚本本身缺失就无法复查：这是“查不了”，不是通过。
    if (typeof builderPath !== "string" || !existsSync(builderPath)) {
      throw new JobError(0, "translation-gate-unavailable", "the translation checker script is missing");
    }
    const result = await runBuilder(job, ["check-translation", "--canonical", job.stageDir, "--lang", language, "--json"], buildTimeoutMs);
    // 被掐断的子命令与“根本没有 exit code”必须分开报：前者是 timeout，后者是 unavailable。
    const timedOut = result?.timedOut === true || result?.killed === true || result?.code_ === "ETIMEDOUT";
    if (timedOut) {
      throw new JobError(0, "translation-gate-timeout", "the translation checker did not finish before its deadline");
    }
    if (!Number.isSafeInteger(result?.code)) {
      throw new JobError(0, "translation-gate-unavailable", "the translation checker produced no exit code");
    }
    if (result.code !== 0) {
      requireJobBudget(job, "translation gate"); // 被 deadline 掐断的子命令报 job-timeout，而不是它自己的失败
      throw new JobError(0, "translation-gate-failed",
        `check-translation failed (exit ${result.code}): ${String(result.output ?? "").slice(0, 1200)}`);
    }
    let verdict;
    try { verdict = JSON.parse(result.stdout); } catch { verdict = null; }
    if (verdict === null || typeof verdict !== "object" || Array.isArray(verdict)) {
      throw new JobError(0, "translation-gate-unavailable", "check-translation stdout is not a single JSON object");
    }
    if (verdict.ok !== true) {
      throw new JobError(0, "translation-gate-failed", "the candidate wiki failed its translation integrity check");
    }
  };

  const validateCandidate = async (job) => {
    const wiki = await readCandidateWiki(job);
    if (!wiki || typeof wiki !== "object" || !Array.isArray(wiki.pages) || wiki.pages.length === 0) {
      throw new JobError(0, "candidate-invalid", "candidate wiki.json has no pages");
    }
    if (wiki.language !== "en") {
      throw new JobError(0, "candidate-language", `candidate wiki.json language must be exactly "en" (canonical), got ${JSON.stringify(wiki.language ?? null)}`);
    }
    const repoId = typeof wiki.repoId === "string" ? wiki.repoId : "";
    if (!repoId || !path.isAbsolute(repoId) || asPathKey(repoId) !== asPathKey(job.root)) {
      throw new JobError(0, "candidate-repo-mismatch", `candidate wiki.json repoId must be the repository root ${job.root}, got "${repoId}"`);
    }
    job.pages = wiki.pages.length;
  };

  /**
   * 逐个条目保留宿主拥有的 live 内容：来源必须是可证明包含在 live 之下的普通条目。
   *
   * lstat 只看最后一段、也不重走祖先，所以“是普通文件”并不等于“在 live 里”：硬链接把 live 之外的
   * 同名内容链接进来时，copyFile 会把它复制成一个全新的单链接文件，最后的整树扫描只会看到 nlink 1，
   * 事后无法分辨。因此来源一律先用 fs-contain 证明（逐级 lstat + realpath），普通文件还必须是
   * nlink === 1；证明不了或不是单链接就 fail closed，绝不复制。
   */
  const copyProtectedEntry = async (source, dest) => {
    let identity;
    try {
      identity = await identityOf(source);
    } catch (error) {
      if (error?.code === "path-link") {
        throw new JobError(0, "protected-symlink", `refusing to publish: ${source} is a symlink; host-owned ${wikiDirName} content must be a regular file or directory`);
      }
      if (error?.code === "ancestor-link") {
        throw new JobError(0, "protected-symlink", `refusing to publish: ${source} crosses a symlink or junction; host-owned ${wikiDirName} content must be a regular file or directory`);
      }
      throw new JobError(0, "protected-invalid", `refusing to publish: ${source} cannot be proven a contained ${wikiDirName} entry (${error?.code ?? "error"}): ${error?.message ?? error}`);
    }
    if (identity.kind === "dir") {
      await mkdir(dest, { recursive: true });
      for (const name of await readdir(source)) await copyProtectedEntry(path.join(source, name), path.join(dest, name));
      return;
    }
    if (identity.kind !== "file") {
      throw new JobError(0, "protected-invalid", `refusing to publish: ${source} is not a regular file or directory`);
    }
    if (identity.nlink !== "1") {
      throw new JobError(0, "protected-hardlink", `refusing to publish: ${source} is a hardlinked file (nlink ${identity.nlink}); host-owned ${wikiDirName} content must be a contained single-link regular file`);
    }
    await copyFile(source, dest);
  };

  /**
   * 存在性探针：只有 ENOENT（真正的“不存在”）才等于缺席。其它错误（junction 祖先、权限、换位）
   * 一律 fail closed——把“看不清”当成“没有”会静默丢掉宿主拥有的内容，或删掉一个看不见的生成条目。
   */
  const probeOrFail = async (target, status, code, what) => {
    try {
      await lstat(target);
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw new JobError(status, code, `refusing to publish: ${what} cannot be probed (${error?.code ?? "error"}): ${error?.message ?? error}`);
    }
  };

  /**
   * 翻译作业的 locales 合并：live 的其它语言目录仍由宿主拥有（逐条复制），但本作业自己的目标语言
   * 目录是候选的产物，必须留下——否则刚翻译好的内容会被 live 的旧版本整目录覆盖。
   */
  const mergeHostOwnedLocales = async (job, live, staged, targetLang) => {
    let stagedDir;
    try {
      stagedDir = (await assertCanonicalDir(staged)).path;
    } catch (error) {
      throw new JobError(0, "candidate-untrusted", `the staged locales directory of the candidate is not a trusted canonical directory (${error?.code ?? "error"})`);
    }
    for (const name of await readdir(stagedDir)) {
      if (name === targetLang) continue;
      await rm(path.join(stagedDir, name), { recursive: true, force: true });
    }
    const source = path.join(live, "locales");
    if (!(await probeOrFail(source, 409, "live-untrusted", "the live locales"))) return;
    let liveDir;
    try {
      liveDir = (await assertCanonicalDir(source)).path;
    } catch (error) {
      throw new JobError(409, "live-untrusted", `the live locales of ${job.root} is not a trusted canonical directory (${error?.code ?? "error"})`);
    }
    for (const name of await readdir(liveDir)) {
      if (name === targetLang) continue;
      await copyProtectedEntry(path.join(liveDir, name), path.join(stagedDir, name));
    }
  };

  const preserveHostOwned = async (job) => {
    const live = path.join(job.root, wikiDirName);
    // 翻译作业的目标语言目录属于候选（翻译工作发现了它），不能像其它宿主条目那样被 live 替换。
    const translateLang = job.action === "translate" && typeof job.targetLang === "string" && job.targetLang !== "en"
      ? job.targetLang
      : null;
    for (const name of PROTECTED_LIVE_ENTRIES) {
      const staged = path.join(job.stageDir, name);
      const stagedPresent = await probeOrFail(staged, 0, "candidate-untrusted", `the staged ${name}`);
      if (stagedPresent && translateLang !== null && name === "locales") {
        await mergeHostOwnedLocales(job, live, staged, translateLang);
        continue;
      }
      if (stagedPresent) {
        await rm(staged, { recursive: true, force: true });
        warn(`dropped generated ${name} from the candidate for ${job.root}: ${name} is host-owned and is copied from the live ${wikiDirName}`);
      }
      const source = path.join(live, name);
      if (!(await probeOrFail(source, 409, "live-untrusted", `the live ${name}`))) continue;
      await copyProtectedEntry(source, staged);
    }
    if (translateLang !== null) {
      // 翻译作业不重写 generation-meta.json：canonical 的生成来源必须逐字节保留。
      const source = path.join(live, "generation-meta.json");
      if (!(await probeOrFail(source, 409, "live-untrusted", "the live generation-meta.json"))) return;
      const staged = path.join(job.stageDir, "generation-meta.json");
      if (await probeOrFail(staged, 0, "candidate-untrusted", "the staged generation-meta.json")) {
        await rm(staged, { force: true });
      }
      await copyProtectedEntry(source, staged);
    }
  };

  // ---------- translate job: seed the candidate from the published canonical wiki ----------
  // 翻译只追加 locales/<lang>/，所以候选必须从已发布的 canonical 树开始（canonical 的 assemble
  // 被跳过：wiki.json/pages/cards 只能来自 live）。live 是攻击者可控的内容，因此只用 scanTree 的
  // fail-closed 清单（link/junction、硬链接、非常规条目、realpath 不一致一律整体拒绝），再逐条
  // copyFile，并在复制后 verifySame 证明源身份没有被换掉。
  //
  // T014a-rev（实测真实运行）：worker 会把自然的目标（暂存根上的英文 Markdown）就地翻译成越南语，
  // 而真正的产物是空的 units 文件。所以翻译作业的 worker 写域是 locales/<lang>/ 镜像（pages/ 与
  // cards/ 是 canonical 的逐字节英文副本），并且 worker 停下之后 canonical 一律从 live 重新播种：
  // 结构性保证，而不是相信模型没有改动它。
  const TRANSLATE_SEED_SKIP = new Set(["locales", "site", "generation-meta.json"]);
  /** canonical 的顶层条目：语言镜像与 worker 之后的重新播种都只碰这些。 */
  const TRANSLATE_CANONICAL_ENTRIES = new Set(["wiki.json", "pages", "cards"]);
  /** 语言镜像里由 worker 就地翻译的目录。 */
  const TRANSLATE_MIRROR_ENTRIES = new Set(["pages", "cards"]);

  /**
   * live `.dsh-wiki` 的 fail-closed 清单；证明不了就是 seed-untrusted，绝不返回部分结果。
   * purpose 只影响错误短句（translate / update）：播种本身对两种作业完全相同。
   */
  const scanLiveCanonical = async (job, purpose = "translate") => {
    const live = path.join(job.root, wikiDirName);
    let liveDir;
    try {
      liveDir = (await assertCanonicalDir(live)).path;
    } catch (error) {
      throw new JobError(409, "live-missing", `there is no published ${wikiDirName} to ${purpose} for ${job.root} (${error?.code ?? "error"})`);
    }
    let inventory;
    try {
      inventory = await scanTree(liveDir);
    } catch (error) {
      throw new JobError(0, "seed-untrusted", `refusing to seed the candidate from the live ${wikiDirName}: ${error?.code ?? "error"}: ${error?.message ?? error}`);
    }
    return { liveDir, inventory };
  };

  /** 逐条播种：目录 mkdir，文件 copyFile + verifySame；目的条目必须被证明是单链接常规文件。 */
  const copySeededEntry = async (liveDir, entry, dest) => {
    const source = path.join(liveDir, ...entry.path.split("/"));
    try {
      if (entry.kind === "dir") {
        await mkdir(dest, { recursive: true });
      } else {
        await copyFile(source, dest);
      }
      await verifySame(source, entry.identity);
    } catch (error) {
      throw new JobError(0, "seed-untrusted", `refusing to seed ${JSON.stringify(entry.path)} from the live ${wikiDirName}: ${error?.code ?? "error"}: ${error?.message ?? error}`);
    }
    if (entry.kind !== "file") return;
    let copied;
    try {
      copied = await identityOf(dest);
    } catch (error) {
      throw new JobError(0, "seed-untrusted", `the seeded ${JSON.stringify(entry.path)} cannot be proven a contained regular file (${error?.code ?? "error"})`);
    }
    if (copied.kind !== "file" || copied.nlink !== "1") {
      throw new JobError(0, "seed-untrusted", `the seeded ${JSON.stringify(entry.path)} is not a single-link regular file`);
    }
  };

  const seedStageFromLive = async (job, purpose = "translate") => {
    const { liveDir, inventory } = await scanLiveCanonical(job, purpose);
    const entries = inventory.entries.filter((entry) => !TRANSLATE_SEED_SKIP.has(entry.path.split("/")[0]));
    if (!entries.some((entry) => entry.path === "wiki.json" && entry.kind === "file")) {
      throw new JobError(409, "live-missing", `the published ${wikiDirName} of ${job.root} has no canonical wiki.json to ${purpose}`);
    }
    for (const entry of entries) {
      await copySeededEntry(liveDir, entry, path.join(job.stageDir, ...entry.path.split("/")));
    }
  };

  // ---------- 增量更新：基线 → 祖先 → 影响映射 → 严格解析（spec 013 §2.2 步骤 1–4） ----------
  // 这一整段是**只读**的：git 只读 refs/对象，diff-impact 只读 wiki + git，不写工作区、不联网。
  // 它在两个地方被调用，且都是“拒绝优先于行动”：
  //   1) 路由在 manager.start() 之前调用 incrementalPlan()，因此每一种失败都是 409 响应、没有作业；
  //   2) 作业自己在 worker 启动之前再解析一次——请求时刻的事实代表不了 worker 启动时刻的事实
  //      （HEAD 会动、live wiki 会被替换），并且第二次解析的结果才是作业记录里写下的那一个。
  // 抑制“静默降级”的规则：本段只有成功与抛错两种结果；没有返回值 = 没有增量。
  const incrementalPreflightMs = Number.isFinite(cfg.incrementalPreflightMs) ? cfg.incrementalPreflightMs : 60000;
  // 基线来源的优先级与 builder 的 diff-impact 完全一致：generation-meta.json 优先，其次 wiki.json。
  // （实测：job 发布的 wiki 把 sourceCommit 写在 generation-meta.json 里，wiki.json 没有这个键。）
  const INCREMENTAL_META_FILES = ["generation-meta.json", "wiki.json"];

  /**
   * builder 输出的首行，两种形态：
   *   - raw：完整首行，只进 logger 与本地失败诊断（这台机器上的运维需要它）；
   *   - safe：去掉控制字符、压平空白、把绝对路径（盘符、UNC、POSIX）换成 `<path>` 并截到 200 字符。
   * 公开 409 的 detail 只放 safe：固定短句策略不变，而且路径（宿主安装位置、仓库根）绝不进响应体。
   */
  const firstOutputLine = (text, root) => {
    const raw = String(text ?? "").split(/\r?\n/).map((entry) => entry.trim()).find((entry) => entry.length > 0) ?? "";
    let safe = raw;
    for (const known of [root, builderPath]) {
      if (typeof known === "string" && known.length > 0) safe = safe.split(known).join("<path>");
    }
    safe = safe
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .replace(/[A-Za-z]:[\\/][^\s'"()]*/g, "<path>")
      .replace(/\\\\[^\s'"()]*/g, "<path>")
      .replace(/(^|[\s'"=(])\/[^\s'"()]+/g, "$1<path>")
      .trim()
      .slice(0, 200)
      .trim();
    return { raw: raw.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 400), safe };
  };

  /** 前置解析的伪作业：让 runBuilder/sourceCommit 复用同一套预算与解释器选择，而不必先建真作业。 */
  const preflightJob = (root, phase) => ({
    id: `preflight-${phase}`,
    root,
    deadlineAt: Date.now() + incrementalPreflightMs,
    python: null,
    engine: null,
    evidence: "",
  });

  /** 读 live 已发布 wiki 记录的基线；没有 live / 没有可用 sourceCommit 都收敛成 incremental-no-baseline。 */
  const readLiveBaseline = async (root) => {
    let repoDir;
    try {
      repoDir = (await assertCanonicalDir(root)).path;
    } catch (error) {
      throw new JobError(409, "root-untrusted", `the repository root ${root} is not a trusted canonical directory (${error?.code ?? "error"}): ${error?.message ?? error}`);
    }
    const live = path.join(repoDir, wikiDirName);
    let liveDir;
    try {
      liveDir = (await assertCanonicalDir(live)).path;
    } catch (error) {
      if (error?.code === "path-not-found") {
        throw new JobError(409, "incremental-no-baseline", `there is no published ${wikiDirName} to update incrementally for ${root}: the live wiki was not found; run a full update first`);
      }
      throw new JobError(409, "live-untrusted", `the live ${wikiDirName} of ${root} is not a trusted canonical directory (${error?.code ?? "error"}): ${error?.message ?? error}`);
    }
    for (const name of INCREMENTAL_META_FILES) {
      const target = path.join(liveDir, name);
      let identity;
      try {
        identity = await identityOf(target);
      } catch (error) {
        if (error?.code === "path-not-found") continue;
        throw new JobError(409, "live-untrusted", `the live ${wikiDirName}/${name} of ${root} cannot be proven a contained regular file (${error?.code ?? "error"}): ${error?.message ?? error}`);
      }
      if (identity.kind !== "file" || identity.nlink !== "1") {
        throw new JobError(409, "live-untrusted", `the live ${wikiDirName}/${name} of ${root} is not a single-link regular file`);
      }
      let raw;
      try {
        raw = await readProvenFile(target, identity);
      } catch (error) {
        throw new JobError(409, "live-untrusted", `the live ${wikiDirName}/${name} of ${root} could not be read as the file that was proven (${error?.code ?? "error"})`);
      }
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null; // 不可解析 = 这一份元数据没有可用的 sourceCommit，继续看下一份
      }
      const recorded = typeof parsed?.sourceCommit === "string" ? parsed.sourceCommit.trim().toLowerCase() : "";
      if (isCommitSha(recorded)) return { liveDir, baseline: recorded, baselineSource: name };
    }
    throw new JobError(409, "incremental-no-baseline", `the published ${wikiDirName} of ${root} records no usable sourceCommit (checked ${INCREMENTAL_META_FILES.join(" and ")}); run a full update first`);
  };

  /** `git merge-base --is-ancestor`：true / false / null（查不了）。基线被 rebase 掉 => false。 */
  const defaultIsAncestor = async (root, ancestor, head) => {
    const result = await execFileResult("git", ["-C", root, "merge-base", "--is-ancestor", ancestor, head], {
      timeout: Math.max(1, Math.min(10000, incrementalPreflightMs)), windowsHide: true, shell: false, maxBuffer: 64 * 1024,
    });
    if (result.code === 0) return true;
    if (result.code === 1) return false;
    return null;
  };
  const isAncestorOf = typeof cfg.isAncestor === "function" ? cfg.isAncestor : defaultIsAncestor;

  /** diff-impact 的一个受影响条目：只有 id 与它命中的文件，两样都必须有界、可安全拼进 `pages/<id>.md`。 */
  const parseImpactEntry = (raw, label) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new JobError(409, "incremental-unavailable", `diff-impact returned a ${label} entry that is not an object`);
    }
    const id = raw.id;
    if (!isPageId(id)) {
      throw new JobError(409, "incremental-unavailable", `diff-impact returned a ${label} entry whose id ${JSON.stringify(id ?? null)} is not a usable page id`);
    }
    if (!Array.isArray(raw.matchedFiles)) {
      throw new JobError(409, "incremental-unavailable", `diff-impact returned a ${label} entry without a matchedFiles array`);
    }
    if (raw.matchedFiles.length > INCREMENTAL_LIMITS.maxFilePaths) {
      throw new JobError(409, "incremental-unavailable", `diff-impact returned more than ${INCREMENTAL_LIMITS.maxFilePaths} matched files for ${label} ${JSON.stringify(id)}`);
    }
    const filePaths = [];
    for (const filePath of raw.matchedFiles) {
      if (!isRepoRelativePath(filePath)) {
        throw new JobError(409, "incremental-unavailable", `diff-impact returned a matched path that is not a repository-relative path for ${label} ${JSON.stringify(id)}`);
      }
      if (!filePaths.includes(filePath)) filePaths.push(filePath);
    }
    return Object.freeze({ id, filePaths: Object.freeze(filePaths) });
  };

  /**
   * 严格解析 diff-impact 的 stdout：只接受**一个**对象，受影响条目必须是带字符串 id 的对象数组，
   * 并且它解析出的 from/to 必须就是请求的那一对（我们传的是完整 sha，解析出别的对象名说明出现了
   * 预期之外的事实）。任何意外 => incremental-unavailable，绝不“尽量理解”。
   */
  const parseImpactReport = (stdout, { baseline, head }) => {
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new JobError(409, "incremental-unavailable", "diff-impact stdout is not a single JSON object");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new JobError(409, "incremental-unavailable", "diff-impact stdout is not a single JSON object");
    }
    if (parsed.from !== baseline || parsed.to !== head) {
      throw new JobError(409, "incremental-unavailable", `diff-impact answered for a different revision range than the one requested (${JSON.stringify(parsed.from ?? null)}..${JSON.stringify(parsed.to ?? null)})`);
    }
    const lists = {};
    for (const [field, label] of [["affectedPages", "page"], ["affectedCards", "card"]]) {
      const raw = parsed[field];
      if (!Array.isArray(raw)) throw new JobError(409, "incremental-unavailable", `diff-impact returned no ${field} array`);
      if (raw.length > INCREMENTAL_LIMITS.maxEntries) {
        throw new JobError(409, "incremental-unavailable", `the diff affects ${raw.length} ${label}s, above the ${INCREMENTAL_LIMITS.maxEntries}-entry incremental limit; run a full update instead`);
      }
      const seen = new Set();
      const entries = [];
      for (const entry of raw) {
        const parsedEntry = parseImpactEntry(entry, label);
        if (seen.has(parsedEntry.id)) continue; // 同一个 id 只重写一次
        seen.add(parsedEntry.id);
        entries.push(parsedEntry);
      }
      lists[field] = Object.freeze(entries);
    }
    if (!Array.isArray(parsed.unmappedFiles)) {
      throw new JobError(409, "incremental-unavailable", "diff-impact returned no unmappedFiles array");
    }
    const unmappedFiles = [];
    for (const filePath of parsed.unmappedFiles) {
      if (!isRepoRelativePath(filePath)) {
        throw new JobError(409, "incremental-unavailable", "diff-impact returned an unmapped path that is not a repository-relative path");
      }
      unmappedFiles.push(filePath);
    }
    return {
      pages: lists.affectedPages,
      cards: lists.affectedCards,
      unmappedFiles: Object.freeze(unmappedFiles),
      changedFiles: Array.isArray(parsed.changedFiles) ? parsed.changedFiles.length : null,
    };
  };

  /**
   * 只读一个键的“极简 front-matter”规则：首行 `---`，到下一个 `---` 为止，每行 `key: value`，value 先按
   * JSON 解析，解析失败则当纯字符串（与 scripts/build_wiki_site.py 的 `_parse_front_matter` 同形）。
   *
   * 这不是一个 front-matter 解析器：它不为别的键求值、不解释嵌套、不修复任何形状。它只回答一个问题
   * ——“这一页声明的 id 是什么”——并且对任何有歧义的输入返回 ok:false（重复的 id 行、非字符串 id、
   * 没有闭合的块），由调用方**拒绝**整个增量计划，而不是猜。没有 front-matter 或没有 id 键是合法的：
   * assemble 自己就按文件名当 id（`page.setdefault("id", f.stem)`），这里与它保持一致。
   * @returns {{ok: boolean, id: string|null}}
   */
  const declaredFrontMatterId = (text) => {
    const normalized = text.replace(/\r\n/g, "\n").replace(/^\ufeff/, "");
    if (!normalized.startsWith("---\n")) return { ok: true, id: null };
    const end = normalized.indexOf("\n---", 4);
    if (end < 0) return { ok: false, id: null };
    let declared = null;
    for (const line of normalized.slice(4, end).split("\n")) {
      if (!line.trim() || line.trimStart().startsWith("#")) continue;
      const colon = line.indexOf(":");
      if (colon < 0) continue;
      if (line.slice(0, colon).trim() !== "id") continue;
      if (declared !== null) return { ok: false, id: null }; // 两行 id：不猜哪一行权威
      const raw = line.slice(colon + 1).trim();
      let value = raw;
      try {
        value = JSON.parse(raw);
      } catch {
        value = raw; // 与 builder 一致：不是 JSON 就当纯字符串
      }
      if (typeof value !== "string") return { ok: false, id: null }; // 不做数字/布尔到字符串的强制转换
      declared = value;
    }
    return { ok: true, id: declared };
  };

  /**
   * 已证明身份的字节 → 这一页**声明**的 id（“怎么读”只有这一份，见 declaredFrontMatterId）。
   *
   * 调用方决定“读不出来”意味着什么：计划阶段对 live 文件是 incremental-id-mismatch，worker 停下之后
   * 对暂存文件是 incremental-unexpected-write。规则本身（畸形 front-matter、非字符串 id、非 UTF-8）
   * 绝不在这里分裂成两份。
   * @returns {{ok: true, id: string|null, reason: null} | {ok: false, id: null, reason: "not-utf8"|"front-matter-unreadable"}}
   */
  const DECLARED_ID_NOT_UTF8 = Object.freeze({ ok: false, id: null, reason: "not-utf8" });
  const DECLARED_ID_UNREADABLE = Object.freeze({ ok: false, id: null, reason: "front-matter-unreadable" });
  const readDeclaredId = (bytes) => {
    const text = bytes.toString("utf8");
    // 原始字节，绝不先解码：解码把不同的非法 UTF-8 序列折叠成同一个 U+FFFD，两次“读到的 id”就会
    // 假装一致。读 id 的前提是这份字节本身就是 UTF-8 文本。
    if (!Buffer.from(text, "utf8").equals(bytes)) return DECLARED_ID_NOT_UTF8;
    const declared = declaredFrontMatterId(text);
    return declared.ok ? { ok: true, id: declared.id, reason: null } : DECLARED_ID_UNREADABLE;
  };

  /** 受影响 id 与已发布文件对不上时的唯一拒绝（409），内部消息带上具体条目，公开短句固定在表里。 */
  const incrementalIdMismatch = (detail) => new JobError(409, "incremental-id-mismatch",
    `the published ${wikiDirName} cannot be updated incrementally: ${detail}; its ids and file names must agree one-to-one, so run a full update instead`);

  /**
   * 受影响 id 与已发布文件必须一一对应（review minor）。
   *
   * 受影响集合按 id 拼成 `pages/<id>.md`，但**文件名不一定等于 front-matter 的 id**（手工导入的 wiki
   * 可以两者不一致）。两个后果都是真的：
   *   - 假失败：一个 id 的真实文件是别的名字，受影响页的合法重写落在那个文件上，`pages/<id>.md` 没变，
   *     于是被上层的越权检查判成 incremental-unexpected-write，永久堵死这个 wiki 的增量；
   *   - 泄漏：`pages/<id>.md` 这个文件其实携带**另一个**（不受影响的）id，worker 改写它等于改写了
   *     那一页，而授权范围却认为它属于受影响的 id。
   * 两者都只能靠“拒绝”关掉：这里要求每个受影响 id 在已发布 wiki 里恰好有 `<kind>/<id>.md`（单链接
   * 常规文件），且该文件 front-matter 声明的 id 要么等于它、要么根本没有声明。任何一条不成立 =>
   * incremental-id-mismatch（409），一个作业都不开，全量更新照常可用。
   *
   * 只读：读 live 的文件，不写、不改、不播种。身份证明与其它 live 读取同一条路径（identityOf +
   * readProvenFile），所以 junction/硬链接/换位一律拒绝，绝不顺着链接读仓库外的字节。
   */
  const verifyIncrementalIdMapping = async (liveDir, report) => {
    for (const [kind, entries] of [["pages", report.pages], ["cards", report.cards]]) {
      const noun = kind === "pages" ? "page" : "card";
      for (const entry of entries) {
        const relative = `${kind}/${entry.id}.md`;
        const target = path.join(liveDir, kind, `${entry.id}.md`);
        let identity;
        try {
          identity = await identityOf(target);
        } catch (error) {
          if (error?.code === "path-not-found") {
            throw incrementalIdMismatch(`the affected ${noun} ${JSON.stringify(entry.id)} has no ${JSON.stringify(relative)} in the published wiki`);
          }
          throw new JobError(409, "live-untrusted", `the published ${JSON.stringify(relative)} of ${wikiDirName} cannot be proven a contained entry (${error?.code ?? "error"}): ${error?.message ?? error}`);
        }
        if (identity.kind !== "file" || identity.nlink !== "1") {
          throw incrementalIdMismatch(`the affected ${noun} ${JSON.stringify(entry.id)} is not a single-link regular file at ${JSON.stringify(relative)}`);
        }
        let bytes;
        try {
          bytes = await readProvenFile(target, identity, null);
        } catch (error) {
          throw new JobError(409, "live-untrusted", `the published ${JSON.stringify(relative)} of ${wikiDirName} could not be read as the file that was proven (${error?.code ?? "error"})`);
        }
        const declared = readDeclaredId(bytes);
        if (declared.reason === "not-utf8") {
          throw incrementalIdMismatch(`the affected ${noun} ${JSON.stringify(entry.id)} is not valid UTF-8, so the id it declares cannot be read`);
        }
        if (!declared.ok) {
          throw incrementalIdMismatch(`the affected ${noun} ${JSON.stringify(entry.id)} has a front-matter block whose id cannot be read unambiguously`);
        }
        if (declared.id !== null && declared.id !== entry.id) {
          throw incrementalIdMismatch(`the affected ${noun} ${JSON.stringify(entry.id)} declares the id ${JSON.stringify(declared.id)} in its front matter`);
        }
      }
    }
  };

  /**
   * 一次完整的前置解析（步骤 1–4）。成功 => 冻结的 plan；失败 => JobError(409, ...)，永不返回“半个 plan”。
   * plan 里的 pages/cards 已经是 prompt 的形状（{ id, filePaths }），filePaths 保留 diff-impact 的命中顺序。
   */
  const planIncremental = async (root, evidenceJob = null) => {
    const { liveDir, baseline, baselineSource } = await readLiveBaseline(root);
    const head = await sourceCommit(root);
    if (head === null) {
      throw new JobError(409, "incremental-unavailable", `the current revision of ${root} could not be read (no usable HEAD); run a full update instead`);
    }
    if (head === baseline) {
      // 没有新提交 = 没有任何页面受影响。绝不再发一个“没有事做”的作业（review minor）：那会为一个空洞的
      // 增量开一个 worker 会话去碰暂存，并把“什么都没发生”包装成一次成功的增量发布。显式拒绝，是否全量
      // 重建由调用方自己决定。
      throw new JobError(409, "incremental-up-to-date", `the published ${wikiDirName} of ${root} already records the current revision ${head}; the published wiki already matches HEAD — run a full update if the wiki is stale for another reason`);
    }
    const ancestor = await isAncestorOf(root, baseline, head);
    if (ancestor === false) {
      throw new JobError(409, "incremental-baseline-diverged", `the published ${wikiDirName} of ${root} was derived from ${baseline}, which is not an ancestor of ${head} (the history was rewritten); run a full update instead`);
    }
    if (ancestor === null) {
      throw new JobError(409, "incremental-unavailable", `the repository at ${root} cannot answer whether ${baseline} is an ancestor of ${head}; run a full update instead`);
    }
    // 真作业存在时把 diff-impact 的输出收进它的失败证据；路由的前置解析没有作业，用伪作业。
    const job = evidenceJob ?? preflightJob(root, "diff-impact");
    const result = await runBuilder(job, ["diff-impact", "--wiki", liveDir, "--repo", root, "--from", baseline, "--to", head], incrementalPreflightMs);
    if (!result?.ok) {
      const line = firstOutputLine(result?.output, root);
      const failure = new JobError(409, "incremental-unavailable",
        `diff-impact failed${Number.isSafeInteger(result?.code) ? ` (exit ${result.code})` : ""}: ${line.safe || "no output"}`);
      // 公开 409 的 detail 只放 safe（无路径、有界）；raw 只进 logger 与本地失败诊断。
      failure.builderLine = line.safe;
      failure.builderRaw = line.raw;
      throw failure;
    }
    const report = parseImpactReport(result.stdout, { baseline, head });
    // 受影响 id 与已发布文件名必须一一对应：否则“受影响集合 = 这些 id 对应的那些文件”这个前提不成立，
    // 越权检查会假失败，或放行一次落在别页上的改写。不成立就拒绝整个计划（incremental-id-mismatch）。
    await verifyIncrementalIdMapping(liveDir, report);
    return Object.freeze({
      mode: "incremental",
      baseline,
      head,
      baselineSource,
      liveDir,
      pages: report.pages,
      cards: report.cards,
      unmappedFiles: report.unmappedFiles,
      changedFiles: report.changedFiles,
    });
  };

  /** 作业记录里的增量事实（键集固定，非增量作业恒为 null）。 */
  const incrementalSummary = (plan) => {
    if (!plan) return null;
    const total = Number.isSafeInteger(plan.unmappedTotal) ? plan.unmappedTotal : plan.unmappedFiles.length;
    return {
      mode: "incremental",
      baseline: plan.baseline,
      head: plan.head,
      affectedPages: plan.pages.length,
      affectedCards: plan.cards.length,
      pagesRewritten: null,
      // 删除的受影响页：与 pagesRewritten 分开计（D2），worker 停下之后才可能非 null。
      pagesRemoved: null,
      removedSample: null,
      unmappedFiles: total,
      unmappedSample: plan.unmappedFiles.slice(0, 5),
      sourceCommit: null,
      sourceCommitAdvanced: null,
    };
  };

  /** 暂存里一个受影响条目的当前 sha256（不存在 => null）；读取前必须已证明它留在暂存目录里。 */
  const shaOfStagedEntry = async (job, relative) => {
    const target = path.join(job.stageDir, ...relative.split("/"));
    let identity;
    try {
      identity = await identityOf(target);
    } catch (error) {
      if (error?.code === "path-not-found") return null;
      throw new JobError(0, "candidate-untrusted", `the staged ${JSON.stringify(relative)} cannot be proven a contained regular file (${error?.code ?? "error"})`);
    }
    if (identity.kind !== "file" || identity.nlink !== "1") return null;
    let bytes;
    try {
      // 原始字节，绝不先解码（review minor）：解码会把不同的非法 UTF-8 序列折叠成同一个 U+FFFD，
      // 两份不同的坏字节因此哈希相同——一次改写就藏在“解码后一样”里。比较的输入必须是盘上的字节。
      bytes = await readProvenFile(target, identity, null);
    } catch (error) {
      throw new JobError(0, "candidate-untrusted", `the staged ${JSON.stringify(relative)} could not be read as the file that was proven (${error?.code ?? "error"})`);
    }
    return createHash("sha256").update(bytes).digest("hex");
  };

  const incrementalEntryKey = (kind, id) => `${kind}/${id}.md`;

  /** 播种之后、worker 之前的字节基线：用它判定 pagesRewritten（不依赖模型自报）。 */
  const snapshotIncrementalEntries = async (job, plan) => {
    const snapshot = new Map();
    for (const [kind, entries] of [["pages", plan.pages], ["cards", plan.cards]]) {
      for (const entry of entries) {
        const key = incrementalEntryKey(kind, entry.id);
        snapshot.set(key, await shaOfStagedEntry(job, key));
      }
    }
    return snapshot;
  };

  /**
   * 受影响的暂存条目在 worker 停下之后必须**仍然**只代表它自己（review MAJOR，D1）。
   *
   * 授权范围把受影响集合**排除**在“逐字节不变”的比较之外（verifyUntouchedEntries 故意跳过它们），
   * 于是受影响文件可以自由改写——包括它的 front-matter `id`。而 assemble 是按**声明的 id** 建页的
   * （`page.setdefault("id", f.stem)`），所以把 `pages/overview.md` 的 id 改成一个**不受影响**的页的
   * id，就等于在发布时替换掉那一页：`incremental-id-mismatch` 关掉的那个洞，从另一侧又开了。
   *
   * 规则与计划阶段**同一条**（readDeclaredId + declaredFrontMatterId）：声明的 id 要么不存在（id 由
   * 文件名决定），要么就等于这个文件的 stem。任何其它情况都是 worker 写了自己没被授权写的东西 =>
   * incremental-unexpected-write（沿用既有 code，公开契约不因此变宽），具体条目只进内部诊断。
   *
   * 这里也用“消失”这一事实（D2，见 countPageChanges）：受影响**页**被删除时跳过——它是一次合法的
   * 下线，但会在作业状态里显式计入 pagesRemoved，绝不当成改写。受影响**卡片**的删除仍被拒绝：
   * 页面的删除有 pagesRemoved/removedSample 记录，卡片的删除没有对应的公开事实，宁可失败也不让它
   * 无声消失。
   */
  const verifyAffectedEntryIds = async (job, plan) => {
    for (const [kind, entries] of [["pages", plan.pages], ["cards", plan.cards]]) {
      const noun = kind === "pages" ? "page" : "card";
      for (const entry of entries) {
        const relative = incrementalEntryKey(kind, entry.id);
        const target = path.join(job.stageDir, kind, `${entry.id}.md`);
        let identity;
        try {
          identity = await identityOf(target);
        } catch (error) {
          if (error?.code === "path-not-found") {
            if (kind === "pages") continue; // 删除：由 countPageChanges 计入 pagesRemoved
            throw new JobError(409, "incremental-unexpected-write",
              `the worker removed the affected ${noun} ${JSON.stringify(relative)}; an incremental update may rewrite an affected card but never remove one`);
          }
          throw new JobError(409, "incremental-unexpected-write",
            `the staged ${JSON.stringify(relative)} cannot be proven a contained entry (${error?.code ?? "error"})`);
        }
        if (identity.kind !== "file" || identity.nlink !== "1") {
          throw new JobError(409, "incremental-unexpected-write",
            `the staged ${JSON.stringify(relative)} is not a single-link regular file`);
        }
        let bytes;
        try {
          bytes = await readProvenFile(target, identity, null);
        } catch (error) {
          throw new JobError(409, "incremental-unexpected-write",
            `the staged ${JSON.stringify(relative)} could not be read as the file that was proven (${error?.code ?? "error"})`);
        }
        const declared = readDeclaredId(bytes);
        if (declared.reason === "not-utf8") {
          throw new JobError(409, "incremental-unexpected-write",
            `the affected ${noun} ${JSON.stringify(relative)} is not valid UTF-8, so the id it declares cannot be checked`);
        }
        if (!declared.ok) {
          throw new JobError(409, "incremental-unexpected-write",
            `the affected ${noun} ${JSON.stringify(relative)} has a front-matter block whose id cannot be read unambiguously`);
        }
        if (declared.id !== null && declared.id !== entry.id) {
          throw new JobError(409, "incremental-unexpected-write",
            `the affected ${noun} ${JSON.stringify(relative)} declares the id ${JSON.stringify(declared.id)} instead of its own file name, so publishing it would retarget another entry`);
        }
      }
    }
  };

  /**
   * worker 停下之后重算受影响的页面：字节变了算**改写**，消失了算**删除**，两者绝不混为一谈
   * （review MAJOR，D2）。混起来的后果是：删掉一个页只表现为 pagesRewritten 的一次自增，而这一页
   * 同时从发布里静静消失——没有任何事实说它没了。
   *
   * 删除是合法的（仓库里被删掉的主题本来就应该下线），所以它被**记录**（pagesRemoved +
   * removedSample）而不是被拒绝；改写计数因此只统计仍然存在且字节变了的页。
   *
   * 这比“让模型自报数字”更诚实：一个没动过的页不会被计成改写，一个被改过的页也不会被漏掉。
   * `pages/<id>.md` 与 id 一一对应由 plan 与 verifyAffectedEntryIds 一起保证，所以这里不需要再考虑
   * “文件名与 id 不一致”的形状。
   * @returns {{rewritten: number, removed: string[]}} removed 是 id（按计划顺序，至多一页一个）。
   */
  const countPageChanges = async (job, plan, seeded) => {
    let rewritten = 0;
    const removed = [];
    for (const entry of plan.pages) {
      const key = incrementalEntryKey("pages", entry.id);
      const before = seeded instanceof Map ? seeded.get(key) ?? null : null;
      const after = await shaOfStagedEntry(job, key);
      if (after === null) {
        // 播种时存在、现在不见了 => 删除。播种时本来就不存在 => 什么都没发生。
        if (before !== null) removed.push(entry.id);
        continue;
      }
      if (after !== before) rewritten += 1;
    }
    return { rewritten, removed };
  };

  // 失败消息只放有界的样例（内部消息进 logger 与失败诊断；HTTP 响应仍然只有固定短句，永远没有路径）。
  const UNTOUCHED_SAMPLE_MAX = 5;
  const UNTOUCHED_SAMPLE_CHARS = 200;

  /**
   * 增量作业里**由宿主拥有或重新生成**的暂存条目：它们不参与“逐字节不变”的比较，各自有确切理由。
   *
   *   - `site/index.html`：宿主的 build 只重写这一个文件（build 站点写 `site/index.html`），
   *     worker 写了它也会在发布前被宿主覆盖，所以它不可能被“偷渡”。**只有**这一个：`site/` 下的其它
   *     条目不会被 build 覆盖，会随整树发布，所以它们照常参与比较；`site` 目录本身也允许出现/消失
   *     （否则一个只写了 site/index.html 的 worker 会因为“新目录”被判越权）。
   *   - `generation-meta.json`：播种时根本不复制它（它不在暂存里），宿主在内容闸门之后按本次作业自己
   *     重写它；worker 写在那里的内容一定会被覆盖。
   *   - `config.json` 与 `locales/`：宿主拥有的 live 条目（`PROTECTED_LIVE_ENTRIES`）。发布前的
   *     preserveHostOwned 会把暂存里的同名条目整目录丢弃、再从 live 逐条复制回来，所以 worker 写在
   *     那里的内容根本到不了发布；把它们的字节纳入比较只会引入与发布结果无关的噪声。
   */
  const INCREMENTAL_HOST_OWNED_ENTRIES = new Set([
    "site",
    "site/index.html",
    "generation-meta.json",
    "config.json",
  ]);
  const INCREMENTAL_HOST_OWNED_TREES = ["locales"];

  /** 该暂存相对路径是否属于宿主拥有 / 重新生成的条目（整棵 `locales/` 也算）。 */
  const isHostOwnedIncrementalEntry = (relative) => INCREMENTAL_HOST_OWNED_ENTRIES.has(relative)
    || INCREMENTAL_HOST_OWNED_TREES.some((prefix) => relative === prefix || relative.startsWith(`${prefix}/`));

  /**
   * 规范 JSON 文本（键排序、递归）：同一份语义只有一种字节。比较 wiki.json 时用它，比较的是“内容变了
   * 没有”，而不是“JSON 的格式变了没有”。
   */
  const canonicalJsonText = (value) => {
    if (Array.isArray(value)) return `[${value.map(canonicalJsonText).join(",")}]`;
    if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJsonText(value[key])}`).join(",")}}`;
  };

  /**
   * 暂存里**整棵树**的快照：每个普通文件的原始字节 sha256，每个目录一个 kind 标记（键 = 相对路径）。
   *
   * 为什么是整棵树，而不只是 `pages/` 与 `cards/`（review MAJOR）：incremental 的路径把 live 整棵播种
   * 到暂存，而发布是整树替换；worker guard 的写域是**整个 `job.stageDir`**（translate 才把它收到
   * `locales/<lang>/`）。所以暂存里的 `wiki.json`、任何其它顶层条目、以及 worker 新建的条目都能进发布。
   * 只哈希两个目录，等于对“其余逐字节不变”这句话完全不做验证。
   *
   * 三个刻意的选择：
   *   1. 原始字节，绝不先解码：解码把不同的非法 UTF-8 序列折叠成同一个 U+FFFD，两份哈希就相同了。
   *   2. 每个条目都先由 identityOf 证明（逐级 lstat + realpath、单链接常规文件），与播种/重新播种同一
   *      信任模型：worker 能把 `pages/x.md` 换成链接，那属于越权写入，不是“读不了”。
   *   3. 目录只记 kind（不记内容、不记 dev/ino）：这样“一个新建的空目录”是可检测的差异，而“目录被
   *      删除后重建、内容仍是授权内容”不会被当成越权。目录自身的替换/换位由文件内容与 journal 的
   *      暂存身份校验覆盖，本比较不声称能单独发现它（见 LIMITATIONS 式说明：这是一次快照比较，
   *      不是原子保证）。
   *
   * `wiki.json` 不进 `entries`：它按顶层键单独比较（见 wikiJsonKeyHashes），因为 assemble 在**这个
   * 检查之后**才会重写它，而语义比较能避免“只有格式变了”的噪声。
   */
  const snapshotStagedEntries = async (job) => {
    const entries = new Map();
    let wikiBytes = null;
    let wikiPresent = false;
    const pending = [""];
    while (pending.length > 0) {
      const relative = pending.pop();
      const isRoot = relative === "";
      const target = isRoot ? job.stageDir : path.join(job.stageDir, ...relative.split("/"));
      let identity;
      try {
        identity = await identityOf(target);
      } catch (error) {
        // 条目消失（或整个子目录从来不存在）= 这个路径没有条目；差异由前后两张快照比较判定
        // （“消失”本身就是越权写入），不在这里当成读失败。暂存根不存在则是另一种失败：证明不了。
        if (isRoot) {
          throw new JobError(0, "incremental-unexpected-write", `the staging directory itself cannot be proven a contained directory (${error?.code ?? "error"})`);
        }
        if (error?.code === "path-not-found") continue;
        throw new JobError(0, "incremental-unexpected-write", `the staged ${JSON.stringify(relative)} cannot be proven a contained entry (${error?.code ?? "error"})`);
      }
      if (identity.kind === "dir") {
        let names;
        try {
          names = await readdir(target);
        } catch (error) {
          throw new JobError(0, "incremental-unexpected-write", `the staged ${JSON.stringify(relative)} cannot be listed (${error?.code ?? "error"})`);
        }
        if (!isRoot) entries.set(relative, { kind: "dir" });
        for (const name of names) pending.push(isRoot ? name : `${relative}/${name}`);
        continue;
      }
      if (identity.kind !== "file" || identity.nlink !== "1") {
        throw new JobError(0, "incremental-unexpected-write", `the staged ${JSON.stringify(relative)} is not a single-link regular file`);
      }
      let bytes;
      try {
        bytes = await readProvenFile(target, identity, null);
      } catch (error) {
        throw new JobError(0, "incremental-unexpected-write", `the staged ${JSON.stringify(relative)} could not be read as the file that was proven (${error?.code ?? "error"})`);
      }
      if (relative === "wiki.json") {
        wikiPresent = true;
        wikiBytes = bytes;
        continue;
      }
      entries.set(relative, { kind: "file", hash: createHash("sha256").update(bytes).digest("hex") });
    }
    return { entries, present: wikiPresent, wikiKeys: wikiPresent ? wikiJsonKeyHashes(wikiBytes) : null };
  };

  /**
   * `wiki.json` 的**顶层键 → 规范 JSON 文本的 sha256**；不可解析时失败（无法验证就不发布）。
   *
   * 为什么整份 wiki.json 都要比，而不是 review 建议的“去掉 pages/cards 再比”：这个检查发生在 worker
   * 停下之后、assemble **之前**，此刻 pages/cards 仍然是播种时的数组，宿主还没有重写它们。把 pages
   * 与 cards 从比较里摘掉不会换来任何正确性，却会留下一个真实的洞：assemble 只在 `cards/` **目录存在**
   * 时才用 `cards/*.md` 覆盖 `cards`（否则沿用 wiki.json 原来的 cards）。一个没有 `cards/` 目录的 wiki，
   * worker 改写 wiki.json 的 `cards` 就会被原样发布。所以这里逐键比较所有顶层键；assemble 之后重写
   * pages/cards 也不会造成误报，因为比较已经结束。（README/CHANGELOG 写的是“non-pages/cards keys”，
   * 那份措辞需要随这次改动更新——它们是 lead 拥有的文档。）
   */
  const wikiJsonKeyHashes = (bytes) => {
    let parsed;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new JobError(0, "seed-untrusted", "the seeded wiki.json is not a JSON object, so the plan's byte-identity promise cannot be verified; nothing was published");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new JobError(0, "seed-untrusted", "the seeded wiki.json is not a JSON object, so the plan's byte-identity promise cannot be verified; nothing was published");
    }
    const out = new Map();
    for (const key of Object.keys(parsed).sort()) {
      out.set(key, createHash("sha256").update(canonicalJsonText(parsed[key])).digest("hex"));
    }
    return out;
  };

  /**
   * 增量作业的**授权范围**检查（review MAJOR）：plan 声明“只有这些页/卡受影响，其余逐字节不变”，
   * 而 worker guard 允许 write/edit 落在整个暂存目录下——提示语不是保证，`selfcheck` 也只查引用是否
   * 成立，查不出“这一页被整个替换掉了”。所以 worker 停下之后、任何 assemble/validate/build/selfcheck/
   * 发布之前，把**整棵暂存树**里受影响集合之外的每个条目与播种时的原始字节比一遍：改写、新增、消失
   * 都意味着 worker 写了它没被授权写的东西 => 本次作业硬失败，绝不发布，也绝不重新播种后继续（一个
   * 越权写过的 worker 在同一次作业里不再可信）。
   *
   * `wiki.json` 单独按顶层键比较（见 wikiJsonKeyHashes）：宿主自己的 assemble 会在本检查**之后**重写
   * 它的 pages/cards 数组，所以这里比较的是“worker 有没有改它”，与 assemble 的合法重写无关。
   *
   * 只由宿主拥有/重新生成的条目被跳过（理由见 INCREMENTAL_HOST_OWNED_ENTRIES）。
   */
  const verifyUntouchedEntries = async (job, plan, seeded) => {
    const after = await snapshotStagedEntries(job);
    const before = seeded !== null && typeof seeded === "object" && seeded.entries instanceof Map ? seeded : { entries: new Map(), present: false, wikiKeys: null };
    const affected = new Set();
    for (const entry of plan.pages) affected.add(incrementalEntryKey("pages", entry.id));
    for (const entry of plan.cards) affected.add(incrementalEntryKey("cards", entry.id));
    const changed = new Set();
    for (const [key, entry] of after.entries) {
      if (affected.has(key) || isHostOwnedIncrementalEntry(key)) continue;
      const was = before.entries.get(key) ?? null;
      // 播种时不存在 => 新增；kind 变了 => 换成了别的东西；文件字节不同 => 改写。三种都算越权。
      if (was === null || was.kind !== entry.kind) { changed.add(key); continue; }
      if (entry.kind === "file" && was.hash !== entry.hash) changed.add(key);
    }
    for (const key of before.entries.keys()) {
      if (affected.has(key) || isHostOwnedIncrementalEntry(key)) continue;
      if (!after.entries.has(key)) changed.add(key); // 播种后消失
    }
    // wiki.json：出现/消失/不可解析，或任何顶层键的增量比较失败（新增、删除、改动都算）。
    if (before.present !== after.present) {
      changed.add("wiki.json");
    } else if (after.present) {
      const wasKeys = before.wikiKeys ?? new Map();
      for (const [key, hash] of after.wikiKeys) {
        if (wasKeys.get(key) !== hash) changed.add(`wiki.json#${key}`);
      }
      for (const key of wasKeys.keys()) {
        if (!after.wikiKeys.has(key)) changed.add(`wiki.json#${key}`);
      }
    }
    if (changed.size === 0) return;
    const offending = [...changed].sort();
    // 只有暂存内相对键进消息（`pages/...`、`cards/...`、`wiki.json#<key>` 或 worker 新建的条目名），
    // 不含宿主路径；并去掉控制字符、截短、限制条数：一条被污染的文件名不能把换行或超长文本带进日志
    // 与失败诊断。
    const sample = offending.slice(0, UNTOUCHED_SAMPLE_MAX).map((key) => key
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(UNSAFE_INVISIBLE_RE, " ")
      .slice(0, UNTOUCHED_SAMPLE_CHARS));
    const more = offending.length > sample.length ? ` and ${offending.length - sample.length} more` : "";
    throw new JobError(409, "incremental-unexpected-write",
      `the worker changed ${offending.length} entr${offending.length === 1 ? "y" : "ies"} outside the affected set (${sample.join(", ")}${more}); the candidate was refused instead of being published`);
  };

  /**
   * 语言镜像：canonical 的 `pages/` 与 `cards/` 逐字节复制到 `locales/<lang>/`。
   *
   * 这些副本是 worker 唯一的工作区（guard 的写域被激活到这个目录，见 startGuardedWorker），也是
   * 组装 `locales/<lang>/wiki.json` 的输入。没有 `pages/*.md` 就没有可翻译的 Markdown：本切片不再
   * 让 worker 手填 units 文件，所以直接 fail closed，而不是发一个注定空转的作业。
   */
  const seedLocaleMirror = async (job) => {
    const { liveDir, inventory } = await scanLiveCanonical(job);
    const entries = inventory.entries.filter((entry) => TRANSLATE_MIRROR_ENTRIES.has(entry.path.split("/")[0]));
    if (!entries.some((entry) => entry.kind === "file" && entry.path.split("/")[0] === "pages" && entry.path.endsWith(".md"))) {
      throw new JobError(409, "live-missing", `the published ${wikiDirName} of ${job.root} has no pages/*.md to translate; the translation units are assembled from Markdown`);
    }
    const mirror = path.join(job.stageDir, "locales", job.targetLang);
    for (const entry of entries) {
      await copySeededEntry(liveDir, entry, path.join(mirror, ...entry.path.split("/")));
    }
  };

  /**
   * worker 停下之后的 canonical 重新播种（T014a-rev）。
   *
   * 翻译作业的 canonical 产物按定义必须与已发布 canonical 逐字节相同，所以最便宜的正确做法是
   * 再复制一次，而不是校验模型的克制：`wiki.json`、`pages/`、`cards/` 先整体丢弃（worker 可能
   * 就地翻译了它们——真实运行正是如此），再从 live 逐条复制回来。live 证明不了就 seed-untrusted，
   * 绝不带着一个可疑的 canonical 继续往下走。
   */
  const reseedCanonicalFromLive = async (job) => {
    const { liveDir, inventory } = await scanLiveCanonical(job);
    const entries = inventory.entries.filter((entry) => TRANSLATE_CANONICAL_ENTRIES.has(entry.path.split("/")[0]));
    if (!entries.some((entry) => entry.path === "wiki.json" && entry.kind === "file")) {
      throw new JobError(409, "live-missing", `the published ${wikiDirName} of ${job.root} has no canonical wiki.json to restore`);
    }
    for (const name of TRANSLATE_CANONICAL_ENTRIES) {
      const target = path.join(job.stageDir, name);
      try {
        await rm(target, { recursive: true, force: true });
      } catch (error) {
        throw new JobError(0, "seed-untrusted", `could not discard the staged canonical ${JSON.stringify(name)} before re-seeding it from live (${error?.code ?? "error"}): ${error?.message ?? error}`);
      }
    }
    for (const entry of entries) {
      await copySeededEntry(liveDir, entry, path.join(job.stageDir, ...entry.path.split("/")));
    }
  };

  /** 宿主自己创建翻译单元骨架；不是 exit 0，或没有真的写出 locales/<lang>/wiki.json，就失败。 */
  const runLocalesInit = async (job) => {
    const result = await runBuilder(job, ["locales-init", "--canonical", job.stageDir, "--lang", job.targetLang, "--json"], buildTimeoutMs);
    if (!result.ok) {
      requireJobBudget(job, "locales-init");
      throw new JobError(0, "locales-init-failed", `locales-init failed${result.code === null ? "" : ` (exit ${result.code})`}: ${String(result.output ?? "").slice(0, 1200)}`);
    }
    const units = path.join(job.stageDir, "locales", job.targetLang, "wiki.json");
    let identity;
    try {
      identity = await identityOf(units);
    } catch (error) {
      throw new JobError(0, "locales-init-failed", `locales-init did not create the translation units for ${job.targetLang} (${error?.code ?? "error"})`);
    }
    if (identity.kind !== "file" || identity.nlink !== "1") {
      throw new JobError(0, "locales-init-failed", `the translation units for ${job.targetLang} are not a single-link regular file`);
    }
  };

  /**
   * 从翻译后的 Markdown 组装 `locales/<lang>/wiki.json`（T014a-rev）。
   *
   * `translation-meta.json` 是 locales-init 用 canonical 文本算出的逐单元结构哈希，必须逐字节保留：
   * 所以组装前后各读一次并比较。产物必须是可用的 units 文件（单链接常规文件、目标语言、至少一页），
   * 否则 assemble-failed——绝不把一个空骨架交给翻译闸门当作“已翻译”。
   */
  const runLocalesAssemble = async (job) => {
    const mirror = path.join(job.stageDir, "locales", job.targetLang);
    const metaPath = path.join(mirror, "translation-meta.json");
    let metaBefore;
    try {
      metaBefore = await readFile(metaPath);
    } catch (error) {
      throw new JobError(0, "assemble-failed", `the translation-meta.json of ${job.targetLang} is not readable before the assemble step (${error?.code ?? "error"})`);
    }
    const result = await runBuilder(job, ["assemble", "--wiki", mirror, "--language", job.targetLang], buildTimeoutMs);
    if (!result.ok) {
      requireJobBudget(job, "locales assemble");
      throw new JobError(0, "assemble-failed", `assemble of the ${job.targetLang} translation units failed${result.code === null ? "" : ` (exit ${result.code})`}: ${String(result.output ?? "").slice(0, 1200)}`);
    }
    let metaAfter;
    try {
      metaAfter = await readFile(metaPath);
    } catch (error) {
      throw new JobError(0, "assemble-failed", `the translation-meta.json of ${job.targetLang} disappeared during the assemble step (${error?.code ?? "error"})`);
    }
    if (!metaBefore.equals(metaAfter)) {
      throw new JobError(0, "assemble-failed", `assemble rewrote the translation-meta.json of ${job.targetLang}; its per-unit structural hashes must stay canonical`);
    }
    const units = path.join(mirror, "wiki.json");
    let identity;
    try {
      identity = await identityOf(units);
    } catch (error) {
      throw new JobError(0, "assemble-failed", `assemble did not write the ${job.targetLang} translation units (${error?.code ?? "error"})`);
    }
    if (identity.kind !== "file" || identity.nlink !== "1") {
      throw new JobError(0, "assemble-failed", `the assembled ${job.targetLang} translation units are not a single-link regular file`);
    }
    let parsed = null;
    try {
      parsed = JSON.parse(await readProvenFile(units, identity));
    } catch {
      parsed = null;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.pages) || parsed.pages.length === 0) {
      throw new JobError(0, "assemble-failed", `the assembled ${job.targetLang} translation units are not a usable units file (no pages)`);
    }
    if (parsed.language !== job.targetLang) {
      throw new JobError(0, "assemble-failed", `the assembled ${job.targetLang} translation units declare language ${JSON.stringify(parsed.language ?? null)}`);
    }
  };

  // ---------- identity helpers (fs-contain) ----------
  const livePathOf = (root) => path.join(root, wikiDirName);
  const bound = (text) => (text === null ? null : JSON.parse(text));
  /** 缺失 => null；其它错误（junction、不可读、非目录）= 抛错：绝不把“看不清”当成“不存在”。 */
  const identityOrNull = async (target) => {
    try {
      return await identityOf(target);
    } catch (error) {
      if (error?.code === "path-not-found") return null;
      throw error;
    }
  };

  /** 失败路径 / 释放路径 / 取消路径共用的暂存清理：只按 journal 记录里绑定的身份删除。 */
  const cleanupStaging = async (job) => {
    if (!job.stageCreated) return;
    if (!job.snapshot) {
      // 没有事务记录就没有绑定身份：不删（可能被换掉/是链接），交给操作者。
      warn(`staging ${job.stageDir} is not bound by a journal record; it is left in place for an operator`);
      return;
    }
    const stageId = bound(job.snapshot.record.snapshots.stage);
    if (stageId === null) {
      // 记录说“没有暂存”；盘上却有一个目录。没有绑定身份就不删（可能被换掉/是链接）。
      warn(`staging ${job.stageDir} is not bound by the journal record; it is left in place for an operator`);
      return;
    }
    try {
      await removeVerifiedTree(job.stageDir, stageId, bound(job.snapshot.record.rootIdentity));
    } catch (error) {
      warn(`could not remove the journal-bound staging directory ${job.stageDir}: ${error?.message ?? error}; it is kept, not deleted`);
    }
  };

  // ---------- journal transaction steps (REQUIRED WRITE ORDER, spec T018) ----------

  /** 只允许 created → ... 顺序推进；store 出错 = 致命（隔离、保留栅栏、不再 rename）。 */
  const advanceJournal = async (job, phase, snapshots) => {
    const previous = job.snapshot;
    if (!previous) throw new JobError(0, "journal-missing", "no journal snapshot is held; the transaction cannot be advanced");
    const next = { ...previous.record, phase, snapshots };
    try {
      const { snapshot } = await journalStore.advance(previous, next);
      job.snapshot = snapshot;
      job.journalPhase = phase;
      return snapshot;
    } catch (error) {
      throw journalFatal(phase, error);
    }
  };

  /**
   * worker 存活观测：默认 "unknown"（=> planRecovery 一律隔离）。只有调用方注入可信
   * workerLiveness 才可能得到 alive/stopped；本模块自己无法证明任何 worker 进程已退出。
   */
  const observeWorker = async (record) => {
    if (!workerLiveness) return { state: "unknown" };
    let observed;
    try {
      observed = await workerLiveness(record);
    } catch {
      return { state: "unknown" };
    }
    if (observed === null || typeof observed !== "object") return { state: "unknown" };
    const state = observed.state;
    if (state !== "alive" && state !== "stopped" && state !== "unknown") return { state: "unknown" };
    if (state !== "stopped") return { state };
    return observed.proof === undefined ? { state } : { state, proof: observed.proof };
  };

  /**
   * 建立本作业的事务记录（phase=created），严格在创建 staging 之前。
   * 已存在非终止记录 => 拒绝（显式 journal-not-terminal，栅栏保持）；终止记录 => replaceTerminal。
   */
  const createJournal = async (job) => {
    let rootEntry;
    try {
      rootEntry = await assertCanonicalDir(job.root);
    } catch (error) {
      throw new JobError(409, "root-untrusted", `the repository root ${job.root} is not a trusted canonical directory (${error?.code ?? "error"}): ${error?.message ?? error}`);
    }
    const roots = await resolveAllowedRoots();
    if (!roots.some((value) => asPathKey(value) === asPathKey(rootEntry.path))) {
      throw new JobError(409, "root-not-allowed", `the repository root ${rootEntry.path} is not one of the allowlisted roots supplied by the host`);
    }
    // Bind the record to the canonical paths (on-disk casing) so the journal's exact-path rule holds
    // even when the caller spelled the root differently.
    job.livePath = livePathOf(rootEntry.path);
    job.backupDir = backupDirFor(rootEntry.path, job.id);
    job.stageDir = stagingDirFor(rootEntry.path, job.id);
    const liveNow = await identityOrNull(job.livePath);
    const record = {
      version: 1,
      jobId: job.id,
      hostInstanceId,
      rootReal: rootEntry.path,
      rootIdentity: identityJson(rootEntry.identity),
      stagePath: job.stageDir,
      livePath: job.livePath,
      backupPath: job.backupDir,
      // 该会话 id 在启动 worker 时使用同一个值；记录先于 staging 建立，所以这里绑定“将要使用”的 id。
      workerSessionId: `dsh-wiki-${job.id}`,
      protocolSha256: job.protocolSha256,
      promptSha256: job.promptSha256,
      phase: "created",
      snapshots: { stage: null, live: liveNow === null ? null : identityJson(liveNow), backup: null },
    };
    if (typeof record.protocolSha256 !== "string" || typeof record.promptSha256 !== "string") {
      throw new JobError(0, "journal-hashes-missing", "the worker prompt/protocol hashes are required before the transaction is journaled");
    }
    let prior = null;
    try {
      prior = await journalStore.load(rootEntry.path);
    } catch (error) {
      throw journalFatal("load", error);
    }
    if (prior) {
      if (!TERMINAL_PHASES.includes(prior.record.phase)) {
        const refusal = new JobError(409, "journal-not-terminal",
          `the journal for ${rootEntry.path} holds an unfinished transaction (job ${prior.record.jobId}, phase "${prior.record.phase}"); this repository is fenced until it is reconciled — no new job and no rename is admitted`);
        refusal.failClosed = true;
        throw refusal;
      }
      try {
        const { snapshot, replacement } = await journalStore.replaceTerminal(prior, record);
        job.snapshot = snapshot;
        if (replacement?.retained?.length) {
          // 被替换的旧记录已不可读；它的绑定目录只能由操作者手工检查（store 不做清理）。
          warn(`replaced terminal job ${prior.record.jobId}: retained artifacts must be inspected manually (${replacement.retained.map((entry) => `${entry.kind} ${entry.path}`).join(", ")})`);
        }
      } catch (error) {
        throw journalFatal("replaceTerminal", error);
      }
    } else {
      try {
        const { snapshot } = await journalStore.create(record);
        job.snapshot = snapshot;
      } catch (error) {
        throw journalFatal("create", error);
      }
    }
    job.journalPhase = "created";
  };

  /** 失败/取消的收尾：先记 aborted，再用身份校验删除暂存（绝不先删后记）。
   *  同一作业可能被多条收尾路径同时到达（cancel / unload / run-finally）：它们共享同一次 abort，
   *  否则两个 advance 会互相判成 stale-snapshot 而把仓库永久栅栏。失败则清掉缓存以便稍后重试。 */
  const abortJournal = async (job) => {
    if (job.abortPromise) return job.abortPromise;
    const snapshot = job.snapshot;
    if (!snapshot) return;
    const phase = snapshot.record.phase;
    if (TERMINAL_PHASES.includes(phase)) return;
    const current = snapshot.record.snapshots;
    // aborted 的 carryover：live 不变、backup 为空、stage 保留或为空（绝不替换）。
    const snapshots = { stage: current.stage, live: current.live, backup: null };
    job.abortPromise = advanceJournal(job, "aborted", snapshots)
      .then(() => undefined, (error) => { job.abortPromise = null; throw error; });
    return job.abortPromise;
  };

  /**
   * 提升之前的回滚（提升被拒，或提升前的预算到期）：按身份把 backup 移回 live（首次生成时没有
   * live 可恢复），记录 rolled-back（终态：stage 保留、live = 旧 wiki、backup 为空），最后抛出
   * failure —— 绝不提升。回滚 rename 自身失败 => failClosed：记录停在 live-moved，backup 与暂存
   * 都保留，由 reconcile 处理；这里既不提升也不删任何目录。
   */
  const rollbackBeforePromotion = async (job, record, priorLive, { failure, context }) => {
    if (priorLive !== null) {
      try {
        const rootIdentity = bound(record.rootIdentity);
        await guardedRename(record.backupPath, record.livePath, { expect: { src: priorLive, srcParent: rootIdentity, destParent: rootIdentity } });
      } catch (rollbackError) {
        const stuck = new JobError(0, "rollback-failed", `${context} and the backup could not be restored (${rollbackError?.message ?? rollbackError}); the previous wiki stays at ${record.backupPath} and the repository is fenced`);
        stuck.failClosed = true;
        throw stuck;
      }
    }
    await advanceJournal(job, "rolled-back", { stage: record.snapshots.stage, live: record.snapshots.live, backup: null });
    throw failure;
  };

  /**
   * journal 事务发布：validated 已在盘上（durable）后，两次身份校验 rename + 相位推进。
   * 预算在**锁内**重新检查：调用方在锁外的检查跨过了 validated 的写盘等待，证明不了此刻仍有预算；
   * 阶段入口的检查也约束不了一个 awaited 文件系统阶段的持续时间。rename 不可取消，所以在启动每个
   * rename 之前按同一个 deadlineAt 检查剩余量，并为每种到期给出确定结果：
   *   - 锁内、第一次 rename 之前到期：一个字都不动（live / staging 原样，记录仍是 validated），抛
   *     job-timeout，由 run-finally 记 aborted 并清理暂存；绝不 rename。
   *   - live 已移走（live-moved 已落盘）之后到期（含 live-moved 写盘本身越过截止时间）：绝不提升；
   *     按身份把 backup 移回 live，记录 rolled-back（终态）后抛 job-timeout；回滚失败 => failClosed，
   *     记录停在 live-moved、backup 与暂存保留、栅栏保留，交 reconcile。
   *   - 提升成功之后不再检预算：rename 不能撤销，必须把 published 写完（记录滞后于磁盘才是损坏）。
   */
  const publishJournaled = async (job) => {
    const record = job.snapshot.record;
    const rootIdentity = bound(record.rootIdentity);
    const stageIdentity = bound(record.snapshots.stage);
    const priorLive = bound(record.snapshots.live);
    const live = record.livePath;
    const backup = record.backupPath;
    if (record.phase !== "validated") throw new JobError(0, "journal-phase", `publication requires the journal phase "validated", found "${record.phase}"`);
    if (stageIdentity === null) throw new JobError(0, "journal-phase", "the journal does not bind a staging identity; refusing to publish");

    await withLock(asPathKey(job.root), async () => {
      // 锁内重检（含等锁时间）：剩余预算已用完就绝不开始发布 —— 此时 live、staging 与记录都未动。
      requireJobBudget(job, "publish");

      // ---- 第一次 rename: live -> .dsh-wiki.bak-<jobId>（无 live 的首次生成跳过） ----
      if (priorLive !== null) {
        try {
          await guardedRename(live, backup, { expect: { src: priorLive, srcParent: rootIdentity, destParent: rootIdentity } });
        } catch (error) {
          // 不确定 live 是否仍在：只有观察到 live 仍是记录的旧 wiki 才能安全地记 aborted。
          const liveNow = await observePath(live);
          const stillThere = liveNow.state === "present" && liveNow.identity.dev === priorLive.dev && liveNow.identity.ino === priorLive.ino;
          if (!stillThere) {
            const uncertain = new JobError(0, "journal-live-move-uncertain", `the first publish rename failed (${error?.code ?? "error"}: ${error?.message ?? error}) and the live directory no longer verifies as the bound previous wiki; the transaction stays at "validated" and the repository is fenced`);
            uncertain.failClosed = true;
            throw uncertain;
          }
          throw new JobError(0, error?.code ? `publish-${error.code}` : "publish-failed", `the first publish rename was refused before it happened (${error?.message ?? error}); the live wiki is unchanged`);
        }
        // 记录 LIVE-MOVED 严格在第一次 rename 之后。
        await advanceJournal(job, "live-moved", { stage: record.snapshots.stage, live: null, backup: record.snapshots.live });
      } else {
        // 首次生成：没有 live 可移动，记录 live-moved 与 journal 的不变量一致（backup 恒为 null）。
        await advanceJournal(job, "live-moved", { stage: record.snapshots.stage, live: null, backup: null });
      }

      // 提升之前再检一次：live 已移走（live 路径此刻是空的），提升是越过 deadline 的可见副作用。
      // 到期（含 live-moved 写盘本身越过截止时间）=> 不提升，回滚到旧 wiki 并记 rolled-back。
      if (remainingJobMs(job) <= 0) {
        await rollbackBeforePromotion(job, record, priorLive, {
          failure: new JobError(0, "job-timeout", `the job's absolute budget ran out after the live directory was moved to ${backup}; the promotion was not started and the previous wiki was restored`),
          context: "the promotion was not started because the job's absolute budget ran out",
        });
      }

      // ---- 第二次 rename: staging -> live（提升） ----
      try {
        await guardedRename(record.stagePath, live, { expect: { src: stageIdentity, srcParent: rootIdentity, destParent: rootIdentity } });
      } catch (error) {
        // 回滚：backup -> live。回滚失败 => 保留 backup、隔离、记录停在 live-moved。
        await rollbackBeforePromotion(job, record, priorLive, {
          failure: new JobError(0, "publish-failed", `the promotion was refused (${error?.code ?? "error"}: ${error?.message ?? error}); the previous wiki was restored and the candidate is retained in staging`),
          context: `the promotion failed (${error?.message ?? error})`,
        });
      }

      // 记录 PUBLISHED 严格在提升之后。
      await advanceJournal(job, "published", { stage: null, live: record.snapshots.stage, backup: record.snapshots.live });
      job.published = true;

      // 备份清理只在已发布且身份完全一致时进行；清理失败 = 警告并保留备份。
      if (priorLive !== null) {
        try {
          await verifySame(backup, priorLive);
          await removeVerifiedTree(backup, priorLive, rootIdentity);
        } catch (error) {
          warn(`could not remove the published backup ${backup} (${error?.code ?? "error"}: ${error?.message ?? error}); it is kept for a later reconcile`);
        }
      }
    });
  };

  /**
   * 取消 worker 并等 handle.dispose() 真正 resolve（带外层超时）。
   * 只有 resolve 之后才算“确认停下”：此时 guard / activation（挂在 agentCtx effect 上）也已释放。
   * 超时或 throw => 返回 false：调用方隔离，保留暂存与栅栏。
   * 外层等待用**清理预算 cleanupTimeoutMs**，不是作业的执行预算：执行预算已经过期的作业同样必须
   * 有机会把 worker 停下（否则过期就会留下一个无人停止的 worker）；清理预算本身仍有界。
   */
  const terminateWorker = async (job) => {
    if (!job.handle && job.starting) {
      // create 仍在飞：abort 之后等它落地（或超时），否则可能留下一个无主 worker。
      try { job.abort?.abort(); } catch { /* already aborted */ }
      const settled = await Promise.race([job.starting.then(() => "ok", () => "ok"), sleep(cleanupTimeoutMs).then(() => "timeout")]);
      if (settled === "timeout") { warn(`worker creation for job ${job.id} did not settle within ${cleanupTimeoutMs} ms`); return false; }
    }
    if (!job.handle) return true;
    if (job.workerStopped) return true;
    const agent = job.agent;
    try {
      if (agent && agent.status === "running") agent.cancel?.({ kind: "user" });
    } catch { /* 已空闲/已释放 */ }
    const disposing = job.disposePromise ??= Promise.resolve().then(() => job.handle.dispose());
    const outcome = await Promise.race([
      disposing.then(() => "ok", (error) => ({ error })),
      sleep(cleanupTimeoutMs).then(() => "timeout"),
    ]);
    if (outcome === "ok") { job.workerStopped = true; return true; }
    if (outcome === "timeout") {
      warn(`worker dispose for job ${job.id} did not resolve within ${cleanupTimeoutMs} ms`);
    } else {
      job.disposePromise = null; // 失败的 teardown 允许稍后重试
      warn(`worker dispose for job ${job.id} failed: ${outcome.error?.message ?? outcome.error}`);
    }
    return false;
  };

  /**
   * 一个仍持有“未证明停下”的 worker 的作业的可公开描述。sessionId 是该 worker 的 Agent.id，
   * 也是 workerGuard.activate() 的 agent id：卸载据此保留（而不是释放）对应的 guard activation。
   * @returns {{root: string, jobId: string, sessionId: string|null}}
   */
  const describeUnresolved = (job) => {
    const agentId = typeof job.agent?.id === "string" && job.agent.id
      ? job.agent.id
      : typeof job.sessionId === "string" && job.sessionId ? job.sessionId : null;
    return { root: job.root, jobId: job.id, sessionId: agentId };
  };

  /** 隔离的释放路径：只有 dispose resolve 后才删暂存并放开栅栏。 */
  const releaseQuarantine = async (job) => {
    if (job.blocked?.journal === true) {
      // journal 栅栏只能由 reconcile 解开：这里既不放行也不删除任何目录。
      warn(`quarantined job ${job.id} holds a journal fence (${job.blocked.reason}); run reconcile() for ${job.root}`);
      return false;
    }
    const stopped = await terminateWorker(job);
    if (!stopped) {
      if (job.blocked?.reason === "startup-unsettled" && job.handle) {
        job.blocked = { ...job.blocked, reason: "worker-not-stopped" };
        job.error = { ...(job.error ?? {}), code: "worker-not-stopped" };
      }
      warn(`quarantined job ${job.id} still has a live worker; staging and fence kept`);
      return false;
    }
    if (job.snapshot) {
      try { await abortJournal(job); } catch (error) {
        job.blocked = { reason: error?.code ?? "journal-error", journal: true };
        job.error = { code: String(error?.code ?? "journal-error"), message: error?.message ?? String(error) };
        warn(`could not abort the journal for quarantined job ${job.id}: ${error?.message ?? error}; staging and fence kept`);
        return false;
      }
    }
    await cleanupStaging(job);
    job.phase = "canceled";
    job.blocked = null;
    job.error = null;
    job.waitingFor = null;
    job.updatedAt = new Date().toISOString();
    lastByRoot.set(asPathKey(job.root), summarize(job));
    if (jobs.get(asPathKey(job.root)) === job) jobs.delete(asPathKey(job.root));
    return true;
  };

  /**
   * 撤销本管理器为一个 root 保留的内存 journal 栅栏。只由校验全部通过的 reconcile 调用：
   * 不碰盘（reconcile 已按 plan 处理过身份绑定的目录）、不推进 journal、不删暂存。
   * 内存改为跟随 store：snapshot/journalPhase 用重读到的记录，摘要因此与存储记录一致。
   * @returns {{released: boolean, releaseReason: string}} releaseReason 是稳定 token，供调用方报告。
   */
  const releaseJournalFence = (rootKey, reloaded) => {
    const job = jobs.get(rootKey);
    if (!job) return { released: false, releaseReason: "no-fence" };
    if (job.blocked?.journal !== true) return { released: false, releaseReason: "job-active" };
    job.snapshot = reloaded;
    job.journalPhase = reloaded.record.phase;
    job.blocked = null;
    job.updatedAt = new Date().toISOString();
    lastByRoot.set(rootKey, summarize(job));
    if (jobs.get(rootKey) === job) jobs.delete(rootKey);
    warn(`released the journal fence for ${job.root} after reconcile: record ${reloaded.record.jobId} is "${reloaded.record.phase}"; the root accepts a new job`);
    return { released: true, releaseReason: "reconciled" };
  };

  /** 监督循环：取消、超时、context-leak、等人输入，或本回合结束（turn/end 数超过基线且不在运行）。 */
  const supervise = async (job, baseline) => {
    for (;;) {
      if (job.cancelRequested || disposed) return { kind: "canceled" };
      const leak = findContextLeak(job.agent);
      if (leak) return { kind: "context-leak", leak };
      if (remainingJobMs(job) <= 0) return { kind: "timeout" };
      const pending = readPending(job.agent);
      if (pending.length > 0) return { kind: "input-required", pending: pending.slice() };
      if (job.agent.status !== "running" && turnEndCount(job.agent) > baseline) return { kind: "idle" };
      await sleep(pollMs);
    }
  };

  /**
   * 等一次“待输入”解除。两个上限都只在进入暂停时算一次：
   *   - 输入自己的预算 inputTimeoutMs：一次暂停不能无限等；
   *   - 作业的绝对预算 deadlineAt：所有等待共用，绝不续期。
   * 循环内部不重算任何截止时间，所以第二次、第三次乃至第十次暂停都无法把作业往后推。
   * @returns {"resumed"|"canceled"|"input-timeout"|"job-timeout"} 到期原因分开报告，调用方据此选稳定 code。
   */
  const waitWhileInputPending = async (job) => {
    const inputDeadline = Math.min(job.deadlineAt, Date.now() + inputTimeoutMs);
    for (;;) {
      if (job.cancelRequested || disposed) {
        job.cancelRequested = true;
        return "canceled";
      }
      if (readPending(job.agent).length === 0) return "resumed";
      const now = Date.now();
      if (now >= inputDeadline) {
        // 谁先到期就报谁：作业绝对预算用完是 job-timeout，输入暂停自己用完是 input-timeout。
        return now >= job.deadlineAt ? "job-timeout" : "input-timeout";
      }
      await sleep(Math.min(pollMs, inputDeadline - now));
    }
  };

  /** 候选树自检：任何 link/junction、硬链接、非常规条目或越界 => 拒绝（fail closed）。 */
  const scanCandidate = async (job, phase) => {
    try {
      await scanTree(job.stageDir);
    } catch (error) {
      throw new JobError(0, "candidate-untrusted", `the staged candidate is not a link-free tree before the ${phase} phase (${error?.code ?? "error"}): ${error?.message ?? error}`);
    }
  };

  /**
   * 宿主阶段的“顺序”闸门（review 缺陷修复）。
   *
   * 仓库内容是攻击者可控的，而下面每个宿主阶段（assemble、内容闸门、generation-meta 写入、validate、
   * build、selfcheck、宿主条目保留）都要读或写暂存候选。只在最后 scanCandidate 一次是不够的：候选里
   * 预先存在的链接条目，或在 worker 停下之后被换掉的暂存/祖先目录，会先被更早的阶段跟随；而事后扫描
   * 无法撤销已经发生的读或写。所以每个阶段之前都先按 journal 绑定的身份重新证明：
   *   1. root 仍是本事务绑定的那个 root（verifySame 逐级重走祖先，链接/换位一律拒绝）；
   *   2. 暂存目录仍是 worker-running 时绑定的那个目录（换掉暂存 => 拒绝）；
   *   3. 整个暂存树没有 link/junction、硬链接、非常规条目（scanTree fail closed）。
   * `live:true` 的阶段还会证明 live wiki 仍是 journal 里绑定的那个目录（保留阶段要读它）。
   * 一次通过只是收窄窗口，不是原子保证（见 fs-contain 的 LIMITATIONS）；最后的 scanCandidate 依旧保留。
   */
  const guardHostPhase = async (job, phase, options = {}) => {
    const record = job.snapshot?.record;
    const rootIdentity = bound(record?.rootIdentity ?? null);
    const stageIdentity = bound(record?.snapshots?.stage ?? null);
    if (rootIdentity === null || stageIdentity === null) {
      throw new JobError(0, "journal-phase", `the ${phase} phase requires a journal-bound root and staging identity`);
    }
    try {
      await verifySame(record.rootReal, rootIdentity);
    } catch (error) {
      throw new JobError(409, "root-untrusted", `refusing the ${phase} phase: the repository root no longer verifies as the journal-bound root (${error?.code ?? "error"}): ${error?.message ?? error}`);
    }
    try {
      await verifySame(record.stagePath, stageIdentity);
    } catch (error) {
      throw new JobError(0, "candidate-untrusted", `refusing the ${phase} phase: the staging directory no longer verifies as the journal-bound staging directory (${error?.code ?? "error"}): ${error?.message ?? error}`);
    }
    if (options.live === true) {
      const liveIdentity = bound(record.snapshots.live);
      if (liveIdentity !== null) {
        try {
          await verifySame(record.livePath, liveIdentity);
        } catch (error) {
          throw new JobError(409, "live-untrusted", `refusing the ${phase} phase: the live ${wikiDirName} no longer verifies as the wiki bound in the journal (${error?.code ?? "error"}): ${error?.message ?? error}`);
        }
      }
    }
    await scanCandidate(job, phase);
  };

  const run = async (job) => {
    const rootKey = asPathKey(job.root);
    const translate = job.action === "translate";
    try {
      // ---- 预备：先解析配置并算出 prompt/protocol hash，事务记录必须在创建 staging 之前写入 ----
      // 预备的每一步都只读同一个 deadlineAt：剩余预算已用完就拒绝，绝不开始一个注定越过截止时间的步骤。
      if (typeof cfg.runBuilder !== "function") {
        const python = await withinJobBudget(job, "python probe", () => resolvePython(job));
        if (!python) throw new JobError(0, "python-missing", `no usable python interpreter (tried ${pythonCandidates.join(", ")}); set the plugin config pythonPath`);
        job.python = python;
        job.engine = python.file;
      }
      requireJobBudget(job, "live-language");
      const liveLang = await liveLanguage(job.root);
      if (liveLang !== null && liveLang !== "en") {
        throw new JobError(0, "live-not-canonical", `the live ${wikiDirName} for ${job.root} declares language ${JSON.stringify(liveLang)}; this slice only updates the canonical en wiki — migrate or regenerate it first (the live wiki was not touched)`);
      }
      if (translate) {
        // 翻译的源就是已发布的 canonical wiki：没有它就什么都不做（绝不翻译一个空树）。
        if (liveLang === null) {
          throw new JobError(409, "live-missing", `there is no published ${wikiDirName} to translate for ${job.root}; generate the canonical en wiki first`);
        }
        // 没有翻译 prompt 构造器时，translate 绝不能退化成 generation prompt。
        if (typeof cfg.buildTranslationPrompt !== "function") {
          throw new JobError(0, "translation-unsupported", "this Host provides no translation prompt builder; a translate job is refused instead of running as a generation job");
        }
      }
      // 增量（spec 013 §2.2 步骤 1–4）：作业自己再解析一次基线/HEAD/祖先/影响映射。请求时刻的结果不能
      // 代表 worker 启动时刻的事实，而这一次的结果才是写进作业记录与 prompt 的那一个。
      // 任何失败都是硬失败（409 语义的 code），绝不静默降级成全量重建。
      let incrementalPlan = null;
      if (job.incremental !== null) {
        setStage(job, "incremental plan");
        requireJobBudget(job, "incremental plan");
        incrementalPlan = await withinJobBudget(job, "incremental plan", () => planIncremental(job.root, job));
        job.incremental = incrementalSummary(incrementalPlan);
        job.updatedAt = new Date().toISOString();
      }
      // 宿主自己解析配置：stdout 就是有效配置对象（--dry-run 不写任何文件）。
      // 配置本身也被绝对预算截断（runBuilder 取剩余量与 buildTimeoutMs 的较小者），所以慢配置
      // 不可能在 staging / journal 状态已经存在之后才变成一个晚到的 startup-timeout。
      setStage(job, "config");
      requireJobBudget(job, "configuration");
      const resolved = await runBuilder(job, ["resolve-config", "--repo", job.root, "--set", "language=en", "--dry-run"], buildTimeoutMs);
      if (!resolved.ok) {
        requireJobBudget(job, "configuration"); // 被 deadline 掐断的子命令报 job-timeout，而不是它自己的失败
        throw new JobError(0, "config-failed", `resolve-config failed${resolved.code === null ? "" : ` (exit ${resolved.code})`}: ${resolved.output.slice(0, 1200)}`);
      }
      let config;
      try { config = JSON.parse(resolved.stdout); } catch { throw new JobError(0, "config-invalid", "resolve-config stdout is not a single JSON object"); }
      // 翻译作业：config 描述的是 canonical 源（language=en），而翻译闸门读 job.config.language，
      // 所以目标语言在这里进入 job.config；generate/update 的 config 语义一点不改。
      if (translate) job.config = { ...config, language: job.targetLang };
      let built;
      try {
        // 异步准备同样有界：注入的 buildWorkerPrompt 永不 settle 时不能把作业挂在这里。
        built = await withinJobBudget(job, "worker prompt", () => (translate
          ? cfg.buildTranslationPrompt({ jobId: job.id, root: job.root, stageDir: job.stageDir, config, targetLang: job.targetLang })
          : cfg.buildWorkerPrompt({
            jobId: job.id, root: job.root, stageDir: job.stageDir, config,
            // 增量作业才带这个键：全量作业的 prompt 与今天逐字节相同。
            ...(incrementalPlan === null ? {} : {
              incremental: {
                baseline: incrementalPlan.baseline,
                head: incrementalPlan.head,
                pages: incrementalPlan.pages,
                cards: incrementalPlan.cards,
                unmappedFiles: incrementalPlan.unmappedFiles,
              },
            }),
          })));
      } catch (error) {
        if (error instanceof JobError) throw error;
        throw new JobError(0, error?.code ? String(error.code) : "prompt-failed", `the worker prompt could not be built: ${error?.message ?? error}`);
      }
      if (!translate) job.config = built.config ?? config;
      job.promptSha256 = built.promptSha256 ?? null;
      job.protocolSha256 = built.protocolSha256 ?? null;
      if (job.cancelRequested || disposed) { job.phase = "canceled"; return; }

      // ---- 事务记录 phase=created 严格早于 staging 的创建 ----
      await createJournal(job);

      setStage(job, "staging");
      await mkdir(job.stageDir, { recursive: false }).catch((error) => {
        if (error?.code === "EEXIST") throw new JobError(409, "staging-exists", `staging directory already exists: ${job.stageDir}`);
        throw error;
      });
      job.stageCreated = true;
      // ---- 只有 mkdir 成功之后才绑定 staging 身份并推进 worker-running ----
      const stageIdentity = await identityOf(job.stageDir);
      await advanceJournal(job, "worker-running", {
        stage: identityJson(stageIdentity),
        live: job.snapshot.record.snapshots.live,
        backup: null,
      });

      if (translate) {
        // 翻译作业的候选从已发布的 canonical 树播种，然后由宿主自己创建翻译单元骨架。
        // 两步都在 worker 会话之前：worker 只能写已经存在、且由宿主证明过包含性的条目。
        setStage(job, "seed");
        requireJobBudget(job, "staging seed");
        await guardHostPhase(job, "staging seed");
        await seedStageFromLive(job);
        setStage(job, "locales-init");
        requireJobBudget(job, "locales-init");
        await guardHostPhase(job, "locales-init");
        await runLocalesInit(job);
        // 语言镜像（locales/<lang>/pages|cards）是 worker 的工作区：canonical 的英文字节副本，
        // 由 worker 就地翻译，随后由宿主组装成 units 文件。
        setStage(job, "locale mirror");
        requireJobBudget(job, "locale mirror");
        await guardHostPhase(job, "locale mirror", { live: true });
        await seedLocaleMirror(job);
      }

      if (incrementalPlan !== null) {
        // 增量（spec 013 §2.2 步骤 5）：把已发布的 canonical 树整棵播种到暂存，未受影响的页面因此
        // 原样活到发布之后。失败是**硬失败**（seed-untrusted / live-missing），绝不是警告：发布替换
        // live 目录，没有播种就等于把 wiki 缩小成“只写过的那几页”。
        setStage(job, "seed");
        requireJobBudget(job, "staging seed");
        await guardHostPhase(job, "staging seed", { live: true });
        await seedStageFromLive(job, "update");
        // 播种之后的受影响条目就是 worker 之前的字节基线：用它判定 pagesRewritten（不依赖模型自报）。
        job.incrementalSeeded = await withinJobBudget(job, "staging seed", () => snapshotIncrementalEntries(job, incrementalPlan));
        // 另有一份**整棵暂存树**的字节基线（review MAJOR）：worker 停下后用它复核受影响集合之外的
        // 每一条（含 wiki.json 的顶层键与 worker 新建的条目/空目录）。这是独立于上面那份的检查，
        // 不是它的延伸。
        job.incrementalSeededAll = await withinJobBudget(job, "staging seed", () => snapshotStagedEntries(job));
      }

      setStage(job, "session");
      const startWorker = typeof cfg.startGuardedWorker === "function" ? cfg.startGuardedWorker : startGuardedWorker;
      job.starting = Promise.resolve().then(() => startWorker(
        { agents: cfg.agents, agentPresets: cfg.agentPresets, workerGuard: cfg.workerGuard, workingDirectory: cfg.workingDirectory, presetId: cfg.presetId },
        {
          sessionId: `dsh-wiki-${job.id}`, root: job.root, stageDir: job.stageDir, model: job.model, signal: job.abort.signal,
          // 翻译作业的写域是语言镜像，不是整个暂存目录：canonical 树对 worker 不可写。
          ...(translate ? { writeRoot: path.join(job.stageDir, "locales", job.targetLang) } : {}),
        },
      )).then((handle) => { job.handle = handle; job.agent = handle.agent; return handle; });
      // create 可能永不 settle：晚到的 settle 由这里统一收口（隔离中则走释放路径，绝不 followup）。
      const onStartSettled = () => {
        job.startSettled = true;
        if (job.blocked) void releaseQuarantine(job);
      };
      job.starting.then(onStartSettled, onStartSettled);
      // 启动阶段也受取消/超时监督：竞速 create、cancel、绝对预算剩余，不无界等待。
      // 剩余量来自同一个 deadlineAt（不是新的窗口）：配置阶段已经花掉的时间不再被抹掉。
      const startupBudgetMs = Math.max(0, remainingJobMs(job));
      const interrupt = new Promise((resolve) => { job.interruptStartup = () => resolve("canceled"); });
      let startTimer;
      const startDeadline = new Promise((resolve) => {
        startTimer = setTimeout(() => resolve("timeout"), startupBudgetMs);
        if (typeof startTimer.unref === "function") startTimer.unref();
      });
      let startOutcome;
      try {
        startOutcome = await Promise.race([job.starting.then(() => "started"), interrupt, startDeadline]);
      } finally {
        clearTimeout(startTimer);
        job.interruptStartup = null;
      }
      if (startOutcome === "timeout") {
        try { job.abort.abort(); } catch { /* already aborted */ }
        throw new JobError(0, "startup-timeout", startupBudgetMs <= 0
          ? "the job's absolute time budget ran out before the worker session could be created"
          : `the worker session was not created within the remaining ${Math.round(startupBudgetMs / 1000)} s of the job budget`);
      }
      if (startOutcome === "canceled") { job.phase = "canceled"; return; }
      job.sessionId = job.agent.id;
      job.updatedAt = new Date().toISOString();
      if (job.cancelRequested || disposed) { job.phase = "canceled"; return; }

      setStage(job, "agent");
      const baseline = turnEndCount(job.agent);
      job.agent.followup({
        id: globalThis.crypto.randomUUID(),
        role: "user",
        content: [{ type: "text", text: built.prompt }],
        source: { kind: "user" },
      });
      let watched;
      for (;;) {
        watched = await supervise(job, baseline);
        if (watched.kind !== "input-required") break;
        job.waitingFor = watched.pending.slice();
        setStage(job, "waiting_input");
        const resolution = await waitWhileInputPending(job);
        job.waitingFor = null;
        if (resolution === "canceled") { job.phase = "canceled"; return; }
        // 输入暂停到期不是“继续等”，也不重算任何截止时间：走既有的失败→终止→（必要时）隔离路径。
        if (resolution === "job-timeout") {
          throw new JobError(0, "job-timeout", `the job exceeded its absolute ${Math.round(jobTimeoutMs / 1000)} s budget while waiting for human input`);
        }
        if (resolution === "input-timeout") {
          throw new JobError(0, "input-timeout", `the worker waited for human input for the whole ${Math.round(inputTimeoutMs / 1000)} s input budget; the job was abandoned instead of waiting without a deadline`);
        }
      }
      if (watched.kind === "canceled") { job.phase = "canceled"; return; }
      if (watched.kind === "context-leak") {
        try { job.agent.cancel?.({ kind: "user" }); } catch { /* terminateWorker retries */ }
        throw new JobError(0, "context-leak", `the worker session received loader context (${watched.leak.kind}); refusing the candidate`);
      }
      if (watched.kind === "timeout") throw new JobError(0, "job-timeout", `the job exceeded its absolute ${Math.round(jobTimeoutMs / 1000)} s budget before the agent finished`);
      const outcome = turnOutcome(lastTurnEnd(job.agent));
      if (!outcome.ok) {
        if (outcome.canceled) { job.phase = "canceled"; return; }
        job.error = outcome.error ?? { message: "the agent turn failed" };
        job.phase = "failed";
        // 模型/路由的原始报错只进 logger；摘要与公开投影只有固定 code + 短句。
        warn(`job ${job.id} failed at stage ${job.stage}: ${job.error.message ?? "the agent turn failed"}`);
        return;
      }

      // worker 必须先确认停下（dispose resolve），宿主才碰候选目录。终止走独立的清理预算
      // （cleanupTimeoutMs），所以即使执行预算刚刚过期，这里也必须有机会真正把 worker 停下。
      setStage(job, "stopping");
      if (!(await terminateWorker(job))) {
        throw new JobError(0, "worker-not-stopped", `the worker for job ${job.id} could not be confirmed stopped (dispose did not resolve)`);
      }
      // 只有 dispose 确认停下之后才记录 worker-stopped（暂存/ live / backup 均不变）。
      await advanceJournal(job, "worker-stopped", {
        stage: job.snapshot.record.snapshots.stage,
        live: job.snapshot.record.snapshots.live,
        backup: null,
      });
      // 增量（spec 013 §2.2 步骤 7–8）：worker 停下之后、assemble 之前，先做两次复核，然后才统计受
      // 影响的页改写了多少、删除了多少：
      //   1. 受影响集合里的每个条目**仍然只代表它自己**（front-matter 的 id 缺席或等于文件名）——
      //      授权范围检查故意跳过受影响集合，没有这一步，把受影响页的 id 改成一个不受影响页的 id 就
      //      能在 assemble 时顶替那一页（review MAJOR，D1）；
      //   2. 受影响集合之外的条目必须与播种时逐字节相同，wiki.json 的任何顶层键变化同理（改写/新增/
      //      删除 => incremental-unexpected-write，绝不发布）。
      // assemble 之后会重写 wiki.json 的 pages/cards，所以两者都必须在它之前：此刻的 wiki.json 还只
      // 可能是 worker 改过的。
      let pagesRewritten = null;
      let removedPageIds = null;
      if (incrementalPlan !== null) {
        setStage(job, "incremental ids");
        requireJobBudget(job, "incremental ids");
        await guardHostPhase(job, "incremental ids");
        await withinJobBudget(job, "incremental ids",
          () => verifyAffectedEntryIds(job, incrementalPlan));
        setStage(job, "incremental scope");
        requireJobBudget(job, "incremental scope");
        await guardHostPhase(job, "incremental scope");
        await withinJobBudget(job, "incremental scope",
          () => verifyUntouchedEntries(job, incrementalPlan, job.incrementalSeededAll));
        setStage(job, "incremental rewrites");
        requireJobBudget(job, "incremental rewrites");
        await guardHostPhase(job, "incremental rewrites");
        const pageChanges = await withinJobBudget(job, "incremental rewrites",
          () => countPageChanges(job, incrementalPlan, job.incrementalSeeded));
        pagesRewritten = pageChanges.rewritten;
        removedPageIds = pageChanges.removed;
        // 删除单独记录（D2）：它绝不能只是 pagesRewritten 里的一次自增，否则一页消失是无声的。
        job.incremental = {
          ...job.incremental,
          pagesRewritten,
          pagesRemoved: removedPageIds.length,
          removedSample: removedPageIds.slice(0, 5),
        };
        job.updatedAt = new Date().toISOString();
      }
      // worker 之后的每个宿主阶段之前都先看同一个绝对预算：剩余已用完就拒绝开始，
      // 而不是先跑完 assemble/validate/build/selfcheck/preserve 再在截止时间之后发布。
      // 翻译作业不组装 canonical（wiki.json 是播种进来的文件），但必须先做两件事：
      //   1. canonical  invariance：wiki.json/pages/cards 从 live 重新播种，丢弃 worker 写在那里的
      //      任何内容——这是结构性保证，“不要修改 canonical”的提示语不是保证；
      //   2. 用翻译后的 Markdown 组装 locales/<lang>/wiki.json（assemble --wiki <mirror>）。
      if (translate) {
        setStage(job, "canonical re-seed");
        requireJobBudget(job, "canonical re-seed");
        await guardHostPhase(job, "canonical re-seed", { live: true });
        await reseedCanonicalFromLive(job);
        setStage(job, "locales assemble");
        requireJobBudget(job, "locales assemble");
        await guardHostPhase(job, "locales assemble");
        await runLocalesAssemble(job);
      } else {
        setStage(job, "assemble");
        requireJobBudget(job, "assemble");
        await guardHostPhase(job, "assemble");
        const assemble = await runBuilder(job, ["assemble", "--wiki", job.stageDir, "--repo", job.root, "--language", "en"], buildTimeoutMs);
        if (!assemble.ok) {
          requireJobBudget(job, "assemble"); // 被 deadline 掐断的子命令报 job-timeout，而不是 assemble-failed
          throw new JobError(0, "assemble-failed", `assemble failed${assemble.code === null ? "" : ` (exit ${assemble.code})`}: ${assemble.output.slice(0, 1200)}`);
        }
      }
      // 内容闸门：assemble 之后、任何 journal 推进到 validated 之前。宿主自己判定，细节只进 logger。
      requireJobBudget(job, "content gate");
      await guardHostPhase(job, "content gate");
      await applyContentGate(job);
      // 翻译作业不写 generation-meta.json：canonical 的生成来源由 preserveHostOwned 从 live 保留。
      if (!translate) {
        requireJobBudget(job, "generation-meta");
        const commit = await withinJobBudget(job, "generation-meta", () => sourceCommit(job.root));
        // spec 013 §5.1 / §2.2 步骤 6：增量作业记录的是**它实际 diff 过的**那对提交；而 worker 一页都
        // 没有改写、也没有删除时绝不把 sourceCommit 推到 HEAD——那会声称做了比实际更多的事。此时曲线
        // 留在基线，不匹配由作业状态里的 pagesRewritten / pagesRemoved vs affectedPages 如实暴露。
        // 删除同样是一次真实的 diff 结果（一页真的下线了），所以它和改写一样把记录推进到 HEAD。
        let sourceCommitValue = commit;
        let sourceCommitAdvanced = commit !== null;
        if (incrementalPlan !== null) {
          const rewrote = Number.isSafeInteger(pagesRewritten) && pagesRewritten > 0;
          const removed = Array.isArray(removedPageIds) && removedPageIds.length > 0;
          sourceCommitAdvanced = rewrote || removed;
          sourceCommitValue = sourceCommitAdvanced ? incrementalPlan.head : incrementalPlan.baseline;
        }
        const meta = {
          schema: "repo-wiki-local/1",
          kind: "generation-meta",
          generatedAt: new Date().toISOString(),
          repoId: job.root,
          ...(sourceCommitValue ? { sourceCommit: sourceCommitValue } : {}),
          resolved: job.config,
          docModel: { provider: job.model.provider, model: job.model.model },
          promptSha256: job.promptSha256,
          protocolSha256: job.protocolSha256,
          generatedBy: "dsh-wiki-job",
          jobId: job.id,
        };
        await guardHostPhase(job, "generation-meta");
        await writeFile(path.join(job.stageDir, "generation-meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
        if (incrementalPlan !== null) {
          job.incremental = { ...job.incremental, sourceCommit: sourceCommitValue ?? null, sourceCommitAdvanced };
          job.updatedAt = new Date().toISOString();
        }
      }
      setStage(job, "validate");
      requireJobBudget(job, "validate");
      await guardHostPhase(job, "validate");
      await validateCandidate(job);
      setStage(job, "build");
      requireJobBudget(job, "build");
      await guardHostPhase(job, "build");
      const build = await runBuilder(job, ["build", "--wiki", job.stageDir], buildTimeoutMs);
      if (!build.ok) {
        requireJobBudget(job, "build");
        throw new JobError(0, "build-failed", `build failed${build.code === null ? "" : ` (exit ${build.code})`}: ${build.output.slice(0, 1200)}`);
      }
      setStage(job, "selfcheck");
      requireJobBudget(job, "selfcheck");
      await guardHostPhase(job, "selfcheck");
      const selfcheck = await runBuilder(job, ["selfcheck", "--wiki", job.stageDir], selfcheckTimeoutMs);
      if (!selfcheck.ok) {
        requireJobBudget(job, "selfcheck");
        throw new JobError(0, "selfcheck-failed", `selfcheck failed${selfcheck.code === null ? "" : ` (exit ${selfcheck.code})`}: ${selfcheck.output.slice(0, 1200)}`);
      }
      if (job.cancelRequested) { job.phase = "canceled"; return; }
      // 宿主所有条目（config.json / locales/）在验证之前并入候选；随后整树自检。
      setStage(job, "preserve");
      requireJobBudget(job, "preserve");
      await guardHostPhase(job, "preserve", { live: true });
      await preserveHostOwned(job);
      // 翻译完整性闸门：内容闸门之后、候选扫描与发布之前（locales 已由宿主并入候选）。
      await applyTranslationGate(job);
      await scanCandidate(job, "publish");
      // validated 必须在第一次 rename 之前落盘（journal.js REQUIRED WRITE ORDER 第 1 步）。
      // 发布是绝对预算下的最后一步：剩余已用完就停在这里（记录仍停在 worker-stopped，
      // 由 run-finally 记 aborted 并删暂存），绝不越过 deadline 后再 rename。
      requireJobBudget(job, "publish");
      await advanceJournal(job, "validated", {
        stage: job.snapshot.record.snapshots.stage,
        live: job.snapshot.record.snapshots.live,
        backup: null,
      });
      setStage(job, "publish");
      await publishJournaled(job);
      job.phase = "done";
      setStage(job, "done");
    } catch (error) {
      if (error?.failClosed === true) job.failClosed = true;
      if (job.cancelRequested && error?.failClosed !== true) {
        job.phase = "canceled";
      } else {
        job.phase = "failed";
        job.error = {
          message: error?.message ?? String(error),
          ...(error?.code ? { code: String(error.code) } : {}),
        };
        // 原始细节（provider/builder stderr、路径、stack）只进 logger：摘要与公开投影都只有固定 code + 短句。
        warn(`job ${job.id} failed at stage ${job.stage}: ${job.error.message}`);
      }
    } finally {
      // 失败/超时/取消/等待输入后：先 await handle.dispose()，resolve 之后才删暂存、放栅栏。
      // journal / store 出错（fail closed）=> 什么都不删、不推进，隔离并保留栅栏。
      if (job.failClosed) {
        job.phase = "failed";
        job.blocked = { reason: job.error?.code ?? "journal-fence", staging: job.stageDir, journal: true };
        warn(`job ${job.id} holds a journal fence (${job.blocked.reason}); staging and fence kept — reconcile is required`);
      } else if (!job.published) {
        const stopped = await terminateWorker(job);
        if (stopped) {
          // 先记 aborted，再按记录里绑定的身份删除暂存（绝不先删后记）。
          if (job.snapshot) {
            try {
              await abortJournal(job);
            } catch (error) {
              job.phase = "failed";
              job.error = { code: String(error?.code ?? "journal-error"), message: error?.message ?? String(error) };
              job.blocked = { reason: job.error.code, staging: job.stageDir, journal: true };
              warn(`could not abort the journal for job ${job.id} (${job.error.code}); staging and fence kept`);
            }
          }
          if (!job.blocked) await cleanupStaging(job);
        } else {
          const unsettled = !job.handle && job.starting && !job.startSettled;
          const code = unsettled ? "startup-unsettled" : "worker-not-stopped";
          job.phase = "failed";
          job.blocked = { reason: code, staging: job.stageDir };
          job.error = {
            code,
            message: `the worker for job ${job.id} could not be confirmed stopped${unsettled ? " (session creation never settled)" : ""}; staging ${job.stageDir} and the single-flight fence are quarantined — cancel again once the worker is gone, or restart the plugin`,
          };
          warn(`job ${job.id} quarantined (${code}); staging kept at ${job.stageDir}`);
          if (job.startSettled) void releaseQuarantine(job); // create 在判定与隔离之间落地
        }
      }
      job.waitingFor = null;
      job.updatedAt = new Date().toISOString();
      // 终态失败（phase=failed，含隔离）先写诊断再公布摘要：观察者看到终态时证据已在本机盘上。
      // 取消与成功都不写；写盘失败已在内部降级为警告，绝不改变这里的相位、错误或栅栏。
      if (job.phase === "failed") await writeFailureDiagnostic(job);
      lastByRoot.set(rootKey, summarize(job));
      if (jobs.get(rootKey) === job && !job.blocked) jobs.delete(rootKey);
    }
  };

  return {
    /** 是否有作业在跑（同步、便宜，供 GET 汇总）。 */
    isBusy(root) {
      return jobs.has(asPathKey(root));
    },
    /**
     * 同步报告仍持有“未证明停下”的 worker 的作业：worker 句柄尚在（含 create 在飞）且从未确认
     * dispose resolve。卸载用它决定保留哪些 guard activation；已确认停下的 worker 不在其中。
     * @returns {Array<{root: string, jobId: string, sessionId: string|null}>}
     */
    unresolvedWorkers() {
      const out = [];
      for (const job of jobs.values()) {
        if (job.workerStopped) continue;
        if (!job.handle && !job.starting) continue;
        out.push(describeUnresolved(job));
      }
      return out.sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : 0) || (a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0));
    },
    /**
     * 增量更新前置解析（spec 013 §2.2 步骤 1–4）：路由在 manager.start() **之前**调用它，于是每一种
     * 失败都是 409 响应、且一个作业都没有被接纳（绝不用“先接纳再失败”冒充拒绝）。
     *
     * 它是只读的：读 live 元数据、读 HEAD、问一次祖先关系、跑一次 diff-impact。成功返回冻结的 plan
     * （含 liveDir，供作业记录与提示语使用），失败抛 JobError(409, incremental-*)。作业自己还会再解析
     * 一次（见 run()）——这里的返回值只是一个“可以开始”的判定与早期投影。
     * @param {string} root 已由调用方证明为规范、且在 allowlist 里的仓库根
     */
    async incrementalPlan(root) {
      if (disposed) throw new JobError(503, "plugin-unloaded", "the dsh-wiki plugin has been unloaded");
      requireServices();
      return planIncremental(path.resolve(root));
    },    /**
     * 启动一个作业。**同步**插入单飞栅栏（在任何 await 之前），然后才排入异步流水线。
     * @throws JobError 409 已有作业 / 409 分区残留 / 503 服务缺失
     */
    start(request) {
      if (disposed) throw new JobError(503, "plugin-unloaded", "the dsh-wiki plugin has been unloaded");
      const root = path.resolve(request.root);
      const rootKey = asPathKey(root);
      const running = jobs.get(rootKey);
      if (running) {
        if (running.blocked) {
          throw new JobError(409, "job-quarantined", `the previous job for ${root} is quarantined (${running.blocked.reason}: its worker could not be confirmed stopped); staging kept at ${running.blocked.staging ?? running.stageDir} — cancel it once the worker is gone, or restart the plugin`);
        }
        throw new JobError(409, "job-busy", `a ${running.action} job is already running for ${root}`);
      }
      // translate 需要非 en 的 targetLang；generate/update 仍然只接受规范 en（501 保持不变）。
      if (request.action === "translate") {
        const lang = request.targetLang;
        if (typeof lang !== "string" || lang.length === 0 || lang.length > LANG_TAG_MAX || !LANG_TAG_RE.test(lang) || lang === "en") {
          throw new JobError(400, "invalid-target-lang", "a translate job requires a non-en BCP 47 targetLang");
        }
      } else if (request.targetLang != null && request.targetLang !== "en") {
        throw new JobError(501, "language-unsupported", "only the canonical en wiki is generated in this slice");
      }
      // 增量（spec 013 §2.1）：只有 update 接受它，而且必须是完整的前置解析结果。这是管理器的第二道
      // 闸门——直接调用 start() 的调用方同样拿不到“静默全量重建”，也拿不到半个 plan。
      let incremental = null;
      if (request.incremental !== undefined && request.incremental !== null) {
        if (request.action === "generate") {
          throw new JobError(400, "incremental-not-for-generate", "a first build has no published baseline to update incrementally");
        }
        if (request.action === "translate") {
          throw new JobError(400, "incremental-not-for-translate", "an incremental update never applies to a translation job");
        }
        incremental = normalizeIncrementalRequest(request.incremental);
      }
      requireServices();
      // 绝对预算只在这里算一次：startedAt + jobTimeoutMs。之后所有等待都只读 deadlineAt，
      // 谁也不能靠重算（尤其是每次回到 supervise）把它往后推。
      const startedAtMs = Date.now();
      const now = new Date(startedAtMs).toISOString();
      const id = globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 16);
      const job = {
        id,
        root,
        action: request.action,
        model: { provider: request.model.provider, model: request.model.model },
        targetLang: request.targetLang ?? "en",
        phase: "running",
        stage: "queued",
        startedAt: now,
        deadlineAt: startedAtMs + jobTimeoutMs,
        updatedAt: now,
        sessionId: null,
        agent: null,
        handle: null,
        starting: null,
        startSettled: false,
        interruptStartup: null,
        disposePromise: null,
        abortPromise: null,
        workerStopped: false,
        error: null,
        published: false,
        pages: null,
        cancelRequested: false,
        waitingFor: null,
        blocked: null,
        stageCreated: false,
        stageDir: stagingDirFor(root, id),
        livePath: livePathOf(root),
        backupDir: backupDirFor(root, id),
        snapshot: null,
        journalPhase: null,
        failClosed: false,
        promptSha256: null,
        protocolSha256: null,
        // 增量事实（spec 013）：非增量作业恒为 null。run() 会用作业自己的前置解析结果刷新它，
        // 因此在 worker 启动之前这个对象就已经是“这次作业真的要改写什么”。
        incremental: incremental === null ? null : incrementalSummary(incremental),
        incrementalSeeded: null,
        // 最近一次 builder/worker 输出的尾部窗口：只供终态失败的本地诊断，绝不进摘要或 HTTP 投影。
        evidence: "",
        abort: new AbortController(),
      };
      jobs.set(rootKey, job); // 栅栏：同步关闭
      void run(job);
      return summarize(job);
    },
    /** 请求取消（幂等）；返回是否确实取消了正在跑的作业。 */
    cancel(root) {
      const job = jobs.get(asPathKey(root));
      if (!job) return { canceled: false, reason: "no active job" };
      if (job.blocked) {
        void releaseQuarantine(job);
        const journalFence = job.blocked.journal === true;
        return {
          canceled: false,
          quarantine: true,
          id: job.id,
          reason: journalFence
            ? "this repository is fenced by the trusted journal; cancel does not release it — run reconcile() for the root, which acts only on a validated journal record"
            : "the worker could not be confirmed stopped; release retried — staging and the fence stay quarantined until it is gone",
        };
      }
      job.cancelRequested = true;
      // abort 在每个阶段都转发（包括 create 在飞时，宿主 raceAbort 依赖它）；并唤醒启动竞速。
      try { job.abort?.abort(); } catch { /* already aborted */ }
      try { job.interruptStartup?.(); } catch { /* ignore */ }
      try { job.agent?.cancel?.({ kind: "user" }); } catch { /* 已空闲 */ }
      return { canceled: true, id: job.id };
    },
    /** 作业视图：active 为当前运行中的作业，last 为本进程内最近一次结束的作业。 */
    view(root, options = {}) {
      const rootKey = asPathKey(root);
      const active = jobs.get(rootKey);
      // options.public=true：公开投影（固定错误短句、无 staging/路径）；HTTP 出口必须使用。
      const project = options?.public === true ? publicJobView : (value) => value;
      const last = lastByRoot.get(rootKey) ?? null;
      return {
        active: active ? project(summarize(active)) : null,
        last: last === null ? null : project(last),
      };
    },
    /**
     * 卸载：取消并 dispose 本插件拥有的每个 worker handle（由 ctx.effect 清理调用）。
     * journal 栅栏只能由 reconcile() 解开：持有栅栏的记录在卸载时绝不推进到 aborted，也绝不删暂存——
     * aborted 是终止相位，下一次 start() 会把它 replaceTerminal 掉，那就是绕过栅栏。worker 仍然要停。
     * unload 必须是完全的：单个作业的意外失败只警告，绝不把异常抛给卸载调用者。
     */
    async dispose() {
      disposed = true;
      const running = [...jobs.values()];
      // 卸载报告的“未证明停下”的 worker：调用方（index.js）据此保留这些 agent 的 guard activation，
      // 绝不能把一个仍在运行的 worker 释放成无围栏进程。
      const unresolved = [];
      for (const job of running) {
        job.cancelRequested = true;
        try { job.abort?.abort(); } catch { /* already aborted */ }
        try { job.interruptStartup?.(); } catch { /* ignore */ }
        try { job.agent?.cancel?.({ kind: "user" }); } catch { /* 已空闲 */ }
      }
      await Promise.all(running.map(async (job) => {
        try {
          const stopped = await terminateWorker(job);
          if (!stopped) unresolved.push(describeUnresolved(job));
          if (job.blocked?.journal === true) {
            // 只停 worker，不碰记录/暂存：栅栏的释放属于 reconcile。
            warn(`job ${job.id} holds a journal fence (${job.blocked.reason}) on unload; its record and staging ${job.stageDir} are kept untouched — reconcile() is required${stopped ? "" : " (the worker could not be confirmed stopped)"}`);
            return;
          }
          if (!stopped) {
            warn(`staging and fence kept for job ${job.id} on unload: dispose did not resolve (${job.stageDir})`);
            return;
          }
          if (job.snapshot && !job.published) {
            try { await abortJournal(job); } catch (error) {
              warn(`staging and fence kept for job ${job.id} on unload: the journal could not be aborted (${error?.code ?? "error"})`);
              return;
            }
          }
          if (!job.published) await cleanupStaging(job);
          if (jobs.get(asPathKey(job.root)) === job && !job.blocked) jobs.delete(asPathKey(job.root));
        } catch (error) {
          warn(`job ${job.id} could not be released on unload: ${error?.message ?? error}; its record, staging and fence are kept`);
          // 释放路径自己失败 => 这个 worker 的存活状态未知：同样按“未证明停下”报告（fail closed）。
          unresolved.push(describeUnresolved(job));
        }
      }));
      unresolved.sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : 0) || (a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0));
      return { unresolved };
    },
    /**
     * 启动恢复入口（T018）：只读 journal，按记录自身的路径与身份重建观测，绝不 readdir、
     * 绝不按文件名/mtime 发现备份。默认只“计划”；execute:true 时由 publish-executor 执行
     * planRecovery 给出的符号动作（其余决定零副作用）。不被任何 GET 调用，index.js 未接线。
     *
     * 内存栅栏（review 缺陷：恢复成功后内存仍 blocked，store 与内存各说各话）：成功恢复之后，
     * 本管理器为同一个 root 保留的 in-memory 栅栏随之撤销。撤销需要三条同时成立：
     *   1. 计划真的被执行——executeRecoveryPlan 返回 executed:true 且 effects>0。no-op/manual/
     *      quarantine 什么都不做，**仅仅“存储相位已经终止”绝不撤销**；
     *   2. 重读的存储记录仍是同一个 jobId 且相位属于 TERMINAL_PHASES（内存随后跟着 store 走）；
     *   3. 本模块既有的停止证明：planRecovery 的 worker 观测（observeWorker => workerLiveness；
     *      没有独立证明时它只给 quarantine，因此不可能有计划动作）与本作业自己的 terminateWorker
     *      （dispose resolve，与 run-finally 同一个机制）。
     * root 上还有 active/disposing 作业时绝不在它脚下清状态：execute 直接
     * status:"refused"/code:"job-active"（确定性拒绝并报告），执行前在单 root 锁内再确认一次；
     * 待撤销的作业若 dispose 不 resolve，则等满清理预算 cleanupTimeoutMs 后拒绝并报告
     * releaseReason:"worker-not-proven-stopped"。
     */
    async reconcile(root, options = {}) {
      const missing = journalDepsMissing();
      if (missing.length) throw new JobError(503, "services-unavailable", `reconcile needs the ${missing.join(", ")} dependency`);
      const requested = path.resolve(root);
      const roots = await resolveAllowedRoots();
      if (!roots.some((value) => asPathKey(value) === asPathKey(requested))) {
        return { status: "refused", code: "root-not-allowed", root: requested };
      }
      // 恢复专用的 store 覆盖（spec 007 / T029）：**只在** execute:true 时生效，普通写入与只读计划
      // 永远走 journalStore（钉死在本实例上的那个）。为什么需要：makeHostInstanceId 每次 apply 都换
      // 新值，宿主重启后钉死的 store 永远配不上上一条记录，执行前就会以 host-pin-mismatch 拒绝。所以
      // 执行路径可以由调用方交进一个未钉死的实例（index.js 的 openRecoveryStore），并必须同时声明
      // recovery:true——执行器在未钉死 store 上要求这个显式授权，未被声明就整体拒绝（零动作）。
      // 整个 execute 路径（load → 计划 → 执行 → 复验）都只用这一份 store：snapshot 只对签发它的
      // 那个 store 实例有效（journal-store 的 per-store brand），混用两个实例会让 CAS 失败。
      const recoveryStore = options?.execute === true ? (options?.store ?? null) : null;
      if (recoveryStore !== null
        && (typeof recoveryStore?.load !== "function" || typeof recoveryStore?.advance !== "function")) {
        return { status: "refused", code: "recovery-store-invalid", root: requested };
      }
      const store = recoveryStore ?? journalStore;
      let snapshot;
      try {
        snapshot = await store.load(requested);
      } catch (error) {
        return { status: "error", code: storeCode(error), root: requested, message: error?.message ?? String(error) };
      }
      if (!snapshot) return { status: "no-record", root: requested };
      const record = snapshot.record;
      // 观测只来自记录自身绑定的三个路径 + root；worker 默认 unknown（=> 隔离）。
      const observations = {
        hostInstanceId,
        worker: await observeWorker(record),
        root: await observePath(record.rootReal),
        stage: await observePath(record.stagePath),
        live: await observePath(record.livePath),
        backup: await observePath(record.backupPath),
      };
      let plan;
      try {
        plan = planRecovery(record, observations);
      } catch (error) {
        return { status: "error", code: storeCode(error), root: requested, jobId: record.jobId, message: error?.message ?? String(error) };
      }
      const result = { status: "planned", root: record.rootReal, jobId: record.jobId, phase: record.phase, observations, plan };
      if (options?.execute !== true) return result;
      // 内存栅栏按两种拼写找：调用方给出的 root 与记录里的 canonical root。
      const rootKeys = [asPathKey(requested), asPathKey(record.rootReal)].filter((key, index, all) => all.indexOf(key) === index);
      const rootKey = rootKeys.find((key) => jobs.has(key)) ?? asPathKey(requested);
      const holder = jobs.get(rootKey) ?? null;
      if (holder && holder.blocked?.journal !== true) {
        // 运行中（或 quarantine 释放中）的作业：不执行、不清理、不撤销，只报告是哪一个。
        return { ...result, status: "refused", code: "job-active", executed: false, effects: 0, released: false, releaseReason: "job-active" };
      }
      if (plan.actions.length === 0) return { ...result, executed: false, effects: 0, released: false, releaseReason: "no-action" };
      // 与同一 root 的发布/恢复串行：锁内再确认一次没有作业插进来（start() 是同步插栅栏的）。
      return withLock(rootKey, async () => {
        const live = jobs.get(rootKey) ?? null;
        if (live && live.blocked?.journal !== true) {
          return { ...result, status: "refused", code: "job-active", executed: false, effects: 0, released: false, releaseReason: "job-active" };
        }
        // 先按本模块既有的“确认停下”机制证明这个作业的 worker 不在写，再碰任何目录。
        if (live && !(await terminateWorker(live))) {
          return { ...result, status: "refused", code: "worker-not-stopped", executed: false, effects: 0, released: false, releaseReason: "worker-not-proven-stopped" };
        }
        let outcome;
        try {
          // recovery 只从调用方显式取得：执行器用它在“未钉死的 store”上要求一个明确的授权声明。
          outcome = await executeRecoveryPlan(plan, { store, snapshot, recovery: options?.recovery === true });
        } catch (error) {
          return { ...result, status: "execute-failed", code: storeCode(error), message: error?.message ?? String(error), released: false, releaseReason: "execute-failed" };
        }
        const executed = { ...result, ...outcome };
        if (executed.executed !== true || !(Number.isInteger(executed.effects) && executed.effects > 0)) {
          // 计划没有产生任何效果：仅仅“记录已终止”不是恢复完成，栅栏保持。
          return { ...executed, released: false, releaseReason: "plan-not-executed" };
        }
        let reloaded;
        try {
          // 同一份 store 复验（execute 路径只用一个实例）：记录是否真的推进到终止相位由签发它的一方重读。
          reloaded = await store.load(requested);
        } catch (error) {
          return { ...executed, released: false, releaseReason: "verify-failed", releaseCode: storeCode(error) };
        }
        if (!reloaded || reloaded.record.jobId !== record.jobId) {
          return { ...executed, released: false, releaseReason: "record-replaced" };
        }
        if (!TERMINAL_PHASES.includes(reloaded.record.phase)) {
          return { ...executed, released: false, releaseReason: "record-not-terminal" };
        }
        if (observations.worker.state !== "stopped") {
          return { ...executed, released: false, releaseReason: "worker-not-proven-stopped" };
        }
        return { ...executed, ...releaseJournalFence(rootKey, reloaded) };
      });
    },
    /**
     * 测试/诊断：journal 接线状态。journal 是唯一发布模式——缺依赖时 start() 已 503，没有无 journal 路径。
     * `fenced` 是内存里仍然立着 journal 栅栏的作业（成功的 reconcile 之后应为空）。它带 root 路径，
     * 只进内部诊断：公开投影 publicJournalState() 仍然只有 mode/missing。
     */
    journalState() {
      const fenced = [];
      for (const job of jobs.values()) {
        if (job.blocked?.journal !== true) continue;
        fenced.push({ root: job.root, jobId: job.id, reason: publicErrorCode(job.blocked.reason) });
      }
      fenced.sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : 0) || (a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0));
      return { mode: "journal", missing: journalDepsMissing(), fenced };
    },
    /** 测试/诊断：当前活动作业快照。 */
    _jobs: jobs,
  };
}
