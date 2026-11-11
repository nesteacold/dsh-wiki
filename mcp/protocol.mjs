// dsh-wiki — MCP 适配层的协议内核（spec 015）。
//
// 这里**只**做 MCP/JSON-RPC 语义：initialize / server-discover / ping / tools/list / tools/call。
// 工具本身没有第二套实现：`buildToolDefinitions()` 是 spec 014 交给 `ctx.tools.register` 的同一批
// 普通对象定义，`name`/`description`/`parameters` 原样成为 MCP 的 `name`/`description`/`inputSchema`，
// `output.render` 就是 MCP 的文本 content。所以 DSH 原生工具与 MCP 工具在**同一个进程外**也不可能
// 给出两个答案 —— 它们共用一个 execute、一套上限、一个新鲜度函数（lib/wiki-tools.js）。
//
// 传输分帧（HTTP 的 POST/SSE、stdio 的换行分帧）不在这里，见 http-transport.mjs / stdio-transport.mjs。
import { buildToolDefinitions, WIKI_TOOL_NAMES } from "../lib/wiki-tools.js";

export const SERVER_NAME = "dsh-wiki";

// 支持的协议版本，最新的在前。客户端请求的版本在表内就照原样回，否则回最新版（MCP 的版本协商）。
export const PROTOCOL_VERSIONS = Object.freeze(["2025-06-18", "2025-03-26", "2024-11-05"]);
export const LATEST_PROTOCOL_VERSION = PROTOCOL_VERSIONS[0];

// JSON-RPC 2.0 的标准错误码。工具自己的**定型失败**（ok:false）不是 JSON-RPC 错误：
// 那是“调用成功了，但请求被合法拒绝”，走 tools/call 的 isError:true，与 DSH 原生工具一致。
export const RPC = Object.freeze({
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
});

export const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
export const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

// 单条请求的硬时限。stdio 是**串行**队列，一条卡住的 tools/call 会把它后面的所有请求一起堵死；
// HTTP 上至少会占住一条连接。工具本身都是本机只读（唯一子进程是 3 s 超时的 git 探测），30 s 远超
// 现实耗时，所以超时只可能是真的坏了 —— 那就回一条 -32603，而不是让客户端永远等一个不来的包。
export const REQUEST_TIMEOUT_MS = 30000;

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// JSON-RPC 2.0：id 只能是字符串、数字或 null。别把对象/数组/布尔当成 id 回显 —— 客户端按 id
// 对响应做匹配，回显一个它发不出的形状只会让匹配失败。
const isRpcId = (value) => value === null || typeof value === "string" || typeof value === "number";

/** 版本协商：只回我们真的实现的版本，别把客户端自称的版本号当成事实回显。 */
const negotiate = (requested) =>
  (typeof requested === "string" && PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION);

class RpcFailure extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const DEFAULT_INSTRUCTIONS =
  "Read-only local repository wiki (nothing uploaded). Call wiki_search before changing unfamiliar code, "
  + "wiki_page / wiki_cards for detail, wiki_impact after edits, wiki_status for freshness. The wiki is a map, "
  + "not the source of truth: verify every cited path:line in the code.";

/**
 * 构造协议层。`deps` 与 lib/index.js 交给 registerWikiTools 的形状完全一致
 * （resolveRepo / loadSnapshot / freshness / logWarn），所以定义层看到的是同一个契约。
 * @param {{deps: object, version: string, defaultRepo?: string|null, instructions?: string,
 *          requestTimeoutMs?: number}} options
 */
export function createMcpServer({
  deps,
  version,
  defaultRepo = null,
  instructions = DEFAULT_INSTRUCTIONS,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
}) {
  const definitions = buildToolDefinitions(deps);
  const names = definitions.map((definition) => definition.name);
  // 两个工具面共用一份定义：名字集合一旦漂移就是缺陷，宁可在启动时炸掉，也不要静默少一个工具。
  if (JSON.stringify(names) !== JSON.stringify([...WIKI_TOOL_NAMES])) {
    throw new Error(`dsh-wiki mcp: tool definitions drifted from WIKI_TOOL_NAMES (${names.join(", ")})`);
  }
  const byName = new Map(definitions.map((definition) => [definition.name, definition]));
  const tools = definitions.map((definition) => ({
    name: definition.name,
    description: definition.description,
    // parameters 只用了 type/properties/required/items/enum/description —— 合法的 JSON Schema 子集。
    inputSchema: definition.parameters ?? { type: "object", properties: {} },
  }));

  const serverInfo = { name: SERVER_NAME, title: "Local Repo Wiki", version };
  const capabilities = { tools: { listChanged: false } };
  const handshake = (protocolVersion) => ({
    protocolVersion: negotiate(protocolVersion),
    capabilities,
    serverInfo,
    instructions,
  });

  const callTool = async (params) => {
    if (params !== undefined && !isPlainObject(params)) {
      throw new RpcFailure(RPC.invalidParams, "invalid params: params must be an object");
    }
    // 非对象 arguments 不能悄悄当成 {}：那会让工具带着默认参数跑起来（例如落到另一个仓库）。
    // 调用方写错了类型，就明确回 -32602，与“没传参数”区分开。
    if (params?.arguments !== undefined && !isPlainObject(params.arguments)) {
      throw new RpcFailure(RPC.invalidParams, "invalid params: arguments must be an object");
    }
    const name = typeof params?.name === "string" ? params.name : "";
    const definition = byName.get(name);
    if (!definition) throw new RpcFailure(RPC.invalidParams, `unknown tool: ${name || "(missing name)"}`);
    const args = { ...(params?.arguments ?? {}) };
    // 适配层的 `--repo` 只是“调用方省略 repo 时的默认候选”，仍然要过 resolveRepo 的同一条证明；
    // 工具自己的解析顺序（显式 > 会话目录 > 唯一已发现根）不变。
    if (!args.repo && typeof defaultRepo === "string" && defaultRepo.length > 0) args.repo = defaultRepo;
    // 会话目录候选（spec 021 R1）：MCP 没有 Host 的 exec 上下文，所以把**本进程的工作目录**作为
    // 最小等价物交出去 —— `sessionCwdOf` 认 `exec.cwd`。Claude Code 以项目目录为 cwd 拉起 stdio 服务器
    // （实测），于是不带 `--repo` 的便携注册也能落到当前仓库。它与 Host 内一样只是**候选**：
    // wiki-context 的 resolveRepo 仍要求该目录真的含 <wikiDir>/wiki.json（或是已登记根），
    // 没有 wiki 的目录不会变成默认目标；显式 repo（含 `--repo`）优先级不变。
    const exec = { cwd: process.cwd() };
    let value;
    try {
      value = await definition.execute(args, exec);
    } catch (error) {
      deps.logWarn(`dsh-wiki mcp: ${name} failed: ${String(error?.message ?? error)}`);
      throw new RpcFailure(RPC.internalError, "the wiki tool could not complete this request");
    }
    const content = typeof definition.output?.render === "function"
      ? definition.output.render(value)
      : [{ type: "text", text: JSON.stringify(value) }];
    // 定型拒绝（ok:false）是**结果**，不是协议错误；用 isError 让客户端把它当失败显示。
    return { content, isError: value?.ok !== true };
  };

  /** 一条 JSON-RPC 消息 → 响应对象；通知（无 id）返回 null，表示“不回应”。 */
  const dispatch = async (message) => {
    if (!isPlainObject(message)) return rpcError(null, RPC.invalidRequest, "invalid request: expected a JSON-RPC object");
    const id = message.id;
    // id 形状先判：畸形 id 无法回显（回显一个对象等于让客户端的请求/响应匹配失效），所以用 null 回错。
    if (id !== undefined && !isRpcId(id)) {
      return rpcError(null, RPC.invalidRequest, "invalid request: id must be a string or a number");
    }
    const method = message.method;
    if (typeof method !== "string") return rpcError(id, RPC.invalidRequest, "invalid request: missing method");
    // 没有 id 的消息是通知（JSON-RPC / MCP 同一规则）：不回应。带 id 的 notifications/* 是坏请求 ——
    // 它必须拿到回应，否则客户端会一直等一个永远不会来的包。
    if (id === undefined) return null;
    if (method.startsWith("notifications/")) {
      return rpcError(id, RPC.invalidRequest, `notifications must not carry an id: ${method}`);
    }
    try {
      switch (method) {
        case "initialize":
          return rpcResult(id, handshake(message.params?.protocolVersion));
        // 实测 Claude Code 2.1.286 在 initialize **之前**先发 server/discover（见 specs/015 的测量）：回同一个
        // 握手结果，让客户端拿到 capabilities/version 再决定下一步；不实现它会让首包直接 -32601。
        case "server/discover":
          return rpcResult(id, handshake(message.params?.protocolVersion));
        case "ping":
          return rpcResult(id, {});
        case "tools/list":
          return rpcResult(id, { tools });
        case "tools/call":
          return rpcResult(id, await callTool(message.params));
        default:
          throw new RpcFailure(RPC.methodNotFound, `method not found: ${method}`);
      }
    } catch (error) {
      if (error instanceof RpcFailure) return rpcError(id, error.code, error.message);
      deps.logWarn(`dsh-wiki mcp: ${method} failed: ${String(error?.message ?? error)}`);
      return rpcError(id, RPC.internalError, "the request could not be completed");
    }
  };

  return { dispatch, tools, serverInfo, protocolVersions: PROTOCOL_VERSIONS, requestTimeoutMs };
}

const TIMED_OUT = Symbol("dsh-wiki.request-timeout");

/**
 * 传输层共用的一步：批量数组在 MCP 里已不合法（2025-06-18 起），统一回 -32600，别在两个 transport 里各写一遍；
 * 单条请求在这里统一套上限时，超时回 -32603，客户端拿到的是可解释的失败而不是永远沉默。
 * @returns {Promise<object|null>} 响应对象；null 表示这是通知（或超时的通知），不需要回应。
 */
export async function dispatchPayload(server, payload) {
  if (Array.isArray(payload)) return rpcError(null, RPC.invalidRequest, "invalid request: batch arrays are not supported");
  const timeoutMs = Number.isFinite(server?.requestTimeoutMs) && server.requestTimeoutMs > 0
    ? server.requestTimeoutMs
    : REQUEST_TIMEOUT_MS;
  // 通知没有可回应的对象：它超时就安静放弃，不能凭空造一条客户端没在等的响应。
  const isNotification = !isPlainObject(payload) || !("id" in payload) || payload.id === undefined;
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    timer.unref?.();
  });
  // 输掉竞速的那一方之后可能仍会 reject（工具还在跑）；先挂上 catch，别让它变成 unhandledRejection。
  // 消息保持通用：内部异常文本不进客户端（与 dispatch 自己的兜底一致）。
  const work = Promise.resolve()
    .then(() => server.dispatch(payload))
    .catch(() => rpcError(null, RPC.internalError, "the request could not be completed"));
  try {
    const outcome = await Promise.race([work, deadline]);
    if (outcome !== TIMED_OUT) return outcome;
    if (isNotification) return null;
    return rpcError(payload.id, RPC.internalError, `the request exceeded the adapter's ${Math.round(timeoutMs / 1000)}s time limit`);
  } finally {
    clearTimeout(timer);
  }
}
