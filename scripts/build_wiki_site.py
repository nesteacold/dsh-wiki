#!/usr/bin/env python3
"""repo-wiki 插件构建器 — 纯本地、零网络、仅标准库（Python ≥3.7）。

子命令:
  build          --wiki <dir>                       由 wiki.json 构建自包含 site/index.html
  import-legacy  <hash|path> [--dest <dir>]         导入旧版 ~/.zcode/v2/repo-wiki/<hash> 并构建（不自动自检）
  selfcheck      --wiki <dir>                       树完整性 + 零外链 + 引用机检 (exit 0/1)
  resolve-config --repo <path> [--set K=V …] [--dry-run]  三层合并生成配置并落 generation-meta.json

约定：WARN/FAIL 诊断走 stderr，数据/报告走 stdout。
"""
import argparse
import html
import json
import os
import re
import sys
import time
import uuid
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path

HOME = Path.home()
LEGACY_BASE = HOME / ".zcode" / "v2" / "repo-wiki"
MERMAID_PATH = Path(__file__).resolve().parent.parent / "assets" / "mermaid.min.js"

# ---------------------------------------------------------------- markdown

_MAX_MD_DEPTH = 16


def _inline(s: str) -> str:
    s = s.replace("\x00", "")  # NUL 不合法且与 stash 占位符冲突，直接剔除
    token = f"\x00{uuid.uuid4().hex}\x00"
    stash: list[str] = []

    def _stash(m):
        stash.append(m.group(1))
        return f"{token}{len(stash) - 1}{token}"

    s = re.sub(r"`([^`]+)`", _stash, s)
    s = html.escape(s, quote=True)
    s = re.sub(r"!\[([^\]]*)\]\(([^)]+)\)",
               lambda m: f'<span class="imgref" title="{m.group(2)}">🖼 {m.group(1) or "图片"}（离线查看器不加载外部图片）</span>', s)
    s = re.sub(r"\[([^\]]+)\]\(([^)]+)\)",
               lambda m: f'<span class="linkref" title="{m.group(2)}">{m.group(1)}</span>', s)
    s = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"(?<!\*)\*([^*\n]+)\*(?!\*)", r"<em>\1</em>", s)
    s = re.sub(re.escape(token) + r"(\d+)" + re.escape(token),
               lambda m: "<code>" + html.escape(stash[int(m.group(1))], quote=True) + "</code>", s)
    return s


def _list_html(items, pos, depth, max_depth=_MAX_MD_DEPTH):
    ordered = items[pos][1]
    tag = "ol" if ordered else "ul"
    out = [f"<{tag}>"]
    while pos < len(items):
        d, _o, text = items[pos]
        if d < depth:
            break
        if d == depth and pos + 1 < len(items) and items[pos + 1][0] > depth:
            if depth >= max_depth:
                # 超深嵌套：拍平为同级列表项，不再递归
                out.append(f"<li>{_inline(text)}</li>")
                pos += 1
                while pos < len(items) and items[pos][0] > depth:
                    out.append(f"<li>{_inline(items[pos][2])}</li>")
                    pos += 1
            else:
                sub, pos = _list_html(items, pos + 1, depth + 1, max_depth)
                out.append(f"<li>{_inline(text)}{sub}</li>")
        else:
            out.append(f"<li>{_inline(text)}</li>")
            pos += 1
    out.append(f"</{tag}>")
    return "".join(out), pos


def md_to_html(md: str, _depth: int = 0) -> str:
    md = md.replace("\x00", "")
    lines = md.replace("\r\n", "\n").split("\n")
    out, i, n = [], 0, len(lines)
    while i < n:
        line = lines[i]
        m = re.match(r"^\s*```(\w*)\s*$", line)
        if m:
            lang, buf = m.group(1).lower(), []
            i += 1
            while i < n and not re.match(r"^\s*```\s*$", lines[i]):
                buf.append(lines[i])
                i += 1
            i += 1
            code = "\n".join(buf)
            if lang == "mermaid":
                out.append('<pre class="mermaid">' + html.escape(code) + "</pre>")
            else:
                lab = f'<span class="lang">{html.escape(lang)}</span>' if lang else ""
                out.append(f'<pre class="code">{lab}<code>{html.escape(code)}</code></pre>')
            continue
        if _SVG_OPEN_RE.match(line):
            m = _SVG_CLOSE_RE.search(line)
            if m:
                # 单行内的 svg：只取到第一个 </svg>；同行余下内容替换回 lines[i] 继续解析
                buf = [line[:m.end()]]
                tail = line[m.end():]
                if tail.strip():
                    lines[i] = tail
                else:
                    i += 1
            else:
                buf = [line]
                i += 1
                while not _SVG_CLOSE_RE.search(buf[-1]) and i < n and len(buf) < _MAX_SVG_LINES:
                    buf.append(lines[i])
                    i += 1
            raw = "\n".join(buf)
            safe = sanitize_svg(raw)
            if safe is None:
                # fail-closed：不可解析的 SVG 绝不直通原始标记，降级为转义文本
                out.append('<pre class="code"><span class="lang">svg</span><code>'
                           + html.escape(raw) + "</code></pre>")
            else:
                out.append('<div class="diagram">' + safe + "</div>")
            continue
        m = re.match(r"^(#{1,6})\s+(.*)$", line)
        if m:
            lv = len(m.group(1))
            out.append(f"<h{lv}>{_inline(m.group(2))}</h{lv}>")
            i += 1
            continue
        if re.match(r"^\s*([-*_])\s*(\1\s*){2,}$", line):
            out.append("<hr>")
            i += 1
            continue
        if "|" in line and i + 1 < n and re.match(r"^\s*\|?[\s:|-]*-", lines[i + 1]):
            header = [c.strip() for c in line.strip().strip("|").split("|")]
            i += 2
            rows = []
            while i < n and "|" in lines[i] and lines[i].strip():
                rows.append([c.strip() for c in lines[i].strip().strip("|").split("|")])
                i += 1
            th = "".join(f"<th>{_inline(c)}</th>" for c in header)
            tr = "".join("<tr>" + "".join(f"<td>{_inline(c)}</td>" for c in r) + "</tr>" for r in rows)
            out.append(f"<table><thead><tr>{th}</tr></thead><tbody>{tr}</tbody></table>")
            continue
        if re.match(r"^\s*>", line):
            buf = []
            while i < n and re.match(r"^\s*>", lines[i]):
                buf.append(re.sub(r"^\s*>\s?", "", lines[i]))
                i += 1
            if _depth >= _MAX_MD_DEPTH:
                out.append("<blockquote>" + _inline(" ".join(buf)) + "</blockquote>")
            else:
                out.append("<blockquote>" + md_to_html("\n".join(buf), _depth + 1) + "</blockquote>")
            continue
        m = re.match(r"^(\s*)([-*+]|\d+[.)])\s+(.*)$", line)
        if m:
            items = []
            while i < n:
                mm = re.match(r"^(\s*)([-*+]|\d+[.)])\s+(.*)$", lines[i])
                if mm:
                    items.append((len(mm.group(1)) // 2, mm.group(2)[0].isdigit(), mm.group(3)))
                    i += 1
                elif lines[i].strip() and items and re.match(r"^\s{2,}\S", lines[i]):
                    d, o, t = items[-1]
                    items[-1] = (d, o, t + " " + lines[i].strip())
                    i += 1
                else:
                    break
            lst, _ = _list_html(items, 0, items[0][0])
            out.append(lst)
            continue
        if not line.strip():
            i += 1
            continue
        buf = [line]
        i += 1
        while (i < n and lines[i].strip()
               and not re.match(r"^\s*(```|#{1,6}\s|>|\s*([-*+]|\d+[.)])\s|<svg\b)", lines[i])):
            buf.append(lines[i])
            i += 1
        out.append("<p>" + _inline(" ".join(s.strip() for s in buf)) + "</p>")
    return "\n".join(out)


def _strip_tags(h: str) -> str:
    return re.sub(r"<[^>]+>", " ", h)


# ---------------------------------------------------------------- svg sanitize

_SVG_NS = "http://www.w3.org/2000/svg"
# 白名单：绘图/文本/渐变/裁剪/滤镜所需标签。
# 决策（R5 收敛审核）：不放行 <style>、style 属性与 <animate>（SMIL 可改写 href 指向外链），
# 也不放行 script/foreignObject/iframe/meta/base/form/object 等执行面——
# 裸 CSS 文本的转义混淆面无法用正则穷尽，fidelity 让位于确定性（呈现属性仍全部支持）。
_SVG_ALLOWED_TAGS = {
    "svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
    "text", "tspan", "textpath", "title", "desc", "defs", "marker", "use", "symbol",
    "lineargradient", "radialgradient", "stop", "clippath", "mask", "pattern",
    "filter", "image", "switch", "metadata",
    "animatetransform", "animatemotion",
    "fegaussianblur", "feoffset", "feblend", "femerge", "femergenode",
    "fecolormatrix", "fecomposite", "fedropshadow", "feflood", "feturbulence",
    "fecomponenttransfer", "fefunca", "fefuncb", "fefuncg", "fefuncr",
    "femorphology", "feimage", "fedisplacementmap", "fespecularlighting",
    "fediffuselighting", "fedistantlight", "fepointlight", "fespotlight",
}
# 这些属性名一旦出现在 attributeName（动画目标）上即删除该动画元素的目标
_SVG_UNSAFE_ANIM_TARGETS = {"href", "xlink:href", "src", "style", "class",
                            "filter", "mask", "clip-path", "marker-start", "marker-mid",
                            "marker-end", "fill", "stroke"}
_SVG_URL_ATTRS = {"href", "src"}
_SVG_BLOCKED_ATTRS = {"srcset", "content", "action", "data", "poster", "formaction",
                      "background", "dynsrc", "lowsrc", "ping"}
_SVG_URL_LIST_ATTRS = {"values", "to", "from", "by", "path"}
_SVG_DATA_IMAGE_RE = re.compile(r"^data:image/(?:png|jpe?g|gif|webp|svg\+xml);base64,", re.I)
_SVG_SCHEME_RE = re.compile(r"(?i)(?:https?|file|javascript|vbscript|data):|//")
_SVG_CLOSE_RE = re.compile(r"<\s*/\s*svg\s*>", re.I)
_SVG_OPEN_RE = re.compile(r"^\s*<\s*svg\b", re.I)
_SVG_URL_VALUE_RE = re.compile(r"url\(", re.I)
_MAX_SVG_LINES = 20000
_MAX_SVG_BYTES = 2_000_000
_MAX_SVG_DEPTH = 100


def _svg_local(name: str) -> str:
    return name.rsplit("}", 1)[-1]


def _svg_style_clean(value: str) -> str:
    """保守清理：含反斜杠（CSS 转义可混淆 url()/@import）或任何 url() 直接丢弃整值。"""
    if "\\" in value or _SVG_URL_VALUE_RE.search(value) or "@" in value:
        return ""
    return value


def _svg_url_targets_ok(value: str) -> bool:
    """值中所有 url(...) 目标都必须是页内片段（#id），且不含协议/转义混淆。"""
    if "\\" in value:
        return False
    for m in re.finditer(r"url\(\s*['\"]?([^)'\"]*)", value):
        if not m.group(1).strip().startswith("#"):
            return False
    return True


def _svg_url_ok(value: str, local_attr: str) -> bool:
    """href/src 只允许页内片段与内联 data:image。"""
    v = value.strip()
    if v.startswith("#"):
        return True
    if local_attr in _SVG_URL_ATTRS and _SVG_DATA_IMAGE_RE.match(v):
        return True
    return False


def sanitize_svg(svg: str):
    """解析 → 白名单 → 重序列化。解析失败/超限/根不是 svg 时返回 None（调用方降级为转义文本）。

    基于 XML 解析而非正则删除：不存在"删除令牌后相邻片段重新拼接成标签"的变异面；
    未知标签整棵子树被移除，事件属性、外部 URL 属性、DOCTYPE/ENTITY 被移除或拒绝。
    """
    if len(svg) > _MAX_SVG_BYTES:
        return None
    # DOCTYPE/ENTITY 是实体放大（billion laughs/XXE）的唯一载体：直接拒绝，不依赖 expat 版本
    if "<!ENTITY" in svg or "<!DOCTYPE" in svg.upper():
        return None
    try:
        root = ET.fromstring(svg)
    except ET.ParseError:
        # 常见合法写法：使用 xlink: 前缀但漏声明命名空间——补上再解析
        if "xlink:" in svg and "xmlns:xlink" not in svg and _SVG_OPEN_RE.match(svg.split("\n", 1)[0]):
            patched = re.sub(r"(\s*<\s*svg\b)", r'\1 xmlns:xlink="http://www.w3.org/1999/xlink"',
                             svg, count=1, flags=re.I)
            try:
                root = ET.fromstring(patched)
            except (ET.ParseError, RecursionError):
                return None
        else:
            return None
    if _svg_local(root.tag).lower() != "svg":
        return None

    # 迭代式清理（显式栈），带深度上限：深嵌套 SVG 不会以 RecursionError 终止构建
    stack = [(root, 0)]
    while stack:
        el, depth = stack.pop()
        if depth > _MAX_SVG_DEPTH:
            return None
        el_local = _svg_local(el.tag).lower()
        for child in list(el):
            if _svg_local(child.tag).lower() not in _SVG_ALLOWED_TAGS:
                el.remove(child)
                continue
            stack.append((child, depth + 1))
        # 动画元素不得把目标指向 URL 承载属性（<animate attributeName="href" values="http://…">）
        anim_target = _svg_local(el.attrib.get("attributeName", "")).lower() if el_local.startswith("animate") else ""
        if anim_target in _SVG_UNSAFE_ANIM_TARGETS:
            el.attrib.pop("attributeName", None)
            for k in list(el.attrib):
                if _svg_local(k).lower() in _SVG_URL_LIST_ATTRS:
                    del el.attrib[k]
        for name in list(el.attrib):
            low = _svg_local(name).lower()
            if "\\" in el.attrib[name]:
                # SVG 属性值不含合法反斜杠；出现即视为 CSS/JS 转义混淆，整值丢弃
                del el.attrib[name]
                continue
            if low.startswith("on"):
                del el.attrib[name]
            elif low == "style":
                # style 属性整体移除：CSS 文本（含 image-set 等函数与转义混淆）不可穷尽校验，
                # 需要样式请用呈现属性（fill/stroke/opacity…）
                del el.attrib[name]
            elif low in _SVG_URL_ATTRS:
                if not _svg_url_ok(el.attrib[name], low):
                    del el.attrib[name]
            elif low in _SVG_URL_LIST_ATTRS:
                # values/to/from/by/path：任一段含协议或非 # 的 url() 即删该属性
                if _SVG_SCHEME_RE.search(el.attrib[name]) or not _svg_url_targets_ok(el.attrib[name]):
                    del el.attrib[name]
            elif _SVG_URL_VALUE_RE.search(el.attrib[name]):
                # 呈现属性里的 url()（如 fill="url(#g)"）：只允许页内片段目标
                if not _svg_url_targets_ok(el.attrib[name]):
                    del el.attrib[name]
            elif low in _SVG_BLOCKED_ATTRS:
                del el.attrib[name]
        if _svg_local(el.tag).lower() == "style" and el.text:
            el.text = _svg_style_clean(el.text)

    tag_map = {"lineargradient": "linearGradient", "radialgradient": "radialGradient",
               "clippath": "clipPath", "textpath": "textPath",
               "fegaussianblur": "feGaussianBlur", "feoffset": "feOffset",
               "feblend": "feBlend", "femerge": "feMerge", "femergenode": "feMergeNode",
               "fecolormatrix": "feColorMatrix", "fecomposite": "feComposite",
               "fedropshadow": "feDropShadow", "feflood": "feFlood",
               "feturbulence": "feTurbulence", "fecomponenttransfer": "feComponentTransfer",
               "fefunca": "feFuncA", "fefuncb": "feFuncB", "fefuncg": "feFuncG",
               "fefuncr": "feFuncR", "femorphology": "feMorphology", "feimage": "feImage",
               "fedisplacementmap": "feDisplacementMap",
               "fespecularlighting": "feSpecularLighting",
               "fediffuselighting": "feDiffuseLighting", "fedistantlight": "feDistantLight",
               "fepointlight": "fePointLight", "fespotlight": "feSpotLight",
               "animatetransform": "animateTransform", "animatemotion": "animateMotion"}

    def rebuild(el):
        tag = tag_map.get(_svg_local(el.tag).lower(), _svg_local(el.tag))
        node = ET.Element(tag)
        for k, v in el.attrib.items():
            node.set(_svg_local(k), v)
        if el.text:
            node.text = el.text
        if el.tail:
            node.tail = el.tail
        for ch in el:
            node.append(rebuild(ch))
        return node

    tree = rebuild(root)
    tree.set("xmlns", _SVG_NS)
    return ET.tostring(tree, encoding="unicode")


# ---------------------------------------------------------------- tree / pages

def _sortkey(p):
    o = p.get("order")
    return (0, o) if isinstance(o, (int, float)) else (1, 0)


def build_tree(pages):
    by_id = {p["id"]: p for p in pages}
    children = defaultdict(list)
    roots = []
    for p in sorted(pages, key=_sortkey):
        pid = p.get("parentId")
        if pid and pid in by_id:
            children[pid].append(p)
        else:
            roots.append(p)
    return roots, children


def _safe_id(raw: str, used: set) -> str:
    sid = re.sub(r"[^A-Za-z0-9_-]", "-", raw or "page") or "page"
    base, k = sid, 2
    while sid in used:
        sid = f"{base}-{k}"
        k += 1
    used.add(sid)
    return sid


def _clean_text(s: str) -> str:
    """修复孤立代理对（JSON \\udXXX 可构造）并剔除 NUL：写出时不再触发编码错误、不产生非法 HTML。"""
    if not s:
        return s
    s = s.replace("\x00", "")
    try:
        return s.encode("utf-8", "surrogatepass").decode("utf-8", "replace")
    except UnicodeDecodeError:
        return s.encode("utf-8", "replace").decode("utf-8", "replace")


def _as_str_list(val):
    if isinstance(val, str):
        return [_clean_text(val)]
    if isinstance(val, list):
        return [_clean_text(str(x)) for x in val if x is not None]
    return []


def _as_sources(val):
    items = [val] if isinstance(val, dict) else (val if isinstance(val, list) else [])
    out = []
    for s in items:
        if isinstance(s, dict):
            entry = {"path": _clean_text(str(s.get("path", "?")))}
            if _is_int(s.get("startLine")) and s["startLine"] > 0:
                entry["startLine"] = s["startLine"]
            out.append(entry)
        elif isinstance(s, str):
            out.append({"path": _clean_text(s)})
    return out


def normalize_pages(raw_pages, warns=None):
    warns = warns if warns is not None else []
    used: set = set()
    mapping = {}
    counts = defaultdict(int)
    pages = []
    for idx, p in enumerate(raw_pages):
        if not isinstance(p, dict):
            warns.append(f"pages[{idx}] 不是对象（{type(p).__name__}），已跳过")
            continue
        raw_id = p.get("id")
        raw_title = p.get("title")
        key_src = raw_id if raw_id is not None else raw_title
        raw_key = str(key_src) if key_src is not None else "page"
        pid = _safe_id(raw_key, used)
        mapping.setdefault(raw_key, pid)
        counts[raw_key] += 1
        if raw_id is None and raw_title is not None:
            warns.append(f"pages[{idx}] 缺 id，按 title {raw_title!r} 生成")
        title = raw_title if isinstance(raw_title, str) else (str(raw_title) if raw_title is not None else "")
        title = _clean_text(title)
        if not title.strip():
            if raw_title is not None:
                warns.append(f"页面 {pid} 的 title 为空或纯空白，已置为『无标题』")
            title = "无标题"
        desc = p.get("description") or ""
        md = p.get("markdown") or ""
        pages.append({
            "id": pid,
            "parentId": p.get("parentId"),
            "title": title,
            "order": p.get("order"),
            "description": _clean_text(desc if isinstance(desc, str) else str(desc)),
            "filePaths": _as_str_list(p.get("filePaths")),
            "sources": _as_sources(p.get("sources")),
            "markdown": _clean_text(md if isinstance(md, str) else str(md)),
        })
    for raw_key, n in counts.items():
        if n > 1:
            warns.append(f"页面 id 重复 {raw_key!r} ×{n}，已自动去重")
    # parentId 与 id 走同一套清洗/去重映射，避免 CJK/数字/重名 id 断链
    for q in pages:
        if q["parentId"] is not None:
            raw_parent = str(q["parentId"])
            q["parentId"] = mapping.get(raw_parent, raw_parent)
    return pages


def _tree_html(roots, children) -> str:
    """显式栈迭代构建导航树，避免深链递归。"""
    out = ["<ul>"]
    stack = [("open", r) for r in reversed(roots)]
    while stack:
        kind, node = stack.pop()
        if kind == "close":
            out.append("</ul></li>")
            continue
        kids = children.get(node["id"], [])
        inner = html.escape(str(node.get("title") or node["id"]))
        out.append(f'<li><a class="navitem" data-page="{node["id"]}" href="#{node["id"]}">{inner}</a>')
        if kids:
            out.append("<ul>")
            stack.append(("close", node))
            for k in reversed(kids):
                stack.append(("open", k))
        else:
            out.append("</li>")
    out.append("</ul>")
    return "".join(out)


def _page_section(p) -> str:
    chips = "".join(f'<span class="chip">{html.escape(str(f))}</span>' for f in p["filePaths"][:12])
    chip_html = f'<div class="chips">{chips}</div>' if chips else ""
    srcs = "".join(
        f'<span class="chip src">{html.escape(str(s.get("path", "?")))}'
        f'{":" + html.escape(str(s["startLine"])) if s.get("startLine") else ""}</span>'
        for s in p["sources"][:20])
    src_html = f'<div class="chips"><span class="srclab">来源</span>{srcs}</div>' if srcs else ""
    desc = f'<p class="desc">{_inline(p["description"])}</p>' if p["description"] else ""
    body = md_to_html(p["markdown"]) if p["markdown"] else '<p class="todo">（此页无内容）</p>'
    return (f'<section class="page" id="pg-{p["id"]}" hidden>'
            f'<h1>{html.escape(str(p["title"]))}</h1>{desc}{chip_html}{src_html}'
            f'<div class="content">{body}</div></section>')


# ---------------------------------------------------------------- template

_TEMPLATE = """<!DOCTYPE html>
<html lang="__LANG__">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>__TITLE__</title>
<style>
:root{--bg:#fafaf8;--fg:#1f2328;--muted:#59636e;--panel:#ffffff;--border:#d1d9e0;--accent:#0969da;--codebg:#f2f4f7;--chipbg:#eceff3;--shadow:rgba(0,0,0,.06)}
[data-theme=dark]{--bg:#0d1117;--fg:#e6edf3;--muted:#8b949e;--panel:#161b22;--border:#30363d;--accent:#4493f8;--codebg:#10151c;--chipbg:#1d242d;--shadow:rgba(0,0,0,.4)}
*{box-sizing:border-box}html,body{margin:0;height:100%}
body{display:flex;background:var(--bg);color:var(--fg);font:15px/1.75 -apple-system,"PingFang SC","Segoe UI",Roboto,sans-serif}
aside{width:300px;min-width:300px;height:100vh;overflow:auto;background:var(--panel);border-right:1px solid var(--border);padding:16px 14px 32px}
#tbtn{float:right;background:none;border:1px solid var(--border);border-radius:6px;color:var(--fg);cursor:pointer;font-size:12px;padding:2px 8px}
#repo{font-weight:700;font-size:15px;margin:2px 44px 10px 0;word-break:break-all}
#search{width:100%;padding:6px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--fg);font-size:13px;margin-bottom:8px}
#hits{border:1px solid var(--border);border-radius:8px;margin-bottom:8px;max-height:45vh;overflow:auto;background:var(--bg)}
.hit{padding:6px 10px;border-bottom:1px solid var(--border);cursor:pointer;font-size:12.5px}
.hit:last-child{border-bottom:0}.hit.none{color:var(--muted);cursor:default}
.hit b{display:block;font-size:13px}.hit span{color:var(--muted)}
aside ul{list-style:none;margin:0;padding-left:14px}aside>ul{padding-left:0}
.navitem{display:block;padding:3px 8px;border-radius:6px;color:var(--fg);text-decoration:none;font-size:13.5px;line-height:1.5}
.navitem:hover{background:var(--chipbg)}.navitem.active{background:var(--chipbg);color:var(--accent);font-weight:600}
main{flex:1;height:100vh;overflow:auto;padding:40px 56px 80px;max-width:980px}
section.page[hidden]{display:none}
h1{font-size:26px;line-height:1.3;margin:0 0 8px;border-bottom:1px solid var(--border);padding-bottom:12px}
.desc{color:var(--muted)}
.chips{margin:10px 0;display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.srclab{color:var(--muted);font-size:12px}
.chip{background:var(--chipbg);border-radius:5px;padding:1px 8px;font-size:12px;font-family:ui-monospace,Menlo,monospace}
h2{font-size:20px;margin:28px 0 10px}h3{font-size:17px;margin:22px 0 8px}
pre.code{background:var(--codebg);border:1px solid var(--border);border-radius:10px;padding:12px 14px;overflow:auto;position:relative}
pre.code .lang{position:absolute;top:6px;right:12px;font-size:11px;color:var(--muted)}
code{font-family:ui-monospace,Menlo,monospace;font-size:.92em}
p code,li code,td code,h2 code,h3 code{background:var(--chipbg);border-radius:4px;padding:1px 5px}
pre.mermaid{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:16px;text-align:center;overflow:auto}
.mermaid-fallback{background:var(--codebg);border:1px dashed var(--border);border-radius:10px;padding:12px;font-family:ui-monospace,Menlo,monospace;font-size:12px;white-space:pre-wrap;color:var(--muted)}
.diagram{margin:18px 0;overflow-x:auto}.diagram svg{max-width:100%}
blockquote{border-left:3px solid var(--accent);margin:14px 0;padding:2px 16px;color:var(--muted);background:var(--panel);border-radius:0 8px 8px 0}
table{border-collapse:collapse;margin:14px 0;width:100%}
th,td{border:1px solid var(--border);padding:6px 10px;text-align:left;font-size:13.5px}
th{background:var(--chipbg)}
.linkref{color:var(--accent);border-bottom:1px dotted var(--accent);cursor:help}
.imgref{color:var(--muted);font-size:.92em}
.todo{color:var(--muted);font-style:italic}
hr{border:0;border-top:1px solid var(--border);margin:22px 0}
footer{margin-top:60px;color:var(--muted);font-size:12px}
@media (prefers-reduced-motion:no-preference){.navitem,.chip{transition:background .15s}}
@media (max-width:760px){body{flex-direction:column}aside{width:100%;min-width:0;height:auto;max-height:38vh;border-right:0;border-bottom:1px solid var(--border)}main{height:auto;max-width:none;padding:20px 16px 64px}}
</style>
</head>
<body>
<aside>
  <button id="tbtn" title="切换主题">🌓</button>
  <div id="repo">__REPO__</div>
  <input id="search" type="search" placeholder="全文搜索…" autocomplete="off">
  <div id="hits" hidden role="listbox"></div>
  <nav id="tree">__TREE__</nav>
</aside>
<main id="main">
<noscript><p class="todo">本查看器需要 JavaScript 才能切换页面与全文搜索；请在启用 JS 的浏览器中打开。</p></noscript>
__PAGES__
<footer>dsh-wiki@local · 纯本地生成，零上传 · __DATE__</footer>
</main>
<script>__MERMAID__</script>
<script>
window.INDEX=JSON.parse(__INDEX__);
(function(){
var $=function(s){return document.querySelector(s)};
function show(id){
  id=String(id||'').replace(/^pg-/,'');
  var ok=false;
  document.querySelectorAll('section.page').forEach(function(s){var v=s.id==='pg-'+id;s.hidden=!v;if(v)ok=true;});
  if(!ok){var first=document.querySelector('section.page');if(first){first.hidden=false;id=first.id.slice(3);}}
  document.querySelectorAll('.navitem').forEach(function(a){a.classList.toggle('active',a.dataset.page===id);});
  try{if(history.replaceState)history.replaceState(null,'','#'+id);}catch(e){}
  $('#main').scrollTop=0;
}
document.addEventListener('click',function(e){
  var a=e.target.closest('.navitem');
  if(a){e.preventDefault();show(a.dataset.page);return;}
  var h=e.target.closest('.hit[data-page]');
  if(h){show(h.dataset.page);$('#hits').hidden=true;$('#search').value='';}
});
document.addEventListener('keydown',function(e){
  if(e.key!=='Enter'&&e.key!==' '&&e.key!=='Spacebar')return;
  var h=e.target&&e.target.closest?e.target.closest('.hit[data-page]'):null;
  if(h){e.preventDefault();show(h.getAttribute('data-page'));$('#hits').hidden=true;$('#search').value='';}
});
window.addEventListener('hashchange',function(){var id=location.hash.slice(1);if(id)show(id);});
var search=$('#search'),hits=$('#hits');
search.addEventListener('input',function(){
  var q=search.value.trim().toLowerCase();
  if(!q){hits.hidden=true;hits.innerHTML='';return;}
  var out=[];
  for(var id in window.INDEX){
    var it=window.INDEX[id];
    var hay=(it.title+' '+it.desc+' '+it.text).toLowerCase();
    if(hay.indexOf(q)<0)continue;
    var tpos=it.text.toLowerCase().indexOf(q);
    out.push({id:id,t:it.title,s:it.text.substr(tpos>=0?Math.max(0,tpos-30):0,90)});
    if(out.length>=30)break;}
  hits.innerHTML='';
  if(!out.length){var none=document.createElement('div');none.className='hit none';none.textContent='无命中';hits.appendChild(none);}
  else{out.forEach(function(h){
    var d=document.createElement('div');d.className='hit';d.setAttribute('data-page',h.id);
    d.tabIndex=0;d.setAttribute('role','option');
    var b=document.createElement('b');b.textContent=h.t;
    var s=document.createElement('span');s.textContent=h.s;
    d.appendChild(b);d.appendChild(s);hits.appendChild(d);});}
  hits.hidden=false;
});
function mermaidFallback(){
  document.querySelectorAll('pre.mermaid').forEach(function(el){
    el.classList.add('mermaid-fallback');el.textContent=el.dataset.src||el.textContent;});
}
function renderMermaids(){
  if(!window.mermaid||!window.mermaid.initialize){mermaidFallback();return false;}
  document.querySelectorAll('pre.mermaid').forEach(function(el){
    if(el.dataset.src===undefined){el.dataset.src=el.textContent;}
    /* 重渲前必须清掉 mermaid 的处理标记，否则主题切换后图会永久变回源码 */
    el.removeAttribute('data-processed');
    el.classList.remove('mermaid-fallback');
    el.innerHTML='';el.textContent=el.dataset.src;
  });
  try{
    mermaid.initialize({startOnLoad:false,securityLevel:'strict',suppressErrors:true,
      theme:document.documentElement.dataset.theme==='dark'?'dark':'neutral'});
    var r=mermaid.run({querySelector:'pre.mermaid'});
    if(r&&typeof r.catch==='function'){r.catch(function(){mermaidFallback();});}
    return true;
  }catch(err){
    mermaidFallback();
    return false;
  }
}
function applyTheme(t){
  t=(t==='dark')?'dark':'light';
  document.documentElement.dataset.theme=t;
  try{localStorage.setItem('rw-theme',t);}catch(e){}
  document.getElementById('tbtn').textContent=t==='dark'?'☀️ 浅色':'🌙 深色';
  renderMermaids();
}
document.getElementById('tbtn').onclick=function(){
  applyTheme(document.documentElement.dataset.theme==='dark'?'light':'dark');};
var saved='light';
try{saved=localStorage.getItem('rw-theme')||'';}catch(e){}
if(saved!=='dark'&&saved!=='light'){
  try{saved=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}catch(e){saved='light';}
}
applyTheme(saved);
var initial=location.hash.slice(1);
show(initial);
})();
</script>
</body>
</html>
"""


def _mermaid_runtime() -> str:
    if MERMAID_PATH.exists():
        try:
            js = MERMAID_PATH.read_text(encoding="utf-8", errors="surrogatepass")
        except (UnicodeDecodeError, OSError) as exc:
            print(f"[dsh-wiki] WARN mermaid 资产不可读（{exc}），图表仅显源码", file=sys.stderr)
            return "window.mermaid=null;console.warn('mermaid.min.js 未内联，图表仅显源码');"
        # 大小写不敏感地打断脚本结束标记与注释起始（HTML 解析对 </script 大小写不敏感）
        js = re.sub(r"(?i)</script", "<\\/script", js)
        js = re.sub(r"(?i)<!--", "<\\!--", js)
        # 打断 HTML 边界标签字面量（<body/</body/<head/</head/<html/</html/<script）。
        # 内联 bundle 的字符串/模板字面量里就带这些序列（DOMPurify 的 XHTML 包装串
        # '<html…><head></head><body>'+…+"</body></html>"、iframe 助手的 `<body …>`），
        # 宿主侧朴素注入器靠正则找注入点（如本插件路由的 </body> 替换、
        # dsh-host-webserver 的 /<body[^>]*>/ 定位），会命中假标签把 <script>…
        # </script> 注进脚本中间——注入的 </script> 提前闭合脚本，bundle 余下部分
        # 整体泄漏为正文文本（页面上出现巨幅 JS 源码墙）。
        # \u003c 在 JS 字符串/模板/正则字面量（及 JSON 字符串）里都与 '<' 等价，语义不变；
        # 若未来资产把这类序列用在字面量之外会直接语法报错，被 node --check 测试拦下。
        js = re.sub(r"(?i)<(/?(?:body|head|html|script)(?![A-Za-z]))",
                    lambda m: "\\u003c" + m.group(1), js)
        adapter = ("var __rwNs=window.__esbuild_esm_mermaid_nm;"
                   "window.mermaid=(__rwNs&&__rwNs.mermaid)&&(__rwNs.mermaid.default||__rwNs.mermaid);"
                   "if(!window.mermaid)console.warn('dsh-wiki: mermaid 挂载失败,图表仅显源码');")
        return js + "\n" + adapter
    print("[dsh-wiki] WARN 未找到 assets/mermaid.min.js，图表仅显源码", file=sys.stderr)
    return "window.mermaid=null;console.warn('mermaid.min.js 未内联，图表仅显源码');"


def _write_text(path: Path, text: str) -> None:
    """原子写入（tmp + replace），保留目标文件权限；符号链接写到其目标；失败转干净错误。"""
    target = path
    if path.is_symlink():
        try:
            target = path.resolve()
        except OSError:
            target = path
    mode = None
    if target.exists():
        try:
            mode = target.stat().st_mode & 0o7777
        except OSError:
            mode = None
    tmp = target.with_name(target.name + f".tmp-{os.getpid()}-{uuid.uuid4().hex[:8]}")
    try:
        tmp.write_text(text, encoding="utf-8")
        if mode is not None:
            os.chmod(tmp, mode)
        tmp.replace(target)
    except (OSError, UnicodeEncodeError) as exc:
        try:
            tmp.unlink()
        except OSError:
            pass
        sys.exit(f"[dsh-wiki] 无法写入 {target}：{exc}")


def _read_json(path: Path, label: str):
    """读取并解析 JSON，失败时给出干净错误（stderr + exit 1），不裸 traceback。"""
    if path.is_dir():
        sys.exit(f"[dsh-wiki] {label} 是一个目录，不是文件: {path}")
    if not path.is_file():
        sys.exit(f"[dsh-wiki] {label} 不存在: {path}")
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        sys.exit(f"[dsh-wiki] {label} 不是 UTF-8 文本: {path}（{exc}）")
    except OSError as exc:
        sys.exit(f"[dsh-wiki] {label} 不可读: {path}（{exc}）")
    try:
        return json.loads(text)
    except RecursionError:
        sys.exit(f"[dsh-wiki] {label} JSON 嵌套过深，无法解析: {path}")
    except json.JSONDecodeError as exc:
        sys.exit(f"[dsh-wiki] {label} 不是合法 JSON: {path}（{exc}）")


def build_site(wiki_dir: Path) -> dict:
    wiki_json = wiki_dir / "wiki.json"
    data = _read_json(wiki_json, "wiki.json")
    if not isinstance(data, dict):
        sys.exit(f"[dsh-wiki] {wiki_json} 顶层必须是 JSON 对象")
    warns: list = []
    pages = normalize_pages(data.get("pages") or [], warns)
    if not pages:
        for w in warns:
            print(f"[dsh-wiki] WARN {w}", file=sys.stderr)
        extra = f"（{len(warns)} 个页面元素非法或缺失，详见 WARN）" if warns else ""
        sys.exit(f"[dsh-wiki] {wiki_json} 中没有页面{extra}")
    for w in warns:
        print(f"[dsh-wiki] WARN {w}", file=sys.stderr)
    sections, index = [], {}
    roots, children = build_tree(pages)
    reachable: set = set()
    stack = list(roots)
    while stack:
        node = stack.pop()
        if node["id"] in reachable:
            continue
        reachable.add(node["id"])
        stack.extend(children.get(node["id"], []))
    unreachable = [p["id"] for p in pages if p["id"] not in reachable]
    if unreachable:
        print(f"[dsh-wiki] WARN {len(unreachable)} 个页面父链成环不可达，导航不显示: "
              f"{', '.join(unreachable[:10])}", file=sys.stderr)
    for p in pages:
        sections.append(_page_section(p))
        index[p["id"]] = {
            "title": p["title"],
            "desc": p["description"],
            "text": html.unescape(_strip_tags(md_to_html(p["markdown"])))[:20000],
        }
    # 品牌位显示名：可选 title 优先，其次 repoId（历史行为），最后落目录名。
    # repoId 仍是引用机检的仓库根，两者互不影响。
    title = _clean_text(str(data.get("title") or data.get("repoId") or wiki_dir.name))
    lang = str(data.get("language") or "zh-CN")
    if not _LANG_RE.match(lang):
        lang = "zh-CN"
    page_html = "\n".join(sections)
    # INDEX 以 JSON 字符串嵌入并由 JSON.parse 解析：既规避 </script> 上下文风险，
    # 也避免 {{"__proto__": …}} 对象字面量的原型语义（幽灵页）
    idx_literal = json.dumps(json.dumps(index, ensure_ascii=False))
    idx_literal = (idx_literal.replace("<", "\\u003c").replace(">", "\\u003e")
                   .replace("&", "\\u0026"))
    # 单次扫描替换全部占位符：插入内容不会被后续 replace 二次替换
    mapping = {
        "__LANG__": html.escape(lang, quote=True),
        "__TITLE__": html.escape(title),
        "__REPO__": html.escape(title),
        "__TREE__": _tree_html(roots, children),
        "__DATE__": time.strftime("%Y-%m-%d %H:%M %z"),
        "__MERMAID__": _mermaid_runtime(),
        "__INDEX__": idx_literal,
        "__PAGES__": page_html,
    }
    doc = re.sub(r"__[A-Z]+__", lambda m: mapping.get(m.group(0), m.group(0)), _TEMPLATE)
    unresolved = sorted(set(re.findall(r"__[A-Z]+__", _TEMPLATE)) - set(mapping))
    if unresolved:
        sys.exit(f"[dsh-wiki] 内部错误: 模板占位符缺少映射 {unresolved}（构建器 bug，请报告）")
    site = wiki_dir / "site"
    try:
        site.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        sys.exit(f"[dsh-wiki] 无法创建站点目录 {site}：{exc}")
    out = site / "index.html"
    _write_text(out, doc)
    return {"pages": len(pages), "path": out.resolve(), "bytes": out.stat().st_size,
            "mermaid": MERMAID_PATH.exists()}


# ---------------------------------------------------------------- config

DEFAULT_CONFIG = {
    "language": "auto",            # auto=跟随仓库文档语言；否则显式 BCP47 代码
    "granularity": "theme",        # theme=按主题合并 | file=逐文件 | hybrid
    "pages": {"min": 6, "max": 40},
    "tree": {"maxChildren": 8, "maxDepth": 4},
    "wordsPerPage": [400, 900],
    "diagrams": "minimal",         # none | minimal(架构/数据流/模块边界页≥1图) | rich(尽量每页1图)
    "citations": "strict",         # strict=每个论断必须 path:line（selfcheck 机检永远常开）
    "skeleton": {"knownIssues": True},
}

# 预设档位：展开为上述字段的快捷方式；同层/后层的显式字段覆盖预设
PROFILES = {
    "compact":  {"pages": {"min": 6, "max": 16},  "wordsPerPage": [300, 600],
                 "diagrams": "minimal", "granularity": "theme"},
    "standard": {"pages": {"min": 6, "max": 40},  "wordsPerPage": [400, 900],
                 "diagrams": "minimal", "granularity": "theme"},
    "deep":     {"pages": {"min": 12, "max": 40}, "wordsPerPage": [800, 1600],
                 "diagrams": "minimal", "granularity": "theme"},
    "legacy":   {"pages": {"min": 20, "max": 40}, "wordsPerPage": [1200, 2200],
                 "diagrams": "rich", "granularity": "file"},
}

_LANG_RE = re.compile(r"^[a-zA-Z]{2,3}(-[A-Za-z0-9]{2,8})*$")
_NESTED = {"pages", "tree", "skeleton"}
_KNOWN_KEYS = {"language", "granularity", "pages", "tree", "wordsPerPage",
               "diagrams", "citations", "skeleton"}
_NESTED_KEYS = {"pages": {"min", "max"}, "tree": {"maxChildren", "maxDepth"},
                "skeleton": {"knownIssues"}}


def _apply_layer(resolved, prov, layer_name, cfg, errors):
    if not isinstance(cfg, dict):
        errors.append(f"{layer_name} 配置必须是 JSON 对象")
        return None
    profile_present = "profile" in cfg
    profile = cfg.get("profile")
    if profile_present:
        if not isinstance(profile, str) or profile not in PROFILES:
            errors.append(f"{layer_name}: 未知 profile {profile!r}（可选: {'/'.join(PROFILES)}）")
        else:
            _apply_layer(resolved, prov, f"{layer_name}:profile", PROFILES[profile], errors)
    for key, val in cfg.items():
        if key == "profile":
            continue
        if key not in _KNOWN_KEYS:
            errors.append(f"{layer_name}: 未知配置键 '{key}'"
                          f"（可调键: {', '.join(sorted(_KNOWN_KEYS | {'profile'}))}）")
            continue
        if key in _NESTED and isinstance(resolved.get(key), dict) and isinstance(val, dict):
            resolved[key] = {**resolved[key], **val}
            for sub in val:
                prov[f"{key}.{sub}"] = layer_name
        else:
            resolved[key] = val
        prov[key] = layer_name
    return resolved


def _is_int(x) -> bool:
    """True 仅对真正的整数（bool 是 int 子类，必须排除）。"""
    return isinstance(x, int) and not isinstance(x, bool)


def _validate(resolved, errors, warns):
    lang = resolved.get("language")
    if lang != "auto" and not (isinstance(lang, str) and _LANG_RE.match(lang)):
        errors.append(f"language 非法: {lang!r}（用 'auto' 或 BCP47 代码如 zh-CN/en）")
    if resolved.get("granularity") not in ("theme", "file", "hybrid"):
        errors.append(f"granularity 非法: {resolved.get('granularity')!r}")
    if resolved.get("diagrams") not in ("none", "minimal", "rich"):
        errors.append(f"diagrams 非法: {resolved.get('diagrams')!r}")
    if resolved.get("citations") not in ("relaxed", "strict"):
        errors.append(f"citations 非法: {resolved.get('citations')!r}")
    pages = resolved.get("pages")
    if not isinstance(pages, dict):
        errors.append(f"pages 必须是对象: {pages!r}")
        pages = {}
    elif not (_is_int(pages.get("min")) and _is_int(pages.get("max"))
              and 1 <= pages["min"] <= pages["max"] <= 100):
        errors.append(f"pages 非法: {pages}（需 1 ≤ min ≤ max ≤ 100 的整数）")
    tree = resolved.get("tree")
    if not isinstance(tree, dict):
        errors.append(f"tree 必须是对象: {tree!r}")
        tree = {}
    else:
        if not (_is_int(tree.get("maxChildren")) and 2 <= tree["maxChildren"] <= 16):
            errors.append(f"tree.maxChildren 非法: {tree.get('maxChildren')!r}（2–16 的整数）")
        if not (_is_int(tree.get("maxDepth")) and 2 <= tree["maxDepth"] <= 6):
            errors.append(f"tree.maxDepth 非法: {tree.get('maxDepth')!r}（2–6 的整数）")
    wpp = resolved.get("wordsPerPage")
    if not (isinstance(wpp, list) and len(wpp) == 2
            and all(_is_int(n) and 100 <= n <= 5000 for n in wpp) and wpp[0] <= wpp[1]):
        errors.append(f"wordsPerPage 非法: {wpp!r}（[min, max]，100–5000 的整数）")
    skeleton = resolved.get("skeleton")
    if not isinstance(skeleton, dict):
        errors.append(f"skeleton 必须是对象: {skeleton!r}")
    elif not isinstance(skeleton.get("knownIssues"), bool):
        errors.append("skeleton.knownIssues 必须是布尔值")
    for group, allowed in _NESTED_KEYS.items():
        val = resolved.get(group)
        if isinstance(val, dict):
            extra = sorted(set(val) - allowed)
            if extra:
                errors.append(f"{group} 含未知子键: {', '.join(extra)}"
                              f"（可调: {', '.join(sorted(allowed))}）")
    if resolved.get("granularity") == "file" and _is_int(pages.get("max")) and pages["max"] < 20:
        warns.append("granularity=file 但 pages.max<20：逐文件切分通常需要更多页，建议调高")


def cmd_resolve(args):
    repo = Path(args.repo).expanduser().resolve()
    if not repo.is_dir():
        sys.exit(f"[dsh-wiki] 仓库路径不是目录或不存在: {repo}")
    errors, warns = [], []
    resolved = json.loads(json.dumps(DEFAULT_CONFIG))  # deep copy
    prov = {k: "builtin" for k in resolved}

    home_cfg = HOME / ".dsh" / "dsh-wiki" / "config.json"
    repo_cfg = repo / ".dsh-wiki" / "config.json"
    layers = {}
    for name, path in (("global", home_cfg), ("repo", repo_cfg)):
        if path.exists():
            layers[name] = _read_json(path, f"{name} 配置")
        else:
            layers[name] = None
    for name in ("global", "repo"):
        if layers[name] is not None:
            _apply_layer(resolved, prov, name, layers[name], errors)

    profiles_used = {}
    for name in ("global", "repo"):
        cfg = layers[name]
        p = cfg.get("profile") if isinstance(cfg, dict) else None
        if isinstance(p, str) and p in PROFILES:
            profiles_used[name] = p

    flag_cfg = {}
    flag_sets = []
    for pair in (args.set or []):
        if "=" not in pair:
            sys.exit(f"[dsh-wiki] --set 需要 k=v 形式，收到: {pair}")
        key, raw = pair.split("=", 1)
        try:
            val = json.loads(raw)
        except Exception:
            val = raw
        parts = key.split(".")
        if any(not part for part in parts):
            errors.append(f"--set {key}: 路径段不能为空（形如 pages.max）")
            continue
        if parts[0] not in _KNOWN_KEYS and parts[0] != "profile":
            errors.append(f"--set: 未知配置键 '{parts[0]}'"
                          f"（可调键: {', '.join(sorted(_KNOWN_KEYS | {'profile'}))}）")
            continue
        if len(parts) > 1 and isinstance(resolved.get(parts[0]), list):
            errors.append(f"--set {key}: '{parts[0]}' 是列表字段，不支持点路径下钻；请整体赋值（如 --set '{parts[0]}=[300,600]'）")
            continue
        node = flag_cfg
        bad = False
        for part in parts[:-1]:
            nxt = node.get(part)
            if nxt is None:
                nxt = {}
                node[part] = nxt
            elif not isinstance(nxt, dict):
                errors.append(f"--set {key}: '{part}' 不是对象（{type(nxt).__name__}），"
                              f"不支持点路径下钻；列表字段请整体赋值")
                bad = True
                break
            node = nxt
        if bad:
            continue
        node[parts[-1]] = val
        flag_sets.append(f"{key}={raw}")
    if flag_cfg:
        _apply_layer(resolved, prov, "flags", flag_cfg, errors)
        layers["flags"] = flag_sets
        if isinstance(flag_cfg.get("profile"), str) and flag_cfg["profile"] in PROFILES:
            profiles_used["flags"] = flag_cfg["profile"]

    _validate(resolved, errors, warns)
    if errors:
        for e in errors:
            print(f"[dsh-wiki] FAIL 配置非法: {e}", file=sys.stderr)
        sys.exit(1)

    meta = {
        "schema": "repo-wiki-local/1",
        "kind": "generation-meta",
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "resolved": resolved,
        "provenance": prov,
        "layers": {
            "global": str(home_cfg) if layers["global"] is not None else None,
            "repo": str(repo_cfg) if layers["repo"] is not None else None,
            "flags": layers.get("flags", []),
            "profiles": profiles_used,
        },
    }
    print(json.dumps(resolved, ensure_ascii=False, indent=2))
    for w in warns:
        print(f"[dsh-wiki] WARN {w}", file=sys.stderr)
    if args.dry_run:
        return
    out = repo / ".dsh-wiki" / "generation-meta.json"
    try:
        out.parent.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        sys.exit(f"[dsh-wiki] 无法创建 {out.parent}：{exc}")
    _write_text(out, json.dumps(meta, ensure_ascii=False, indent=2))
    src_desc = ", ".join(f"{k}←{v}" for k, v in prov.items() if v != "builtin") or "全部默认"
    print(f"[dsh-wiki] 生效配置已写入 {out}（覆盖: {src_desc}）", file=sys.stderr)
    for w in warns:
        print(f"[dsh-wiki] WARN {w}", file=sys.stderr)


# ---------------------------------------------------------------- import legacy

def _page_has_markdown(p) -> bool:
    md = p.get("markdown")
    return isinstance(md, str) and bool(md.strip())


def load_legacy(source: Path):
    meta_src = {}
    pages = []
    bad_files = []
    wj = source / "wiki.json"
    if wj.exists():
        data = _read_json(wj, "legacy wiki.json")
        if isinstance(data, dict):
            meta_src = data
            pages = [p for p in (data.get("pages") or [])
                     if isinstance(p, dict) and _page_has_markdown(p)]
    if not pages:
        for f in sorted((source / "draft-pages").glob("*.json")):
            try:
                p = json.loads(f.read_text(encoding="utf-8"))
            except Exception as exc:
                bad_files.append(f"{f.name}: {exc}")
                continue
            if not isinstance(p, dict):
                bad_files.append(f"{f.name}: 顶层不是 JSON 对象")
                continue
            if p.get("markdown") is not None and not isinstance(p.get("markdown"), str):
                bad_files.append(f"{f.name}: markdown 不是字符串")
                continue
            if _page_has_markdown(p):
                pages.append(p)
    if bad_files:
        print(f"[dsh-wiki] WARN {len(bad_files)} 个 draft-pages 文件不可解析: "
              f"{'; '.join(bad_files[:5])}", file=sys.stderr)
    if not pages:
        detail = f"（其中 {len(bad_files)} 个文件解析失败）" if bad_files else ""
        sys.exit(f"[dsh-wiki] {source} 里既无含正文的 wiki.json，也无可用 draft-pages{detail}")
    draft = {}
    dj = source / "draft.json"
    if dj.exists():
        d = _read_json(dj, "legacy draft.json")
        draft = d if isinstance(d, dict) else {}
    catalog = meta_src.get("catalogTree") or draft.get("catalogTree") or []
    if not isinstance(catalog, list):
        print("[dsh-wiki] WARN legacy catalogTree 不是列表，已忽略", file=sys.stderr)
        catalog = []
    return meta_src, draft, pages, catalog


def merge_catalog(catalog, pages, warns=None):
    """旧版目录树(catalogTree 节点) + 内容页(pages, 挂在节点下) → 统一页面树。

    有 pageId 的节点替换为对应内容页；无 pageId 的节点生成"本节导览"页。
    未被目录树引用的内容页降级为根并计数。节点 id 与页面 id 集合互不混淆，
    目录层级通过映射后的实际页面 id 串联（不产生断链）。
    """
    warns = warns if warns is not None else []
    if not catalog:
        return pages, len(pages), 0
    by_id = {str(p.get("id")): p for p in pages if isinstance(p, dict)}
    used = {str(p.get("id")) for p in pages if isinstance(p, dict)}
    merged, mounted, seen_nodes = [], set(), set()
    stack = [(nd, None) for nd in reversed(catalog) if isinstance(nd, dict)]
    for bad in [nd for nd in catalog if not isinstance(nd, dict)]:
        warns.append(f"catalogTree 节点不是对象（{type(bad).__name__}），已跳过")

    while stack:
        nd, parent_actual = stack.pop()
        nid = str(nd.get("id") or "")
        if nid and nid in seen_nodes:
            warns.append(f"catalogTree 节点 id 重复: {nid}")
        seen_nodes.add(nid)
        kids = nd.get("children")
        if kids is None:
            kids = []
        elif not isinstance(kids, list):
            warns.append(f"catalogTree 节点 {nid or '?'} 的 children 不是列表，已忽略")
            kids = []
        pid = nd.get("pageId")
        if pid is not None and str(pid) in by_id and str(pid) not in mounted:
            page = dict(by_id[str(pid)])
            page["parentId"] = parent_actual or None
            merged.append(page)
            mounted.add(str(pid))
            child_parent = page.get("id") if page.get("id") is not None else pid
        else:
            if pid is not None and str(pid) in mounted:
                warns.append(f"catalogTree 节点 {nid or '?'} 重复引用页面 {pid}，生成导览页代替")
            base = nid or "section"
            sid, k = base, 2
            while sid in used:
                sid = f"{base}-sec{k}"
                k += 1
            used.add(sid)
            toc = "## 本节导览\n\n" + "\n".join(
                f"- {c.get('title')}" for c in kids if isinstance(c, dict)) if kids else ""
            merged.append({
                "id": sid,
                "parentId": parent_actual or None,
                "title": nd.get("title") or nid or "本节",
                "order": nd.get("order"),
                "description": "",
                "filePaths": [],
                "sources": [],
                "markdown": toc,
            })
            child_parent = sid
        for k in reversed(kids):
            if isinstance(k, dict):
                stack.append((k, child_parent))
            else:
                warns.append(f"catalogTree 节点不是对象（{type(k).__name__}），已跳过")
    orphans = 0
    for p in pages:
        if not isinstance(p, dict):
            continue
        if str(p.get("id")) not in mounted:
            merged.append(dict(p))
            orphans += 1
    return merged, len(merged), orphans


def _strip_leading_h1(md: str, title: str) -> str:
    """旧版正文常自带 `# 标题` 首行，而查看器页头已按元数据渲染 h1——去重。"""
    lines = md.split("\n")
    i = 0
    while i < len(lines) and not lines[i].strip():
        i += 1
    if i >= len(lines):
        return md
    m = re.match(r"^#\s+(.+?)\s*$", lines[i])
    if not m:
        return md
    norm = lambda s: re.sub(r"\s+", "", s).casefold()
    if norm(m.group(1)) != norm(title or ""):
        return md
    return "\n".join(lines[i + 1:]).lstrip("\n")


def cmd_import(args):
    src = Path(args.source).expanduser()
    if not src.is_absolute():
        src = LEGACY_BASE / src
    if not src.exists():
        sys.exit(f"[dsh-wiki] 找不到 {src}")
    meta_src, draft, raw_pages, catalog = load_legacy(src)
    warns: list = []
    merged, total, orphans = merge_catalog(catalog, raw_pages, warns)
    for w in warns:
        print(f"[dsh-wiki] WARN {w}", file=sys.stderr)
    if orphans:
        print(f"[dsh-wiki] WARN {orphans} 个内容页不在目录树中，已降级为根节点", file=sys.stderr)
    deduped = 0
    for p in merged:
        md = p.get("markdown")
        if isinstance(md, str):
            stripped = _strip_leading_h1(md, str(p.get("title") or ""))
            if stripped != md:
                p["markdown"] = stripped
                deduped += 1
    if deduped:
        print(f"[dsh-wiki] 已去掉 {deduped} 页与页头 h1 重复的首行标题")
    repo_id = meta_src.get("repoId") or draft.get("repoId") or ""
    explicit_dest = bool(args.dest)
    if args.dest:
        dest = Path(args.dest).expanduser()
    elif repo_id:
        rid = Path(str(repo_id)).expanduser()
        if not rid.is_absolute():
            rid = (src / rid).resolve()   # 相对 repoId 以 legacy 源目录为基准，不随 CWD 漂移
        dest = rid / ".dsh-wiki"
    else:
        dest = HOME / ".zcode/v2/repo-wiki-local" / src.name
    try:
        dest_res, src_res = dest.resolve(), src.resolve()
    except OSError as exc:
        sys.exit(f"[dsh-wiki] 路径解析失败：{exc}")
    where = "--dest" if explicit_dest else "默认目标（由 repoId 推导）"
    if dest_res == src_res:
        sys.exit(f"[dsh-wiki] 拒绝导入: {where} 指向 legacy 源目录本身（{src}），会不可逆覆写源数据")
    if dest_res in src_res.parents:
        # dest 是 src 的上级（如指向 legacy 库根）：会把产物写进库根，拒绝
        sys.exit(f"[dsh-wiki] 拒绝导入: {where}（{dest}）是 legacy 源目录的上级，请使用独立目录")
    if src_res in dest_res.parents:
        # dest 在 src 内（文档化的默认情形）：仅允许全新/空目录或本工具产物，
        # 防止把 wiki.json/pages 写进 legacy 数据目录（如 src/draft-pages）或其父级
        if dest.exists() and any(dest.iterdir()):
            existing = dest / "wiki.json"
            ok = False
            if existing.is_file():
                try:
                    prev = json.loads(existing.read_text(encoding="utf-8"))
                    ok = isinstance(prev, dict) and prev.get("generatedBy") == "import-legacy"
                except Exception:
                    ok = False
            if not ok:
                sys.exit(f"[dsh-wiki] 拒绝导入: {where}（{dest}）位于 legacy 源目录内且已含其他文件，"
                         f"请使用空的子目录（如 <src>/.dsh-wiki）或独立目录")
    if dest.exists() and not dest.is_dir():
        sys.exit(f"[dsh-wiki] 拒绝导入: --dest 已存在且不是目录: {dest}")
    dest_wj = dest / "wiki.json"
    if dest_wj.is_file():
        try:
            prev = json.loads(dest_wj.read_text(encoding="utf-8"))
        except Exception:
            prev = None
        if not isinstance(prev, dict) or prev.get("generatedBy") != "import-legacy":
            sys.exit(f"[dsh-wiki] 拒绝导入: {dest_wj} 已存在且非本工具导入产物，"
                     f"请改用其他 --dest 或先移走该目录")
    try:
        dest.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        sys.exit(f"[dsh-wiki] 无法创建目标目录 {dest}：{exc}")
    wiki = {
        "schema": "repo-wiki-local/1",
        "repoId": repo_id or src.name,
        "language": meta_src.get("language") or draft.get("language") or "zh-CN",
        "generatedBy": "import-legacy",
        "importedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "legacySource": str(src),
        "pages": merged,
    }
    _write_text(dest / "wiki.json", json.dumps(wiki, ensure_ascii=False, indent=1))
    legacy_meta = {k: (meta_src.get(k) or draft.get(k))
                   for k in ("generationModel", "generationOptions", "wikiId")
                   if (meta_src.get(k) or draft.get(k))}
    if legacy_meta:
        _write_text(dest / "legacy-meta.json", json.dumps(legacy_meta, ensure_ascii=False, indent=1))
    pages_dir = dest / "pages"
    try:
        pages_dir.mkdir(exist_ok=True)
    except OSError as exc:
        sys.exit(f"[dsh-wiki] 无法创建 {pages_dir}：{exc}")
    for f in pages_dir.glob("*.md"):
        try:
            f.unlink()
        except OSError as exc:
            sys.exit(f"[dsh-wiki] 无法清理旧导出 {f}：{exc}")
    used_names: set = set()
    for p in merged:
        pid = re.sub(r"[^A-Za-z0-9_-]", "-", str(p.get("id") or "page")) or "page"
        base, k = pid, 2
        while pid in used_names:
            pid = f"{base}-{k}"
            k += 1
        used_names.add(pid)
        _write_text(pages_dir / f"{pid}.md", p.get("markdown") or "")
    info = build_site(dest)
    print(f"[dsh-wiki] 导入完成: {src.name} → {dest_res}")
    print(f"[dsh-wiki] 页数 {info['pages']}, 站点 {info['path']} ({info['bytes'] // 1024} KB), "
          f"mermaid离线渲染 {'✓' if info['mermaid'] else '✗(仅源码)'}")
    print(f"[dsh-wiki] 用浏览器打开: {info['path']}")


# ---------------------------------------------------------------- build / selfcheck

def cmd_build(args):
    info = build_site(Path(args.wiki).expanduser())
    print(f"[dsh-wiki] 构建: {info['pages']} 页 → {info['path']} ({info['bytes'] // 1024} KB), "
          f"mermaid离线渲染 {'✓' if info['mermaid'] else '✗(仅源码)'}")


# 外链扫描：脚本块（内联 bundle / INDEX JSON）先整体剔除，只在真实 HTML 片段里
# 匹配元素属性——覆盖单/双/无引号、实体编码与控制字符混淆、protocol-relative，
# 以及 CSS url()/@import。正文里被转义的纯文本（&lt;img …）不会命中。
_TAG_RE = re.compile(r"<([a-zA-Z][a-zA-Z0-9-]*)((?:[^>\"']|\"[^\"]*\"|'[^']*')*)>", re.S)
_ATTR_RE = re.compile(
    r"([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:\"([^\"]*)\"|'([^']*)'|([^\s>]+))")
_CSS_URL_RE = re.compile(r"url\(\s*([^)]*)\)", re.I)
_EXT_SCHEME_RE = re.compile(r"^(?:(?:https?|file|data|javascript|vbscript):|//)", re.I)
_SCRIPT_BLOCK_RE = re.compile(r"<script\b[^>]*>.*?</script>", re.I | re.S)
# 构建器自己写入的 mermaid 内联标记：只在"首个真实 script 块"内查找（页面正文里的
# 字面量会被转义成 &lt;script&gt;，无法伪造出真 script 块）
_MERMAID_MARK = "__esbuild_esm_mermaid_nm"


def _mermaid_inlined(doc: str) -> bool:
    for m in _SCRIPT_BLOCK_RE.finditer(doc):
        block = m.group(0)
        head = re.sub(r"^<script[^>]*>\s*", "", block, count=1)
        # 页面正文只可能出现在 INDEX 脚本块内；按块首结构判定，其余块由模板生成
        if head.startswith("window.INDEX=JSON.parse("):
            continue
        if _MERMAID_MARK in block:
            return True
    return False


def _normalize_url_value(val: str) -> str:
    val = html.unescape(val)
    return re.sub(r"[\x00-\x20\x7f]", "", val)


def _looks_external(val: str) -> bool:
    if not val:
        return False
    if _SVG_DATA_IMAGE_RE.match(val.strip()):   # 内联 base64 图片属自包含，不算外链
        return False
    return bool(_EXT_SCHEME_RE.match(val))


def _split_url_list(val: str):
    """srcset 等多 URL 值：按逗号/空白拆成单个 URL 逐个判定。"""
    return [u for u in re.split(r"[,\s]+", val) if u]


_STYLE_BLOCK_RE = re.compile(r"<style\b[^>]*>(.*?)</style>", re.I | re.S)
_STYLE_ATTR_RE = re.compile(r"""\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))""", re.I)
_CSS_IMPORT_RE = re.compile(r"@\s*import", re.I)
_CSS_STRING_URL_RE = re.compile(r"""["']\s*(?:(?:https?|file|javascript|vbscript|data):|//)[^"']*["']""", re.I)
_CSS_ESCAPE_RE = re.compile(r"\\([0-9a-fA-F]{1,6}\s?|.)")


def _css_unescape(text: str) -> str:
    """解码 CSS 反斜杠转义（\\75 rl( → url( ），使混淆写法在扫描前归一。"""
    def dec(m):
        tok = m.group(1)
        try:
            if re.fullmatch(r"[0-9a-fA-F]{1,6}\s?", tok):
                return chr(int(tok.strip(), 16))
        except ValueError:
            pass
        return tok.strip() or m.group(0)
    return _CSS_ESCAPE_RE.sub(dec, text)


def _css_problems(css: str, where: str):
    """CSS 文本的一票否决规则：@import/字符串 URL/非 # 的 url() 目标。"""
    out = []
    decoded = _css_unescape(css)
    if _CSS_IMPORT_RE.search(decoded):
        out.append(f"{where}: @import")
    for m in _CSS_STRING_URL_RE.finditer(decoded):
        out.append(f"{where}: {m.group(0)[:80]}")
    for m in _CSS_URL_RE.finditer(decoded):
        val = _normalize_url_value(m.group(1)).strip("'\"")
        if _looks_external(val):
            out.append(f"url({val[:80]})")
    return out


def _external_refs(doc: str):
    """返回文档里真实外链/可执行 URL 列表（selfcheck FAIL 用）。

    元素属性在"真实标签"内匹配；CSS url() 只在 <style> 块与 style 属性内匹配——
    正文里讲解 CSS 的纯文本（如 `background:url(https://…)`）不误报。
    """
    scan = _SCRIPT_BLOCK_RE.sub("", doc)
    found = []
    for tm in _TAG_RE.finditer(scan):
        tag, attrs = tm.group(1).lower(), tm.group(2)
        for am in _ATTR_RE.finditer(attrs):
            attr = am.group(1).lower()
            val = _normalize_url_value(am.group(2) or am.group(3) or am.group(4) or "")
            if not val:
                continue
            # xmlns 命名空间声明与 data-* 自定义属性不产生请求
            if attr == "xmlns" or attr.startswith("xmlns:") or attr.startswith("data-"):
                continue
            if attr == "srcdoc":
                found.append(f"<{tag}> srcdoc=<内联 HTML 文档>")
                continue
            if attr == "content":
                mm = re.search(r"(?i)\burl\s*=\s*['\"]?\s*([^'\";]+)", val)
                if not mm:
                    continue
                val = _normalize_url_value(mm.group(1))
            if attr in ("href", "src") and val.startswith("#"):
                continue
            if attr == "srcset":
                if _SVG_DATA_IMAGE_RE.match(val.strip()):
                    continue
                for u in _split_url_list(val):
                    if _looks_external(u):
                        found.append(f"srcset={u[:80]}")
                continue
            if attr in _SVG_URL_LIST_ATTRS or attr == "attributename":
                if _SVG_SCHEME_RE.search(val) or not _svg_url_targets_ok(val):
                    found.append(f"{attr}={val[:80]}")
                continue
            if attr == "style":
                found.extend(_css_problems(val, "style-attr"))
                continue
            if _looks_external(val):
                found.append(f"{attr}={val[:80]}")
    css_texts = [m.group(1) for m in _STYLE_BLOCK_RE.finditer(scan)]
    css_texts += [m.group(1) or m.group(2) or m.group(3) or "" for m in _STYLE_ATTR_RE.finditer(scan)]
    for css in css_texts:
        found.extend(_css_problems(css, "css"))
    return found

# path:line 引用机检：`` `相对路径:行号` `` 或 `` `相对路径:起-止` ``
# 覆盖常见代码/配置扩展名（白名单有限，未列出的扩展名不做机检，见 SKILL.md）
_REF_EXTS = ("ts|tsx|js|jsx|cjs|mjs|json|md|wxml|py|go|rs|swift|kt|java|vue|yml|yaml|toml"
             "|cpp|cc|hpp|hxx|cs|css|scss|less|html|htm|xml|sql|rb|php|lua|dart|mm|pl"
             "|sh|bash|zsh|c|h|m|txt|ini|cfg|conf|env|properties|gradle|proto|graphql|tf")
_REF_RE = re.compile(
    r"`([A-Za-z0-9._\-/]+\.(?:" + _REF_EXTS + r")):(\d+)(?:-(\d+))?`", re.I)
_REF_SKIP_WARN = "引用机检跳过（仓库根不可用，无法解析相对路径）"


def _check_refs(repo_id, pages, problems, warns, wiki_dir: Path):
    """常开质量门：所有 path:line 引用必须文件存在且行号在界内，且不得越出仓库。

    仓库根取 wiki.json 的 repoId：绝对路径直接用；相对路径以 wiki 目录为基准解析
    （不随 CWD 漂移）。仓库已移动/删除的存量 wiki 降级为警告而非失败。
    """
    repo_id = str(repo_id or "")
    if not repo_id:
        warns.append(_REF_SKIP_WARN + ": 未记录")
        return
    repo_root = Path(repo_id).expanduser()
    if not repo_root.is_absolute():
        repo_root = (wiki_dir / repo_root).resolve()
    if not repo_root.exists():
        warns.append(_REF_SKIP_WARN + f": {repo_root}")
        return
    line_counts = {}
    n_checked = 0
    n_before = len(problems)
    for p in pages:
        for m in _REF_RE.finditer(p.get("markdown") or ""):
            n_checked += 1
            rel, s = m.group(1), int(m.group(2))
            e = int(m.group(3) or m.group(2))
            rel_norm = os.path.normpath(rel)
            if os.path.isabs(rel_norm) or rel_norm == ".." or rel_norm.startswith(".." + os.sep):
                problems.append(f"页面 {p.get('id')}: 引用越出仓库范围 {rel}")
                continue
            f = repo_root / rel_norm
            if not f.is_file():
                problems.append(f"页面 {p.get('id')}: 引用文件不存在 {rel}")
                continue
            if rel not in line_counts:
                try:
                    line_counts[rel] = f.read_text(encoding="utf-8", errors="replace").count("\n") + 1
                except OSError:
                    problems.append(f"页面 {p.get('id')}: 引用文件不可读 {rel}")
                    continue
            if s < 1 or e < s or e > line_counts[rel]:
                problems.append(
                    f"页面 {p.get('id')}: 行号越界 {rel}:{s}-{e}（文件共 {line_counts[rel]} 行）")
    if n_checked:
        n_bad = len(problems) - n_before
        if n_bad:
            print(f"[dsh-wiki] 引用机检: {n_checked} 处中 {n_bad} 处失败（见 FAIL）")
        else:
            print(f"[dsh-wiki] 引用机检: {n_checked} 处 path:line 引用全部可解析")


def cmd_selfcheck(args):
    wiki_dir = Path(args.wiki).expanduser()
    problems, warns = [], []
    wj = wiki_dir / "wiki.json"
    if not wj.exists():
        sys.exit(f"[dsh-wiki] selfcheck 失败: 缺 {wj}")
    data = _read_json(wj, "wiki.json")
    if not isinstance(data, dict):
        sys.exit(f"[dsh-wiki] selfcheck 失败: {wj} 顶层必须是 JSON 对象")
    pages = normalize_pages(data.get("pages") or [], warns)
    ids = {p["id"] for p in pages}
    for p in pages:
        pid = p.get("parentId")
        if pid and pid not in ids:
            warns.append(f"页面 {p['id']} 的父 {pid} 缺失（降级为根）")
    # 环检测：normalize 后 id 唯一；只报实际环成员（旁支节点不计入）
    parent = {p["id"]: p.get("parentId") for p in pages}
    reported = set()
    for start in parent:
        seen, chain, cur = {}, [], start
        while cur and cur in parent and parent[cur]:
            if cur in seen:
                cycle = chain[seen[cur]:]
                key = tuple(sorted(cycle))
                if key not in reported:
                    reported.add(key)
                    problems.append(f"页面树存在环: {' → '.join(cycle + [cur])}")
                break
            seen[cur] = len(chain)
            chain.append(cur)
            cur = parent[cur]
    site = wiki_dir / "site" / "index.html"
    if not site.is_file():
        problems.append(f"缺站点文件 {site}")
    else:
        try:
            doc = site.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError) as exc:
            doc = None
            problems.append(f"站点文件不可读/损坏 {site}（{exc}）")
        if doc is not None:
            if len(doc) < 512 or "<!DOCTYPE html" not in doc or "<main" not in doc:
                problems.append(f"站点文件内容不完整（{len(doc)} 字符，缺 DOCTYPE/main 结构）: {site}")
            for ref in _external_refs(doc):
                problems.append(f"外链 {ref}")
            if not _mermaid_inlined(doc):
                warns.append("站点未内联 mermaid 运行时（图表将仅显源码）")
    _check_refs(data.get("repoId"), pages, problems, warns, wiki_dir)
    for w in warns:
        print(f"[dsh-wiki] WARN {w}", file=sys.stderr)
    if problems:
        for p in problems:
            print(f"[dsh-wiki] FAIL {p}", file=sys.stderr)
        sys.exit(1)
    print(f"[dsh-wiki] selfcheck 通过: {len(pages)} 页, 站点自包含、零外链")


# ---------------------------------------------------------------- cli

def main():
    ap = argparse.ArgumentParser(prog="build_wiki_site.py", description="repo-wiki 纯本地构建器")
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build", help="由 wiki.json 构建自包含站点")
    b.add_argument("--wiki", required=True)
    im = sub.add_parser("import-legacy", help="导入旧版 repo-wiki 数据并构建")
    im.add_argument("source")
    im.add_argument("--dest", default=None)
    sc = sub.add_parser("selfcheck", help="树完整性 + 零外链 + 引用可解析性校验")
    sc.add_argument("--wiki", required=True)
    rc = sub.add_parser("resolve-config", help="三层合并生成配置并落 generation-meta.json")
    rc.add_argument("--repo", required=True, help="仓库路径")
    rc.add_argument("--set", action="append", default=[], metavar="K=V",
                    help="覆盖字段，点路径寻址（可重复，如 --set language=zh-CN --set pages.max=24）")
    rc.add_argument("--dry-run", action="store_true", help="只打印生效配置，不写文件")
    args = ap.parse_args()
    try:
        if args.cmd == "build":
            cmd_build(args)
        elif args.cmd == "import-legacy":
            cmd_import(args)
        elif args.cmd == "selfcheck":
            cmd_selfcheck(args)
        elif args.cmd == "resolve-config":
            cmd_resolve(args)
    except RecursionError:
        sys.exit("[dsh-wiki] 输入嵌套过深（递归超限）：请降低 markdown 嵌套/页面树深度后重试")


if __name__ == "__main__":
    main()
