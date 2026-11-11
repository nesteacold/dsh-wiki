#!/usr/bin/env node
// dsh-wiki MCP 适配层的命令行入口（spec 015）。
//
// 两种传输：
//   node mcp/server.mjs [--repo <绝对路径>] [--dsh-home <dir>] [--wiki-dir NAME]        （默认 stdio）
//   node mcp/server.mjs --transport http --port 7919 [--repo <绝对路径>] [--dsh-home <dir>]
//
// 为什么默认是 stdio：用户真正用 Claude Code 的地方是普通终端，`claude mcp add dsh-wiki -- node
// …/mcp/server.mjs` 会用管道拉起本进程、在 stdin/stdout 上说 JSON-RPC —— 不开端口、不监听、没有网络面，
// 也不需要用户挑一个空闲端口。HTTP 是回退/自动化路径（客户端只接受 URL 时），必须显式 --transport http。
// 两条传输共用同一个 protocol 内核，所以工具行为不会因为传输不同而不同。
//
// 这个默认值没法在本进程里端到端验证：DSH 沙箱禁止带管道的子进程（EPERM，spec 014 spec.md:158 记录过
// 同一失败类），所以沙箱里的 agent 只跑 HTTP 用例；CLI/OS 管道层在普通终端跑，沙箱里显式 SKIP。
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createHttpTransport } from "./http-transport.mjs";
import { createMcpServer } from "./protocol.mjs";
import { attachStdio } from "./stdio-transport.mjs";
import { createWikiContext, defaultDshHome } from "./wiki-context.mjs";

const PACKAGE = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const DEFAULT_PORT = 7919;
// 端口策略（owner 实测）：<1024 需要特权；2190-2289 是本机保留段。落在这两段里直接拒绝，
// 不要悄悄换一个端口 —— 注册命令里的 URL 必须与服务实际监听的一致。
const BLOCKED_PORT_RANGES = Object.freeze([[1, 1023], [2190, 2289]]);

const USAGE = `dsh-wiki MCP server ${PACKAGE.version}

Usage:
  node mcp/server.mjs [--transport stdio|http] [--port N] [--repo PATH] [--dsh-home DIR] [--wiki-dir NAME]

Options:
  --transport stdio     Newline-delimited JSON-RPC over stdin/stdout (default); no port, no socket
  --transport http      Streamable HTTP on 127.0.0.1 (opt-in, for clients that only accept a URL)
  --port N              Loopback port for --transport http only (default ${DEFAULT_PORT}); refused below 1024
                        and in 2190-2289, and refused with the default stdio transport instead of ignored
  --repo PATH           Default repository root when a tool call omits "repo" (must be absolute)
  --dsh-home DIR        DSH profile home holding dsh-wiki/registry.json (default $DSH_HOME or ~/.dsh)
  --wiki-dir NAME       Wiki directory inside a repository (default .dsh-wiki)
  --version             Print the adapter version and exit
  --help, -h            Print this help and exit

The server reads <repo>/<wiki-dir>/wiki.json and generation-meta.json only, and never writes, fetches
or uploads anything. The default stdio transport opens no socket; the opt-in http transport binds
127.0.0.1 only, and remote exposure is out of scope (constitution A7).`;

const write = (stream, text) => {
  try {
    stream.write(text);
  } catch {
    /* 管道已断开：客户端先走了，没有可报告的 */
  }
};

const exitWith = (message, code) => {
  write(process.stderr, `dsh-wiki mcp: ${message}\n`);
  process.exit(code);
};

const portAllowed = (port) => Number.isInteger(port) && port >= 1 && port <= 65535
  && !BLOCKED_PORT_RANGES.some(([low, high]) => port >= low && port <= high);

/** 极简 argv 解析：`--key value` 与 `--key=value` 都接受；未知参数是错误，不静默忽略。 */
function parseArgs(argv) {
  const known = new Set(["transport", "port", "repo", "dsh-home", "wiki-dir", "version", "help"]);
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "-h") {
      parsed.help = true;
      continue;
    }
    if (!token.startsWith("--")) exitWith(`unexpected argument: ${token}`, 2);
    const body = token.slice(2);
    const equals = body.indexOf("=");
    const key = equals >= 0 ? body.slice(0, equals) : body;
    if (!known.has(key)) exitWith(`unknown option: --${key}`, 2);
    if (key === "version" || key === "help") {
      parsed[key] = true;
      continue;
    }
    const value = equals >= 0 ? body.slice(equals + 1) : argv[++index];
    if (value === undefined || value.length === 0 || value.startsWith("--")) exitWith(`--${key} needs a value`, 2);
    parsed[key] = value;
  }
  return parsed;
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  write(process.stdout, `${USAGE}\n`);
  process.exit(0);
}
if (options.version) {
  write(process.stdout, `${PACKAGE.version}\n`);
  process.exit(0);
}

const transportName = options.transport ?? "stdio";
if (transportName !== "http" && transportName !== "stdio") exitWith(`--transport must be http or stdio, got "${transportName}"`, 2);

// --port 只在 http 下有意义。默认 stdio 时静默忽略它，会让“注册命令里写了端口、服务端却不开端口”成为
// 一个没人能解释的现象；与端口段围栏同一原则：宁可不启动，也不猜。
if (transportName !== "http" && options.port !== undefined) {
  exitWith(`--port only applies to --transport http; the default stdio transport opens no socket (got --port ${options.port})`, 2);
}

let port = DEFAULT_PORT;
if (transportName === "http") {
  const rawPort = options.port === undefined ? String(DEFAULT_PORT) : options.port;
  port = Number(rawPort);
  if (!/^[0-9]+$/.test(rawPort) || !Number.isInteger(port)) exitWith(`--port must be an integer, got "${rawPort}"`, 2);
  if (!portAllowed(port)) {
    exitWith(`--port ${port} is outside the allowed range (refused: below 1024, and 2190-2289); pick another loopback port`, 2);
  }
}

if (options.repo !== undefined && !path.isAbsolute(options.repo)) exitWith(`--repo must be an absolute path, got "${options.repo}"`, 2);
const wikiDirName = options["wiki-dir"] ?? ".dsh-wiki";
if (!wikiDirName.startsWith(".")) exitWith(`--wiki-dir must start with ".", got "${wikiDirName}"`, 2);

const logWarn = (message) => write(process.stderr, `[dsh-wiki] ${message}\n`);

const deps = createWikiContext({
  dshHome: options["dsh-home"] ?? defaultDshHome(),
  wikiDirName,
  logWarn,
});
const server = createMcpServer({ deps, version: PACKAGE.version, defaultRepo: options.repo ?? null });

if (transportName === "stdio") {
  const stdio = attachStdio(server);
  // stdin 的 EOF 只说明“不会再有请求”。已经排队的响应必须写完再退出：写进管道缓冲后立刻
  // process.exit 会把它们一起丢掉（客户端连写几条就关 stdin 是最常见的收尾方式）。
  // close() 等到队列排空、并等到 stdout 收下这些字节，之后退出才是安全的。
  let finishing = false;
  const finish = async () => {
    if (finishing) return;
    finishing = true;
    await stdio.close();
    process.exit(0);
  };
  process.stdin.on("end", () => { void finish(); });
  process.stdin.on("close", () => { void finish(); });
} else {
  const transport = createHttpTransport({ server, path: "/mcp", logWarn });
  let address;
  try {
    address = await transport.listen(port);
  } catch (error) {
    exitWith(`could not listen on 127.0.0.1:${port} (${String(error?.code ?? error?.message ?? error)})`, 1);
  }
  // stdout 恰好一行：测试与 shell 包装按它判断“已就绪”。
  write(process.stdout, `dsh-wiki mcp: listening on http://127.0.0.1:${address.port}/mcp\n`);
  if (options.repo) logWarn(`default repo: ${options.repo}`);

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    logWarn(`shutting down (${signal})`);
    await transport.close();
    process.exit(0);
  };
  process.on("SIGINT", () => { void shutdown("SIGINT"); });
  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
}

// 任何未捕获的异常都不能带着半开的端口继续跑：报告一行、退出非零。
process.on("unhandledRejection", (reason) => {
  logWarn(`unhandled rejection: ${String(reason?.message ?? reason)}`);
  process.exit(1);
});
