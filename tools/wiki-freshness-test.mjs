#!/usr/bin/env node
// dsh-wiki — wiki 新鲜度的“改动文件列表”测试。
//
// changedFiles 必须用 git pathspec 排除 wiki 目录，否则重新生成的 .dsh-wiki/** 会占满预览与计数。
// 自包含：注入假 execFile 给 createGitProbe，不起 git、不联网、不碰仓库自己的 .dsh-wiki。
import { LIMITS } from "../lib/wiki-knowledge.js";
import { DEFAULT_WIKI_DIR_NAME, buildToolDefinitions, computeFreshness, createGitProbe } from "../lib/wiki-tools.js";

let PASSED = 0;
const FAILS = [];
const check = (name, ok, detail) => {
  if (ok) PASSED += 1;
  else FAILS.push(name);
  console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : `  [${detail}]`));
};

const ROOT = "C:\\repo\\root";
const FROM = "a".repeat(40);

/** 假 execFile：记录每次 argv，按 stdout/error 回调。 */
const fakeExec = (stdout, error = null) => {
  const calls = [];
  const fn = (_cmd, args, _opts, cb) => { calls.push(args); cb(error, stdout); };
  fn.calls = calls;
  return fn;
};

const diffArgs = (fn) => fn.calls[fn.calls.length - 1];
const pathspecAfterDashes = (args) => {
  const index = args.indexOf("--");
  return index < 0 ? null : args.slice(index + 1);
};

// (a) 排除 pathspec 在 `--` 之后，且 argv 仍以 -C <root> 开头
{
  const exec = fakeExec("src/a.js\nsrc/b.js\n");
  const files = await createGitProbe({ execFile: exec }).changedFiles(ROOT, FROM);
  const args = diffArgs(exec);
  const spec = pathspecAfterDashes(args);
  check("argv starts with -C <root>", args[0] === "-C" && args[1] === ROOT, JSON.stringify(args));
  check("argv has the exclusion pathspec after `--`",
    Array.isArray(spec) && spec.length === 1 && spec[0] === `:(exclude)${DEFAULT_WIKI_DIR_NAME}`, JSON.stringify(args));
  check("argv keeps the range and --name-only", args.includes("--name-only") && args.includes(`${FROM}..HEAD`), JSON.stringify(args));
  check("source files are returned in order", JSON.stringify(files) === JSON.stringify(["src/a.js", "src/b.js"]), JSON.stringify(files));
}

// (b) 默认目录名
check("default wiki dir name is .dsh-wiki", DEFAULT_WIKI_DIR_NAME === ".dsh-wiki", DEFAULT_WIKI_DIR_NAME);

// (c) 自定义目录名被采用
{
  const exec = fakeExec("x\n");
  await createGitProbe({ execFile: exec }).changedFiles(ROOT, FROM, "docs-wiki");
  check("a custom wikiDirName is honoured", pathspecAfterDashes(diffArgs(exec))?.[0] === ":(exclude)docs-wiki", JSON.stringify(diffArgs(exec)));
}

// (d) 不安全目录名回落默认值，且绝不进入 argv
for (const [label, bad] of [["..", "../x"], ["embedded ..", "a/../b"], ["leading /", "/abs"], ["leading \\", "\\abs"], ["colon", "a:b"], ["newline", "a\nb"], ["CR", "a\rb"], ["empty", ""], ["non-string", 42]]) {
  const exec = fakeExec("x\n");
  await createGitProbe({ execFile: exec }).changedFiles(ROOT, FROM, bad);
  const args = diffArgs(exec);
  const spec = pathspecAfterDashes(args);
  const leaked = typeof bad === "string" && bad.length > 0 && args.some((arg) => String(arg).includes(bad));
  check(`unsafe wikiDirName (${label}) falls back to the default`, spec?.[0] === `:(exclude)${DEFAULT_WIKI_DIR_NAME}`, JSON.stringify(args));
  check(`unsafe wikiDirName (${label}) never reaches argv`, !leaked, JSON.stringify(args));
}

// computeFreshness 转发 input.wikiDirName；不给就用默认值
{
  const seen = [];
  const git = {
    head: async () => "b".repeat(40),
    behind: async () => 1,
    changedFiles: async (_root, _from, dir) => { seen.push(dir); return []; },
  };
  await computeFreshness(git, { root: ROOT, sourceCommit: FROM, wikiDirName: "custom-wiki" });
  await computeFreshness(git, { root: ROOT, sourceCommit: FROM });
  check("computeFreshness forwards input.wikiDirName", seen[0] === "custom-wiki", JSON.stringify(seen));
  check("computeFreshness without wikiDirName forwards undefined (default applies in the probe)", seen[1] === undefined, JSON.stringify(seen));
}

// 边界情形：behind>=1 但没有源码文件变化 => changedFiles 为 []，behind 不变，stale 仍为 true
{
  const exec = (cmd, args, opts, cb) => {
    if (args.includes("rev-parse")) return cb(null, `${"b".repeat(40)}\n`);
    if (args.includes("rev-list")) return cb(null, "3\n");
    return cb(null, "");
  };
  const fresh = await computeFreshness(createGitProbe({ execFile: exec }), { root: ROOT, sourceCommit: FROM });
  check("edge: behind>=1 with no source change => stale=true, behind=3, changedFiles=[]",
    fresh.stale === true && fresh.behind === 3 && Array.isArray(fresh.changedFiles) && fresh.changedFiles.length === 0,
    JSON.stringify(fresh));
}

// (e) 列表受 LIMITS.changedFilesMax 约束
{
  const many = Array.from({ length: LIMITS.changedFilesMax + 50 }, (_, i) => `src/f${i}.js`).join("\n");
  const files = await createGitProbe({ execFile: fakeExec(many) }).changedFiles(ROOT, FROM);
  check("changedFiles is bounded by LIMITS.changedFilesMax", files.length === LIMITS.changedFilesMax, `got ${files?.length}`);
}

// (f) git 失败 => null，绝不抛出
{
  const failing = await createGitProbe({ execFile: fakeExec("", new Error("boom")) }).changedFiles(ROOT, FROM);
  check("git error yields null", failing === null, String(failing));
  const throwing = await createGitProbe({ execFile: () => { throw new Error("spawn failed"); } }).changedFiles(ROOT, FROM);
  check("execFile throwing yields null (no exception)", throwing === null, String(throwing));
}

// (g) render：wiki_status 的文本必须自证“只列源码”“列表被截了多少”“空列表说明什么”。
// 只测 render（纯函数），所以 deps 可以是空壳：render 不碰任何服务。
{
  const status = buildToolDefinitions({}).find((definition) => definition.name === "wiki_status");
  const render = (value) => status.output.render(value);
  const textOf = (value) => render(value).map((block) => block.text).join("\n");
  const linesOf = (value) => textOf(value).split("\n");
  const base = {
    ok: true,
    repo: "C:\\repo\\root",
    repoId: "repo",
    title: "repo wiki",
    language: "en",
    pageCount: 3,
    cardCount: 4,
    stale: true,
    sourceCommit: "a".repeat(40),
    head: "b".repeat(40),
    behind: 3,
  };

  // (i) 被截断的预览：20 条上限必须写成 “first 20 of N”，且行数不增长。
  {
    const many = Array.from({ length: 25 }, (_, i) => `src/f${i}.js`);
    const capped = textOf({ ...base, changedFiles: many });
    const all = textOf({ ...base, changedFiles: many.slice(0, 3) });
    check("render: a capped changed list says first 20 of 25 and lists only the first 20",
      capped.includes("changed source files — first 20 of 25: src/f0.js")
      && capped.includes("src/f19.js") && !capped.includes("src/f20.js"),
      capped.slice(0, 400));
    check("render: the source-only count in the stale line counts every changed file, not the preview",
      capped.includes("25 source file(s) changed") && capped.includes("wiki's own pages are excluded"), capped.slice(0, 400));
    check("render: a capped preview does not grow the output (one changed line either way)",
      linesOf({ ...base, changedFiles: many }).length === linesOf({ ...base, changedFiles: many.slice(0, 3) }).length,
      `${linesOf({ ...base, changedFiles: many }).length} vs ${linesOf({ ...base, changedFiles: many.slice(0, 3) }).length}`);
    check("render: an uncapped list says all N instead of a bogus fraction",
      all.includes("changed source files — all 3: src/f0.js, src/f1.js, src/f2.js"), all.slice(0, 300));
    check("render: the changedFiles description states the exclusion, the cap and the 20-entry preview",
      /wiki directory itself is excluded/.test(status.output.schema.properties.changedFiles.description)
      && status.output.schema.properties.changedFiles.description.includes(String(LIMITS.changedFilesMax))
      && status.output.schema.properties.changedFiles.description.includes("first 20"),
      status.output.schema.properties.changedFiles.description);
  }

  // (ii) 只有 wiki 目录的提交：stale=true、behind=N、changedFiles=[] —— 空列表必须解释，不能被读成“没变化”。
  {
    const text = textOf({ ...base, changedFiles: [] });
    const lines = text.split("\n");
    check("render: stale=true with an empty list explains the wiki-only commits in exactly one line",
      lines.filter((line) => line.startsWith("changed source files:")).length === 1
      && text.includes("changed only the wiki directory")
      && text.includes("cannot clear this flag"),
      text.slice(0, 400));
    check("render: stale=true with an empty list keeps stale/behind untouched and omits no freshness line",
      text.includes("stale=true") && text.includes("behind=3") && text.includes("the wiki no longer matches HEAD: 0 source file(s) changed"),
      text.slice(0, 400));
    check("render: the wiki-only line does not grow the output (same line count as an uncapped preview)",
      lines.length === linesOf({ ...base, changedFiles: ["src/a.js"] }).length,
      `${lines.length} vs ${linesOf({ ...base, changedFiles: ["src/a.js"] }).length}`);
    check("render: a fresh wiki (stale=false) gets no changed line at all",
      !textOf({ ...base, stale: false, behind: 0, changedFiles: [] }).includes("changed source files:"),
      textOf({ ...base, stale: false, behind: 0, changedFiles: [] }).slice(0, 300));
  }
}

console.log(`\n${PASSED} passed, ${FAILS.length} failed`);
if (FAILS.length > 0) {
  console.log(`FAILED: ${FAILS.join("; ")}`);
  process.exit(1);
}
