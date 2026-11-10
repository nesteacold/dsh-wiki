// dsh-wiki front-matter **差分** harness —— lib/jobs.js 的 JS 读取器 vs 真 builder 的 Python 读取器。
//
// 为什么这份文件必须存在：增量路径上有**两个**解析器读同一份字节。lib/jobs.js 的 readDeclaredId 回答
// “这一页声明了什么 id”，scripts/build_wiki_site.py 的 assemble 用 _parse_front_matter + _fm_text_fields
// + page.setdefault("id", f.stem) 决定“这一页被建成哪个 id”。两者对同一份字节给出两个答案，检查就等于
// 不存在：JS 说“没有声明 id”（放行，id 由文件名决定），Python 说 id: other（按 other 建页），于是被授权的
// pages/<受影响 id>.md 顶替了真正的 other 页。下面的语料把这个不变量钉住：任何一次单边修改都会红。
//
// 两条硬约束（都是“不许撒谎”的约束）：
//   1. 被测字节必须来自磁盘上的 lib/jobs.js 本身：这里**不复制**读取器，而是从源码里抠出被 ship 的
//      const 声明、在进程内求值。抠不出来 = 立刻大声失败（绝不静默跳过）。
//   2. 参照实现必须是真 Python 读取器：一个子进程 import scripts/build_wiki_site.py，按 assemble 的
//      顺序跑 Path.read_text → _parse_front_matter → _fm_text_fields → setdefault("id", stem)。
//      没有 python = 显式 SKIP + 非零退出（一个跑不起来的差分测试通过 = 谎言）。
//
// 运行时预算：整个语料只开**一个** python 子进程（不是每样本一个），实测几百毫秒。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const here = import.meta.dirname;
const JOBS_PATH = path.join(here, "..", "lib", "jobs.js");
const BUILDER_PATH = path.join(here, "..", "scripts", "build_wiki_site.py");
// 与 tools/jobs-harness-test.mjs 同一个覆盖点：机器上没有 `python` 时用 DSH_WIKI_TEST_PYTHON。
const PYTHON = process.env.DSH_WIKI_TEST_PYTHON || "python";

// 每个 fixture 目录在创建时登记，统一在退出时清掉：中途抛异常或 check 失败也不会留垃圾。
const TEMP_DIRS = [];
const tempDir = (prefix) => {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  TEMP_DIRS.push(dir);
  return dir;
};
const cleanupTempDirs = () => {
  for (const dir of TEMP_DIRS.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
};
process.on("exit", cleanupTempDirs);

let CHECKS = 0;
const FAILS = [];
const check = (name, ok, detail = "") => {
  CHECKS += 1;
  console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : `  [${detail}]`));
  if (!ok) FAILS.push(name);
};

// ---------------------------------------------------------------- 1. 从源码里抠出被 ship 的读取器
//
// 只抠这 7 个顶层 const：空白集合、Python-json 扩展正则、两个 strip 助手、id 行解析器、非 UTF-8 结论、
// 以及调用方真正用到的 readDeclaredId（它内部调用 declaredFrontMatterId）。抠出来的文本原样求值，
// 所以断言的是文件里的字节，不是本文件里的一份副本。
const STATEMENT_ANCHORS = [
  "const PYTHON_WHITESPACE = new Set([",
  "const PY_JSON_EXTENSION_RE = /",
  "const pythonLstrip = (text) => {",
  "const pythonStrip = (text) => {",
  "const DECLARED_ID_NOT_UTF8 = Object.freeze({",
  "const declaredFrontMatterId = (text) => {",
  "const readDeclaredId = (bytes) => {",
];

// 这些 token 之后出现的 `/` 是正则字面量而不是除号（本文件的被抠片段里只有 replace(/\r\n/g …) 这类）。
const REGEX_PRECEDERS = new Set(["", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);

const skipString = (source, start, quote, label) => {
  let index = start + 1;
  while (index < source.length) {
    const ch = source[index];
    if (ch === "\\") { index += 2; continue; }
    if (ch === quote) return index + 1;
    index += 1;
  }
  throw new Error(`${label}: unterminated ${quote} string literal at offset ${start}`);
};

const skipRegex = (source, start, label) => {
  let index = start + 1;
  let inClass = false;
  while (index < source.length) {
    const ch = source[index];
    if (ch === "\\") { index += 2; continue; }
    if (inClass) { if (ch === "]") inClass = false; index += 1; continue; }
    if (ch === "[") { inClass = true; index += 1; continue; }
    if (ch === "/") {
      index += 1;
      while (index < source.length && /[a-z]/i.test(source[index])) index += 1;
      return index;
    }
    index += 1;
  }
  throw new Error(`${label}: unterminated regex literal at offset ${start}`);
};

// 从声明处往后扫到深度 0 的第一个 `;`：跳过行注释/块注释/字符串/正则，括号成对计数。
// 失败即抛（调用方把它变成一次响亮的失败，而不是“什么都没测到但通过”）。
const findStatementEnd = (source, start, label) => {
  let depth = 0;
  let index = start;
  let previous = "";
  while (index < source.length) {
    const ch = source[index];
    const next = source[index + 1];
    if (ch === "/" && next === "/") {
      const newline = source.indexOf("\n", index);
      index = newline < 0 ? source.length : newline + 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      const close = source.indexOf("*/", index + 2);
      if (close < 0) throw new Error(`${label}: unterminated block comment at offset ${index}`);
      index = close + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { index = skipString(source, index, ch, label); previous = ch; continue; }
    if (ch === "/" && REGEX_PRECEDERS.has(previous)) { index = skipRegex(source, index, label); previous = "/"; continue; }
    if (ch === "{" || ch === "(" || ch === "[") { depth += 1; previous = ch; index += 1; continue; }
    if (ch === "}" || ch === ")" || ch === "]") {
      depth -= 1;
      if (depth < 0) throw new Error(`${label}: unbalanced closing ${ch} at offset ${index}`);
      previous = ch;
      index += 1;
      continue;
    }
    if (ch === ";" && depth === 0) return index + 1;
    if (!/\s/.test(ch)) previous = ch;
    index += 1;
  }
  throw new Error(`${label}: no statement terminator found (the declaration shape changed)`);
};

const extractStatements = (source) => {
  const pieces = [];
  for (const anchor of STATEMENT_ANCHORS) {
    const first = source.indexOf(anchor);
    if (first < 0) throw new Error(`missing shipped statement "${anchor}" in lib/jobs.js (renamed or removed?)`);
    if (source.indexOf(anchor, first + 1) >= 0) throw new Error(`shipped statement "${anchor}" is not unique in lib/jobs.js`);
    pieces.push(source.slice(first, findStatementEnd(source, first, anchor)));
  }
  return pieces;
};

const jobsBytes = readFileSync(JOBS_PATH);
const jobsSha256 = createHash("sha256").update(jobsBytes).digest("hex");
const builderSha256 = createHash("sha256").update(readFileSync(BUILDER_PATH)).digest("hex");
const buildShippedReader = () => {
  const pieces = extractStatements(jobsBytes.toString("utf8"));
  const body = `${pieces.join("\n\n")}\nreturn { PYTHON_WHITESPACE, PY_JSON_EXTENSION_RE, pythonLstrip, pythonStrip, declaredFrontMatterId, DECLARED_ID_NOT_UTF8, readDeclaredId };`;
  const reader = new Function(body)();
  for (const name of ["declaredFrontMatterId", "readDeclaredId", "pythonLstrip", "pythonStrip"]) {
    if (typeof reader[name] !== "function") throw new Error(`extracted "${name}" is not a function`);
  }
  if (!(reader.PYTHON_WHITESPACE instanceof Set) || reader.PYTHON_WHITESPACE.size === 0) {
    throw new Error("extracted PYTHON_WHITESPACE is not a non-empty Set");
  }
  if (!(reader.DECLARED_ID_NOT_UTF8 && reader.DECLARED_ID_NOT_UTF8.ok === false)) {
    throw new Error("extracted DECLARED_ID_NOT_UTF8 is not the shipped refusal constant");
  }
  return { reader, pieces };
};

console.log(`# shipped reader: lib/jobs.js ${jobsSha256}`);
console.log(`# reference reader: scripts/build_wiki_site.py ${builderSha256}`);
let extracted = null;
try {
  extracted = buildShippedReader();
} catch (error) {
  // 这里绝不 SKIP：抠不出 ship 的读取器，这套差分就什么都没证明，通过比不测更糟。
  console.log(`FAIL reader-extraction: ${error?.message ?? error}`);
  console.log("FAIL reader-extraction: the suite must evaluate the shipped statements from lib/jobs.js; this run proved nothing.");
  process.exit(1);
}
const { reader, pieces: extractedPieces } = extracted;
console.log(`# extracted ${extractedPieces.length} shipped statements (${extractedPieces.reduce((sum, piece) => sum + piece.length, 0)} bytes evaluated in-process, no copy)`);

// ---------------------------------------------------------------- 2. 语料：58 个形状，名字就是它钉住的东西
//
// 回归说明（这三个形状是**实测**出来的，不是理论推演；review round 4 的最高优先级缺陷）：
//   1. 只处理 `\r\n`：`Path.read_text()` 的 newline=None 把**单字符** `\r` 也当换行，只把 `\r\n` 换成
//      `\n` 的旧 JS 认为 `---\rid: "other"\r---\r` 不以 `---\n` 开头 => “没有声明 id” => 放行；
//      Python 却按 `id: other` 建页 => pages/overview.md 顶替 other 页。
//   2. 只去一个 BOM：Python 的 `.lstrip("\ufeff")` 去掉**任意个**前导 BOM，旧 JS 的 `/^\ufeff/` 只去一个；
//      两个 BOM 就让 JS 认为没有 front-matter，Python 照样读到 id。
//   3. JS `trim()` 与 Python `str.isspace()` 不是同一个集合：`\x1c-\x1f`、`\x85` 是 Python 空白而 JS trim
//      不去；`\ufeff` 相反。`\x1cid: other` 在 Python 是 id 行，在 JS 不是。
// 三个形状的共同后果是同一个洞：JS 判“没有声明 id”而放行，Python 按 front-matter 的 id 建页。
// 因此 A 组（单字符 \r）、B 组（两/三个 BOM）、C 组（Python 空白前缀）与 E 组的 1c-key 样本是绊线：
// 任何一次单边放宽，它们会以 leaks 的形式立刻变红。
const STEM = "overview";
const OTHER = 'id: "other"';
const OWN = 'id: "overview"';
const fm = (lines, body = "# Body\n") => `---\n${lines.join("\n")}\n---\n${body}`;
const utf8 = (text) => Buffer.from(text, "utf8");
const raw = (...parts) => Buffer.concat(parts.map((part) => (Buffer.isBuffer(part) ? part : Buffer.from(part, "utf8"))));
const crlf = (text) => text.replace(/\n/g, "\r\n");
const cr = (text) => text.replace(/\n/g, "\r");

const GROUPS = [
  ["A", "newline variants — Path.read_text() universal newlines vs the JS normaliser"],
  ["B", "BOM counts — Python lstrip(\"\\ufeff\") removes any number, not one"],
  ["C", "Python-whitespace prefixes — str.isspace() is not String.prototype.trim"],
  ["D", "quoted / bare / typed ids — JSON value shapes and _fm_text_fields types"],
  ["E", "duplicate ids — Python dict overwrite vs the JS duplicate refusal"],
  ["F", "block termination — the \\n--- closing scan and sys.exit shapes"],
  ["G", "non-UTF-8 — read_text(utf-8) raises and the JS reader refuses the bytes"],
  ["H", "no front-matter — the id comes from the file stem in both readers"],
  ["I", "own id — legitimate shapes that must still publish (no over-refusal)"],
];

const SAMPLES = [
  // A. 换行变体（旧读取器只认 \r\n）
  { group: "A", name: "crlf-every-line", bytes: utf8(crlf(fm([OTHER, 'title: "T"']))) },
  { group: "A", name: "lone-cr-every-line", bytes: utf8(cr(fm([OTHER, 'title: "T"']))) },
  { group: "A", name: "lone-cr-first-line-only", bytes: utf8('---\rid: "other"\nparentId: null\n---\n# Body\n') },
  { group: "A", name: "lone-cr-closing-only", bytes: utf8('---\nid: "other"\r---\r# Body\n') },
  { group: "A", name: "bom-plus-crlf", bytes: utf8("\ufeff" + crlf(fm([OTHER]))) },

  // B. BOM 个数（旧读取器只去一个）
  { group: "B", name: "bom-one", bytes: utf8("\ufeff" + fm([OTHER])) },
  { group: "B", name: "bom-two", bytes: utf8("\ufeff\ufeff" + fm([OTHER])) },
  { group: "B", name: "bom-three", bytes: utf8("\ufeff\ufeff\ufeff" + fm([OTHER])) },
  { group: "B", name: "bom-two-plus-crlf", bytes: utf8("\ufeff\ufeff" + crlf(fm([OTHER]))) },
  { group: "B", name: "bom-inside-key", bytes: utf8(fm([`\ufeff${OTHER}`])) },

  // C. Python 空白前缀（旧读取器用 trim()，集合不同）
  { group: "C", name: "prefix-1c", bytes: utf8(fm([`\u001c${OTHER}`])) },
  { group: "C", name: "prefix-1d", bytes: utf8(fm([`\u001d${OTHER}`])) },
  { group: "C", name: "prefix-1f", bytes: utf8(fm([`\u001f${OTHER}`])) },
  { group: "C", name: "prefix-85-nel", bytes: utf8(fm([`\u0085${OTHER}`])) },
  { group: "C", name: "prefix-nbsp", bytes: utf8(fm([`\u00a0${OTHER}`])) },
  { group: "C", name: "prefix-3000-ideographic-space", bytes: utf8(fm([`\u3000${OTHER}`])) },
  { group: "C", name: "prefix-tab", bytes: utf8(fm([`\t${OTHER}`])) },
  { group: "C", name: "trailing-1c-before-colon", bytes: utf8(fm(['id\u001c: "other"'])) },

  // D. 引号 / 裸值 / 类型化 id
  { group: "D", name: "bare-id", bytes: utf8(fm(["id: other"])) },
  { group: "D", name: "double-quoted-id", bytes: utf8(fm([OTHER])) },
  { group: "D", name: "single-quoted-id", bytes: utf8(fm(["id: 'other'"])) },
  { group: "D", name: "int-id", bytes: utf8(fm(["id: 7"])) },
  { group: "D", name: "float-id", bytes: utf8(fm(["id: 7.5"])) },
  { group: "D", name: "bool-id", bytes: utf8(fm(["id: true"])) },
  { group: "D", name: "null-id", bytes: utf8(fm(["id: null"])) },
  { group: "D", name: "array-id", bytes: utf8(fm(['id: ["other"]'])) },
  { group: "D", name: "nan-id", bytes: utf8(fm(["id: NaN"])) },
  { group: "D", name: "infinity-id", bytes: utf8(fm(["id: Infinity"])) },
  { group: "D", name: "negative-infinity-id", bytes: utf8(fm(["id: -Infinity"])) },
  { group: "D", name: "empty-id-value", bytes: utf8(fm(["id:"])) },

  // E. 重复 id（Python 后者覆盖前者；JS 拒绝一切重复）
  { group: "E", name: "duplicate-quoted-id", bytes: utf8(fm(['id: "first"', OTHER])) },
  { group: "E", name: "duplicate-own-then-other", bytes: utf8(fm([OWN, OTHER])) },
  { group: "E", name: "duplicate-commented-second", bytes: utf8(fm([OWN, "# id: other"])) },
  { group: "E", name: "duplicate-key-with-1c-prefix", bytes: utf8(fm([OWN, `\u001c${OTHER}`])) },
  { group: "E", name: "triple-id-lines", bytes: utf8(fm(['id: "a"', 'id: "b"', OTHER])) },

  // F. 块终止
  { group: "F", name: "unterminated-block", bytes: utf8('---\nid: "other"\n# no closing marker\n') },
  { group: "F", name: "unterminated-at-eof", bytes: utf8('---\nid: "other"') },
  { group: "F", name: "closing-with-trailing-space", bytes: utf8('---\nid: "other"\n---  \n') },
  { group: "F", name: "closing-four-dashes", bytes: utf8('---\nid: "other"\n----\n') },
  { group: "F", name: "closing-token-inside-value", bytes: utf8('---\ntitle: "a --- b"\nid: "other"\n---\n') },
  { group: "F", name: "closing-at-eof", bytes: utf8('---\nid: "other"\n---') },
  { group: "F", name: "empty-block-with-blank-line", bytes: utf8("---\n\n---\n# Body\n") },

  // G. 非 UTF-8 字节
  { group: "G", name: "latin1-byte-in-id", bytes: raw('---\nid: "other', Buffer.from([0xe9]), '"\n---\n') },
  { group: "G", name: "lone-0x80-in-body", bytes: raw('---\nid: "other"\n---\n# ', Buffer.from([0x80]), "\n") },
  { group: "G", name: "truncated-utf8-3-byte", bytes: raw('---\nid: "other"\n# ', Buffer.from([0xe2, 0x82]), "\n---\n") },
  { group: "G", name: "utf16le-with-bom", bytes: raw(Buffer.from([0xff, 0xfe]), Buffer.from('---\nid: "other"\n---\n', "utf16le")) },
  { group: "G", name: "valid-utf8-multibyte-id", bytes: utf8(fm(['id: "trang chủ ✓"'])) },

  // H. 没有 front-matter（两边都退回文件名）
  { group: "H", name: "plain-markdown-body", bytes: utf8("# Title\n\nText.\n") },
  { group: "H", name: "marker-with-trailing-space", bytes: utf8("--- \nid: other\n---\n") },
  { group: "H", name: "leading-blank-line", bytes: utf8('\n---\nid: "other"\n---\n') },
  { group: "H", name: "empty-file", bytes: Buffer.alloc(0) },
  { group: "H", name: "thematic-break-later", bytes: utf8("Intro\n\n---\n\nMore\n") },
  { group: "H", name: "bom-then-plain-body", bytes: utf8("\ufeff# Title\n\nText.\n") },

  // I. 自有 id：这些页面必须能发布（防止把读取器改成“一律拒绝”）
  { group: "I", name: "own-id-quoted", bytes: utf8(fm([OWN, "parentId: null", "order: 1", 'title: "Overview"'])) },
  { group: "I", name: "own-id-lone-cr", bytes: utf8(cr(fm([OWN]))) },
  { group: "I", name: "own-id-two-boms", bytes: utf8("\ufeff\ufeff" + fm(["id: overview"])) },
  { group: "I", name: "own-id-duplicate-same-value", bytes: utf8(fm([OWN, OWN])) },
  { group: "I", name: "own-id-no-front-matter", bytes: utf8("# Overview\n\nBody text.\n") },
].map((sample) => ({ ...sample, stem: STEM }));

// ---------------------------------------------------------------- 3. 真 Python 读取器（一个子进程跑完整个语料）
//
// 顺序严格照 assemble：Path.read_text(encoding="utf-8") → _parse_front_matter → _fm_text_fields →
// page.setdefault("id", f.stem)。三种“Python 不建页/建不了页”的结果分开记录：
//   exit        _parse_front_matter 里 sys.exit（块未闭合、行没有冒号）
//   skipped     _fm_text_fields 返回 False（id 是布尔/列表/对象/null —— 该文件被跳过）
//   read-error  read_text(utf-8) 抛异常（非 UTF-8 字节会让整个 assemble 崩掉）
// 只输出 JSON；ensure_ascii + PYTHONIOENCODING 双保险，避免 Windows 控制台代码页把多字节 id 弄丢。
const PY_DRIVER = [
  "import importlib.util, json, sys",
  "from pathlib import Path",
  "builder_path, root = sys.argv[1], Path(sys.argv[2])",
  "spec = importlib.util.spec_from_file_location('dsh_wiki_builder_reference', builder_path)",
  "module = importlib.util.module_from_spec(spec)",
  "spec.loader.exec_module(module)",
  "out = {}",
  "for f in sorted(root.glob('*/pages/*.md')):",
  "    sample = f.parent.parent.name",
  "    warns = []",
  "    try:",
  "        text = f.read_text(encoding='utf-8')",
  "    except Exception as exc:",
  "        out[sample] = {'outcome': 'read-error', 'detail': type(exc).__name__}",
  "        continue",
  "    try:",
  "        meta, _body = module._parse_front_matter(text, str(f))",
  "    except SystemExit as exc:",
  "        out[sample] = {'outcome': 'exit', 'detail': str(exc)}",
  "        continue",
  "    if meta is None:",
  "        meta = {}",
  "    try:",
  "        keep = module._fm_text_fields(meta, ('id', 'title', 'parentId', 'description'), 'pages/' + f.name, warns)",
  "    except SystemExit as exc:",
  "        out[sample] = {'outcome': 'exit', 'detail': str(exc)}",
  "        continue",
  "    if not keep:",
  "        out[sample] = {'outcome': 'skipped', 'detail': '; '.join(warns)}",
  "        continue",
  "    meta.setdefault('id', f.stem)",
  "    out[sample] = {'outcome': 'id', 'id': meta['id'], 'stem': f.stem}",
  "print(json.dumps({'python': sys.version.split()[0], 'samples': out}, ensure_ascii=True, sort_keys=True))",
].join("\n");

const corpusRoot = tempDir("dsh-wiki-frontmatter-");
const dirOf = (index, sample) => `${String(index).padStart(2, "0")}-${sample.name}`;
for (const [index, sample] of SAMPLES.entries()) {
  const dir = path.join(corpusRoot, dirOf(index, sample), "pages");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${sample.stem}.md`), sample.bytes);
}

const runReferenceReader = () => {
  const output = execFileSync(PYTHON, ["-c", PY_DRIVER, BUILDER_PATH, corpusRoot], {
    encoding: "utf8",
    env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const parsed = JSON.parse(output);
  if (!parsed || typeof parsed.samples !== "object" || parsed.samples === null) {
    throw new Error("the python driver returned no samples object");
  }
  return parsed;
};

const startedAt = process.hrtime.bigint();
let reference = null;
try {
  reference = runReferenceReader();
} catch (error) {
  if (error?.code === "ENOENT") {
    // 显式 SKIP + 非零退出：跑不起来的差分测试绝不能通过。
    console.log(`SKIP frontmatter-differential: python interpreter not found (tried "${PYTHON}"; set DSH_WIKI_TEST_PYTHON to override)`);
    console.log("SKIP reason: the reference reader is scripts/build_wiki_site.py; without python there is nothing to compare against");
    console.log("SKIP policy: an unrun differential suite is a FAILURE, not a pass (exit code 2)");
    process.exit(2);
  }
  const stderr = String(error?.stderr ?? "").trim().split("\n").slice(-6).join("\n");
  console.log(`FAIL python-reference: the reference reader could not be driven (${error?.message ?? error})`);
  if (stderr) console.log(`FAIL python-reference stderr:\n${stderr}`);
  process.exit(1);
}

// ---------------------------------------------------------------- 4. 判定：安全属性优先于“两边一致”
//
// 调用方（verifyIncrementalIdMapping）的规则：受影响 id 必须恰好是 pages/<id>.md，且该文件声明要么没有
// id、要么等于这个 id。这里照抄这条判定，所以 jsAllows 是**调用方**的放行，而不是读取器的 ok。
//   leak                     Python 会在别的 id 下建页，而 JS 调用方放行  => 重定向洞 => FAIL
//   js-allows/python-refuses Python 硬失败或跳过该文件，而 JS 放行        => FAIL
//   conservative             Python 按自有 id 建页，而 JS 拒绝            => 允许（保守方向），计数并打印
const jsCallerDecision = (sample) => {
  const declared = reader.readDeclaredId(sample.bytes);
  const allows = declared.ok === true && (declared.id === null || declared.id === sample.stem);
  return { declared, allows };
};
const describeReader = ({ declared }) => (declared.ok
  ? (declared.id === null ? "js reads no declared id" : `js reads declared id ${JSON.stringify(declared.id)}`)
  : `js refuses (${declared.reason}${declared.refusal ? `/${declared.refusal}` : ""})`);
const describePython = (result) => {
  if (!result) return "no result";
  if (result.outcome === "id") return `id ${JSON.stringify(result.id)}`;
  if (result.outcome === "skipped") return "skips the file (_fm_text_fields rejects the value type)";
  if (result.outcome === "exit") return "sys.exit (assemble fails)";
  return `read_text fails (${result.detail})`;
};

const leaks = [];
const allowWherePythonRefuses = [];
let redirectBlocked = 0;
let agreement = 0;
let bothRefused = 0;
let conservative = 0;
let currentGroup = null;

for (const [index, sample] of SAMPLES.entries()) {
  if (sample.group !== currentGroup) {
    currentGroup = sample.group;
    const [, title] = GROUPS.find(([letter]) => letter === currentGroup) ?? [currentGroup, ""];
    console.log(`\n# --- ${currentGroup}. ${title}`);
  }
  const py = reference.samples[dirOf(index, sample)];
  const decision = jsCallerDecision(sample);
  const label = `${sample.group}/${sample.name}`;
  const pyBuilds = py?.outcome === "id";
  const pyStemOk = !pyBuilds || py.stem === sample.stem;
  if (!py) {
    check(`${label}: python produced no verdict for this sample`, false, JSON.stringify({ python: py ?? null }));
    continue;
  }
  if (!pyStemOk) {
    check(`${label}: fixture stem mismatch (python saw ${JSON.stringify(py.stem)}, expected ${JSON.stringify(sample.stem)})`, false, JSON.stringify(py));
    continue;
  }
  const redirect = pyBuilds && py.id !== sample.stem;
  const redirectedTo = redirect ? JSON.stringify(py.id) : null;

  if (redirect && decision.allows) {
    leaks.push(label);
    check(`${label}: python builds this page as id ${redirectedTo}, js allows (LEAK)`, false,
      JSON.stringify({ python: py, declared: decision.declared, stem: sample.stem }));
    continue;
  }
  if (!pyBuilds && decision.allows) {
    allowWherePythonRefuses.push(label);
    check(`${label}: python refuses this file, js allows (ALLOW-WHERE-PYTHON-REFUSES)`, false,
      JSON.stringify({ python: py, declared: decision.declared, stem: sample.stem }));
    continue;
  }
  if (decision.allows) {
    agreement += 1;
    check(`${label}: python ${describePython(py)}; ${describeReader(decision)} -> publishes under the file stem`, true);
    continue;
  }
  if (redirect) {
    redirectBlocked += 1;
    // 读取器拒绝，或者读取器看到了 id 而调用方按“声明 id != 文件名”拒绝：两种都关掉了重定向，但来源不同。
    const blocked = decision.declared.ok
      ? "-> caller refuses the redirect (declared id != file stem)"
      : "-> redirect blocked";
    check(`${label}: python would build id ${redirectedTo}; ${describeReader(decision)} ${blocked}`, true);
    continue;
  }
  if (!pyBuilds) {
    bothRefused += 1;
    check(`${label}: python ${describePython(py)}; ${describeReader(decision)}`, true);
    continue;
  }
  conservative += 1;
  check(`${label}: python builds the own id ${JSON.stringify(py.id)}; ${describeReader(decision)} -> conservative refusal (allowed direction, nothing retargeted)`, true);
}

// ---------------------------------------------------------------- 5. 套件自检（这些不是样本，而是“这套测试本身有没有意义”）
const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
const uniqueNames = new Set(SAMPLES.map((sample) => sample.name));
check("corpus: exactly 58 named shapes, unique names, every stem is the same page id",
  SAMPLES.length === 58 && uniqueNames.size === 58 && SAMPLES.every((sample) => sample.stem === STEM),
  JSON.stringify({ count: SAMPLES.length, unique: uniqueNames.size, stems: [...new Set(SAMPLES.map((sample) => sample.stem))] }));
check("reference: the real scripts/build_wiki_site.py answered for all 58 samples (one subprocess)",
  Object.keys(reference.samples).length === SAMPLES.length
  && Object.values(reference.samples).every((result) => ["id", "skipped", "exit", "read-error"].includes(result.outcome)),
  JSON.stringify({ got: Object.keys(reference.samples).length, expected: SAMPLES.length }));
check(`reader: 7 shipped statements extracted from lib/jobs.js ${jobsSha256.slice(0, 12)} (no copy, no fallback)`,
  extractedPieces.length === STATEMENT_ANCHORS.length
  && typeof reader.readDeclaredId === "function" && typeof reader.declaredFrontMatterId === "function",
  JSON.stringify({ pieces: extractedPieces.length, anchors: STATEMENT_ANCHORS.length }));
check("security: no sample lets js publish a page that python builds under a different id (leaks == 0)",
  leaks.length === 0, JSON.stringify(leaks));
check("security: no sample has js allows / python refuses (must be 0)",
  allowWherePythonRefuses.length === 0, JSON.stringify(allowWherePythonRefuses));
check(`runtime: the whole corpus runs in one python subprocess inside the few-seconds budget (${Math.round(elapsedMs)} ms)`,
  elapsedMs < 30000, `${Math.round(elapsedMs)} ms`);

console.log("");
console.log(`# samples=${SAMPLES.length} python=${reference.python} elapsed=${Math.round(elapsedMs)} ms`);
console.log(`# leaks=${leaks.length} js-allows/python-refuses=${allowWherePythonRefuses.length} redirect-blocked=${redirectBlocked} agreement=${agreement} both-refused=${bothRefused} conservative=${conservative}`);
console.log(FAILS.length ? `\n${FAILS.length} FAILED` : "\nALL PASS");
process.exit(FAILS.length ? 1 : 0);
