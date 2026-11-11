// dsh-wiki README **parity** harness —— “所有 README 内容一致，取英文为源” 的机器检查。
//
// 为什么这份文件存在：README.md 是唯一事实源，README.<lang>.md 只是它的译本。译者漏掉一整节、一个代码块
// 或一个 refusal 码，读者拿到的事实就少一块，而**别的任何测试都不会红**。这里把“同一份内容”拆成七条可机检
// 的性质：存在性 / 标题骨架 / 代码块字节 / 事实 token / 链接与锚点 / 行数比例 / 机器路径泄漏。
//
// 两条硬约束（都是“不许撒谎”的约束）：
//   1. 英文侧的 count 一律**现场 derive**（块数、每套测试的项数、badge 文案、incremental 码表）：
//      改 README.md 不需要跟着改本套件，反过来也不会让本套件悄悄失效。
//   2. 缺文件 = FAIL，缺一节 = FAIL；没有“静默跳过”这个出口（跑不起来的检查“通过” == 谎言）。
//
// 已知边界（写出来，免得读者过度解读）：只比较**顶层** fenced code block。blockquote 内的 ``` 是展示壳
// （每一行都带 "> " 前缀），README.vi.md 在其中用 %LOCALAPPDATA% 表示英文用 C:\Users\<you>\AppData\Local
// 表示的同一个目录 —— 同一事实的两种写法，不是内容缺失。本仓库的 README.zh.md 在那里与英文逐字一致，
// 但这一条不在本套件的保证范围内。
import fs from "node:fs";
import path from "node:path";

const here = import.meta.dirname;
const ROOT = path.join(here, "..");
const SOURCE_NAME = "README.md";
const TRANSLATION_RE = /^README\..+\.md$/;
const RATIO_MIN = 0.7;
const RATIO_MAX = 1.6;

const FAILS = [];
let checks = 0;
const check = (name, ok, detail = "") => {
  checks += 1;
  console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : `  [${detail}]`));
  if (!ok) FAILS.push(name);
};

const readme = (name) => fs.readFileSync(path.join(ROOT, name), "utf8");
const truncate = (text, max = 110) => (text.length > max ? `${text.slice(0, max)}…` : text);
const contentLines = (text) => {
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
};

// ---------------------------------------------------------------- 标题骨架
// 语言不同，标题文本没法直接比；能比的只有“第 i 个标题是几级”。emoji 前缀要保留，锚点才会平行，
// 所以 slug 必须和 GitHub 那份算法同形：去掉行内代码、符号与 emoji（含 U+FE0F 变体选择符），空格转 '-'。
const slugify = (text) => text
  .replace(/`[^`\n]*`/g, "")
  .toLowerCase()
  .replace(/[^\p{L}\p{N} _-]/gu, "")
  .replace(/ /g, "-");

const headings = (text) => {
  const seen = new Map();
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
    if (!match) continue;
    const level = match[1].length;
    const raw = match[2];
    let slug = slugify(raw);
    if (seen.has(slug)) {
      const next = seen.get(slug) + 1;
      seen.set(slug, next);
      slug = `${slug}-${next}`;
    } else {
      seen.set(slug, 0);
    }
    out.push({ level, text: raw, slug });
  }
  return out;
};

// ---------------------------------------------------------------- fenced code blocks（顶层）
// 逐行状态机而不是正则：blockquote 里的 ``` 不算顶层块，未闭合的块也不会把后面的文件内容吞掉。
const fencedBlocks = (text) => {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  let index = 0;
  while (index < lines.length) {
    const open = /^```(.*)$/.exec(lines[index]);
    if (!open) { index += 1; continue; }
    const lang = open[1].trim();
    const startLine = index + 1;
    const body = [];
    index += 1;
    while (index < lines.length && !/^```\s*$/.test(lines[index])) {
      body.push(lines[index]);
      index += 1;
    }
    blocks.push({ lang, body: `${body.join("\n")}${body.length ? "\n" : ""}`, startLine });
    index += 1;
  }
  return blocks;
};

// ---------------------------------------------------------------- 链接
// 扫描前先剥掉 fenced block 与**行内代码**：英文文件用 `[text](#card-<id>)` 记录卡片链接语法，那是
// 被引用的文本，不是链接；不剥就会得到一个假失败。
const withoutFences = (text) => {
  const kept = [];
  let fence = null;
  for (const line of text.split(/\r?\n/)) {
    if (fence === "quoted") { if (/^> ```/.test(line)) fence = null; continue; }
    if (fence === "top") { if (/^```/.test(line)) fence = null; continue; }
    if (/^> ```/.test(line)) { fence = "quoted"; continue; }
    if (/^```/.test(line)) { fence = "top"; continue; }
    kept.push(line);
  }
  return kept.join("\n");
};

const withoutInlineCode = (text) => text.replace(/``([\s\S]*?)``/g, "").replace(/`[^`\n]*`/g, "");

const links = (text) => {
  const scan = withoutInlineCode(withoutFences(text));
  const found = [];
  const markdown = /\[[^\]]*\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+"[^"]*")?\s*\)/g;
  const html = /(?:href|src)="([^"]*)"/g;
  for (const match of scan.matchAll(markdown)) {
    found.push({ target: match[1].replace(/^<|>$/g, ""), raw: match[0] });
  }
  for (const match of scan.matchAll(html)) {
    found.push({ target: match[1], raw: match[0] });
  }
  return found;
};

const isExternal = (target) => /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//");

// ---------------------------------------------------------------- 英文侧：derive 事实
const source = readme(SOURCE_NAME);
const sourceLines = contentLines(source);
const sourceHeadings = headings(source);
const sourceBlocks = fencedBlocks(source);

// 八个 incremental-* refusal code：从英文正文里抽，不写死。
const incrementalCodes = [...new Set(source.match(/\bincremental-[a-z][a-z0-9-]*\b/g) || [])].sort();
// 按套件列的测试项数：从英文的 tests 代码块里抽（script → 数字），不写死。
const suiteCounts = (() => {
  const block = sourceBlocks.find((candidate) => /test_build_wiki_site\.py/.test(candidate.body));
  if (!block) return [];
  return block.body.split("\n").filter(Boolean).map((line) => {
    const script = /(\S+?\.(?:py|mjs))/.exec(line);
    const count = /#\s*(\d+)\s+\S/.exec(line);
    return script && count ? { script: script[1], count: count[1] } : null;
  }).filter(Boolean);
})();
const badgeTestsAlt = /alt="tests: ([^"]+)"/.exec(source)?.[1] || null;
// 固定事实 token：必须逐字出现。名字类事实不 derive，避免被“同一份英文”掩盖。
const FACT_TOKENS = ["pagesRemoved", "sourceCommit", "frontmatter-differential-test.mjs", "jobs.enabled", "MIT", "Acfufu"];
// 机器路径：真用户名才是泄漏；`C:\Users\<you>` 是文档里的占位符，必须放过。
const ACCOUNT_NAME = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    return typeof pkg?.author?.name === "string" ? pkg.author.name.trim() : "";
  } catch {
    return "";
  }
})();
const MACHINE_PATTERNS = [
  { label: "Windows user profile", re: /[A-Za-z]:[\\/]+Users[\\/]+(?!<)[A-Za-z0-9._$-]+/g },
  { label: "POSIX home directory", re: /(?:^|[\s"'`(])\/(?:home|Users)\/(?!<)[A-Za-z0-9._-]+/g },
];
if (ACCOUNT_NAME) {
  MACHINE_PATTERNS.push({ label: "developer account name", re: new RegExp(`\\b${ACCOUNT_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi") });
}

// ---------------------------------------------------------------- 源文件自检：解析失败要算在解析器头上，不是译本
check(`${SOURCE_NAME}: parsed as the source of truth (${sourceHeadings.filter((head) => head.level === 2).length} ## + ${sourceHeadings.filter((head) => head.level === 3).length} ### heads, ${sourceBlocks.length} top-level blocks)`,
  sourceHeadings.length > 0 && sourceBlocks.length > 0,
  JSON.stringify({ headings: sourceHeadings.length, blocks: sourceBlocks.length }));
check(`${SOURCE_NAME}: carries the derived fact set (${incrementalCodes.length} incremental codes, ${suiteCounts.length} suite counts, badge alt ${badgeTestsAlt ? "present" : "MISSING"})`,
  incrementalCodes.length > 0 && suiteCounts.length > 0 && Boolean(badgeTestsAlt),
  JSON.stringify({ incrementalCodes, suiteCountEntries: suiteCounts.length, badgeTestsAlt }));

// ---------------------------------------------------------------- 每个译本
const translations = fs.readdirSync(ROOT)
  .filter((name) => TRANSLATION_RE.test(name))
  .sort();

check("translations: at least one README.<lang>.md sits next to package.json",
  translations.length > 0, JSON.stringify({ found: translations }));

for (const name of translations) {
  // 列在目录里但读不出来（例如坏掉的链接）也必须是 FAIL，而不是让整套检查崩在一行 stack trace 上：
  // 崩溃会掩盖这台机器上其余文件的结论。
  let text = "";
  try {
    text = readme(name);
  } catch (error) {
    check(`${name}: file exists and is readable`, false, String(error?.code ?? error));
    continue;
  }
  const lines = contentLines(text);
  const heads = headings(text);
  const blocks = fencedBlocks(text);
  const stats = { h2: 0, h3: 0, blocks: 0, facts: 0, links: 0, anchors: 0 };

  check(`${name}: file exists and is non-empty`, text.trim().length > 0, "empty file");

  // 1) 标题骨架：数量 + 逐位置级别（语言不同，只能比位置与级别）
  const sourceH2 = sourceHeadings.filter((head) => head.level === 2).length;
  const sourceH3 = sourceHeadings.filter((head) => head.level === 3).length;
  const headsH2 = heads.filter((head) => head.level === 2).length;
  const headsH3 = heads.filter((head) => head.level === 3).length;
  check(`${name}: same ## count as ${SOURCE_NAME} (${sourceH2})`, headsH2 === sourceH2, JSON.stringify({ expected: sourceH2, got: headsH2 }));
  check(`${name}: same ### count as ${SOURCE_NAME} (${sourceH3})`, headsH3 === sourceH3, JSON.stringify({ expected: sourceH3, got: headsH3 }));
  stats.h2 = headsH2;
  stats.h3 = headsH3;

  const levelMismatch = (() => {
    const total = Math.min(sourceHeadings.length, heads.length);
    for (let index = 0; index < total; index += 1) {
      if (sourceHeadings[index].level !== heads[index].level) {
        return { position: index, expected: "#".repeat(sourceHeadings[index].level), got: "#".repeat(heads[index].level), heading: heads[index].text };
      }
    }
    return sourceHeadings.length === heads.length ? null : { position: total, expected: "end of headings", got: heads[total]?.text ?? "end of headings" };
  })();
  check(`${name}: heading order matches ${SOURCE_NAME} position by position (same level at every slot)`,
    levelMismatch === null, JSON.stringify(levelMismatch));

  // 2) 代码块：数量 + 每个块逐字节（命令/路径/旗标/预期输出不翻译）
  check(`${name}: same number of fenced code blocks as ${SOURCE_NAME} (${sourceBlocks.length})`,
    blocks.length === sourceBlocks.length, JSON.stringify({ expected: sourceBlocks.length, got: blocks.length }));
  stats.blocks = blocks.length;
  sourceBlocks.forEach((block, index) => {
    const firstLine = truncate(block.body.split("\n")[0]);
    const actual = blocks[index];
    const ok = actual !== undefined && actual.body === block.body;
    const where = actual === undefined
      ? "block missing"
      : `${name}:${actual.startLine} first line differs: ${truncate(actual.body.split("\n")[0])}`;
    check(`${name}: code block ${index} (${block.lang || "plain"}) is byte-identical to ${SOURCE_NAME} — "${firstLine}"`,
      ok, ok ? "" : where);
  });

  // 3a) 固定事实 token
  for (const token of FACT_TOKENS) {
    const ok = text.includes(token);
    check(`${name}: fact "${token}" appears verbatim`, ok, "missing");
    if (ok) stats.facts += 1;
  }
  // 3b) refusal 码表（由英文 derive）
  for (const code of incrementalCodes) {
    const ok = text.includes(code);
    check(`${name}: refusal code "${code}" appears verbatim`, ok, "missing");
    if (ok) stats.facts += 1;
  }
  // 3c) 每套测试的项数（由英文 derive）：提到同一个 script 的行里，必须有一行带同一个数字
  //    正文也会提到这些脚本（§19 之类），所以不是“第一行”而是“存在一行”。
  for (const { script, count } of suiteCounts) {
    const mentions = lines.filter((candidate) => candidate.includes(script));
    const ok = mentions.some((candidate) => new RegExp(`#\\s*${count}\\s+\\S`).test(candidate));
    check(`${name}: suite "${script}" reports ${count} checks, as in ${SOURCE_NAME}`,
      ok, mentions.length ? `no "# ${count} …" near: ${truncate(mentions[0], 90)}` : "suite line missing");
    if (ok) stats.facts += 1;
  }
  // 3d) 聚合 badge 文案（tests: … 一行就是对外公布的项数总和）
  if (badgeTestsAlt) {
    const ok = text.includes(`alt="tests: ${badgeTestsAlt}"`);
    check(`${name}: tests badge alt text matches ${SOURCE_NAME} verbatim`, ok, "badge alt differs");
    if (ok) stats.facts += 1;
  }

  // 4) 链接：相对路径要在磁盘上存在；#anchor 要在同一文件的标题里存在
  const sourceAnchorSlugs = new Set(heads.map((head) => head.slug));
  const found = links(text);
  const seen = new Set();
  for (const { target, raw } of found) {
    if (seen.has(target) || isExternal(target)) continue;
    seen.add(target);
    if (target.startsWith("#")) {
      const slug = decodeURIComponent(target.slice(1));
      const ok = sourceAnchorSlugs.has(slug);
      check(`${name}: anchor "${target}" resolves to a heading in the same file`, ok, "no heading produces this slug");
      if (ok) stats.anchors += 1;
    } else {
      const bare = decodeURIComponent(target.replace(/[?#].*$/, ""));
      const ok = bare.length > 0 && fs.existsSync(path.join(ROOT, bare));
      check(`${name}: relative link "${truncate(bare, 70)}" resolves on disk`, ok, truncate(raw, 90));
      if (ok) stats.links += 1;
    }
  }
  // 5) 行数比例：0.7–1.6×，今天的“缺内容”症状就是低于 0.7
  const ratio = lines.length / sourceLines.length;
  check(`${name}: ${lines.length} lines is within ${RATIO_MIN}–${RATIO_MAX}× of ${SOURCE_NAME} ${sourceLines.length} lines (${ratio.toFixed(3)}×)`,
    ratio >= RATIO_MIN && ratio <= RATIO_MAX, `${ratio.toFixed(3)}×`);

  // 6) 机器路径 / 账号名：真用户名才是泄漏，`C:\Users\<you>` 这种占位符必须放过
  const leaks = [];
  for (const { label, re } of MACHINE_PATTERNS) {
    for (const match of text.matchAll(re)) leaks.push(`${label}: ${truncate(match[0].trim(), 60)}`);
  }
  check(`${name}: no machine-specific paths or developer account name`, leaks.length === 0, JSON.stringify(leaks.slice(0, 4)));

  console.log(`# ${name}: lines ${lines.length}/${sourceLines.length} (${ratio.toFixed(3)}×), heads ##+### ${stats.h2}+${stats.h3} vs ${sourceH2}+${sourceH3}, blocks ${stats.blocks}/${sourceBlocks.length}, facts ${stats.facts}, relative links ${stats.links}, anchors ${stats.anchors}`);
}

console.log("");
console.log(`# files=${translations.length + 1} checks=${checks} incremental-codes=${incrementalCodes.length} suite-counts=${suiteCounts.length}`);
console.log(FAILS.length ? `\n${FAILS.length} FAILED` : "\nALL PASS");
process.exit(FAILS.length ? 1 : 0);
