// dsh-wiki — MCP 的 Streamable HTTP 传输（spec 015）。
//
// 形状按实测的客户端行为（Claude Code 2.1.286，见 specs/015 的测量段）：
//   POST /mcp  Accept: application/json, text/event-stream  → 单条 JSON-RPC（JSON 回应）
//   GET  /mcp  Accept: text/event-stream                    → 服务端→客户端的 SSE 通道（本服务器不主动推送）
// 只监听 127.0.0.1：这不是远程表面，任何远程暴露都需要 TLS + 每设备凭证（constitution A7），本适配层不做。
import http from "node:http";
import { RPC, REQUEST_TIMEOUT_MS, dispatchPayload, rpcError, LATEST_PROTOCOL_VERSION } from "./protocol.mjs";

const MAX_BODY_BYTES = 1024 * 1024;
// SSE 通道上限：GET /mcp 是长连接，每个连接占一个 fd 和一条 keep-alive 定时器。客户端正常只开一条，
// 无上限就等于把本机 fd 交给任何能连回环端口的进程。超出直接 429，不排队。
export const MAX_SSE_STREAMS = 16;
// SSE 保活：客户端（或中间件）若在若干秒内收不到任何字节就会断开。注释行不触发事件，纯保活。
const SSE_KEEPALIVE_MS = 25000;
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * 浏览器页面打不开这台服务器的方式：DNS rebinding 的页面会带一个外部 Origin。
 * 浏览器以外的客户端（Claude Code、curl）不发 Origin，因此“没有 Origin”必须放行。
 */
const originAllowed = (req) => {
  const origin = req.headers.origin;
  if (typeof origin !== "string" || origin.length === 0) return true;
  try {
    const parsed = new URL(origin);
    return LOOPBACK_HOSTNAMES.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
};

/**
 * DNS rebinding 的另一半，Origin 挡不住：攻击者让受害浏览器的页面去请求 `http://127.0.0.1:<port>`，
 * 请求里的 `Host` 仍是攻击者的域名（rebinding 前解析过的名字），回环监听会把这种请求照样收下。
 * 所以 Host 必须是回环名。浏览器一定会发 Host；完全不发 Host 的只可能是自制/旧式非浏览器客户端
 * （HTTP/1.0），那不是 rebinding 的攻击面，放行。
 */
const hostAllowed = (req) => {
  const host = req.headers.host;
  if (typeof host !== "string" || host.length === 0) return true;
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(`http://${host}`).hostname.toLowerCase());
  } catch {
    return false;
  }
};

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  let overflow = false;
  req.on("data", (chunk) => {
    if (overflow) return;
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      // 不 destroy：先让 413 真的发出去，靠 Connection: close 结束这条连接。
      overflow = true;
      const error = new Error("request body too large");
      error.code = "body-too-large";
      reject(error);
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    if (!overflow) resolve(Buffer.concat(chunks).toString("utf8"));
  });
  req.on("error", reject);
});

const sseHeaders = () => ({
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
  "mcp-protocol-version": LATEST_PROTOCOL_VERSION,
});

/**
 * @param {{server: object, path?: string, logWarn?: Function, requestTimeoutMs?: number,
 *          connectionsCheckingIntervalMs?: number}} options
 *   server 是 protocol.createMcpServer() 的返回值（只用到 dispatch/requestTimeoutMs）。
 */
export function createHttpTransport({
  server,
  path: mcpPath = "/mcp",
  logWarn = () => {},
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
  connectionsCheckingIntervalMs = 30000,
}) {
  const streams = new Set();
  const timers = new Set();

  const closeStreams = () => {
    for (const timer of timers) clearInterval(timer);
    timers.clear();
    for (const res of streams) {
      try { res.end(); } catch { /* 已经断开 */ }
    }
    streams.clear();
  };

  const sendJson = (res, status, body, extraHeaders = {}) => {
    const payload = body === null ? "" : JSON.stringify(body);
    res.writeHead(status, {
      ...(body === null ? {} : { "content-type": "application/json; charset=utf-8" }),
      "mcp-protocol-version": LATEST_PROTOCOL_VERSION,
      ...extraHeaders,
    });
    res.end(payload);
  };

  /** 客户端只接受 SSE 时，把单条响应按 SSE 的一个 message 事件发出去（规范允许两种回应）。 */
  const sendSse = (res, body) => {
    res.writeHead(200, sseHeaders());
    res.write(`event: message\ndata: ${JSON.stringify(body)}\n\n`);
    res.end();
  };

  const handlePost = async (req, res) => {
    const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
    if (!contentType.includes("application/json")) {
      sendJson(res, 415, rpcError(null, RPC.invalidRequest, "Content-Type must be application/json"));
      return;
    }
    let text;
    try {
      text = await readBody(req);
    } catch (error) {
      const status = error?.code === "body-too-large" ? 413 : 400;
      sendJson(res, status, rpcError(null, RPC.invalidRequest, "could not read the request body"), { connection: "close" });
      return;
    }
    if (text.trim().length === 0) {
      sendJson(res, 400, rpcError(null, RPC.parse, "Parse error: empty body"));
      return;
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      sendJson(res, 400, rpcError(null, RPC.parse, "Parse error: body is not valid JSON"));
      return;
    }
    let response;
    try {
      response = await dispatchPayload(server, payload);
    } catch (error) {
      logWarn(`dsh-wiki mcp: dispatch failed: ${String(error?.message ?? error)}`);
      response = rpcError(null, RPC.internalError, "the request could not be completed");
    }
    if (response === null) {
      // 通知：MCP 要求 202 Accepted 且无响应体。
      sendJson(res, 202, null);
      return;
    }
    const accept = String(req.headers.accept ?? "").toLowerCase();
    const sseOnly = accept.includes("text/event-stream") && !accept.includes("application/json");
    if (sseOnly) sendSse(res, response);
    else sendJson(res, 200, response);
  };

  const handleGet = (req, res) => {
    const accept = String(req.headers.accept ?? "").toLowerCase();
    if (!accept.includes("text/event-stream")) {
      // 规范：客户端不接受 SSE 时服务器回 405。
      sendJson(res, 405, rpcError(null, RPC.invalidRequest, "GET requires Accept: text/event-stream"), { allow: "POST" });
      return;
    }
    if (streams.size >= MAX_SSE_STREAMS) {
      sendJson(res, 429, rpcError(null, RPC.invalidRequest, `too many open SSE streams (max ${MAX_SSE_STREAMS})`),
        { "retry-after": "1", connection: "close" });
      return;
    }
    res.writeHead(200, sseHeaders());
    res.write(": dsh-wiki mcp stream open\n\n");
    streams.add(res);
    const timer = setInterval(() => {
      try { res.write(": keepalive\n\n"); } catch { /* 断开由 close 事件收尾 */ }
    }, SSE_KEEPALIVE_MS);
    timer.unref?.();
    timers.add(timer);
    const cleanup = () => {
      clearInterval(timer);
      timers.delete(timer);
      streams.delete(res);
    };
    res.on("close", cleanup);
    res.on("error", cleanup);
  };

  const handler = async (req, res) => {
    let requestUrl;
    try {
      requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    } catch {
      sendJson(res, 400, rpcError(null, RPC.invalidRequest, "malformed request URL"));
      return;
    }
    if (!hostAllowed(req)) {
      logWarn(`dsh-wiki mcp: refused a request whose Host header is not loopback (${String(req.headers.host).slice(0, 80)})`);
      sendJson(res, 403, rpcError(null, RPC.invalidRequest, "host not allowed"), { connection: "close" });
      return;
    }
    if (requestUrl.pathname !== mcpPath) {
      sendJson(res, 404, rpcError(null, RPC.invalidRequest, `not found: ${requestUrl.pathname}`));
      return;
    }
    if (!originAllowed(req)) {
      logWarn(`dsh-wiki mcp: refused a request with a non-loopback Origin (${String(req.headers.origin).slice(0, 80)})`);
      sendJson(res, 403, rpcError(null, RPC.invalidRequest, "origin not allowed"));
      return;
    }
    try {
      if (req.method === "POST") {
        await handlePost(req, res);
        return;
      }
      if (req.method === "GET") {
        handleGet(req, res);
        return;
      }
      // DELETE 是“结束会话”用的；本服务器无会话（stateless），所以明确不允许。
      sendJson(res, 405, rpcError(null, RPC.invalidRequest, "method not allowed"), { allow: "GET, POST" });
    } catch (error) {
      logWarn(`dsh-wiki mcp: request failed: ${String(error?.message ?? error)}`);
      if (!res.headersSent) sendJson(res, 500, rpcError(null, RPC.internalError, "the request could not be completed"));
      else {
        try { res.end(); } catch { /* 已断开 */ }
      }
    }
  };

  const httpServer = http.createServer(handler);
  // 收请求本身必须有上限：0（旧值）意味着一个只发了半个 body 的连接可以永远占着 socket。
  // requestTimeout 只管“把请求收完”，不砍已经开始的响应 —— 实测把两者都设成 300 ms 时 SSE 长连接照旧开着。
  httpServer.requestTimeout = requestTimeoutMs;
  httpServer.headersTimeout = Math.min(60000, requestTimeoutMs);
  // Node 按自己的节拍检查超时（默认 30 s）：只设 requestTimeout 而不改这个间隔，实际关闭会晚最多一个间隔。
  httpServer.connectionsCheckingInterval = connectionsCheckingIntervalMs;

  return {
    /** 只监听回环：非 127.0.0.1 的绑定在这个适配层里没有选项，是刻意的。 */
    listen: (port) => new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      httpServer.once("error", onError);
      httpServer.listen(port, "127.0.0.1", () => {
        httpServer.off("error", onError);
        resolve(httpServer.address());
      });
    }),
    address: () => httpServer.address(),
    close: () => new Promise((resolve) => {
      closeStreams();
      try {
        httpServer.close(() => resolve());
      } catch {
        resolve();
      }
      // 兜底：close() 不会终结已建立的 keep-alive 连接，3 秒后强制收尾，进程才能真的退出。
      setTimeout(() => {
        try { httpServer.closeAllConnections?.(); } catch { /* 老版本 Node */ }
      }, 3000).unref?.();
    }),
  };
}
