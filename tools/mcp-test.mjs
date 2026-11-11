#!/usr/bin/env node
// dsh-wiki — MCP 适配层测试（spec 015）。
//
// 用例分层，全部**真的**驱动传输，不 mock JSON-RPC：
//   1) HTTP：把 createHttpTransport 起在 127.0.0.1 的真实端口上，按实测的客户端顺序发请求
//      （server/discover → initialize → notifications/initialized → GET SSE → tools/list → tools/call）；
//   2) stdio：把 attachStdio 接在一对 PassThrough 上，写换行分帧、读响应行 —— 与真实管道走同一段代码；
//   2b) EOF 排空：连写几条 → 关 stdin → 每条都必须有响应（一个不可能自动通过的输出流钉住它）；
//   3) CLI 辅助（spawn 探测、文件接住输出）；3a) CLI 端到端（spawn 门控）；3b) CLI 默认传输与参数围栏；
//   4) 仓库解析的信任语义：空登记表 / 歧义 / --repo / 不可解析路径的文案 / 链接被接受；
//   5) 受控读的容量闸：超上限、非普通文件、正好卡在上限；
//   6) 有界时限：永不返回的调用在 HTTP 与 stdio 上都必须拿到 -32603，且串行队列继续应答。
//
// 为什么 CLI 端到端要门控：DSH 沙箱禁止带管道的子进程（`spawn` 直接 EPERM，见 spec 014 spec.md:158 记的同一
// 失败类）。被限制时不假装通过，而是 SKIP 并把“必须在普通终端跑一次”写在输出里。默认传输与参数围栏那一层用
// 文件描述符而不是管道接输出，所以沙箱里照样真跑 —— 默认传输这件事不能只靠一行 SKIP 交代。
// 所有夹具都在系统临时目录里现建现删；仓库自己的 .dsh-wiki 不参与（另一位同事正在改它）。
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { WIKI_TOOL_NAMES } from "../lib/wiki-tools.js";
import { MAX_SSE_STREAMS, createHttpTransport } from "../mcp/http-transport.mjs";
import { createMcpServer } from "../mcp/protocol.mjs";
import { attachStdio } from "../mcp/stdio-transport.mjs";
import { createWikiContext } from "../mcp/wiki-context.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SERVER = path.join(ROOT, "mcp", "server.mjs");
const PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

let PASSED = 0;
const SKIPPED = [];
const FAILS = [];
const check = (name, ok, detail) => {
  if (ok) PASSED += 1;
  else FAILS.push(name);
  console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : `  [${detail}]`));
};
const skip = (name, reason) => {
  SKIPPED.push(name);
  console.log(`SKIP ${name}  [${reason}]`);
};
const logWarn = () => {};

// ---------- 夹具 ----------
const TEMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wiki-mcp-")));
const cleanupTemps = () => {
  try { fs.rmSync(TEMP, { recursive: true, force: true }); } catch { /* 锁住的目录不影响结果 */ }
};

const HUB_CHILDREN = Array.from({ length: 25 }, (_, index) => ({
  id: `hub-${String(index + 1).padStart(2, "0")}`,
  title: `Hub child ${index + 1}`,
  parentId: "hub",
  filePaths: [`src/hub/${index + 1}.js`],
  markdown: `Child ${index + 1}.`,
}));

const PAGES = [
  {
    id: "overview",
    title: "Overview",
    description: "Entry point for the fixture repository.",
    parentId: null,
    filePaths: ["src/app.js"],
    markdown: "The app starts in `src/app.js:12` and registers `src/auth/login.js:3`.",
  },
  {
    id: "auth",
    title: "Auth module",
    description: "Token handling.",
    parentId: "overview",
    filePaths: ["src/auth/login.js"],
    markdown: "Tokens are never logged (`src/auth/login.js:40`).",
  },
  {
    id: "big",
    title: "Big page",
    description: "Deliberately larger than the 16 KiB markdown cap.",
    parentId: "overview",
    filePaths: ["src/big.js"],
    markdown: `# Big\n\n${"x".repeat(20000)}`,
  },
  {
    id: "hub",
    title: "Hub",
    description: "A parent with more children than the 20-id navigation cap.",
    parentId: null,
    filePaths: ["src/hub.js"],
    markdown: "Hub page.",
  },
  ...HUB_CHILDREN,
];

const CARDS = [
  {
    id: "card-auth",
    title: "Auth invariant",
    kind: "module",
    summary: "Tokens are never logged.",
    keyFiles: ["src/auth/login.js"],
    tags: ["auth", "security"],
    pageIds: ["auth"],
  },
  {
    id: "card-search",
    title: "Search scoring",
    kind: "concept",
    summary: "Ranking is deterministic.",
    keyFiles: ["src/search.js"],
    tags: ["search"],
    pageIds: ["overview"],
  },
];

const PAGE_COUNT = PAGES.length;
const CARD_COUNT = CARDS.length;

function makeRepo(name) {
  const root = path.join(TEMP, name);
  const wikiDir = path.join(root, ".dsh-wiki");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(wikiDir, { recursive: true });
  fs.writeFileSync(path.join(wikiDir, "wiki.json"), JSON.stringify({
    schema: "repo-wiki-local/1",
    repoId: name,
    title: `Fixture ${name}`,
    language: "en",
    pages: PAGES,
    cards: CARDS,
  }, null, 2), "utf8");
  // sourceCommit 只在 generation-meta.json 里（wiki.json 没有这个键）；夹具故意不写它 =>
  // 新鲜度必须是 "unknown"，不是 false。
  return fs.realpathSync(root);
}

function makeHome(name, roots) {
  const home = path.join(TEMP, name);
  fs.mkdirSync(path.join(home, "dsh-wiki"), { recursive: true });
  fs.writeFileSync(path.join(home, "dsh-wiki", "registry.json"), JSON.stringify({
    version: 1,
    roots: roots.map((root) => ({ path: root, lastSeen: 1 })),
  }, null, 2), "utf8");
  return home;
}

const repoA = makeRepo("repo-a");
const repoB = makeRepo("repo-b");
const noWikiDir = fs.realpathSync(fs.mkdtempSync(path.join(TEMP, "no-wiki-")));
const homeSingle = makeHome("home-single", [repoA]);
const homeAmbiguous = makeHome("home-ambiguous", [repoA, repoB]);
const homeDry = makeHome("home-dry", []);

// ---------- 进程/传输工具 ----------
const CHILDREN = new Set();
const killAll = () => {
  for (const child of CHILDREN) {
    try { child.kill(); } catch { /* 已经退出 */ }
  }
  CHILDREN.clear();
};

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => {
        const blocked = port <= 1023 || (port >= 2190 && port <= 2289);
        if (blocked) resolve(freePort());
        else resolve(port);
      });
    });
  });
}

/** 进程内建一个协议服务器（与 CLI 用的是同一组构造函数，只是不经过 spawn）。 */
function buildServer({ home, repo = null }) {
  const deps = createWikiContext({ dshHome: home, wikiDirName: ".dsh-wiki", logWarn });
  return createMcpServer({ deps, version: PACKAGE.version, defaultRepo: repo });
}

async function startInProcessHttp(options) {
  const server = buildServer(options);
  const transport = createHttpTransport({ server, path: "/mcp", logWarn });
  const address = await transport.listen(await freePort());
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    boundTo: address.address,
    server,
    close: () => transport.close(),
  };
}

function request(url, { method = "POST", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body));
    const req = http.request(url, {
      method,
      headers: {
        ...(payload === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }),
        accept: "application/json, text/event-stream",
        ...headers,
      },
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => {
        let json = null;
        try { json = text.trim().length > 0 ? JSON.parse(text) : null; } catch { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("request timeout")));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

let idSeed = 0;
const rpc = (url, method, params) => request(url, {
  body: { jsonrpc: "2.0", id: ++idSeed, method, ...(params === undefined ? {} : { params }) },
});

/** 打开 GET /mcp 的 SSE 通道，拿到第一块数据就收手。 */
function openSse(url) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: "GET", headers: { accept: "text/event-stream" } });
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error("SSE stream gave no data")), 5000);
    req.on("response", (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        text += chunk;
        finish(resolve, { status: res.statusCode, headers: res.headers, text, close: () => { res.destroy(); req.destroy(); } });
      });
      res.on("end", () => finish(resolve, { status: res.statusCode, headers: res.headers, text, close: () => req.destroy() }));
    });
    req.on("error", (error) => finish(reject, error));
    req.end();
  });
}

/** 行分帧的读端：可复用于 PassThrough 与真实管道。 */
function lineSource(stream) {
  const lines = [];
  const waiters = [];
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length > 0) {
        const waiter = waiters.shift();
        if (waiter) waiter(line);
        else lines.push(line);
      }
      index = buffer.indexOf("\n");
    }
  });
  return () => {
    if (lines.length > 0) return Promise.resolve(lines.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no response line within 15s")), 15000);
      waiters.push((line) => { clearTimeout(timer); resolve(line); });
    });
  };
}

/** 进程内 stdio：attachStdio 接在一对 PassThrough 上（同一段分帧代码，只是不经过 OS 管道）。 */
function startInProcessStdio() {
  const server = buildServer({ home: homeSingle });
  const input = new PassThrough();
  const output = new PassThrough();
  const stdio = attachStdio(server, { input, output });
  const next = lineSource(output);
  return {
    send: (message) => input.write(`${typeof message === "string" ? message : JSON.stringify(message)}\n`),
    next,
    end: async () => {
      input.end();
      await stdio.close();
      return {
        name: "closing the request stream settles the reader without error",
        ok: true,
        // 真实退出码只能在子进程层观测（见 spawn 层），这里不伪造 0。
        detail: "in-process: exit code is not observable",
      };
    },
  };
}

async function startSpawnedHttp(args) {
  const child = spawn(process.execPath, [SERVER, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  CHILDREN.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ready line; stderr=${stderr.slice(0, 400)}`)), 15000);
    child.stdout.on("data", () => {
      const match = /listening on (http:\/\/127\.0\.0\.1:(\d+)\/mcp)/.exec(stdout);
      if (match) {
        clearTimeout(timer);
        resolve({ url: match[1], port: Number(match[2]) });
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (code ${code}); stderr=${stderr.slice(0, 400)}`));
    });
  });
  const info = await ready;
  return {
    ...info,
    stderr: () => stderr,
    stdout: () => stdout,
    stop: () => new Promise((resolve) => {
      if (child.exitCode !== null) { resolve(); return; }
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* 已退出 */ } }, 4000).unref?.();
    }),
  };
}

/** 子进程 OS 管道版 stdio（只在能 spawn 的环境跑）。 */
function startSpawnedStdio(args) {
  const child = spawn(process.execPath, [SERVER, ...args], { stdio: ["pipe", "pipe", "pipe"] });
  CHILDREN.add(child);
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const next = lineSource(child.stdout);
  return {
    child,
    send: (message) => child.stdin.write(`${typeof message === "string" ? message : JSON.stringify(message)}\n`),
    next,
    end: () => new Promise((resolve) => {
      child.once("exit", (code) => resolve({ name: "closing stdin ends the process with exit code 0", ok: code === 0, detail: String(code) }));
      child.stdin.end();
      setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } }, 4000).unref?.();
    }),
    stderr: () => stderr,
  };
}

const textOf = (response) => (response.json?.result?.content ?? []).map((block) => block.text ?? "").join("\n");
// 直接打协议层（不经过 HTTP）时的同一步：响应没有被包在 .json 里。
const resultTextOf = (response) => (response?.result?.content ?? []).map((block) => block.text ?? "").join("\n");
const callTool = (url, name, args) => rpc(url, "tools/call", { name, arguments: args ?? {} });

// ---------- 层 1：HTTP 用例（进程内与 CLI 子进程共用同一份断言） ----------
async function httpCases(url) {
  const discover = await rpc(url, "server/discover", {});
  check("http: server/discover answers before initialize (Claude Code 2.1.286 sends it first)",
    discover.status === 200
    && discover.json?.result?.serverInfo?.name === "dsh-wiki"
    && typeof discover.json.result.protocolVersion === "string"
    && discover.json.result.capabilities?.tools !== undefined,
    JSON.stringify(discover.json).slice(0, 300));

  const init = await rpc(url, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "claude-code", version: "2.1.286" },
  });
  check("http: initialize echoes the supported protocol version and reports the adapter version",
    init.json?.result?.protocolVersion === "2025-06-18"
    && init.json.result.serverInfo.version === PACKAGE.version
    && typeof init.json.result.instructions === "string" && init.json.result.instructions.length > 0,
    JSON.stringify(init.json).slice(0, 300));

  const legacy = await rpc(url, "initialize", { protocolVersion: "1999-01-01", capabilities: {}, clientInfo: { name: "x", version: "0" } });
  check("http: an unknown protocol version falls back to the newest supported one",
    legacy.json?.result?.protocolVersion === "2025-06-18",
    JSON.stringify(legacy.json).slice(0, 200));

  const notified = await request(url, { body: { jsonrpc: "2.0", method: "notifications/initialized" } });
  check("http: notifications/initialized is accepted with 202 and an empty body",
    notified.status === 202 && notified.text === "",
    `${notified.status} body=${JSON.stringify(notified.text)}`);

  const sse = await openSse(url);
  check("http: GET /mcp opens an SSE stream (text/event-stream + keep-alive comment)",
    sse.status === 200
    && String(sse.headers["content-type"] ?? "").includes("text/event-stream")
    && sse.text.includes(": dsh-wiki mcp stream open"),
    `${sse.status} ${String(sse.headers["content-type"])} ${JSON.stringify(sse.text.slice(0, 120))}`);
  sse.close();

  const listed = await rpc(url, "tools/list", {});
  const tools = listed.json?.result?.tools ?? [];
  const names = tools.map((tool) => tool.name);
  const shapesOk = tools.every((tool) => tool.inputSchema?.type === "object"
    && typeof tool.description === "string" && tool.description.length > 40
    && (tool.inputSchema.required === undefined || Array.isArray(tool.inputSchema.required)));
  check("http: tools/list returns the five wiki tools in contract order with object inputSchema",
    JSON.stringify(names) === JSON.stringify([...WIKI_TOOL_NAMES]) && shapesOk,
    JSON.stringify(names));

  const noPerPropertyRequired = tools.every((tool) => Object.values(tool.inputSchema.properties ?? {})
    .every((property) => property?.required === undefined));
  check("http: no inputSchema property carries a per-property required key", noPerPropertyRequired,
    JSON.stringify(tools.map((tool) => tool.name)));

  const status = await callTool(url, "wiki_status", {});
  const statusText = textOf(status);
  check("http: wiki_status resolves the single registered wiki and reports counts + unknown freshness",
    status.json?.result?.isError === false
    && statusText.includes(`pages: ${PAGE_COUNT} · cards: ${CARD_COUNT}`)
    && statusText.includes("freshness: stale=unknown")
    && statusText.includes(`repo: ${repoA}`),
    statusText.slice(0, 400));

  const searched = await callTool(url, "wiki_search", { query: "auth", limit: 10 });
  const searchText = textOf(searched);
  check("http: wiki_search ranks pages and cards and carries path:line citations",
    searched.json?.result?.isError === false
    && searchText.includes("card-auth")
    && searchText.includes("cites:")
    && /hits=\d+/.test(searchText),
    searchText.slice(0, 400));

  const again = await callTool(url, "wiki_search", { query: "auth", limit: 10 });
  check("http: two identical wiki_search calls render byte-identical text", textOf(again) === searchText, "outputs differ");

  const hub = await callTool(url, "wiki_page", { id: "hub" });
  const hubText = textOf(hub);
  check("http: wiki_page caps the children list and reports the full total",
    hub.json?.result?.isError === false
    && hubText.includes("(+5 more, 25 total)")
    && hubText.includes("children: hub-01"),
    hubText.slice(0, 400));

  const big = await callTool(url, "wiki_page", { id: "big" });
  check("http: wiki_page caps markdown at 16 KiB and says so",
    big.json?.result?.isError === false && textOf(big).includes("truncated: markdown is capped at 16 KiB"),
    textOf(big).slice(0, 300));

  const cards = await callTool(url, "wiki_cards", { tags: ["auth"] });
  const cardsText = textOf(cards);
  check("http: wiki_cards filters by tag and includes key files when filtered",
    cards.json?.result?.isError === false
    && cardsText.includes("rows=1/1 (filtered)")
    && cardsText.includes("key files: src/auth/login.js"),
    cardsText.slice(0, 300));

  const impact = await callTool(url, "wiki_impact", { files: ["src/auth/login.js:12", "nothere.js"] });
  const impactText = textOf(impact);
  check("http: wiki_impact maps a plain path plus a :line path and lists the unmapped one",
    impact.json?.result?.isError === false
    && impactText.includes("pages: auth")
    && impactText.includes("cards: card-auth")
    && impactText.includes("unmapped: nothere.js"),
    impactText.slice(0, 400));

  const missingPage = await callTool(url, "wiki_page", { id: "no-such-page" });
  check("http: a typed refusal is a normal result with isError true (not a JSON-RPC error)",
    missingPage.json?.error === undefined
    && missingPage.json?.result?.isError === true
    && textOf(missingPage).includes("refused (page-not-found)"),
    JSON.stringify(missingPage.json).slice(0, 300));

  const unknownTool = await callTool(url, "wiki_nope", {});
  check("http: an unknown tool is a JSON-RPC -32602 error",
    unknownTool.json?.error?.code === -32602 && /unknown tool/.test(unknownTool.json.error.message),
    JSON.stringify(unknownTool.json).slice(0, 200));

  const unknownMethod = await rpc(url, "resources/list", {});
  check("http: an unadvertised method is a JSON-RPC -32601 error",
    unknownMethod.json?.error?.code === -32601, JSON.stringify(unknownMethod.json).slice(0, 200));

  // 带 id 的通知必须拿到回应，否则客户端会等一个永远不来的包。
  const notificationWithId = await rpc(url, "notifications/initialized", {});
  check("http: a notifications/* message carrying an id is answered with -32600, never left hanging",
    notificationWithId.status === 200 && notificationWithId.json?.error?.code === -32600,
    `${notificationWithId.status} ${JSON.stringify(notificationWithId.json).slice(0, 200)}`);

  const batch = await request(url, { body: [{ jsonrpc: "2.0", id: 1, method: "ping" }] });
  check("http: a batch array is refused with -32600 instead of being half-processed",
    batch.json?.error?.code === -32600, JSON.stringify(batch.json).slice(0, 200));

  const broken = await request(url, { body: "{not json" });
  check("http: a malformed body is HTTP 400 with -32700",
    broken.status === 400 && broken.json?.error?.code === -32700,
    `${broken.status} ${JSON.stringify(broken.json).slice(0, 160)}`);

  const empty = await request(url, { body: "" });
  check("http: an empty body is HTTP 400 with -32700",
    empty.status === 400 && empty.json?.error?.code === -32700, `${empty.status} ${JSON.stringify(empty.json).slice(0, 160)}`);

  const wrongType = await request(url, { headers: { "content-type": "text/plain" }, body: "ping" });
  check("http: a non-JSON Content-Type is HTTP 415",
    wrongType.status === 415, `${wrongType.status} ${JSON.stringify(wrongType.json).slice(0, 160)}`);

  const wrongPath = await request(url.replace("/mcp", "/nope"), { body: { jsonrpc: "2.0", id: 9, method: "ping" } });
  check("http: any path other than /mcp is 404", wrongPath.status === 404, String(wrongPath.status));

  const getNoSse = await request(url, { method: "GET", headers: { accept: "application/json" } });
  check("http: GET without Accept: text/event-stream is 405 with Allow: POST",
    getNoSse.status === 405 && String(getNoSse.headers.allow ?? "").includes("POST"),
    `${getNoSse.status} allow=${String(getNoSse.headers.allow)}`);

  const del = await request(url, { method: "DELETE" });
  check("http: DELETE is 405 (stateless server keeps no sessions)",
    del.status === 405 && String(del.headers.allow ?? "").includes("POST"), String(del.status));

  const evilOrigin = await request(url, {
    headers: { origin: "http://evil.example" },
    body: { jsonrpc: "2.0", id: 10, method: "ping" },
  });
  check("http: a non-loopback Origin is refused with 403 (DNS-rebinding guard)",
    evilOrigin.status === 403 && evilOrigin.json?.error?.message === "origin not allowed",
    `${evilOrigin.status} ${JSON.stringify(evilOrigin.json).slice(0, 160)}`);

  const localOrigin = await request(url, {
    headers: { origin: "http://localhost:13210" },
    body: { jsonrpc: "2.0", id: 11, method: "ping" },
  });
  check("http: a loopback Origin is still served",
    localOrigin.status === 200 && localOrigin.json?.result !== undefined,
    `${localOrigin.status} ${JSON.stringify(localOrigin.json).slice(0, 160)}`);

  const sseOnly = await request(url, {
    headers: { accept: "text/event-stream" },
    body: { jsonrpc: "2.0", id: 12, method: "ping" },
  });
  check("http: Accept: text/event-stream alone gets the response framed as one SSE message",
    sseOnly.status === 200
    && String(sseOnly.headers["content-type"] ?? "").includes("text/event-stream")
    && sseOnly.text.startsWith("event: message\ndata: ")
    && JSON.parse(sseOnly.text.split("data: ")[1]).result !== undefined,
    `${sseOnly.status} ${JSON.stringify(sseOnly.text.slice(0, 160))}`);

  const refusedRepo = await callTool(url, "wiki_status", { repo: noWikiDir });
  check("http: an explicit repo without a wiki is refused with repo-unknown and isError true",
    refusedRepo.json?.result?.isError === true && textOf(refusedRepo).includes("refused (repo-unknown)"),
    textOf(refusedRepo).slice(0, 240));

  const relativeRepo = await callTool(url, "wiki_status", { repo: "..\\relative" });
  check("http: a relative repo is refused with repo-invalid",
    relativeRepo.json?.result?.isError === true && textOf(relativeRepo).includes("refused (repo-invalid)"),
    textOf(relativeRepo).slice(0, 240));

  // --- Fence: Host 头（DNS rebinding 的另一半；Origin 管不到它） ---
  const rebindingHost = await request(url, {
    headers: { host: "evil.example" },
    body: { jsonrpc: "2.0", id: 13, method: "ping" },
  });
  check("http: a non-loopback Host header is refused with 403 (DNS-rebinding guard)",
    rebindingHost.status === 403 && rebindingHost.json?.error?.message === "host not allowed",
    `${rebindingHost.status} ${JSON.stringify(rebindingHost.json).slice(0, 160)}`);

  const loopbackHost = await request(url, {
    headers: { host: `localhost:${new URL(url).port}` },
    body: { jsonrpc: "2.0", id: 14, method: "ping" },
  });
  check("http: a loopback Host header by name (localhost:port) is still served",
    loopbackHost.status === 200 && loopbackHost.json?.result !== undefined,
    `${loopbackHost.status} ${JSON.stringify(loopbackHost.json).slice(0, 160)}`);

  // --- Params/id 形状：错类型要 -32602 / -32600，不能被悄悄改成默认值 ---
  const stringArgs = await rpc(url, "tools/call", { name: "wiki_status", arguments: "repo=C:\\somewhere" });
  check("http: non-object arguments are refused with -32602 instead of being treated as {}",
    stringArgs.json?.error?.code === -32602 && /arguments must be an object/.test(stringArgs.json.error.message),
    JSON.stringify(stringArgs.json).slice(0, 240));

  const arrayArgs = await rpc(url, "tools/call", { name: "wiki_status", arguments: ["src/a.js"] });
  check("http: an array arguments is refused with -32602 as well",
    arrayArgs.json?.error?.code === -32602, JSON.stringify(arrayArgs.json).slice(0, 200));

  const objectId = await request(url, { body: { jsonrpc: "2.0", id: { nested: 1 }, method: "ping" } });
  check("http: an id that is not a string or number is -32600 with a null id (never echoed back)",
    objectId.json?.error?.code === -32600 && objectId.json?.id === null,
    JSON.stringify(objectId.json).slice(0, 200));

  const zeroId = await request(url, { body: { jsonrpc: "2.0", id: 0, method: "ping" } });
  check("http: id 0 is echoed as 0 (a falsy id is still an id)",
    zeroId.json?.id === 0 && zeroId.json?.result !== undefined, JSON.stringify(zeroId.json).slice(0, 160));

  // --- SSE 通道有上限：无上限等于把本机 fd 交给任何能连回环端口的进程 ---
  const heldStreams = [];
  for (let index = 0; index < MAX_SSE_STREAMS; index += 1) heldStreams.push(await openSse(url));
  const overflowStream = await openSse(url);
  const allOpened = heldStreams.every((stream) => stream.status === 200);
  check(`http: the SSE channel is capped (${MAX_SSE_STREAMS} open; the next is 429, not another fd)`,
    allOpened && overflowStream.status === 429 && overflowStream.text.includes("too many open SSE streams"),
    `open=${heldStreams.filter((stream) => stream.status === 200).length} overflow=${overflowStream.status} ${JSON.stringify(overflowStream.text.slice(0, 160))}`);
  for (const stream of [...heldStreams, overflowStream]) stream.close();
}

// ---------- 层 2：stdio 用例（PassThrough 与 OS 管道共用） ----------
async function stdioCases(io, label) {
  io.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pipe", version: "0" } } });
  const init = JSON.parse(await io.next());
  check(`${label}: initialize returns the handshake`,
    init.result?.serverInfo?.name === "dsh-wiki" && init.result.protocolVersion === "2025-06-18",
    JSON.stringify(init).slice(0, 240));

  // 通知不写任何行：下一条读到的必须是 tools/list 的响应，否则顺序就错了。
  io.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  io.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const listed = JSON.parse(await io.next());
  check(`${label}: a notification writes nothing and the next response is the following request`,
    listed.id === 2
    && JSON.stringify((listed.result?.tools ?? []).map((tool) => tool.name)) === JSON.stringify([...WIKI_TOOL_NAMES]),
    JSON.stringify(listed).slice(0, 240));

  io.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "wiki_status", arguments: {} } });
  const status = JSON.parse(await io.next());
  const statusText = (status.result?.content ?? []).map((block) => block.text ?? "").join("\n");
  check(`${label}: tools/call renders the same wiki_status as the http transport`,
    status.result?.isError === false && statusText.includes(`pages: ${PAGE_COUNT} · cards: ${CARD_COUNT}`),
    statusText.slice(0, 240));

  io.send("this is not json");
  const parseError = JSON.parse(await io.next());
  check(`${label}: a non-JSON line is answered with -32700`, parseError.error?.code === -32700,
    JSON.stringify(parseError).slice(0, 200));

  io.send({ jsonrpc: "2.0", id: 4, method: "ping" });
  const ping = JSON.parse(await io.next());
  check(`${label}: the server still answers after a parse error`, ping.id === 4 && ping.result !== undefined,
    JSON.stringify(ping).slice(0, 200));

  // 客户端连写几条就关 stdin（一次性脚本、探测命令的常见收尾）。EOF 只说明“不会再有请求”，
  // 已经写进去的每一条都必须拿到响应 —— 旧代码在 EOF 时把排队中的响应直接丢掉。
  const burstIds = [101, 102, 103];
  for (const id of burstIds) io.send({ jsonrpc: "2.0", id, method: "ping" });
  const ending = io.end();
  const answeredIds = [];
  for (let index = 0; index < burstIds.length; index += 1) answeredIds.push(JSON.parse(await io.next()).id);
  const outcome = await ending;
  check(`${label}: ${outcome.name}`,
    outcome.ok && JSON.stringify(answeredIds) === JSON.stringify(burstIds),
    `${outcome.detail} answered=${JSON.stringify(answeredIds)}`);
}

// ---------- 层 3：CLI 端到端（spawn 门控） ----------
function spawnSupported() {
  if (process.env.DSH_WIKI_MCP_TEST_INPROCESS === "1") return false;
  try {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: ["ignore", "pipe", "pipe"] });
    child.on("error", () => {});
    child.kill();
    return true;
  } catch (error) {
    return error?.code !== "EPERM";
  }
}

/** 用普通文件（不是管道）接住子进程的 stdout/stderr：沙箱禁的是管道，文件描述符照常可用，
 *  所以“默认传输是哪一种”和参数围栏在沙箱里也能真跑，而不是只能留一行 SKIP。 */
let captureSeed = 0;
function runCliCaptured(args, { timeoutMs = 15000 } = {}) {
  const stamp = `${process.pid}-${Date.now()}-${++captureSeed}`;
  const outPath = path.join(TEMP, `cli-${stamp}.out.txt`);
  const errPath = path.join(TEMP, `cli-${stamp}.err.txt`);
  const outFd = fs.openSync(outPath, "w");
  const errFd = fs.openSync(errPath, "w");
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [SERVER, ...args], { stdio: ["ignore", outFd, errFd] });
    } catch (error) {
      fs.closeSync(outFd);
      fs.closeSync(errFd);
      resolve({ code: null, timedOut: false, spawnFailed: true, stdout: "", stderr: String(error?.message ?? error) });
      return;
    }
    CHILDREN.add(child);
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { fs.closeSync(outFd); } catch { /* 已关闭 */ }
      try { fs.closeSync(errFd); } catch { /* 已关闭 */ }
      let stdout = "";
      let stderr = "";
      try { stdout = fs.readFileSync(outPath, "utf8"); } catch { /* 没有输出 */ }
      try { stderr = fs.readFileSync(errPath, "utf8"); } catch { /* 没有输出 */ }
      resolve({ timedOut: false, spawnFailed: false, ...value, stdout, stderr });
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已退出 */ }
      finish({ code: null, timedOut: true });
    }, timeoutMs);
    child.once("error", (error) => finish({ code: null, spawnFailed: true, error: String(error?.message ?? error) }));
    child.once("exit", (code) => finish({ code }));
  });
}

/** 起一个 `--transport http` 的 CLI 子进程，输出接普通文件（不用管道），等就绪行。
 *  http 是显式选入的路径，改了默认值以后必须继续证明它仍然能起来并应答。 */
async function startCapturedHttp(args, { timeoutMs = 15000 } = {}) {
  const stamp = `${process.pid}-${Date.now()}-${++captureSeed}`;
  const outPath = path.join(TEMP, `http-${stamp}.out.txt`);
  const errPath = path.join(TEMP, `http-${stamp}.err.txt`);
  const outFd = fs.openSync(outPath, "w");
  const errFd = fs.openSync(errPath, "w");
  const child = spawn(process.execPath, [SERVER, ...args], { stdio: ["ignore", outFd, errFd] });
  CHILDREN.add(child);
  const read = (file) => {
    try { return fs.readFileSync(file, "utf8"); } catch { return ""; }
  };
  let ready = null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = /listening on (http:\/\/127\.0\.0\.1:(\d+)\/mcp)/.exec(read(outPath));
    if (found) { ready = { url: found[1], port: Number(found[2]) }; break; }
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const stop = () => new Promise((resolve) => {
    const done = () => {
      try { fs.closeSync(outFd); } catch { /* 已关闭 */ }
      try { fs.closeSync(errFd); } catch { /* 已关闭 */ }
      resolve();
    };
    if (child.exitCode !== null) { done(); return; }
    child.once("exit", done);
    try { child.kill("SIGTERM"); } catch { /* 已退出 */ }
    setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } }, 4000).unref?.();
  });
  if (!ready) await stop();
  return { ready, stdout: () => read(outPath), stderr: () => read(errPath), stop };
}

// ---------- 层 3b：CLI 默认传输与参数围栏（不需要管道，沙箱里也跑） ----------
async function cliDefaultCases() {
  // 裸调用 = stdio：stdin 是 EOF（ignore），进程随即以 0 退出，stdout 上没有 http 就绪行。
  const bare = await runCliCaptured([], { timeoutMs: 20000 });
  check("cli: a bare invocation defaults to stdio and exits 0 at stdin EOF (no socket, no ready line)",
    bare.code === 0 && bare.stdout === "",
    `code=${bare.code} timedOut=${bare.timedOut} stdout=${JSON.stringify(bare.stdout)} stderr=${JSON.stringify(bare.stderr.slice(0, 200))}`);

  const portOnly = await runCliCaptured(["--port", "7919"]);
  check("cli: --port without --transport http is refused, not silently ignored",
    portOnly.code === 2 && portOnly.stderr.includes("--transport http"),
    `${portOnly.code} ${JSON.stringify(portOnly.stderr.slice(0, 200))}`);

  const stdioPort = await runCliCaptured(["--transport", "stdio", "--port", "7919"]);
  check("cli: --transport stdio with --port is refused with the same reason",
    stdioPort.code === 2 && stdioPort.stderr.includes("--transport http"),
    `${stdioPort.code} ${JSON.stringify(stdioPort.stderr.slice(0, 200))}`);

  // 默认改成 stdio 之后，显式选入的 http 路径必须照旧能起来、能应答（否则“默认变了”就成了回归）。
  const httpCli = await startCapturedHttp(["--transport", "http", "--port", String(await freePort()), "--dsh-home", homeSingle]);
  try {
    const init = httpCli.ready
      ? await rpc(httpCli.ready.url, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pipe-free", version: "0" } })
      : null;
    check("cli: --transport http still starts with one ready line and answers initialize over the socket",
      Boolean(httpCli.ready)
      && httpCli.stdout().trim().split("\n").length === 1
      && init?.json?.result?.serverInfo?.name === "dsh-wiki",
      `${JSON.stringify(httpCli.stdout().slice(0, 200))} ${JSON.stringify(init?.json).slice(0, 200)}`);
  } finally {
    await httpCli.stop();
  }

  const blocked = await runCliCaptured(["--transport", "http", "--port", "2200"]);
  check("cli: a port inside the reserved 2190-2289 range is refused instead of silently moved",
    blocked.code === 2 && blocked.stderr.includes("2190-2289"), `${blocked.code} ${blocked.stderr.slice(0, 200)}`);

  const privileged = await runCliCaptured(["--transport", "http", "--port", "80"]);
  check("cli: a privileged port (<1024) is refused",
    privileged.code === 2 && privileged.stderr.includes("below 1024"), `${privileged.code} ${privileged.stderr.slice(0, 200)}`);

  const relative = await runCliCaptured(["--repo", "relative\\path"]);
  check("cli: a relative --repo is refused before the server starts",
    relative.code === 2 && relative.stderr.includes("--repo must be an absolute path"), `${relative.code} ${relative.stderr.slice(0, 200)}`);

  const unknown = await runCliCaptured(["--nope"]);
  check("cli: an unknown option is refused", unknown.code === 2 && unknown.stderr.includes("unknown option"),
    `${unknown.code} ${unknown.stderr.slice(0, 200)}`);

  const version = await runCliCaptured(["--version"]);
  check("cli: --version prints the package version and exits 0",
    version.code === 0 && version.stdout.trim() === PACKAGE.version, `${version.code} ${JSON.stringify(version.stdout)}`);

  const help = await runCliCaptured(["--help"]);
  check("cli: --help documents stdio as the default and --port as http-only",
    help.code === 0
    && help.stdout.includes("--transport stdio")
    && help.stdout.includes("stdin/stdout (default)")
    && help.stdout.includes("--transport http only")
    && !/--transport http\b[^\n]*\(default\)/.test(help.stdout),
    `${help.code} ${JSON.stringify(help.stdout.slice(0, 400))}`);
}

// ---------- 层 3a：CLI 端到端（spawn 门控，需要管道） ----------
async function cliCases() {
  const port = await freePort();
  const server = await startSpawnedHttp(["--transport", "http", "--port", String(port), "--dsh-home", homeSingle]);
  try {
    check("cli: prints exactly one ready line naming the loopback /mcp URL",
      server.stdout().trim().split("\n").length === 1
      && server.stdout().includes(`listening on http://127.0.0.1:${server.port}/mcp`),
      server.stdout());
    await httpCases(server.url);
  } finally {
    await server.stop();
  }

  const stdio = startSpawnedStdio(["--transport", "stdio", "--dsh-home", homeSingle]);
  try {
    await stdioCases({
      send: stdio.send,
      next: stdio.next,
      end: stdio.end,
    }, "stdio(os-pipe)");
  } finally {
    try { stdio.child.kill(); } catch { /* 已退出 */ }
  }
}

// ---------- 解析语义（与传输无关，直接打协议层） ----------
async function resolutionCases() {
  const dry = buildServer({ home: homeDry });
  const dryStatus = await dry.dispatch({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "wiki_status", arguments: {} } });
  const dryText = (dryStatus.result?.content ?? []).map((block) => block.text ?? "").join("\n");
  check("resolve: an empty registry with no --repo is repo-unknown with no guess",
    dryStatus.result?.isError === true && dryText.includes("refused (repo-unknown)"), dryText.slice(0, 240));

  const ambiguous = buildServer({ home: homeAmbiguous });
  const ambiguousStatus = await ambiguous.dispatch({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "wiki_status", arguments: {} } });
  const ambiguousText = (ambiguousStatus.result?.content ?? []).map((block) => block.text ?? "").join("\n");
  check("resolve: two known wikis produce repo-ambiguous listing basenames only",
    ambiguousStatus.result?.isError === true
    && ambiguousText.includes("refused (repo-ambiguous)")
    && ambiguousText.includes("known repos: repo-a, repo-b")
    && !ambiguousText.includes(TEMP),
    ambiguousText.slice(0, 300));

  const pinned = buildServer({ home: homeAmbiguous, repo: repoB });
  const pinnedStatus = await pinned.dispatch({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "wiki_status", arguments: {} } });
  const pinnedText = (pinnedStatus.result?.content ?? []).map((block) => block.text ?? "").join("\n");
  check("resolve: --repo disambiguates and resolves to that exact canonical root",
    pinnedStatus.result?.isError === false && pinnedText.includes(`repo: ${repoB}`), pinnedText.slice(0, 300));
}

// ---------- 层 2b：EOF 排空（M1 的回归钉） ----------
/** 模拟“字节还没被 OS 收下”的 stdout：write 的完成回调延后。
 *  CLI 在 close() 之后立刻 process.exit，拿不到这个保证就会截断响应。 */
function delayedSink(delayMs = 20) {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString("utf8"));
      setTimeout(callback, delayMs);
    },
  });
  stream.text = () => chunks.join("");
  return stream;
}

async function eofFlushCase() {
  const server = buildServer({ home: homeSingle });
  const input = new PassThrough();
  const output = delayedSink();
  const stdio = attachStdio(server, { input, output });
  for (const id of [1, 2, 3]) input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "ping" })}\n`);
  input.end(); // 客户端写完就关 stdin，一条响应都还没读
  await stdio.close();
  const answered = output.text().trim().split("\n").filter(Boolean).map((line) => JSON.parse(line).id);
  check("stdio(in-process): requests already queued at stdin EOF are all on the stream before close() resolves",
    JSON.stringify(answered) === "[1,2,3]", `answered=${JSON.stringify(answered)} closed=1,2,3`);
}

// ---------- 层 4：仓库解析的信任语义（M5） ----------
async function trustCases() {
  const server = buildServer({ home: homeSingle });
  const unresolved = await server.dispatch({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "wiki_status", arguments: { repo: path.join(TEMP, "no-such-repo") } },
  });
  const unresolvedText = resultTextOf(unresolved);
  check("resolve: an unresolvable repo says so, and no longer claims a link is untrusted (links are accepted)",
    unresolved.result?.isError === true
    && unresolvedText.includes("refused (repo-not-trusted)")
    && unresolvedText.includes("could not be resolved")
    && !unresolvedText.includes("not a trusted project root"),
    unresolvedText.slice(0, 300));

  // 链接本身是接受的：realpath 之后它就是同一个根，包含性证明不因为路径是链接而失效。
  const linkPath = path.join(TEMP, "linked-repo");
  let linked = false;
  try {
    fs.symlinkSync(repoA, linkPath, "junction");
    linked = true;
  } catch {
    try { fs.symlinkSync(repoA, linkPath, "dir"); linked = true; } catch { linked = false; }
  }
  const viaLink = linked
    ? await server.dispatch({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "wiki_status", arguments: { repo: linkPath } },
    })
    : null;
  const viaLinkText = viaLink ? resultTextOf(viaLink) : "";
  check("resolve: a directory link to a known root is accepted and resolves to that exact root",
    linked && viaLink?.result?.isError === false && viaLinkText.includes(`repo: ${repoA}`),
    linked ? viaLinkText.slice(0, 300) : "this platform refused to create a directory link");
}

// ---------- 层 5：受控读的容量闸与普通文件判定（M6） ----------
const LARGE_FIXTURE_BYTES = 16 * 1024 * 1024 + 1;

function makeOversizedRepo(name) {
  const root = path.join(TEMP, name);
  const wikiDir = path.join(root, ".dsh-wiki");
  fs.mkdirSync(wikiDir, { recursive: true });
  const head = '{"schema":"repo-wiki-local/1","pages":[],"cards":[],"padding":"';
  const tail = '"}';
  // 全部 ASCII：字节数就是字符数，正好比 16 MiB 硬闸多 1 字节。
  fs.writeFileSync(path.join(wikiDir, "wiki.json"),
    head + " ".repeat(LARGE_FIXTURE_BYTES - head.length - tail.length) + tail, "utf8");
  return fs.realpathSync(root);
}

function makeIrregularRepo(name) {
  const root = path.join(TEMP, name);
  // wiki.json 是目录，不是普通文件：句柄上的 fstat 必须拒绝它。
  fs.mkdirSync(path.join(root, ".dsh-wiki", "wiki.json"), { recursive: true });
  return fs.realpathSync(root);
}

/** 恰好 16 MiB 的**合法** wiki：读句柄的循环若有 off-by-one/短读，JSON 就会被截断成 wiki-invalid。 */
function makeAtCapRepo(name) {
  const root = path.join(TEMP, name);
  const wikiDir = path.join(root, ".dsh-wiki");
  fs.mkdirSync(wikiDir, { recursive: true });
  const head = '{"schema":"repo-wiki-local/1","repoId":"at-cap","title":"At cap","language":"en","pages":[],"cards":[],"padding":"';
  const tail = '"}';
  fs.writeFileSync(path.join(wikiDir, "wiki.json"),
    head + " ".repeat(16 * 1024 * 1024 - head.length - tail.length) + tail, "utf8");
  return fs.realpathSync(root);
}

async function boundsCases() {
  const server = buildServer({ home: homeSingle });
  const oversizedRepo = makeOversizedRepo("repo-oversized");
  const oversized = await server.dispatch({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "wiki_status", arguments: { repo: oversizedRepo } },
  });
  const oversizedText = resultTextOf(oversized);
  check("bounds: a wiki.json one byte over the 16 MiB cap is refused as wiki-unreadable",
    oversized.result?.isError === true && oversizedText.includes("refused (wiki-unreadable)"),
    oversizedText.slice(0, 240));

  const irregularRepo = makeIrregularRepo("repo-irregular");
  // 未知根会先被解析层挡成 repo-unknown（它 lstat 不到普通文件），所以这里把根登记进去，
  // 让请求真的走到受控读：句柄上的 fstat 必须拒绝一个目录。
  const irregularHome = makeHome("home-irregular", [irregularRepo]);
  const irregular = await buildServer({ home: irregularHome }).dispatch({
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "wiki_status", arguments: { repo: irregularRepo } },
  });
  const irregularText = resultTextOf(irregular);
  check("bounds: a wiki.json that is not a regular file is refused as wiki-unreadable",
    irregular.result?.isError === true && irregularText.includes("refused (wiki-unreadable)"),
    irregularText.slice(0, 240));

  // 正好卡在上限的合法文件必须被完整读出：读句柄的循环短读一个字节，JSON 就会解析失败。
  const atCapRepo = makeAtCapRepo("repo-at-cap");
  const atCap = await server.dispatch({
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "wiki_status", arguments: { repo: atCapRepo } },
  });
  const atCapText = resultTextOf(atCap);
  check("bounds: a valid wiki.json at exactly the 16 MiB cap is read in full and parsed",
    atCap.result?.isError === false && atCapText.includes("pages: 0 · cards: 0"),
    atCapText.slice(0, 240));
}

// ---------- 层 6：有界时限（M2） ----------
/** 永不返回的 loadSnapshot：工具调用会一直挂着，正好用来验证“不会永远等一个不来的包”。 */
function neverFinishingServer(requestTimeoutMs) {
  const ctx = createWikiContext({ dshHome: homeSingle, wikiDirName: ".dsh-wiki", logWarn });
  const deps = { ...ctx, loadSnapshot: () => new Promise(() => {}) };
  return createMcpServer({ deps, version: PACKAGE.version, requestTimeoutMs });
}

async function timeoutCases() {
  // 收请求也有上限：只发了半个 body 的连接不能永远占着 socket。检查节拍压到 50 ms，否则要等默认的 30 s。
  const stalledTransport = createHttpTransport({
    server: buildServer({ home: homeSingle }),
    path: "/mcp",
    logWarn,
    requestTimeoutMs: 200,
    connectionsCheckingIntervalMs: 50,
  });
  const stalledAddress = await stalledTransport.listen(await freePort());
  try {
    const started = Date.now();
    const closed = await new Promise((resolve) => {
      const socket = net.connect(stalledAddress.port, "127.0.0.1");
      const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 4000);
      let response = "";
      socket.on("data", (chunk) => { response += chunk; });
      socket.on("connect", () => {
        socket.write(`POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${stalledAddress.port}\r\n`
          + "Content-Type: application/json\r\nContent-Length: 100\r\n\r\n{");
      });
      socket.on("close", () => { clearTimeout(timer); resolve(true); });
      socket.on("error", () => { clearTimeout(timer); resolve(true); });
    });
    const stalledMs = Date.now() - started;
    check("http: a request that never finishes its body is closed by the bounded request timeout",
      closed && stalledMs < 3000,
      `closed=${closed} after=${stalledMs}ms`);
  } finally {
    await stalledTransport.close();
  }

  const transport = createHttpTransport({ server: neverFinishingServer(150), path: "/mcp", logWarn });
  const address = await transport.listen(await freePort());
  try {
    const started = Date.now();
    const timed = await callTool(`http://127.0.0.1:${address.port}/mcp`, "wiki_status", {});
    const elapsed = Date.now() - started;
    check("http: a tool call that never finishes is answered with -32603 at the bounded deadline",
      timed.json?.error?.code === -32603
      && /time limit/.test(timed.json.error.message)
      && elapsed < 5000,
      `${elapsed}ms ${JSON.stringify(timed.json).slice(0, 200)}`);
  } finally {
    await transport.close();
  }

  const input = new PassThrough();
  const output = new PassThrough();
  const stdio = attachStdio(neverFinishingServer(150), { input, output });
  const next = lineSource(output);
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "wiki_status", arguments: {} } })}\n`);
  const timed = JSON.parse(await next());
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })}\n`);
  const afterTimeout = JSON.parse(await next());
  await stdio.close();
  check("stdio(in-process): a hung request times out with -32603 and the serialized queue keeps answering",
    timed.error?.code === -32603 && afterTimeout.id === 2 && afterTimeout.result !== undefined,
    `${JSON.stringify(timed).slice(0, 200)} ${JSON.stringify(afterTimeout).slice(0, 120)}`);
}

async function main() {
  try {
    const local = await startInProcessHttp({ home: homeSingle });
    try {
      check("http: the transport binds 127.0.0.1 only", local.boundTo === "127.0.0.1", String(local.boundTo));
      await httpCases(local.url);
    } finally {
      await local.close();
    }

    await stdioCases(startInProcessStdio(), "stdio(in-process)");
    await eofFlushCase();
    await resolutionCases();
    await trustCases();
    await boundsCases();
    await timeoutCases();
    await cliDefaultCases();

    if (spawnSupported()) {
      await cliCases();
    } else {
      for (const name of [
        "cli: prints exactly one ready line naming the loopback /mcp URL",
        "stdio(os-pipe): initialize returns the handshake",
        "stdio(os-pipe): a notification writes nothing and the next response is the following request",
        "stdio(os-pipe): tools/call renders the same wiki_status as the http transport",
        "stdio(os-pipe): a non-JSON line is answered with -32700",
        "stdio(os-pipe): the server still answers after a parse error",
        "stdio(os-pipe): closing stdin ends the process with exit code 0",
      ]) {
        skip(name, "this sandbox forbids piped child processes (spawn EPERM)");
      }
      // 说明而不是伪造一条 SKIP：这一层的断言本身是前面 http/stdio 用例的**同一份代码**，
      // 区别只在“服务器是 CLI 子进程拉起来的、输出走 OS 管道”。
      console.log("NOTE the CLI-spawned end-to-end tier (real http child + OS-pipe stdio) did not run: this sandbox\n"
        + "     forbids piped child processes (spawn EPERM). The default-transport and flag checks DID run above\n"
        + "     (file-captured stdio, no pipes). Run `node tools/mcp-test.mjs` in a normal terminal for the rest.");
    }
  } catch (error) {
    check("suite: ran to completion", false, `${String(error?.message ?? error)}`);
  } finally {
    killAll();
    cleanupTemps();
  }
  console.log(`\n${PASSED} passed, ${SKIPPED.length} skipped, ${FAILS.length} failed`);
  console.log(FAILS.length ? `${FAILS.length} FAILED` : "ALL PASS");
  process.exit(FAILS.length ? 1 : 0);
}

await main();
