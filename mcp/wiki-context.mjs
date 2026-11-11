// dsh-wiki — MCP 适配层的磁盘侧（spec 015）。
//
// 进程外的 MCP 服务器拿不到 Host 的 ctx，所以这里按 lib/index.js 的同一套**语义**重做三件事：
//   1) 仓库解析：显式 repo > 会话目录 > 唯一已发现根；歧义/未知是定型错误，绝不猜；
//   2) 读快照：只读 <repo>/<wikiDirName>/wiki.json 与 generation-meta.json，且必须是规范根之内的普通文件；
//   3) 新鲜度：原样调用 lib/wiki-tools.js 的 createGitProbe + computeFreshness（算术只在
//      wiki-knowledge.freshnessOf 一处），所以 MCP 与 DSH 工具、与面板不可能给出三个答案。
//
// 解析/读取这两件事在 Host 里依赖 ctx 与 lib/fs-contain.js 的句柄身份证明；这里是独立的进程，
// 因此改用 fs.realpath 的包含性证明。差异写在 specs/015-wiki-mcp-adapter/plan.md 的“已知差异”里，
// 不假装两者是同一段代码。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseSnapshot } from "../lib/wiki-knowledge.js";
import { computeFreshness, createGitProbe } from "../lib/wiki-tools.js";

// wiki.json 由模型生成；37 KB 是实测值，16 MiB 只是“绝不整读一个被换掉的巨物”的硬闸。
const WIKI_JSON_MAX_BYTES = 16 * 1024 * 1024;
const META_MAX_BYTES = 1024 * 1024;
// 与 lib/index.js:440 的 ABSENT_READ_CODES 同义：只有“真的不存在”才算没生成。
const ABSENT_READ_CODES = new Set(["ENOENT", "ENOTDIR", "path-not-found", "path-not-directory"]);

const pathKey = (value) => (process.platform === "win32" ? value.toLowerCase() : value);

const unsafe = (message) => {
  const error = new Error(message);
  error.code = "wiki-unsafe";
  return error;
};

/** child 是否真的在 parent 之内（不含 parent 本身）：用 path.relative 判断，不靠字符串前缀。 */
const isInside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
};

/**
 * 建立 wiki 上下文。返回的对象就是 lib/wiki-tools.js 的 deps 契约。
 * @param {{dshHome: string, wikiDirName?: string, logWarn?: Function}} options
 */
export function createWikiContext({ dshHome, wikiDirName = ".dsh-wiki", logWarn = () => {} }) {
  const registryPath = path.join(dshHome, "dsh-wiki", "registry.json");
  const WIKI_REL = path.join(wikiDirName, "wiki.json");
  const META_REL = path.join(wikiDirName, "generation-meta.json");

  /** 已发现根：与 lib/index.js 读同一个登记文件（同一个 profile home），坏文件当成“没有登记”。 */
  const knownRoots = async () => {
    let raw;
    try {
      raw = JSON.parse(await fs.readFile(registryPath, "utf8"));
    } catch {
      return [];
    }
    if (!raw || raw.version !== 1 || !Array.isArray(raw.roots)) return [];
    const seen = new Map();
    for (const row of raw.roots) {
      if (!row || typeof row.path !== "string" || !path.isAbsolute(row.path)) continue;
      const normalized = path.normalize(row.path);
      if (!seen.has(pathKey(normalized))) seen.set(pathKey(normalized), normalized);
    }
    return [...seen.values()];
  };

  const canonical = async (raw) => {
    try {
      return await fs.realpath(raw);
    } catch {
      return null;
    }
  };

  const hasWikiFile = async (root) => {
    try {
      return (await fs.lstat(path.join(root, WIKI_REL))).isFile();
    } catch {
      return false;
    }
  };

  // 候选只报**名字**（basename），与 lib/index.js 的 candidateNames 一致：工具结果里除已解析的根
  // 以外不出现别的绝对路径。
  const candidateNames = (roots) => [...new Set(roots.map((root) => path.basename(root)))].sort().slice(0, 10);

  const resolveRepo = async ({ explicit, sessionCwd } = {}) => {
    const roots = await knownRoots();
    const known = new Set(roots.map((root) => pathKey(root)));
    const accept = async (raw) => {
      if (typeof raw !== "string" || raw.length === 0 || raw.length > 4096 || raw.includes("\u0000") || !path.isAbsolute(raw)) {
        return { ok: false, code: "repo-invalid", error: "repo must be an absolute repository path" };
      }
      const root = await canonical(raw);
      if (!root) {
        // canonical() 只在 realpath 失败时为 null（不存在、链接链断裂、不可访问）。链接本身是**被接受**的：
        // 包含性证明走 realpath，所以一条指向仓库的 junction/符号链接与真实路径解析到同一个根；旧文案
        // 说“a link … 不受信任”与行为矛盾，一条坏路径的报错不该顺带否认一种合法做法。
        return { ok: false, code: "repo-not-trusted", error: "that path could not be resolved on this machine (it does not exist, or a link in its path is broken)" };
      }
      if (known.has(pathKey(root)) || await hasWikiFile(root)) return { ok: true, root };
      return {
        ok: false,
        code: "repo-unknown",
        error: `that path is neither a known wiki root nor a repository that contains ${WIKI_REL}`,
        candidates: candidateNames(roots),
      };
    };
    if (typeof explicit === "string" && explicit.length > 0) return accept(explicit);
    if (typeof sessionCwd === "string" && path.isAbsolute(sessionCwd)) {
      const root = await canonical(sessionCwd);
      if (root && (known.has(pathKey(root)) || await hasWikiFile(root))) return { ok: true, root };
    }
    // 唯一已发现的 wiki 根：只有“恰好一个”才能被当成默认目标。
    const withWiki = [];
    for (const root of roots) {
      const resolved = await canonical(root);
      if (!resolved || withWiki.some((entry) => pathKey(entry) === pathKey(resolved))) continue;
      if (await hasWikiFile(resolved)) withWiki.push(resolved);
    }
    if (withWiki.length === 1) return { ok: true, root: withWiki[0] };
    if (withWiki.length === 0) {
      return {
        ok: false,
        code: "repo-unknown",
        error: `no repository with a readable ${WIKI_REL} was discovered; pass repo explicitly`,
        candidates: candidateNames(roots),
      };
    }
    return {
      ok: false,
      code: "repo-ambiguous",
      error: "more than one repository has a wiki; pass repo explicitly",
      candidates: candidateNames(withWiki),
    };
  };

  /**
   * 受控读：先规范根，再规范目标文件，目标必须落在规范根之内（junction/符号链接指到仓库外即拒绝），
   * 必须是普通文件，且不超过硬闸。它保证的是“读到的确实是这个仓库里那个文件”，不是句柄身份证明。
   *
   * 打开**一次**，之后的大小判定与读取都走同一个句柄：
   *   - stat 之后再按路径读（旧写法）是 TOCTOU —— 中间被换成一个巨物/链接，容量闸就失效了；
   *   - 句柄上的 fstat 与 read 指向同一个对象，容量闸作用在真正会被读到的字节上；
   *   - 读多少由 fstat().size 决定，文件在读取期间变大也只返回声明大小以内的内容。
   */
  const readContained = async (root, rel, maxBytes) => {
    const canonicalRoot = await fs.realpath(root);
    const real = await fs.realpath(path.join(canonicalRoot, rel));
    if (!isInside(canonicalRoot, real)) throw unsafe("the wiki path escapes the repository");
    const handle = await fs.open(real, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw unsafe("the wiki path is not a regular file");
      if (stat.size > maxBytes) throw unsafe("the wiki file exceeds the adapter's size limit");
      const buffer = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (bytesRead === 0) break; // 文件在读取期间被截短：按实际读到的字节解码
        offset += bytesRead;
      }
      return buffer.subarray(0, offset).toString("utf8");
    } finally {
      await handle.close().catch(() => {});
    }
  };

  const loadSnapshot = async (root) => {
    const wikiPath = path.join(root, WIKI_REL);
    let wikiText;
    try {
      wikiText = await readContained(root, WIKI_REL, WIKI_JSON_MAX_BYTES);
    } catch (error) {
      const code = typeof error?.code === "string" ? error.code : "";
      if (ABSENT_READ_CODES.has(code)) {
        return {
          ok: false,
          code: "wiki-not-generated",
          error: `no wiki for this repository; expected ${WIKI_REL} (generate it with /wiki generate)`,
          wikiPath,
        };
      }
      logWarn(`dsh-wiki mcp: unreadable wiki (${WIKI_REL}): ${String(error?.message ?? error)}`);
      return {
        ok: false,
        code: "wiki-unreadable",
        error: "the wiki file is not a regular file inside this project, so it is not readable",
        wikiPath,
      };
    }
    // 元数据缺失只让新鲜度变成 unknown，不影响检索（与 lib/index.js 的处理一致）。
    let metaText = null;
    try {
      metaText = await readContained(root, META_REL, META_MAX_BYTES);
    } catch {
      metaText = null;
    }
    return parseSnapshot(wikiText, { root, wikiDirName, metaText });
  };

  const gitProbe = createGitProbe();
  const freshness = (root, sourceCommit) => computeFreshness(gitProbe, { root, sourceCommit });

  return { wikiDirName, logWarn, resolveRepo, loadSnapshot, freshness };
}

/** 默认的 DSH profile home：与本机 Host 一致（~/.dsh），可被 DSH_HOME 或 --dsh-home 覆盖。 */
export const defaultDshHome = () => process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
