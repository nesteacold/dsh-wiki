// dsh-wiki — 知识检索的纯函数层（feature 014）。
// 本模块不碰宿主、不读盘、不看时钟、不联网：同一个输入一定得到逐字节相同的输出。
// 盘上的字节由调用方（lib/index.js）用既有的受控读证明过以后才交进来；这里只做解析、评分与映射，
// 因此评分/映射/新鲜度算术可以脱离 Host 单测，也可以被将来的 MCP 包装复用。
import path from "node:path";

// wiki.json 的 schema 标识：只接这一个。别的值不是“更新的格式”，是陌生的格式。
export const WIKI_SCHEMA = "repo-wiki-local/1";

// 上限是契约的一部分（FR-015）：工具调用永远不能灌爆上下文窗口。
// 它们同时被写进各自的 description，因为宿主接受的 raw JSON Schema 子集里没有 minimum/maximum
//（见 dsh-tools 的 assertSupportedJsonSchema：只有 type/oneOf/properties/required/
// additionalProperties/items/enum/const + description/title/default/examples），
// 所以边界只能在这里与工具层执行。
export const LIMITS = Object.freeze({
  searchLimitDefault: 5,
  searchLimitMax: 20,
  snippetChars: 400,
  citationsMax: 8,
  // 搜索命中带更少的引用：20 条命中 × 每条 8 个引用会把一次检索变成几十 KB。
  searchCitations: 4,
  citationChars: 120,
  pageMarkdownBytes: 16 * 1024,
  cardRows: 50,
  impactFilesMax: 50,
  changedFilesMax: 200,
  queryTermsMax: 12,
  // 字段级上限：wiki.json 的内容由模型生成，不能假设 id/标题/摘要/列表是短的。
  // 没有这些上限，“50 行”仍然可以被一行 1 MB 的摘要撑爆。
  idChars: 200,
  titleChars: 200,
  descriptionChars: 400,
  listItems: 20,
  listItemChars: 200,
  // 结果行里的**引用列表**（卡片 tags/keyFiles/pageIds、impact 的 pages/cards、搜索命中的 pageIds）：
  // 条数与单条长度都更紧。没有这一层，一行仍可被“20 个 200 字符的 id”撑到 4 KB 以上。
  rowRefItems: 10,
  rowRefChars: 120,
  // 结果级字节预算（最后一道闸门）：即使每个字段都顶到上限，一次调用也不会超过这些字节。
  // 超出时按确定顺序丢弃尾部的命中/行，并置 truncated。
  searchResultBytes: 24 * 1024,
  cardsResultBytes: 24 * 1024,
  impactResultBytes: 24 * 1024,
  // 搜索正文上限（字符）。markdown 本身不封顶（wiki_page 只发前 16 KiB），但一页正文若有 5 MB，
  // 每次 search 都要把它整份 toLowerCase：一次检索退化成对几百 KB 的纯复制。
  // 取 64 KiB —— 是 wiki_page 可见上限（16 KiB）的 4 倍：正文里靠后的内容照样能搜到，病态输入被封住。
  searchMarkdownChars: 64 * 1024,
  // snippetOf 折叠空白前先截到这里：输出只有 400 字符，4 KiB 足够，且不对 5 MB 正文跑正则。
  snippetSourceChars: 4 * 1024,
});

export const CARD_KINDS = Object.freeze(["module", "concept", "api"]);

/** 全库唯一的失败形状：稳定 code + 固定短句，绝不带异常文本、命令或路径以外的细节。 */
const failure = (code, error, extra) => ({ ok: false, code, error, ...(extra ?? {}) });

const asString = (value) => (typeof value === "string" ? value : value == null ? "" : String(value));
const asStrings = (value) =>
  Array.isArray(value) ? value.filter((entry) => entry != null).map(asString) : typeof value === "string" ? [value] : [];

/** 定长截断（字符数）：只用来给“模型生成的内容”设上限，不做语义处理。 */
const clip = (value, max) => {
  const text = asString(value);
  return text.length <= max ? text : text.slice(0, max);
};

/** 有界字符串列表：条数与单条长度都封顶，顺序保持。 */
const clipList = (value, maxItems = LIMITS.listItems, maxChars = LIMITS.listItemChars) =>
  asStrings(value).slice(0, maxItems).map((entry) => clip(entry, maxChars));

/** 结果行里的引用列表：更紧的上限（见 LIMITS.rowRefItems/rowRefChars）。 */
const clipRefs = (value) => clipList(value, LIMITS.rowRefItems, LIMITS.rowRefChars);

/**
 * 结果级字节预算：按给定顺序保留前缀，直到再加一条就会越界为止（第一条总是保留，
 * 否则“有命中却什么都不返回”比超一点点更糟）。纯函数、顺序确定。
 */
function keepWithinBytes(items, maxBytes, serialize = (item) => JSON.stringify(item)) {
  const kept = [];
  let bytes = 0;
  for (const item of items) {
    const size = Buffer.byteLength(serialize(item), "utf8") + 2;
    if (kept.length > 0 && bytes + size > maxBytes) break;
    kept.push(item);
    bytes += size;
  }
  return { kept, truncated: kept.length < items.length };
}

/**
 * 路径归一，语义与构建器 `diff-impact` 的 `_diff_path` 完全一致：
 * 反斜杠 → 正斜杠、去掉尾部 `:line` / `:start-end`、去掉 `./` 前缀、去掉尾部 `/`。
 * 两边必须用同一套归一，否则“改了这个文件”会算到别的条目上。
 */
export function normalizePath(value) {
  let result = asString(value).trim().replace(/\\/g, "/");
  // 显式 `[0-9]`：JS 的 `\d` 本来就是 ASCII 数字，写成字符组是为了让“只认 ASCII 数字”成为可见的契约。
  // 残余差异（不改构建器）：Python 的 `\d` 还匹配 Unicode 数字（Nd），构建器会剥掉 `:١٢` 而行号剥离
  // 在这里不会；Python 的 `strip()` 还剥 \x1c-\x1f 与 \x85，JS 的 `trim()` 不剥 —— 两类字符都不会出现在
  // git 输出的仓库路径里，所以这里不为它们编造归一化，差异如实记录在报告里。
  result = result.replace(/:[0-9]+(?:-[0-9]+)?$/, "");
  while (result.startsWith("./")) result = result.slice(2);
  return result.replace(/\/+$/, "");
}

/**
 * 精确命中，或目录前缀在**路径边界**上命中：`lib` 覆盖 `lib/a.py`，不覆盖 `library/a.py`。
 * 与构建器 `_diff_match` 同义。
 */
export function matchesEntry(file, entry) {
  return Boolean(entry) && (file === entry || file.startsWith(`${entry}/`));
}

/**
 * 从正文里抽出反引号包裹的 `path[:line]` 引用，让每个命中都能回到代码里核对。
 * 只收“看起来在仓库内”的形态：不接受绝对路径、盘符、URL 与含空白的 token（构建器的引用机检
 * 同样只覆盖 ASCII 相对路径）；顺序保持原文顺序，去重，有界。
 */
export function extractCitations(text, limit = LIMITS.citationsMax) {
  const source = asString(text);
  const out = [];
  const seen = new Set();
  const re = /`([^`\n]{1,200})`/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    if (out.length >= limit) break;
    const token = match[1].trim();
    if (!token || token.length > LIMITS.citationChars || seen.has(token)) continue;
    const normalized = normalizePath(token);
    if (!normalized) continue;
    // 绝对/外部形态一律不是仓库内引用。
    if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) continue;
    if (normalized.includes("://") || /\s/.test(normalized)) continue;
    // 任何 `..` 段都指向仓库外：`../x` 与 `a/../../x` 不是可回代码核对的引用。
    if (normalized.split("/").some((segment) => segment === "..")) continue;
    // 必须像一条仓库内路径：含分隔符（目录），或“点号前有含字母的路径段、点号后是以字母开头的扩展名”。
    // 后半句把 `1.2.3`、`v0.2.2-rc.1` 这类**版本号**挡在外面：它们的“扩展名”是数字，不是文件后缀；
    // `12:30` 在行号剥离后只剩数字，同样不是路径。
    // 仍无法区分 `obj.method` 与根目录文件 `AGENTS.md`（形状完全相同），后者是合法引用，所以保留。
    const looksLikePath = normalized.includes("/")
      || /^[^/\s]*[A-Za-z][^/\s]*\.[A-Za-z][A-Za-z0-9]{0,9}$/.test(normalized);
    if (!looksLikePath) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

/** 声明式引用（页面的 filePaths / 卡片的 keyFiles）本身就是 `path[:line]`，可直接当引用用。 */
const looksLikeRepoRef = (normalized) => Boolean(normalized)
  && !normalized.startsWith("/")
  && !/^[A-Za-z]:/.test(normalized)
  && !normalized.includes("://")
  && !/\s/.test(normalized);

/**
 * 一条命中的引用列表：先放条目**声明**的路径（filePaths/keyFiles），再放正文里反引号包裹的引用。
 * 两者都是可回代码核对的 `path[:line]`；去重、有界，顺序确定。
 */
export function citationsOf(entries, text, limit = LIMITS.citationsMax) {
  const out = [];
  const seen = new Set();
  const push = (token) => {
    if (!token || token.length > LIMITS.citationChars || out.length >= limit || seen.has(token)) return;
    seen.add(token);
    out.push(token);
  };
  for (const entry of Array.isArray(entries) ? entries : []) {
    const raw = asString(entry).trim();
    if (looksLikeRepoRef(normalizePath(raw))) push(raw);
  }
  for (const token of extractCitations(text, limit)) push(token);
  return out;
}

/** 单行片段：折叠空白后截断，让预览不会把整页正文带进结果。 */
function snippetOf(text) {
  // 先按 snippetSourceChars 截断再折叠：输出只有 400 字符，4 KiB 的输入足够，
  // 却让“描述为空、正文 5 MB”的页面不会在每次命中时都跑一遍全文空白正则。
  const collapsed = clip(asString(text), LIMITS.snippetSourceChars).replace(/\s+/g, " ").trim();
  if (collapsed.length <= LIMITS.snippetChars) return collapsed;
  return `${collapsed.slice(0, LIMITS.snippetChars - 1).trimEnd()}…`;
}

/** 查询词：小写、按非字母数字切分、长度 >= 2、去重、有界且有序（顺序影响评分，必须确定）。 */
function queryTerms(query) {
  const terms = [];
  const seen = new Set();
  for (const raw of asString(query).toLowerCase().split(/[^0-9a-z\u00c0-\u024f\u4e00-\u9fff]+/)) {
    if (raw.length < 2) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    terms.push(raw);
    if (terms.length >= LIMITS.queryTermsMax) break;
  }
  return terms;
}

/** 出现次数（最多计 `cap` 次）：正文里提到得越多，越可能是这页的主题。 */
function countOccurrences(haystack, term, cap) {
  if (!haystack) return 0;
  let count = 0;
  let at = haystack.indexOf(term);
  while (at !== -1 && count < cap) {
    count += 1;
    at = haystack.indexOf(term, at + term.length);
  }
  return count;
}

/**
 * 与构建器 `cmd_diff_impact` 完全一致的 id 规则（scripts/build_wiki_site.py:1498、:1509）：
 * 有 id 就用 id；只有 id 缺失（None）才退回 title。选定的值若为空白（含空字符串 id），
 * 构建器直接跳过这一条，**不会**再退回 title —— 这里照抄，不发明更好的回退。
 */
function builderRawId(entry) {
  const raw = entry.id != null ? entry.id : entry.title;
  return raw == null || !asString(raw).trim() ? null : raw;
}

/** 解析一次 wiki.json：只认一种 schema，畸形内容整份拒绝，绝不把半个 wiki 当数据用。 */
function normalizePage(raw, index) {
  const page = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const rawId = builderRawId(page);
  // 构建器跳过既无 id 又无 title 的页面；这里也跳过，而不是编一个 `page-N`：
  // 那个编号既不等于构建器的答案，也会随数组顺序漂移（同一个页面换个位置就换了 id）。
  if (rawId === null) return null;
  const markdown = asString(page.markdown);
  // 输出用（有界）与匹配用（完整）分开：裁剪过的列表会让“第 21 个 filePaths”在工具里隐形，
  // 而构建器 diff-impact 用的是完整列表（FR-009 要求两边给出同一个答案）。
  const filePathsAll = asStrings(page.filePaths);
  return {
    id: clip(asString(rawId), LIMITS.idChars),
    parentId: page.parentId == null || page.parentId === "" ? null : clip(asString(page.parentId), LIMITS.idChars),
    order: typeof page.order === "number" && Number.isFinite(page.order) ? page.order : index + 1,
    title: clip(asString(page.title) || asString(rawId), LIMITS.titleChars),
    description: clip(asString(page.description), LIMITS.descriptionChars),
    filePaths: clipList(filePathsAll),
    filePathsAll,
    markdown,
    // 搜索只看有界前缀（见 LIMITS.searchMarkdownChars）；小写化在这里做一次，而不是每次检索都做。
    markdownSearch: clip(markdown, LIMITS.searchMarkdownChars).toLowerCase(),
  };
}

function normalizeCard(raw, index) {
  const card = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const rawId = builderRawId(card);
  // 卡片走同一条构建器规则（build_wiki_site.py:613-616 与 diff-impact 的 :1509 同义）。
  if (rawId === null) return null;
  const keyFilesAll = asStrings(card.keyFiles);
  return {
    id: clip(asString(rawId), LIMITS.idChars),
    title: clip(asString(card.title) || asString(rawId), LIMITS.titleChars),
    // kind 原样保留（未知值照样能筛出来）；CARD_KINDS 只用于 schema 的 enum 与文档。
    kind: clip(asString(card.kind), 40),
    summary: clip(asString(card.summary), LIMITS.descriptionChars),
    keyFiles: clipList(keyFilesAll),
    keyFilesAll,
    related: clipList(card.related),
    tags: clipList(card.tags),
    pageIds: clipList(card.pageIds),
  };
}

/**
 * 把 `wiki.json` 的文本解析成快照。纯函数：只依赖入参。
 * @param {string} text wiki.json 的字节（已由调用方证明是项目内的普通文件）
 * @param {{root?: string, wikiDirName?: string, metaText?: string}} options
 *   metaText 是 `generation-meta.json` 的文本（可缺省）：`sourceCommit` 只在那里（实测 wiki.json 没有这个键）。
 * @returns {{ok: true, snapshot: object} | {ok: false, code: string, error: string, wikiPath: string}}
 */
export function parseSnapshot(text, options = {}) {
  const wikiDirName = typeof options.wikiDirName === "string" && options.wikiDirName ? options.wikiDirName : ".dsh-wiki";
  const root = typeof options.root === "string" && options.root ? options.root : null;
  const wikiPath = root ? path.join(root, wikiDirName, "wiki.json") : path.join(wikiDirName, "wiki.json");
  // 错误短句直接进模型上下文：里面只能出现 **wiki 相对**路径（<wikiDirName>/wiki.json）。绝对宿主路径无用，
  // 还会把宿主目录布局带出去。结构化字段 wikiPath 仍保留绝对形式，给需要它的内部调用方。
  const wikiRel = path.join(wikiDirName, "wiki.json");

  let raw;
  try {
    raw = JSON.parse(asString(text));
  } catch {
    // 解析器的原始文本可能夹带片段内容：只报固定短句。
    return { ...failure("wiki-invalid", `the wiki file is not valid JSON: ${wikiRel}`), wikiPath };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...failure("wiki-invalid", `the wiki file is not a JSON object: ${wikiRel}`), wikiPath };
  }
  if (Object.hasOwn(raw, "schema") && raw.schema !== WIKI_SCHEMA) {
    return { ...failure("wiki-schema-unsupported", `unsupported wiki schema (expected ${WIKI_SCHEMA}): ${wikiRel}`), wikiPath };
  }
  if (!Array.isArray(raw.pages)) {
    return { ...failure("wiki-invalid", `the wiki file has no pages array: ${wikiRel}`), wikiPath };
  }

  // 既无 id 又无 title 的条目 normalize* 返回 null（构建器同样跳过它们）。
  const pages = raw.pages.filter((page) => page && typeof page === "object").map(normalizePage).filter(Boolean);
  const cards = Array.isArray(raw.cards)
    ? raw.cards.filter((card) => card && typeof card === "object").map(normalizeCard).filter(Boolean)
    : [];
  const meta = (() => {
    if (typeof options.metaText !== "string" || !options.metaText) return null;
    try {
      const parsed = JSON.parse(options.metaText);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch { return null; }
  })();
  const sourceCommit = typeof meta?.sourceCommit === "string" && meta.sourceCommit.trim()
    ? meta.sourceCommit.trim()
    : (typeof raw.sourceCommit === "string" && raw.sourceCommit.trim() ? raw.sourceCommit.trim() : null);

  return {
    ok: true,
    snapshot: {
      root,
      wikiDirName,
      wikiPath,
      repoId: asString(raw.repoId) || null,
      title: asString(raw.title) || (root ? path.basename(root) : null),
      language: asString(raw.language) || null,
      sourceCommit,
      pages,
      cards,
      pageById: firstById(pages),
      cardById: firstById(cards),
    },
  };
}

/**
 * id → 条目，**第一次出现**的那条胜出。构建器生成 wiki.json 时就用 `_safe_id` 去重了 id，
 * 所以重复只可能来自手写/合并的 wiki；此时 `search` 会为两次出现各给一条命中，
 * `wiki_page` 却只能返回一条 —— 取第一条至少让“先看到的命中”与“读到的页面”一致，
 * 而且不随对象迭代顺序（也就是“最后一条胜出”）漂移。
 */
function firstById(items) {
  const map = new Map();
  for (const item of items) if (!map.has(item.id)) map.set(item.id, item);
  return map;
}

/** 计数摘要（无评分，纯投影）。 */
export function snapshotSummary(snapshot) {
  return {
    repoId: snapshot?.repoId ?? null,
    title: snapshot?.title ?? null,
    language: snapshot?.language ?? null,
    sourceCommit: snapshot?.sourceCommit ?? null,
    pageCount: Array.isArray(snapshot?.pages) ? snapshot.pages.length : 0,
    cardCount: Array.isArray(snapshot?.cards) ? snapshot.cards.length : 0,
  };
}

/**
 * 确定性打分：页面标题/描述/正文 + 卡片标题/摘要/标签/关键文件；文件命中是强信号。
 * 没有任何随机数、时钟或对象迭代顺序依赖；同分按 (kind, id) 排序，因此同样的输入一定同样的输出。
 * @returns {Array<object>} 命中，已排序、已截断到 limit
 */
export function search(snapshot, options = {}) {
  const query = asString(options.query);
  const terms = queryTerms(query);
  const files = (Array.isArray(options.files) ? options.files : []).map(normalizePath).filter(Boolean);
  const limit = clampLimit(options.limit, LIMITS.searchLimitDefault, LIMITS.searchLimitMax);
  if (terms.length === 0 && files.length === 0) return [];

  const lowered = query.trim().toLowerCase();
  const hits = [];

  const fileScore = (entries) => {
    if (files.length === 0) return 0;
    let score = 0;
    for (const entry of entries.map(normalizePath)) {
      if (!entry) continue;
      for (const file of files) {
        if (file === entry) score += 100;
        else if (matchesEntry(file, entry) || matchesEntry(entry, file)) score += 60;
      }
    }
    return score;
  };

  for (const page of snapshot?.pages ?? []) {
    const title = page.title.toLowerCase();
    const description = page.description.toLowerCase();
    // 只搜有界前缀（LIMITS.searchMarkdownChars，解析时已小写化）：正文长度由模型生成，不能假设它小。
    const markdown = page.markdownSearch;
    let score = 0;
    for (const term of terms) {
      if (title === term) score += 120;
      else if (title.includes(term)) score += 60;
      if (description.includes(term)) score += 20;
      score += 6 * countOccurrences(markdown, term, 5);
    }
    // 整串精确查询优先于散词命中。
    if (lowered && title.includes(lowered)) score += 30;
    // 文件匹配用**完整**列表（与构建器 diff-impact 同源），输出仍用裁剪后的列表。
    score += fileScore(page.filePathsAll);
    if (score > 0) {
      hits.push({
        id: page.id,
        kind: "page",
        title: page.title,
        score,
        snippet: snippetOf(page.description || page.markdown),
        citations: citationsOf(page.filePaths, page.markdown, LIMITS.searchCitations),
        pageIds: clipRefs([page.id]),
      });
    }
  }

  for (const card of snapshot?.cards ?? []) {
    const title = card.title.toLowerCase();
    const summary = card.summary.toLowerCase();
    const tags = card.tags.map((tag) => tag.toLowerCase());
    let score = 0;
    for (const term of terms) {
      if (title === term) score += 110;
      else if (title.includes(term)) score += 55;
      if (summary.includes(term)) score += 18;
      if (tags.includes(term)) score += 30;
      score += 4 * countOccurrences(card.keyFiles.join(" ").toLowerCase(), term, 3);
    }
    if (lowered && title.includes(lowered)) score += 25;
    score += fileScore(card.keyFilesAll);
    if (score > 0) {
      hits.push({
        id: card.id,
        kind: "card",
        title: card.title,
        score,
        snippet: snippetOf(card.summary),
        citations: citationsOf(card.keyFiles, card.summary, LIMITS.searchCitations),
        pageIds: clipRefs(card.pageIds),
      });
    }
  }

  hits.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (left.kind !== right.kind) return left.kind < right.kind ? -1 : 1;
    if (left.id === right.id) return 0;
    return left.id < right.id ? -1 : 1;
  });
  const limited = hits.slice(0, limit);
  const budget = keepWithinBytes(limited, LIMITS.searchResultBytes);
  return { hits: budget.kept, truncated: limited.length > budget.kept.length || hits.length > limited.length };
}

function clampLimit(value, fallback, max) {
  if (value === undefined || value === null) return fallback;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  const integer = Math.trunc(number);
  if (integer < 1) return 1;
  return Math.min(integer, max);
}

/** 只给纯函数用的 UTF-8 字节截断：超限时退到码点边界，绝不产生半个字符。 */
function truncateUtf8(text, maxBytes) {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return { text: buffer.subarray(0, end).toString("utf8"), truncated: true };
}

const byPageOrder = (left, right) => {
  if (left.order !== right.order) return left.order - right.order;
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
};

/**
 * 一页的完整 markdown + 导航信息。markdown 硬上限 16 KiB（按 UTF-8 字节），children/siblings 各限 20 条，
 * 两者的截断都置 truncated，并用 childrenTotal/siblingsTotal 给出完整计数 —— 调用方不必猜还有没有下一条。
 * 未知 id 返回带“相近 id”的定型错误，绝不猜一个页面给调用方。
 */
export function getPage(snapshot, id) {
  const wanted = asString(id).trim();
  if (!wanted) return failure("page-id-required", "wiki_page needs a page id (use wiki_search or wiki_cards to find one)");
  const page = snapshot?.pageById?.get(wanted);
  if (!page) {
    const close = [...(snapshot?.pages ?? [])]
      .filter((entry) => entry.id.toLowerCase().includes(wanted.toLowerCase()) || wanted.toLowerCase().includes(entry.id.toLowerCase()))
      .map((entry) => entry.id)
      .sort()
      .slice(0, 5);
    return failure("page-not-found", `no page "${wanted}" in this wiki`, { closeIds: close });
  }
  const pages = snapshot?.pages ?? [];
  // 导航列表同样有界：一页可以对着一千个子页，列表不能因此把结果撑大。
  // 但“被截”必须能看见：总数单独报，并折进 truncated，调用方不用猜还有没有第 21 个。
  const childrenAll = pages.filter((entry) => entry.parentId === page.id).sort(byPageOrder).map((entry) => entry.id);
  const siblingsAll = pages
    .filter((entry) => entry.id !== page.id && entry.parentId === page.parentId)
    .sort(byPageOrder)
    .map((entry) => entry.id);
  const children = childrenAll.slice(0, LIMITS.listItems);
  const siblings = siblingsAll.slice(0, LIMITS.listItems);
  const markdown = truncateUtf8(page.markdown, LIMITS.pageMarkdownBytes);
  return {
    ok: true,
    page: {
      id: page.id,
      title: page.title,
      description: page.description,
      parentId: page.parentId,
      filePaths: [...page.filePaths],
      markdown: markdown.text,
    },
    truncated: markdown.truncated || children.length < childrenAll.length || siblings.length < siblingsAll.length,
    children,
    siblings,
    childrenTotal: childrenAll.length,
    siblingsTotal: siblingsAll.length,
    citations: citationsOf(page.filePaths, page.markdown),
  };
}

/**
 * 卡片筛选：tags 全含（大小写无关）、file 走同一套路径归一/边界前缀、kind 是枚举。
 * 无筛选返回紧凑索引（id/title/kind/tags）；任何情况下最多 50 行。
 */
export function cards(snapshot, options = {}) {
  const tags = (Array.isArray(options.tags) ? options.tags : []).map((tag) => asString(tag).trim().toLowerCase()).filter(Boolean);
  const file = normalizePath(options.file);
  const kind = asString(options.kind).trim();
  const filtered = tags.length > 0 || Boolean(file) || Boolean(kind);
  const all = snapshot?.cards ?? [];
  const matched = all.filter((card) => {
    if (kind && card.kind !== kind) return false;
    if (tags.length > 0) {
      const own = card.tags.map((tag) => tag.toLowerCase());
      if (!tags.every((tag) => own.includes(tag))) return false;
    }
    if (file) {
      // 完整列表：裁剪过的 keyFiles 会让第 21 个条目在筛选里隐形，而构建器看的是完整列表。
      const entries = card.keyFilesAll.map(normalizePath).filter(Boolean);
      if (!entries.some((entry) => entry === file || matchesEntry(file, entry) || matchesEntry(entry, file))) return false;
    }
    return true;
  });
  const rows = matched
    .slice(0, LIMITS.cardRows)
    .map((card) => (filtered
      ? {
        id: card.id, title: card.title, kind: card.kind, summary: card.summary,
        tags: clipRefs(card.tags), keyFiles: clipRefs(card.keyFiles), pageIds: clipRefs(card.pageIds),
      }
      : { id: card.id, title: clip(card.title, LIMITS.rowRefChars), kind: card.kind, tags: clipRefs(card.tags) }));
  const budget = keepWithinBytes(rows, LIMITS.cardsResultBytes);
  return {
    ok: true,
    filtered,
    total: matched.length,
    rows: budget.kept,
    truncated: budget.truncated || matched.length > rows.length,
  };
}

/**
 * 改动文件 → 受影响的页面/卡片。归一与匹配完全复用 `normalizePath` / `matchesEntry`
 *（即构建器 `diff-impact` 的语义），因此工具与构建器不会对“哪些页受影响”给出两个答案。
 * 匹配读**完整**的 filePaths/keyFiles；结果里的页/卡列表各限 10 条，但每行都带 pagesTotal/cardsTotal
 * 与 row.truncated，被截的条目不会被悄悄丢掉。
 */
export function impact(snapshot, files) {
  const wanted = (Array.isArray(files) ? files : []).map(normalizePath).filter(Boolean);
  const unique = [...new Set(wanted)];
  const bounded = unique.slice(0, LIMITS.impactFilesMax);
  const rows = bounded.map((file) => {
    // 匹配一律用**完整**列表（filePathsAll/keyFilesAll），与构建器 `_diff_hits` 读完整数组一致；
    // 裁剪只发生在输出阶段，否则“第 21 个 filePaths”会在工具里隐形而 diff-impact 照样命中（FR-009）。
    const pagesAll = (snapshot?.pages ?? [])
      .filter((page) => page.filePathsAll.map(normalizePath).some((entry) => matchesEntry(file, entry)));
    const cardsAll = (snapshot?.cards ?? [])
      .filter((card) => card.keyFilesAll.map(normalizePath).some((entry) => matchesEntry(file, entry)));
    const pages = pagesAll.slice(0, LIMITS.rowRefItems)
      .map((page) => ({ id: clip(page.id, LIMITS.rowRefChars), title: clip(page.title, LIMITS.rowRefChars) }));
    const hitCards = cardsAll.slice(0, LIMITS.rowRefItems)
      .map((card) => ({ id: clip(card.id, LIMITS.rowRefChars), title: clip(card.title, LIMITS.rowRefChars) }));
    return {
      path: clip(file, LIMITS.listItemChars),
      pages,
      cards: hitCards,
      mapped: pagesAll.length + cardsAll.length > 0,
      // 截断必须自证：总数在裁剪前就记下来，行上单独置 truncated，调用方不用猜还有没有第 11 页。
      pagesTotal: pagesAll.length,
      cardsTotal: cardsAll.length,
      truncated: pagesAll.length > pages.length || cardsAll.length > hitCards.length,
    };
  });
  const budget = keepWithinBytes(rows, LIMITS.impactResultBytes);
  const kept = budget.kept;
  return {
    ok: true,
    files: kept,
    unmapped: kept.filter((row) => !row.mapped).map((row) => row.path),
    // 三种“不完整”都折进同一个 truncated：字节预算丢行、输入文件超 50、或任一行内的页/卡列表被截。
    truncated: budget.truncated || unique.length > bounded.length || rows.some((row) => row.truncated),
  };
}

/**
 * 新鲜度算术（纯）：head 或 sourceCommit 任一不可得 => "unknown"，**永不**假设 false。
 * 只有两个 commit 都在、且确实不同，才允许说 true。
 * @param {{sourceCommit?: string|null, head?: string|null, behind?: number|null, changedFiles?: string[]|null}} input
 */
export function freshnessOf(input = {}) {
  const sourceCommit = typeof input.sourceCommit === "string" && input.sourceCommit.trim() ? input.sourceCommit.trim() : null;
  const head = typeof input.head === "string" && input.head.trim() ? input.head.trim() : null;
  const rawBehind = Number.isSafeInteger(input.behind) && input.behind >= 0 ? input.behind : null;
  const rawChanged = Array.isArray(input.changedFiles)
    ? input.changedFiles.map((entry) => asString(entry).trim()).filter(Boolean).slice(0, LIMITS.changedFilesMax)
    : null;

  if (head === null || sourceCommit === null) {
    return { head, sourceCommit, behind: null, stale: "unknown", changedFiles: [], updateAvailable: false };
  }
  if (head === sourceCommit) {
    return { head, sourceCommit, behind: 0, stale: false, changedFiles: [], updateAvailable: false };
  }
  return {
    head,
    sourceCommit,
    behind: rawBehind,
    stale: true,
    changedFiles: rawChanged ?? [],
    updateAvailable: true,
  };
}
