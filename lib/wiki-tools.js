// dsh-wiki — agent 工具面（feature 014）。
// 五个工具都是**普通对象**定义：本插件不 import 任何 DSH 包（宿主服务一律经 ctx 按名解析），
// 所以拿不到 defineTool；这里按实测的注册契约直接交对象：
//   ctx.tools.register(definition, options?) -> 精确的 disposer
//   必需：definition.name；definition.output 是对象，render 是函数，schema 通过
//         assertSupportedJsonSchema（raw JSON Schema 子集）
//   可选：正的有限 timeoutMs；名字 run_code 被保留
// 实测子集（asar 内 dsh-tools/lib 的 assertSupportedJsonSchema，2026-11-11）只有：
//   type | oneOf | properties | required | additionalProperties | items | enum | const
//   + 注解 description/title/default/examples。
// **没有 minimum/maximum/length**：数值边界写进 description，并在 execute 里真正执行（clampLimit）。
// 也就是说 schema 只是形状与文档，边界是代码事实。
import { execFile } from "node:child_process";
import path from "node:path";
import {
  CARD_KINDS, LIMITS, cards as cardsPure, freshnessOf, getPage as getPagePure, impact as impactPure,
  search as searchPure, snapshotSummary,
} from "./wiki-knowledge.js";

export const WIKI_TOOL_NAMES = Object.freeze(["wiki_search", "wiki_page", "wiki_cards", "wiki_impact", "wiki_status"]);

// 一个工具调用的时间上限。**凡是会走新鲜度的工具**，预算必须覆盖 git 的最坏耗时：head 走索引.js 的缓存
// 探针（execFile timeout 2000ms）+ behind（3000ms）+ changedFiles（3000ms）= 8s，所以 search/impact/status
// 统一给 15000。wiki_page / wiki_cards 不读新鲜度，5000 足够。
const TIMEOUT_MS = Object.freeze({ search: 15000, page: 5000, cards: 5000, impact: 15000, status: 15000 });

/** render 的固定形状：宿主只接受 [{type:"text", text}] 这类文本块。 */
const textBlocks = (text) => [{ type: "text", text: String(text).replace(/\s+$/, "") }];

const asText = (value) => (typeof value === "string" ? value : value == null ? "" : String(value));

/** 固定短句：任何内部异常都不许把 stack/命令行/绝对临时路径带进工具结果。 */
const INTERNAL_FAILURE = Object.freeze({
  code: "internal-error",
  error: "the wiki tool could not complete this request",
});

/**
 * 定型失败的出站投影：只保留稳定 code、固定短句，以及**有界**、非路径形状的辅助列表
 * （候选仓库名、相近页面 id）。其余字段一律丢弃，绝不把内部结构或异常文本带进工具结果。
 */
const failResult = (failure, extra) => {
  const result = {
    ok: false,
    code: typeof failure?.code === "string" ? failure.code : "internal-error",
    error: typeof failure?.error === "string" ? failure.error : INTERNAL_FAILURE.error,
  };
  if (Array.isArray(failure?.candidates)) result.candidates = failure.candidates.slice(0, 10).map(asText).filter(Boolean);
  if (Array.isArray(failure?.closeIds)) result.closeIds = failure.closeIds.slice(0, 5).map(asText).filter(Boolean);
  return { ...result, ...(extra ?? {}) };
};

const clampInt = (value, fallback, max) => {
  if (value === undefined || value === null) return fallback;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.trunc(number), 1), max);
};

/**
 * 会话工作目录（repo 解析的第二个来源）。只认绝对路径；形状按 /wiki 命令实测的 agent 图推导。
 *
 * 诚实说明：`session.header.cwd` 是会话的**创建目录**，不是 `working_directory(cd)` 之后可变的当前目录——
 * 本插件自己的 worker-guard.js:22,348 就把这一点写成不可变事实。它在这里只有一个用途：调用方省略 `repo`
 * 时的**默认候选**（首选它，其次才是唯一已发现的 wiki 根），并且照样要过 canonicalProjectRoot 与
 * “已登记根或真的含 wiki.json”的证明。多个候选都有 wiki 时调用方返回 `repo-ambiguous`
 *（lib/index.js 的 resolveWikiRepo），绝不按 cwd 猜一个仓库。
 */
function sessionCwdOf(exec) {
  const candidates = [
    exec?.agent?.session?.header?.cwd,
    exec?.session?.header?.cwd,
    exec?.agent?.session?.cwd,
    exec?.cwd,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.length > 0 && path.isAbsolute(value)) return value;
  }
  return null;
}

export const DEFAULT_WIKI_DIR_NAME = ".dsh-wiki";

/** wiki 目录名进 git pathspec 之前先验：含 ..、前导 / 或 \、冒号、换行（或非字符串/空）一律回落默认值。 */
export function safeWikiDirName(name) {
  if (typeof name !== "string" || name.length === 0) return DEFAULT_WIKI_DIR_NAME;
  if (name.includes("..") || /^[/\\]/.test(name) || /[:\r\n\0]/.test(name)) return DEFAULT_WIKI_DIR_NAME;
  return name;
}

/**
 * git 探针：无 shell、有超时、只读。任何失败 => null（绝不抛出，绝不把 stderr/命令行交出去）。
 * @param {{execFile?: Function}} options 注入点（测试用假实现，生产用 node:child_process）
 */
export function createGitProbe(options = {}) {
  const run = typeof options.execFile === "function" ? options.execFile : execFile;
  const git = (root, args) => new Promise((resolve) => {
    try {
      run("git", ["-C", root, ...args], { timeout: 3000, windowsHide: true, maxBuffer: 256 * 1024 }, (error, stdout) => {
        resolve(error ? null : String(stdout ?? ""));
      });
    } catch {
      resolve(null);
    }
  });
  return {
    /** HEAD 的 sha；不是 git 仓库/没有 git => null。 */
    async head(root) {
      const out = await git(root, ["rev-parse", "HEAD"]);
      const sha = typeof out === "string" ? out.trim() : "";
      return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(sha) ? sha : null;
    },
    /** sourceCommit..HEAD 的提交数；不可度量 => null（**绝不**折算成 0）。 */
    async behind(root, from) {
      const out = await git(root, ["rev-list", "--count", `${from}..HEAD`]);
      const count = Number.parseInt(String(out ?? "").trim(), 10);
      return Number.isSafeInteger(count) && count >= 0 ? count : null;
    },
    /**
     * sourceCommit..HEAD 改动的**源码**文件（core.quotePath=false，非 ASCII 路径原样），有界。
     * wiki 目录用 pathspec 排除：否则重新生成的 .dsh-wiki/** 会排在最前面把预览占满，并抬高计数。
     */
    async changedFiles(root, from, wikiDirName) {
      const dir = safeWikiDirName(wikiDirName);
      const out = await git(root, ["-c", "core.quotePath=false", "diff", "--name-only", `${from}..HEAD`, "--", `:(exclude)${dir}`]);
      if (typeof out !== "string") return null;
      return out.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, LIMITS.changedFilesMax);
    },
  };
}

/**
 * 新鲜度：git 读数 + 纯算术。工具与 HTTP 面板调用的是**同一个**函数，两者不可能给出不同答案。
 * git 不可用、HEAD 读不到、wiki 没记录 sourceCommit => stale:"unknown"（绝不假设 false）。
 */
export async function computeFreshness(git, input = {}) {
  const root = typeof input.root === "string" ? input.root : null;
  const sourceCommit = typeof input.sourceCommit === "string" && input.sourceCommit.trim() ? input.sourceCommit.trim() : null;
  let head = null;
  let behind = null;
  let changedFiles = null;
  if (root && git && typeof git.head === "function") {
    try {
      head = await git.head(root);
    } catch { head = null; }
  }
  if (head && sourceCommit && head !== sourceCommit) {
    if (typeof git.behind === "function") {
      try { behind = await git.behind(root, sourceCommit); } catch { behind = null; }
    }
    if (typeof git.changedFiles === "function") {
      try { changedFiles = await git.changedFiles(root, sourceCommit, input.wikiDirName); } catch { changedFiles = null; }
    }
  }
  return freshnessOf({ sourceCommit, head, behind, changedFiles });
}

// ---------- 可复用的 schema 片段（只用手册允许的关键字） ----------
const STRING = (description) => ({ type: "string", description });
const STRING_ARRAY = (description) => ({ type: "array", items: { type: "string" }, description });
const INTEGER = (description) => ({ type: "integer", description });
// 混合类型（例如 true|false|"unknown"）只能写成“仅注解”的形式：实测子集里没有 type 数组。
const FREE = (description) => ({ description });

const REPO_PARAM = STRING("Absolute repository root. Omit to use the session's creation directory, or the single known repo wiki (several candidates are refused as repo-ambiguous).");
const ERROR_PROPS = {
  code: STRING("Stable error code when ok is false."),
  error: STRING("Fixed one-line error sentence when ok is false; no stack, no command line."),
};
// wiki_status 的 render 只预览前 20 条：changedFiles 最多 LIMITS.changedFilesMax 条，静悄悄截断会让调用方
// 以为那就是全部，所以被截时必须写出 “20 of N”。
const CHANGED_PREVIEW = 20;

const FRESHNESS_PROPS = {
  stale: FREE('Freshness gate: true (the wiki is behind HEAD), false (sourceCommit equals HEAD), or "unknown" (git or the recorded commit is unavailable — never assumed false).'),
  sourceCommit: STRING("Commit recorded when the wiki was generated, or null when the wiki records none."),
  head: STRING("Current HEAD commit read from git, or null when it cannot be read."),
  behind: INTEGER("Number of commits between sourceCommit and HEAD; null when it cannot be measured."),
  changedFiles: STRING_ARRAY(`Source files changed between sourceCommit and HEAD, when the wiki is stale: the wiki directory itself is excluded (so the wiki's own pages never appear), and the list is capped at ${LIMITS.changedFilesMax} entries. The rendered preview shows only the first ${CHANGED_PREVIEW} and states how many of the total those are.`),
};

const outputSchema = (properties, required = ["ok"]) => ({
  type: "object",
  properties: { ok: { type: "boolean", description: "False when the request was refused or the tool hit a typed error." }, ...properties },
  ...(required ? { required } : {}),
});

/** 渲染公共部分：错误行 + 候选。 */
function renderFailure(label, result) {
  const lines = [`${label} — refused (${result.code})`, result.error];
  if (Array.isArray(result.closeIds) && result.closeIds.length > 0) lines.push(`close ids: ${result.closeIds.join(", ")}`);
  if (Array.isArray(result.candidates) && result.candidates.length > 0) lines.push(`known repos: ${result.candidates.join(", ")}`);
  return textBlocks(lines.join("\n"));
}

const freshnessLine = (result) => {
  const parts = [`stale=${result.stale === true ? "true" : result.stale === false ? "false" : "unknown"}`];
  if (result.sourceCommit) parts.push(`sourceCommit=${result.sourceCommit.slice(0, 12)}`);
  if (result.head) parts.push(`head=${result.head.slice(0, 12)}`);
  if (Number.isSafeInteger(result.behind)) parts.push(`behind=${result.behind}`);
  return parts.join(" ");
};

// ---------- 五个定义 ----------

function searchDefinition(deps) {
  return {
    name: "wiki_search",
    description:
      "Search this repository's local wiki (generated pages and knowledge cards) for a text query and/or repository file paths, " +
      "and get back ranked, cited excerpts instead of the whole wiki. Call it BEFORE changing an unfamiliar module, and again " +
      "when you need the page or card behind a hit (wiki_page / wiki_cards). The wiki is a MAP, not the source of truth: verify " +
      "every citation's path:line in the code. Returns at most 20 hits (default 5) within a ~24 KiB budget, each with id, kind, " +
      "title, score, a <=400 character snippet, its path:line citations, and the page ids a card belongs to.",
    parameters: {
      type: "object",
      properties: {
        query: STRING("Text to look for. Words are matched case-insensitively against page titles, descriptions and bodies, and card titles, summaries, tags and key files."),
        files: STRING_ARRAY("Repository-relative paths to match; a directory entry covers everything under it at a path boundary."),
        repo: REPO_PARAM,
        limit: INTEGER("Maximum hits to return: 1..20, default 5."),
      },
    },
    output: {
      schema: outputSchema({
        repo: STRING("Resolved repository root."),
        query: STRING("Echo of the query."),
        count: INTEGER("Number of hits returned."),
        truncated: { type: "boolean", description: "True when the hit list was cut at the limit." },
        hits: {
          type: "array",
          description: "Ranked hits, best first; ties broken by (kind, id) so the order is stable.",
          items: {
            type: "object",
            required: ["id", "kind", "title", "score"],
            properties: {
              id: STRING("Page or card id."),
              kind: { type: "string", enum: ["page", "card"], description: "What the hit is." },
              title: STRING("Page or card title."),
              score: { type: "number", description: "Deterministic relevance score." },
              snippet: STRING("Preview, at most 400 characters."),
              citations: STRING_ARRAY("path:line tokens the item already cites; verify them in code."),
              pageIds: STRING_ARRAY("Pages the item belongs to (a card's pageIds)."),
            },
          },
        },
        ...FRESHNESS_PROPS,
        ...ERROR_PROPS,
      }),
      render: (argsOrValue, valueMaybe) => {
        const result = valueMaybe === undefined ? argsOrValue : valueMaybe;
        if (!result || result.ok !== true) return renderFailure("wiki_search", result ?? {});
        const lines = [`wiki_search — ${result.repo}`, `hits=${result.count} (${freshnessLine(result)})${result.truncated ? " truncated" : ""}`];
        for (const [index, hit] of (result.hits ?? []).entries()) {
          lines.push(`${index + 1}. [${hit.kind}] ${hit.id} — ${hit.title} · score ${hit.score}`);
          if (hit.snippet) lines.push(`   ${hit.snippet}`);
          if (hit.citations?.length) lines.push(`   cites: ${hit.citations.join(", ")}`);
        }
        if ((result.hits ?? []).length === 0) lines.push("no hits; try fewer or different words, or pass repository file paths");
        return textBlocks(lines.join("\n"));
      },
    },
    timeoutMs: TIMEOUT_MS.search,
    async execute(args, exec) {
      try {
        const repo = await deps.resolveRepo({ explicit: asText(args?.repo), sessionCwd: sessionCwdOf(exec) });
        if (!repo.ok) return failResult(repo);
        const loaded = await deps.loadSnapshot(repo.root);
        if (!loaded.ok) return failResult(loaded, { repo: repo.root });
        const snapshot = loaded.snapshot;
        const limit = clampInt(args?.limit, LIMITS.searchLimitDefault, LIMITS.searchLimitMax);
        // 打分有界（最多 20 条、~24 KiB）且与 limit 无关：先取满上限再截断，才能如实报告“还有更多”。
        const ranked = searchPure(snapshot, { query: asText(args?.query), files: args?.files, limit: LIMITS.searchLimitMax });
        const hits = ranked.hits.slice(0, limit);
        const fresh = await deps.freshness(repo.root, snapshot.sourceCommit);
        return {
          ok: true,
          repo: repo.root,
          query: asText(args?.query),
          count: hits.length,
          truncated: ranked.truncated || ranked.hits.length > hits.length,
          hits,
          ...fresh,
        };
      } catch (error) {
        deps.logWarn(`dsh-wiki: wiki_search failed: ${String(error?.message ?? error)}`);
        return failResult(INTERNAL_FAILURE);
      }
    },
  };
}

function pageDefinition(deps) {
  return {
    name: "wiki_page",
    description:
      "Read one wiki page in full: its markdown, the repository files it covers, and its navigation ids (parent, children, " +
      "siblings). Call it after wiki_search or wiki_cards names a page you need, then verify the page's path:line citations in " +
      "the code — the wiki is a map, not the source of truth. The markdown is capped at 16 KiB and the result says explicitly " +
      "when it was truncated.",
    parameters: {
      type: "object",
      properties: {
        id: STRING("Page id, as returned by wiki_search (kind page) or by the children/siblings of another page."),
        repo: REPO_PARAM,
      },
      required: ["id"],
    },
    output: {
      schema: outputSchema({
        repo: STRING("Resolved repository root."),
        page: {
          type: "object",
          required: ["id", "title", "markdown"],
          properties: {
            id: STRING("Page id."),
            title: STRING("Page title."),
            description: STRING("One-line page description."),
            parentId: FREE("Parent page id, or null for a root page."),
            filePaths: STRING_ARRAY("Repository files this page covers."),
            markdown: STRING("Page body, capped at 16 KiB (UTF-8)."),
          },
        },
        truncated: { type: "boolean", description: "True when the markdown was cut at the 16 KiB cap, or a children/siblings list was cut below its total." },
        children: STRING_ARRAY("Direct child page ids, in page order (at most 20; childrenTotal is the full count)."),
        siblings: STRING_ARRAY("Sibling page ids under the same parent (at most 20; siblingsTotal is the full count)."),
        childrenTotal: INTEGER("Number of direct child pages before the 20-id cap."),
        siblingsTotal: INTEGER("Number of sibling pages before the 20-id cap."),
        citations: STRING_ARRAY("path:line tokens this page cites; verify them in code."),
        closeIds: STRING_ARRAY("For an unknown id: the closest existing page ids."),
        ...ERROR_PROPS,
      }),
      render: (argsOrValue, valueMaybe) => {
        const result = valueMaybe === undefined ? argsOrValue : valueMaybe;
        if (!result || result.ok !== true) return renderFailure("wiki_page", result ?? {});
        const page = result.page ?? {};
        // 导航必须自证被截了：一页可以有 1000 个兄弟，静悄悄只发 20 个会让调用方以为那就是全部。
        const nav = (label, ids, total) => {
          const shown = Array.isArray(ids) ? ids : [];
          const hidden = Math.max(0, (Number.isSafeInteger(total) ? total : shown.length) - shown.length);
          return `${label}: ${shown.join(", ") || "(none)"}${hidden > 0 ? ` (+${hidden} more, ${total} total)` : ""}`;
        };
        const lines = [
          `# wiki_page — ${page.id} — ${page.title}`,
          `repo: ${result.repo}`,
          page.description ? `description: ${page.description}` : null,
          `parent: ${page.parentId ?? "(root)"} · ${nav("children", result.children, result.childrenTotal)} · ${nav("siblings", result.siblings, result.siblingsTotal)}`,
          (page.filePaths ?? []).length ? `files: ${page.filePaths.join(", ")}` : null,
          result.truncated
            ? "truncated: markdown is capped at 16 KiB and each navigation list at 20 ids (the *Total counts above are complete) — read the cited files for the rest"
            : null,
          null,
          page.markdown ?? "",
        ];
        return textBlocks(lines.filter((line) => line !== null).join("\n"));
      },
    },
    timeoutMs: TIMEOUT_MS.page,
    async execute(args, exec) {
      try {
        const repo = await deps.resolveRepo({ explicit: asText(args?.repo), sessionCwd: sessionCwdOf(exec) });
        if (!repo.ok) return failResult(repo);
        const loaded = await deps.loadSnapshot(repo.root);
        if (!loaded.ok) return failResult(loaded, { repo: repo.root });
        const result = getPagePure(loaded.snapshot, args?.id);
        return result.ok ? { ...result, repo: repo.root } : failResult(result, { repo: repo.root });
      } catch (error) {
        deps.logWarn(`dsh-wiki: wiki_page failed: ${String(error?.message ?? error)}`);
        return failResult(INTERNAL_FAILURE);
      }
    },
  };
}

function cardsDefinition(deps) {
  return {
    name: "wiki_cards",
    description:
      "List this repository's atomic wiki cards, filtered by tags (all must match), by repository file, or by kind. With no " +
      "filter it returns a compact index (id/title/kind/tags) so you can see what knowledge exists; with a filter it returns the " +
      "matching cards including their summary and key files. Use it after wiki_impact to read the invariants a change may have " +
      "broken. At most 50 rows; the wiki is a map, so verify the cited path:line in code.",
    parameters: {
      type: "object",
      properties: {
        tags: STRING_ARRAY("Tags that must ALL be present (case-insensitive)."),
        file: STRING("Repository-relative path; a directory entry covers everything under it at a path boundary."),
        kind: { type: "string", enum: [...CARD_KINDS], description: "Card kind." },
        repo: REPO_PARAM,
      },
    },
    output: {
      schema: outputSchema({
        repo: STRING("Resolved repository root."),
        filtered: { type: "boolean", description: "False when no filter was given, so rows are the compact index." },
        total: INTEGER("Number of matching cards before the 50-row cap."),
        truncated: { type: "boolean", description: "True when rows were cut at 50." },
        rows: {
          type: "array",
          description: "Card rows, at most 50.",
          items: {
            type: "object",
            required: ["id", "title", "kind"],
            properties: {
              id: STRING("Card id."),
              title: STRING("Card title."),
              kind: STRING("Card kind."),
              summary: STRING("Present only when a filter was applied."),
              tags: STRING_ARRAY("Card tags."),
              keyFiles: STRING_ARRAY("Present only when a filter was applied; path:line keys."),
              pageIds: STRING_ARRAY("Present only when a filter was applied; pages this card belongs to."),
            },
          },
        },
        ...ERROR_PROPS,
      }),
      render: (argsOrValue, valueMaybe) => {
        const result = valueMaybe === undefined ? argsOrValue : valueMaybe;
        if (!result || result.ok !== true) return renderFailure("wiki_cards", result ?? {});
        const lines = [`wiki_cards — ${result.repo}`, `rows=${(result.rows ?? []).length}/${result.total}${result.filtered ? " (filtered)" : " (index)"}${result.truncated ? " truncated at 50" : ""}`];
        for (const row of result.rows ?? []) {
          lines.push(`- [${row.kind}] ${row.id} — ${row.title}${row.tags?.length ? ` · ${row.tags.join(",")}` : ""}`);
          if (row.summary) lines.push(`  ${row.summary}`);
          if (row.keyFiles?.length) lines.push(`  key files: ${row.keyFiles.join(", ")}`);
          if (row.pageIds?.length) lines.push(`  pages: ${row.pageIds.join(", ")}`);
        }
        if ((result.rows ?? []).length === 0) lines.push("no cards match; drop a filter or list the index first");
        return textBlocks(lines.join("\n"));
      },
    },
    timeoutMs: TIMEOUT_MS.cards,
    async execute(args, exec) {
      try {
        const repo = await deps.resolveRepo({ explicit: asText(args?.repo), sessionCwd: sessionCwdOf(exec) });
        if (!repo.ok) return failResult(repo);
        const loaded = await deps.loadSnapshot(repo.root);
        if (!loaded.ok) return failResult(loaded, { repo: repo.root });
        const result = cardsPure(loaded.snapshot, { tags: args?.tags, file: asText(args?.file), kind: asText(args?.kind) });
        return { ...result, repo: repo.root };
      } catch (error) {
        deps.logWarn(`dsh-wiki: wiki_cards failed: ${String(error?.message ?? error)}`);
        return failResult(INTERNAL_FAILURE);
      }
    },
  };
}

function impactDefinition(deps) {
  return {
    name: "wiki_impact",
    description:
      "Map repository files you changed (or are about to change) to the wiki pages and knowledge cards that cover them, using " +
      "the same path normalization as the wiki builder's diff-impact (backslashes, leading ./ and trailing :line are ignored; a " +
      "directory covers its children at a path boundary). Call it AFTER a change to see which documented invariants you may " +
      "have broken, then read those pages with wiki_page. It also reports wiki freshness, so you can tell whether the mapping " +
      "is based on current knowledge. At most 50 input files; each row lists at most 10 pages and 10 cards and carries " +
      "pagesTotal/cardsTotal plus a row-level truncated flag when that list was cut, so a cut is never silent.",
    parameters: {
      type: "object",
      properties: {
        files: STRING_ARRAY("Repository-relative paths that changed. At most 50 are evaluated."),
        repo: REPO_PARAM,
      },
      required: ["files"],
    },
    output: {
      schema: outputSchema({
        repo: STRING("Resolved repository root."),
        files: {
          type: "array",
          description: "One row per evaluated path, in input order.",
          items: {
            type: "object",
            required: ["path", "pages", "cards", "mapped"],
            properties: {
              path: STRING("Normalized input path."),
              pages: {
                type: "array",
                description: "Pages that cover this path (at most 10; pagesTotal is the full count).",
                items: {
                  type: "object",
                  required: ["id", "title"],
                  properties: { id: STRING("Page id."), title: STRING("Page title.") },
                },
              },
              cards: {
                type: "array",
                description: "Cards that cover this path (at most 10; cardsTotal is the full count).",
                items: {
                  type: "object",
                  required: ["id", "title"],
                  properties: { id: STRING("Card id."), title: STRING("Card title.") },
                },
              },
              mapped: { type: "boolean", description: "True when at least one page or card covers this path." },
              pagesTotal: INTEGER("Pages that cover this path before the 10-item cap."),
              cardsTotal: INTEGER("Cards that cover this path before the 10-item cap."),
              truncated: { type: "boolean", description: "True when this row's pages or cards were cut below their total; read the rest with wiki_page / wiki_cards." },
            },
          },
        },
        unmapped: STRING_ARRAY("Paths no page or card covers."),
        truncated: { type: "boolean", description: "True when the input list was cut at 50 paths, the byte budget dropped rows, or any row was cut below its pagesTotal/cardsTotal." },
        ...FRESHNESS_PROPS,
        updateAvailable: { type: "boolean", description: "True when the wiki is behind HEAD." },
        ...ERROR_PROPS,
      }),
      render: (argsOrValue, valueMaybe) => {
        const result = valueMaybe === undefined ? argsOrValue : valueMaybe;
        if (!result || result.ok !== true) return renderFailure("wiki_impact", result ?? {});
        const lines = [`wiki_impact — ${result.repo}`, `${(result.files ?? []).length} path(s) (${freshnessLine(result)})`];
        for (const row of result.files ?? []) {
          lines.push(`- ${row.path}${row.mapped ? "" : "  (unmapped)"}`);
          if (row.pages.length) lines.push(`  pages: ${row.pages.map((page) => page.id).join(", ")}`);
          if (row.cards.length) lines.push(`  cards: ${row.cards.map((card) => card.id).join(", ")}`);
          // 行内的截断必须让调用方看见：第 11 页不是“不存在”，只是没列出来。
          if (row.truncated) {
            lines.push(`  cut: ${row.pagesTotal} page(s) and ${row.cardsTotal} card(s) match — only the first ${LIMITS.rowRefItems} of each is listed; read the rest with wiki_page / wiki_cards`);
          }
        }
        if (result.unmapped?.length) lines.push(`unmapped: ${result.unmapped.join(", ")}`);
        if (result.stale === true) lines.push(`wiki is stale (behind by ${result.behind ?? "unknown"}); read the pages before trusting them`);
        if (result.stale === "unknown") lines.push("wiki freshness is unknown (no git or no recorded sourceCommit): verifying citations in code is the only safe check");
        return textBlocks(lines.join("\n"));
      },
    },
    timeoutMs: TIMEOUT_MS.impact,
    async execute(args, exec) {
      try {
        const repo = await deps.resolveRepo({ explicit: asText(args?.repo), sessionCwd: sessionCwdOf(exec) });
        if (!repo.ok) return failResult(repo);
        const loaded = await deps.loadSnapshot(repo.root);
        if (!loaded.ok) return failResult(loaded, { repo: repo.root });
        const result = impactPure(loaded.snapshot, args?.files);
        const fresh = await deps.freshness(repo.root, loaded.snapshot.sourceCommit);
        return { ...result, repo: repo.root, ...fresh };
      } catch (error) {
        deps.logWarn(`dsh-wiki: wiki_impact failed: ${String(error?.message ?? error)}`);
        return failResult(INTERNAL_FAILURE);
      }
    },
  };
}

function statusDefinition(deps) {
  return {
    name: "wiki_status",
    description:
      "Report this repository's wiki identity and freshness: repo id, title, language, page and card counts, the commit recorded " +
      "when the wiki was generated (sourceCommit), the current git HEAD, how many commits the wiki is behind, and whether it is " +
      "stale. Call it when you are about to rely on wiki content and need to know whether that knowledge still matches HEAD. " +
      'stale is "unknown" — never false by assumption — when git or the recorded commit is unavailable.',
    parameters: {
      type: "object",
      properties: {
        repo: REPO_PARAM,
      },
    },
    output: {
      schema: outputSchema({
        repo: STRING("Resolved repository root."),
        repoId: STRING("Repository id recorded by the wiki."),
        title: STRING("Wiki title."),
        language: STRING("Wiki body language."),
        pageCount: INTEGER("Number of pages."),
        cardCount: INTEGER("Number of knowledge cards."),
        ...FRESHNESS_PROPS,
        updateAvailable: { type: "boolean", description: "True when the wiki is behind HEAD." },
        ...ERROR_PROPS,
      }),
      render: (argsOrValue, valueMaybe) => {
        const result = valueMaybe === undefined ? argsOrValue : valueMaybe;
        if (!result || result.ok !== true) return renderFailure("wiki_status", result ?? {});
        const changed = Array.isArray(result.changedFiles) ? result.changedFiles : [];
        const preview = changed.slice(0, CHANGED_PREVIEW);
        const lines = [
          `wiki_status — ${result.title ?? result.repoId ?? result.repo}`,
          `repo: ${result.repo}`,
          `language: ${result.language ?? "(unrecorded)"} · pages: ${result.pageCount} · cards: ${result.cardCount}`,
          `freshness: ${freshnessLine(result)}`,
          // 计数只数**源码**：wiki 自己的页面被 pathspec 排除，重新生成一次不会把这个数字变成 0。
          result.stale === true
            ? `the wiki no longer matches HEAD: ${changed.length} source file(s) changed (the wiki's own pages are excluded from this count) — regenerate, or verify every citation in code`
            : result.stale === "unknown"
              ? "freshness unknown (no git or no recorded sourceCommit): verify citations in code before trusting the wiki"
              : "the wiki matches HEAD",
        ];
        if (changed.length > 0) {
          // 预览只有前 20 条：截断必须自证，“first 20 of 137” 才是调用方需要的那句话。
          const shown = changed.length > preview.length ? `first ${preview.length} of ${changed.length}` : `all ${preview.length}`;
          // 200 就是 changedFiles 的上限：这时 N 只是“读到的条数”，别让调用方当成总数的下界。
          const capped = changed.length >= LIMITS.changedFilesMax ? ` (the list itself stops at ${LIMITS.changedFilesMax})` : "";
          lines.push(`changed source files — ${shown}${capped}: ${preview.join(", ")}`);
        } else if (result.stale === true) {
          // 空列表不等于“什么都没变”：stale 只比 commit，wiki 目录被排除，所以只有 wiki 页面的提交落在这里。
          // git 的 diff 读不到时列表同样是空的，两者无法区分，所以那半句必须一起说。
          lines.push("changed source files: none — the commits since sourceCommit changed only the wiki directory (excluded from this list), so regenerating the wiki cannot clear this flag; a git diff that could not run reads the same");
        }
        return textBlocks(lines.join("\n"));
      },
    },
    timeoutMs: TIMEOUT_MS.status,
    async execute(args, exec) {
      try {
        const repo = await deps.resolveRepo({ explicit: asText(args?.repo), sessionCwd: sessionCwdOf(exec) });
        if (!repo.ok) return failResult(repo);
        const loaded = await deps.loadSnapshot(repo.root);
        if (!loaded.ok) return failResult(loaded, { repo: repo.root });
        const summary = snapshotSummary(loaded.snapshot);
        const fresh = await deps.freshness(repo.root, summary.sourceCommit);
        return { ok: true, repo: repo.root, ...summary, ...fresh };
      } catch (error) {
        deps.logWarn(`dsh-wiki: wiki_status failed: ${String(error?.message ?? error)}`);
        return failResult(INTERNAL_FAILURE);
      }
    },
  };
}

/**
 * 构造五个工具定义。
 * @param {{resolveRepo: Function, loadSnapshot: Function, freshness: Function, logWarn: Function}} deps
 * @returns {object[]} 可直接交给 ctx.tools.register 的普通对象
 */
export function buildToolDefinitions(deps) {
  return [
    searchDefinition(deps),
    pageDefinition(deps),
    cardsDefinition(deps),
    impactDefinition(deps),
    statusDefinition(deps),
  ];
}

/**
 * 注册工具。tools 是 apply() 用 ctx.get("tools") **惰性**解析出来的服务：`tools` 不是硬依赖（见 lib/index.js
 * 顶部 inject 的说明），所以这里可能是 undefined。没有该服务（含更老的 Host 连 ctx.get 都没有）时只记
 * **一条** warning 并返回 []，这样 apply() 永远不会抛，技能/命令/路由照旧工作（FR-012）。
 * 单个注册失败（例如同名工具已存在）也只记一条 warning，不中断其余工具。
 * @param {{register?: Function}|undefined} tools ctx.get("tools") 的结果
 * @param {{resolveRepo: Function, loadSnapshot: Function, freshness: Function, logWarn: Function}} deps
 * @returns {Function[]} 精确的 disposer 列表
 */
export function registerWikiTools(tools, deps) {
  if (typeof tools?.register !== "function") {
    deps.logWarn(
      "dsh-wiki: this Host exposes no tools service, so the five wiki tools are not registered "
      + "(resolved lazily via ctx.get(\"tools\"); \"tools\" is not in inject, so the plugin still loads); "
      + "the wiki keeps working without agent tools: the wiki-knowledge skill, the /wiki command and the /dsh-wiki routes are all registered",
    );
    return [];
  }
  const disposers = [];
  for (const definition of buildToolDefinitions(deps)) {
    try {
      const dispose = tools.register(definition);
      if (typeof dispose === "function") disposers.push(dispose);
    } catch (error) {
      // 同名工具/注册期 schema 拒绝都属于“这个工具不可用”，不是插件加载失败。
      deps.logWarn(`dsh-wiki: could not register the ${definition.name} tool: ${String(error?.message ?? error)}`);
    }
  }
  return disposers;
}
