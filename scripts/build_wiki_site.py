#!/usr/bin/env python3
"""dsh-wiki builder — local only, zero network, standard library only (Python >= 3.7).

Subcommands:
  build          --wiki <dir>                       build a self-contained site/index.html from wiki.json
  import-legacy  <hash|path> [--dest <dir>]         import legacy ~/.zcode/v2/repo-wiki/<hash> and build (no automatic selfcheck)
  selfcheck      --wiki <dir>                       tree integrity + zero external links + citation check (exit 0/1)
  resolve-config --repo <path> [--set K=V …] [--dry-run]  merge config layers and write generation-meta.json
  assemble       --wiki <dir> [--repo P] [--title T] [--language L]  pages/*.md + cards/*.md → wiki.json
  diff-impact    --wiki <dir> [--repo P] [--from C] [--to C]  changed files → affected pages/cards (read-only JSON)
  check-translation --canonical <dir> (--translation <dir>|--lang <tag>) [--meta <file>] [--json]
                                                    translated locale snapshot vs canonical English wiki (read-only)
  locales-init   --canonical <dir> --lang <tag> [--force] [--json]
                                                    create <canonical>/locales/<tag>/ skeleton (structure only)

Convention: WARN/FAIL diagnostics go to stderr, data/reports to stdout.
"""
import argparse
import copy
import html
import json
import os
import re
import shutil
import subprocess
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
# 构建期上下文：本 wiki 的卡片 id 集合（None = 无卡片，链接按旧行为渲染）与断链收集
_CARD_LINKS = None
_CARD_LINK_WARNS: list = []

# Site chrome strings follow wiki.json `language`: vi* -> Vietnamese, zh* -> Chinese,
# anything else -> English (default). Every table must carry exactly the "en" keys.
UI_STRINGS = {
    "en": {
        "image": "image", "imageNote": " (offline viewer does not load external images)",
        "sources": "Sources", "emptyPage": "(this page has no content)",
        "kindModule": "Module", "kindConcept": "Concept", "kindApi": "API",
        "all": "All", "cards": "Knowledge cards",
        "cardsDesc": "{n} cards: atomic overviews of modules, concepts and APIs, each with machine-checked evidence.",
        "noSummary": "(no summary)", "keyFiles": "Key files", "related": "Related cards", "refBy": "Pages referencing this card",
        "cardTag": "card", "theme": "Toggle theme", "search": "Search\u2026",
        "noscript": "This viewer needs JavaScript to switch pages and search; open it in a browser with JavaScript enabled.",
        "footer": "generated locally, nothing uploaded", "noHits": "No results", "light": "Light", "dark": "Dark",
    },
    "zh": {
        "image": "图片", "imageNote": "（离线查看器不加载外部图片）",
        "sources": "来源", "emptyPage": "（此页无内容）",
        "kindModule": "模块", "kindConcept": "概念", "kindApi": "API",
        "all": "全部", "cards": "知识卡片",
        "cardsDesc": "{n} 张卡片：模块、概念与 API 的原子速览，每张都带可机检的证据。",
        "noSummary": "（无摘要）", "keyFiles": "关键文件", "related": "相关卡片", "refBy": "引用此卡片的页面",
        "cardTag": "卡片", "theme": "切换主题", "search": "全文搜索…",
        "noscript": "本查看器需要 JavaScript 才能切换页面与全文搜索；请在启用 JS 的浏览器中打开。",
        "footer": "纯本地生成，零上传", "noHits": "无命中", "light": "浅色", "dark": "深色",
    },
    "vi": {
        "image": "hình ảnh", "imageNote": " (trình xem ngoại tuyến không tải ảnh bên ngoài)",
        "sources": "Nguồn", "emptyPage": "(trang này không có nội dung)",
        "kindModule": "Mô-đun", "kindConcept": "Khái niệm", "kindApi": "API",
        "all": "Tất cả", "cards": "Thẻ tri thức",
        "cardsDesc": "{n} thẻ: tổng quan nguyên tử của mô-đun, khái niệm và API, mỗi thẻ đều kèm bằng chứng kiểm tra tự động.",
        "noSummary": "(không có tóm tắt)", "keyFiles": "Tệp tham chiếu", "related": "Thẻ liên quan",
        "refBy": "Trang tham chiếu thẻ này",
        "cardTag": "thẻ", "theme": "Đổi giao diện", "search": "Tìm toàn văn…",
        "noscript": "Trình xem này cần JavaScript để chuyển trang và tìm kiếm toàn văn; hãy mở trong trình duyệt có bật JavaScript.",
        "footer": "tạo cục bộ, không tải lên", "noHits": "Không có kết quả", "light": "Sáng", "dark": "Tối",
    },
}
_UI = UI_STRINGS["en"]


def ui_lang(lang) -> str:
    low = str(lang or "").lower()
    if low.startswith("vi"):
        return "vi"
    return "zh" if low.startswith("zh") else "en"


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
               lambda m: f'<span class="imgref" title="{m.group(2)}">🖼 {m.group(1) or _UI["image"]}{_UI["imageNote"]}</span>', s)
    if _CARD_LINKS is not None:
        # 知识卡片链接 [文本](#card-<id>)：仅当本 wiki 有卡片时才变成站内锚点；
        # 目标不存在则降级为纯文本并告警。id 字符集受限，href 不可能携带外链。
        def _cardlink(m):
            cid = m.group(2)
            if cid in _CARD_LINKS:
                return f'<a class="cardlink" href="#card-{cid}">{m.group(1)}</a>'
            _CARD_LINK_WARNS.append(cid)
            return m.group(1)
        s = re.sub(r"\[([^\]]+)\]\(#card-([A-Za-z0-9_-]+)\)", _cardlink, s)
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
            warns.append(f"pages[{idx}] is not an object ({type(p).__name__}); skipped")
            continue
        raw_id = p.get("id")
        raw_title = p.get("title")
        key_src = raw_id if raw_id is not None else raw_title
        raw_key = str(key_src) if key_src is not None else "page"
        pid = _safe_id(raw_key, used)
        mapping.setdefault(raw_key, pid)
        counts[raw_key] += 1
        if raw_id is None and raw_title is not None:
            warns.append(f"pages[{idx}] has no id; derived from title {raw_title!r}")
        title = raw_title if isinstance(raw_title, str) else (str(raw_title) if raw_title is not None else "")
        title = _clean_text(title)
        if not title.strip():
            if raw_title is not None:
                warns.append(f"page {pid} has an empty title; set to 'Untitled'")
            title = "Untitled"
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
            warns.append(f"duplicate page id {raw_key!r} x{n}; de-duplicated")
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
    src_html = f'<div class="chips"><span class="srclab">{_UI["sources"]}</span>{srcs}</div>' if srcs else ""
    desc = f'<p class="desc">{_inline(p["description"])}</p>' if p["description"] else ""
    body = md_to_html(p["markdown"]) if p["markdown"] else f'<p class="todo">{_UI["emptyPage"]}</p>'
    return (f'<section class="page" id="pg-{p["id"]}" hidden>'
            f'<h1>{html.escape(str(p["title"]))}</h1>{desc}{chip_html}{src_html}'
            f'<div class="content">{body}</div></section>')


# ---------------------------------------------------------------- knowledge cards
# 卡片是可选的原子知识单元（spec 004）：只接受纯文本，全部 html.escape，不走
# markdown/SVG 渲染路径；无卡片时站点输出与旧版逐字节一致（时间戳除外）。

CARD_KINDS = ("module", "concept", "api")
def _kind_label(kind):
    return _UI.get({"module": "kindModule", "concept": "kindConcept", "api": "kindApi"}.get(kind, "kindConcept"))
_CARD_SUMMARY_MAX = 400
_CARD_KEYFILES_MAX = 8
_CARD_WARN_COUNT = 200
_CARD_KEYFILE_RE = re.compile(r"^[A-Za-z0-9._\-/]+(?::\d+(?:-\d+)?)?$")


def normalize_cards(raw_cards, page_ids, warns=None):
    """清洗 wiki.json.cards：非法条目丢弃并告警，断链 related/pageIds 丢弃并告警。"""
    warns = warns if warns is not None else []
    if raw_cards is None:
        return []
    if not isinstance(raw_cards, list):
        warns.append(f"cards is not an array ({type(raw_cards).__name__}); all cards ignored")
        return []
    used = set()
    page_ids = set(page_ids)
    cards = []
    for idx, c in enumerate(raw_cards):
        if not isinstance(c, dict):
            warns.append(f"cards[{idx}] is not an object ({type(c).__name__}); skipped")
            continue
        raw_id = c.get("id") if c.get("id") is not None else c.get("title")
        if raw_id is None or not str(raw_id).strip():
            warns.append(f"cards[{idx}] has neither id nor title; skipped")
            continue
        raw_id = str(raw_id)
        if raw_id == "grid":
            raw_id = "grid-card"
            warns.append(f"cards[{idx}] id 'grid' is reserved; renamed to grid-card")
        before = set(used)
        cid = _safe_id(raw_id, used)
        # 冲突检查必须在清洗/去重之后：去重后缀（如 x-2）也可能撞上页面 id card-x-2
        if f"card-{cid}" in page_ids or cid == "grid":
            warns.append(f"card {raw_id}: anchor card-{cid} collides with a page id or reserved anchor; skipped")
            used.discard(cid)
            continue
        if cid != re.sub(r"[^A-Za-z0-9_-]", "-", raw_id) or raw_id in before:
            warns.append(f"card id {raw_id!r} sanitized/de-duplicated to {cid}")
        title = _clean_text(str(c.get("title") or cid)).strip() or cid
        kind = c.get("kind")
        if kind not in CARD_KINDS:
            if kind is not None:
                warns.append(f"card {cid}: invalid kind {kind!r}; set to concept")
            kind = "concept"
        summary = c.get("summary")
        summary = _clean_text(summary if isinstance(summary, str) else ("" if summary is None else str(summary)))
        summary = " ".join(summary.split())
        if len(summary) > _CARD_SUMMARY_MAX:
            warns.append(f"card {cid}: summary longer than {_CARD_SUMMARY_MAX} chars; truncated")
            summary = summary[:_CARD_SUMMARY_MAX - 1] + "…"
        key_files = []
        for kf in _as_str_list(c.get("keyFiles")):
            kf = kf.strip()
            path_part = kf.split(":", 1)[0]
            if _CARD_KEYFILE_RE.match(kf) and not path_part.startswith("/") \
                    and ".." not in path_part.split("/"):
                key_files.append(kf)
            else:
                warns.append(f"card {cid}: invalid keyFiles entry {kf!r} (need repo-relative path[:line]); dropped")
        if len(key_files) > _CARD_KEYFILES_MAX:
            warns.append(f"card {cid}: more than {_CARD_KEYFILES_MAX} keyFiles; truncated")
            key_files = key_files[:_CARD_KEYFILES_MAX]
        if not key_files:
            warns.append(f"card {cid} has no valid keyFiles (at least 1 piece of evidence required); skipped")
            used.discard(cid)
            continue
        cards.append({
            "id": cid, "title": title, "kind": kind, "summary": summary,
            "keyFiles": key_files,
            "related": [str(x) for x in _as_str_list(c.get("related"))],
            "tags": list(dict.fromkeys(re.sub(r"\s+", "-", t.strip()) for t in _as_str_list(c.get("tags")) if t.strip()))[:12],
            "pageIds": [str(x) for x in _as_str_list(c.get("pageIds"))],
        })
    ids = {c["id"] for c in cards}
    for c in cards:
        bad = [r for r in c["related"] if r not in ids or r == c["id"]]
        if bad:
            warns.append(f"card {c['id']}: related points to missing cards {', '.join(bad[:5])}; removed")
        c["related"] = [r for r in dict.fromkeys(c["related"]) if r in ids and r != c["id"]]
        badp = [p for p in c["pageIds"] if p not in page_ids]
        if badp:
            warns.append(f"card {c['id']}: pageIds point to missing pages {', '.join(badp[:5])}; removed")
        c["pageIds"] = [p for p in dict.fromkeys(c["pageIds"]) if p in page_ids]
    if len(cards) > _CARD_WARN_COUNT:
        warns.append(f"{len(cards)} cards exceed {_CARD_WARN_COUNT} (10-40 recommended); the site may get large and slow")
    return cards


def _card_pages_linking(cards, pages):
    """卡片 id → 引用它的页面 id 列表（pageIds 声明 ∪ 页面正文里的 #card-<id> 链接）。"""
    refs = {c["id"]: list(c["pageIds"]) for c in cards}
    for p in pages:
        for cid in re.findall(r"\]\(#card-([A-Za-z0-9_-]+)\)", p.get("markdown") or ""):
            if cid in refs and p["id"] not in refs[cid]:
                refs[cid].append(p["id"])
    return refs


def _card_tile(c) -> str:
    tags = "".join(f'<span class="ctag">{html.escape(t)}</span>' for t in c["tags"])
    return (f'<a class="ctile" href="#card-{c["id"]}" data-kind="{c["kind"]}" '
            f'data-tags="{html.escape(" ".join(c["tags"]), quote=True)}">'
            f'<span class="ckind k-{c["kind"]}">{_kind_label(c["kind"])}</span>'
            f'<b>{html.escape(c["title"])}</b><span class="csum">{html.escape(c["summary"])}</span>'
            f'<span class="ctags">{tags}</span></a>')


def _cards_html(cards, pages) -> str:
    by_page = {p["id"]: p for p in pages}
    by_card = {c["id"]: c for c in cards}
    refs = _card_pages_linking(cards, pages)
    tags = sorted({t for c in cards for t in c["tags"]}, key=str.casefold)
    kinds = [k for k in CARD_KINDS if any(c["kind"] == k for c in cards)]
    btns = [f'<button class="cfilt on" data-f="">{_UI["all"]}</button>']
    btns += [f'<button class="cfilt" data-f="k:{k}">{_kind_label(k)}</button>' for k in kinds]
    btns += [f'<button class="cfilt" data-f="t:{html.escape(t, quote=True)}">#{html.escape(t)}</button>'
             for t in tags[:40]]
    grid = (f'<section class="page" id="pg-card-grid" hidden><h1>{_UI["cards"]}</h1>'
            f'<p class="desc">{html.escape(_UI["cardsDesc"].format(n=len(cards)))}</p>'
            f'<div class="cfilters">{"".join(btns)}</div>'
            f'<div class="cgrid">{"".join(_card_tile(c) for c in cards)}</div></section>')
    out = [grid]
    for c in cards:
        files = "".join(f"<li><code>{html.escape(f)}</code></li>" for f in c["keyFiles"])
        rel = "".join(f'<li><a class="cardlink" href="#card-{r}">{html.escape(by_card[r]["title"])}</a></li>'
                      for r in c["related"])
        pg = "".join(f'<li><a class="navitem" data-page="{pid}" href="#{pid}">'
                     f'{html.escape(by_page[pid]["title"])}</a></li>'
                     for pid in refs[c["id"]] if pid in by_page)
        tags_html = "".join(f'<span class="ctag">{html.escape(t)}</span>' for t in c["tags"])
        parts = [f'<section class="page card" id="pg-card-{c["id"]}" hidden>',
                 f'<p class="crumb"><a href="#card-grid">{_UI["cards"]}</a> · '
                 f'<span class="ckind k-{c["kind"]}">{_kind_label(c["kind"])}</span></p>',
                 f'<h1>{html.escape(c["title"])}</h1>',
                 f'<p class="csummary">{html.escape(c["summary"]) or _UI["noSummary"]}</p>',
                 f'<div class="ctags">{tags_html}</div>' if tags_html else "",
                 f'<h3>{_UI["keyFiles"]}</h3><ul class="cfiles">{files}</ul>']
        if rel:
            parts.append(f'<h3>{_UI["related"]}</h3><ul>{rel}</ul>')
        if pg:
            parts.append(f'<h3>{_UI["refBy"]}</h3><ul>{pg}</ul>')
        parts.append("</section>")
        out.append("".join(parts))
    return "\n".join(out)


_CARD_CSS = """
.cfilters{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0}
.cfilt{background:var(--chipbg);border:1px solid var(--border);border-radius:14px;color:var(--fg);cursor:pointer;font-size:12px;padding:2px 10px}
.cfilt.on{border-color:var(--accent);color:var(--accent)}
.cgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}
.ctile{display:flex;flex-direction:column;gap:4px;border:1px solid var(--border);border-radius:10px;padding:12px;background:var(--panel);color:var(--fg);text-decoration:none;box-shadow:0 1px 2px var(--shadow)}
.ctile:hover{border-color:var(--accent)}.ctile[hidden]{display:none}
.ctile b{font-size:14px}.csum{color:var(--muted);font-size:12.5px;line-height:1.5}
.ckind{align-self:flex-start;font-size:11px;border-radius:4px;padding:0 6px;background:var(--chipbg);color:var(--accent)}
.ctags{display:flex;flex-wrap:wrap;gap:4px;margin:4px 0}.ctag{font-size:11px;color:var(--muted)}.ctag:before{content:"#"}
.csummary{font-size:16px}.crumb{font-size:12.5px;color:var(--muted);margin:0 0 6px}
.cardlink{color:var(--accent)}a.navcards{margin-top:6px;border-top:1px solid var(--border);border-radius:0;padding-top:8px}
"""

_CARD_JS = """
document.addEventListener('click',function(e){
  var b=e.target.closest('.cfilt');if(!b)return;
  document.querySelectorAll('.cfilt').forEach(function(x){x.classList.toggle('on',x===b);});
  var f=b.getAttribute('data-f')||'';
  document.querySelectorAll('.ctile').forEach(function(t){
    var ok=!f||(f.slice(0,2)==='k:'&&t.getAttribute('data-kind')===f.slice(2))||
      (f.slice(0,2)==='t:'&&(' '+t.getAttribute('data-tags')+' ').indexOf(' '+f.slice(2)+' ')>=0);
    t.hidden=!ok;});
});
"""


# ---------------------------------------------------------------- template

_TEMPLATE = """<!DOCTYPE html>
<html lang="__LANG__">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>__TITLE__</title>
<style>
:root{color-scheme:light;--bg:#fafaf8;--fg:#1f2328;--muted:#59636e;--panel:#ffffff;--border:#d1d9e0;--accent:#0969da;--codebg:#f2f4f7;--chipbg:#eceff3;--shadow:rgba(0,0,0,.06)}
/* 深色规则用 html[data-theme="dark"]（比 :root 高一档特异度），不靠"后写的同特异度规则"取胜；
   并额外写死一份背景/前景兜底，即使某个自定义属性丢失，点击切换也一定看得见。 */
html[data-theme="dark"]{color-scheme:dark;--bg:#0d1117;--fg:#e6edf3;--muted:#8b949e;--panel:#161b22;--border:#30363d;--accent:#4493f8;--codebg:#10151c;--chipbg:#1d242d;--shadow:rgba(0,0,0,.4)}
html[data-theme="dark"],html[data-theme="dark"] body{background:#0d1117;color:#e6edf3}
*{box-sizing:border-box}html,body{margin:0;height:100%}
body{display:flex;background:var(--bg);color:var(--fg);font:15px/1.75 -apple-system,"PingFang SC","Segoe UI",Roboto,sans-serif}
aside{width:300px;min-width:300px;height:100vh;overflow:auto;background:var(--panel);border-right:1px solid var(--border);padding:16px 14px 32px}
/* 主题开关：浮在右上角、位于窗口标题栏（caption 按钮）下方 44px，大点击区、高对比、no-drag。
   旧实现是贴在最上沿的 12px 小按钮，正好落在桌面窗口的可拖拽标题区里，点击会被窗口吞掉。 */
#tbtn{position:fixed;top:44px;right:16px;z-index:2147483000;display:inline-flex;align-items:center;justify-content:center;gap:6px;
  min-height:38px;padding:0 16px;border-radius:999px;border:1px solid var(--border);background:var(--panel);color:var(--fg);
  cursor:pointer;font:600 13px/1.2 -apple-system,"PingFang SC","Segoe UI",Roboto,sans-serif;
  box-shadow:0 2px 10px var(--shadow);-webkit-app-region:no-drag}
#tbtn:hover{border-color:var(--accent);color:var(--accent)}
#tbtn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
#repo{font-weight:700;font-size:15px;margin:0 0 10px;word-break:break-all}
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
@media (max-width:760px){body{flex-direction:column}aside{width:100%;min-width:0;height:auto;max-height:38vh;border-right:0;border-bottom:1px solid var(--border)}main{height:auto;max-width:none;padding:20px 16px 64px}#tbtn{top:auto;bottom:12px;right:12px}}
__CARDCSS__</style>
<script id="rw-theme">
/* 主题在首帧之前应用：只依赖 documentElement / localStorage，不依赖下面那个 3MB 的查看器脚本。
   点击切换后写 localStorage('rw-theme')，并把 data-theme 同时放到 html 与 body 元素上；
   关掉本地存储时仍能切换（读失败就跟随系统偏好）。 */
(function(){
var KEY='rw-theme',LIGHT=__LLIGHT__,DARK=__LDARK__;
function norm(v){return v==='dark'?'dark':'light';}
function read(){try{var v=localStorage.getItem(KEY);if(v==='dark'||v==='light')return v;}catch(e){}
try{return matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}catch(e){return 'light';}}
function paint(v){var t=norm(v),h=document.documentElement;h.setAttribute('data-theme',t);
try{h.dataset.theme=t;}catch(e){}
try{if(document.body)document.body.setAttribute('data-theme',t);}catch(e){}
return t;}
function paintLabel(v){var b=document.getElementById('tbtn');if(!b)return;var dark=norm(v)==='dark';
b.textContent=dark?'☀️ '+LIGHT:'🌙 '+DARK;b.setAttribute('aria-pressed',dark?'true':'false');}
function apply(v,persist){var t=paint(v);if(persist!==false){try{localStorage.setItem(KEY,t);}catch(e){}}
paintLabel(t);try{if(typeof window.__rwAfterTheme==='function')window.__rwAfterTheme(t);}catch(e){}return t;}
function toggle(){return apply(document.documentElement.getAttribute('data-theme')==='dark'?'light':'dark');}
window.__rwTheme={apply:apply,toggle:toggle,read:read,paint:paint,KEY:KEY};
var boot=paint(read());
document.addEventListener('DOMContentLoaded',function(){apply(boot,false);});
})();
</script>
</head>
<body>
<button id="tbtn" type="button" title="__LTHEME__" aria-pressed="false" onclick="window.__rwTheme&amp;&amp;window.__rwTheme.toggle()">__LTHEMELABEL__</button>
<aside>
  <div id="repo">__REPO__</div>
  <input id="search" type="search" placeholder="__LSEARCH__" autocomplete="off">
  <div id="hits" hidden role="listbox"></div>
  <nav id="tree">__TREE__</nav>__CARDNAV__
</aside>
<main id="main">
<noscript><p class="todo">__LNOSCRIPT__</p></noscript>
__PAGES____CARDS__
<footer>dsh-wiki@local · __LFOOTER__ · __DATE__</footer>
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
  if(!out.length){var none=document.createElement('div');none.className='hit none';none.textContent=__LNOHITS__;hits.appendChild(none);}
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
/* 主题由 head 里的 rw-theme 脚本负责（首帧前应用、点击即可用、localStorage 持久化）：
   这里只接管"切换后重渲染图表"，并把点击绑定到同一份实现，避免两套状态互相打脸。 */
window.__rwAfterTheme=function(){renderMermaids();};
(function(){var btn=document.getElementById('tbtn'),T=window.__rwTheme;
if(btn&&T){btn.onclick=function(){T.toggle();};}})();
var initial=location.hash.slice(1);
show(initial);
__CARDJS__})();
</script>
</body>
</html>
"""


def _js_str(s: str) -> str:
    return json.dumps(s, ensure_ascii=False).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")


def _mermaid_runtime() -> str:
    if MERMAID_PATH.exists():
        try:
            js = MERMAID_PATH.read_text(encoding="utf-8", errors="surrogatepass")
        except (UnicodeDecodeError, OSError) as exc:
            print(f"[dsh-wiki] WARN mermaid asset unreadable ({exc}); diagrams will show source only", file=sys.stderr)
            return "window.mermaid=null;console.warn('mermaid.min.js not inlined; diagrams show source only');"
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
                   "if(!window.mermaid)console.warn('dsh-wiki: mermaid failed to mount; diagrams show source only');")
        return js + "\n" + adapter
    print("[dsh-wiki] WARN assets/mermaid.min.js not found; diagrams will show source only", file=sys.stderr)
    return "window.mermaid=null;console.warn('mermaid.min.js not inlined; diagrams show source only');"


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
        sys.exit(f"[dsh-wiki] cannot write {target}: {exc}")


def _read_json(path: Path, label: str):
    """读取并解析 JSON，失败时给出干净错误（stderr + exit 1），不裸 traceback。"""
    if path.is_dir():
        sys.exit(f"[dsh-wiki] {label} is a directory, not a file: {path}")
    if not path.is_file():
        sys.exit(f"[dsh-wiki] {label} does not exist: {path}")
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        sys.exit(f"[dsh-wiki] {label} is not UTF-8 text: {path} ({exc})")
    except OSError as exc:
        sys.exit(f"[dsh-wiki] {label} is not readable: {path} ({exc})")
    try:
        return json.loads(text)
    except RecursionError:
        sys.exit(f"[dsh-wiki] {label}: JSON nested too deeply to parse: {path}")
    except json.JSONDecodeError as exc:
        sys.exit(f"[dsh-wiki] {label} is not valid JSON: {path} ({exc})")


def build_site(wiki_dir: Path) -> dict:
    wiki_json = wiki_dir / "wiki.json"
    data = _read_json(wiki_json, "wiki.json")
    if not isinstance(data, dict):
        sys.exit(f"[dsh-wiki] {wiki_json}: top level must be a JSON object")
    warns: list = []
    pages = normalize_pages(data.get("pages") or [], warns)
    if not pages:
        for w in warns:
            print(f"[dsh-wiki] WARN {w}", file=sys.stderr)
        extra = f" ({len(warns)} page entries invalid or missing; see WARN)" if warns else ""
        sys.exit(f"[dsh-wiki] {wiki_json} contains no pages{extra}")
    cards = normalize_cards(data.get("cards"), [p["id"] for p in pages], warns)
    global _CARD_LINKS, _UI
    _UI = UI_STRINGS[ui_lang(data.get("language"))]
    _CARD_LINKS = {c["id"] for c in cards} if cards else None
    _CARD_LINK_WARNS.clear()
    try:
        return _build_site_render(wiki_dir, data, pages, cards, warns)
    finally:
        # 卡片上下文是模块级状态：无论成功或 sys.exit 都要复位，避免泄漏到下一次构建
        _CARD_LINKS = None
        _UI = UI_STRINGS["en"]


def _build_site_render(wiki_dir: Path, data: dict, pages, cards, warns) -> dict:
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
        print(f"[dsh-wiki] WARN {len(unreachable)} pages unreachable (parent cycle), hidden from navigation: "
              f"{', '.join(unreachable[:10])}", file=sys.stderr)
    for p in pages:
        sections.append(_page_section(p))
        index[p["id"]] = {
            "title": p["title"],
            "desc": p["description"],
            "text": html.unescape(_strip_tags(md_to_html(p["markdown"])))[:20000],
        }
    for c in cards:
        # 卡片与页面同处一个 INDEX；键带 card- 前缀，与页面 id 命名空间分开
        index[f"card-{c['id']}"] = {
            "title": f"[{_kind_label(c['kind'])} {_UI['cardTag']}] {c['title']}",
            "desc": c["summary"],
            "text": " ".join([c["summary"], " ".join(c["tags"]), " ".join(c["keyFiles"])]),
        }
    if _CARD_LINK_WARNS:
        missing = sorted(set(_CARD_LINK_WARNS))
        print(f"[dsh-wiki] WARN {len(missing)} card link targets missing; rendered as plain text: "
              f"{', '.join(missing[:10])}", file=sys.stderr)
    # 品牌位显示名：可选 title 优先，其次 repoId（历史行为），最后落目录名。
    # repoId 仍是引用机检的仓库根，两者互不影响。
    title = _clean_text(str(data.get("title") or data.get("repoId") or wiki_dir.name))
    lang = str(data.get("language") or "en")
    if not _LANG_RE.match(lang):
        lang = "en"
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
        "__LTHEME__": html.escape(_UI["theme"], quote=True),
        # 主题按钮初始文案（浅色下显示"🌙 Dark"，与脚本首帧后的取值一致）
        "__LTHEMELABEL__": html.escape("🌙 " + _UI["dark"]),
        "__LSEARCH__": html.escape(_UI["search"], quote=True),
        "__LNOSCRIPT__": html.escape(_UI["noscript"]),
        "__LFOOTER__": html.escape(_UI["footer"]),
        # JS string literals: JSON-encoded with < > & escaped (inside <script>)
        "__LNOHITS__": _js_str(_UI["noHits"]),
        "__LLIGHT__": _js_str(_UI["light"]),
        "__LDARK__": _js_str(_UI["dark"]),
        # 无卡片时一律展开为空串：旧 wiki 的输出与 0.1.x 逐字节一致（时间戳除外）
        "__CARDS__": ("\n" + _cards_html(cards, pages)) if cards else "",
        "__CARDNAV__": (f'<ul><li><a class="navitem navcards" data-page="card-grid" href="#card-grid">'
                        f'🗂 {html.escape(_UI["cards"])} ({len(cards)})</a></li></ul>') if cards else "",
        "__CARDCSS__": _CARD_CSS.lstrip("\n") if cards else "",
        "__CARDJS__": _CARD_JS.lstrip("\n") if cards else "",
    }
    doc = re.sub(r"__[A-Z]+__", lambda m: mapping.get(m.group(0), m.group(0)), _TEMPLATE)
    unresolved = sorted(set(re.findall(r"__[A-Z]+__", _TEMPLATE)) - set(mapping))
    if unresolved:
        sys.exit(f"[dsh-wiki] internal error: template placeholders without mapping {unresolved} (builder bug, please report)")
    site = wiki_dir / "site"
    try:
        site.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        sys.exit(f"[dsh-wiki] cannot create site directory {site}: {exc}")
    out = site / "index.html"
    _write_text(out, doc)
    return {"pages": len(pages), "cards": len(cards), "path": out.resolve(), "bytes": out.stat().st_size,
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
        errors.append(f"{layer_name} config must be a JSON object")
        return None
    profile_present = "profile" in cfg
    profile = cfg.get("profile")
    if profile_present:
        if not isinstance(profile, str) or profile not in PROFILES:
            errors.append(f"{layer_name}: unknown profile {profile!r} (choices: {'/'.join(PROFILES)})")
        else:
            _apply_layer(resolved, prov, f"{layer_name}:profile", PROFILES[profile], errors)
    for key, val in cfg.items():
        if key == "profile":
            continue
        if key not in _KNOWN_KEYS:
            errors.append(f"{layer_name}: unknown config key '{key}'"
                          f" (known keys: {', '.join(sorted(_KNOWN_KEYS | {'profile'}))})")
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
        errors.append(f"invalid language: {lang!r} (use 'auto' or a BCP47 code such as en/zh-CN)")
    if resolved.get("granularity") not in ("theme", "file", "hybrid"):
        errors.append(f"invalid granularity: {resolved.get('granularity')!r}")
    if resolved.get("diagrams") not in ("none", "minimal", "rich"):
        errors.append(f"invalid diagrams: {resolved.get('diagrams')!r}")
    if resolved.get("citations") not in ("relaxed", "strict"):
        errors.append(f"invalid citations: {resolved.get('citations')!r}")
    pages = resolved.get("pages")
    if not isinstance(pages, dict):
        errors.append(f"pages must be an object: {pages!r}")
        pages = {}
    elif not (_is_int(pages.get("min")) and _is_int(pages.get("max"))
              and 1 <= pages["min"] <= pages["max"] <= 100):
        errors.append(f"invalid pages: {pages} (need integers 1 <= min <= max <= 100)")
    tree = resolved.get("tree")
    if not isinstance(tree, dict):
        errors.append(f"tree must be an object: {tree!r}")
        tree = {}
    else:
        if not (_is_int(tree.get("maxChildren")) and 2 <= tree["maxChildren"] <= 16):
            errors.append(f"invalid tree.maxChildren: {tree.get('maxChildren')!r} (integer 2-16)")
        if not (_is_int(tree.get("maxDepth")) and 2 <= tree["maxDepth"] <= 6):
            errors.append(f"invalid tree.maxDepth: {tree.get('maxDepth')!r} (integer 2-6)")
    wpp = resolved.get("wordsPerPage")
    if not (isinstance(wpp, list) and len(wpp) == 2
            and all(_is_int(n) and 100 <= n <= 5000 for n in wpp) and wpp[0] <= wpp[1]):
        errors.append(f"invalid wordsPerPage: {wpp!r} ([min, max], integers 100-5000)")
    skeleton = resolved.get("skeleton")
    if not isinstance(skeleton, dict):
        errors.append(f"skeleton must be an object: {skeleton!r}")
    elif not isinstance(skeleton.get("knownIssues"), bool):
        errors.append("skeleton.knownIssues must be a boolean")
    for group, allowed in _NESTED_KEYS.items():
        val = resolved.get(group)
        if isinstance(val, dict):
            extra = sorted(set(val) - allowed)
            if extra:
                errors.append(f"{group} has unknown sub-keys: {', '.join(extra)}"
                              f" (allowed: {', '.join(sorted(allowed))})")
    if resolved.get("granularity") == "file" and _is_int(pages.get("max")) and pages["max"] < 20:
        warns.append("granularity=file but pages.max<20: per-file splitting usually needs more pages; consider raising it")


def cmd_resolve(args):
    repo = Path(args.repo).expanduser().resolve()
    if not repo.is_dir():
        sys.exit(f"[dsh-wiki] repository path is not a directory or does not exist: {repo}")
    errors, warns = [], []
    resolved = json.loads(json.dumps(DEFAULT_CONFIG))  # deep copy
    prov = {k: "builtin" for k in resolved}

    home_cfg = HOME / ".dsh" / "dsh-wiki" / "config.json"
    repo_cfg = repo / ".dsh-wiki" / "config.json"
    layers = {}
    for name, path in (("global", home_cfg), ("repo", repo_cfg)):
        if path.exists():
            layers[name] = _read_json(path, f"{name} config")
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
            sys.exit(f"[dsh-wiki] --set needs k=v, got: {pair}")
        key, raw = pair.split("=", 1)
        try:
            val = json.loads(raw)
        except Exception:
            val = raw
        parts = key.split(".")
        if any(not part for part in parts):
            errors.append(f"--set {key}: empty path segment (expected e.g. pages.max)")
            continue
        if parts[0] not in _KNOWN_KEYS and parts[0] != "profile":
            errors.append(f"--set: unknown config key '{parts[0]}'"
                          f" (known keys: {', '.join(sorted(_KNOWN_KEYS | {'profile'}))})")
            continue
        if len(parts) > 1 and isinstance(resolved.get(parts[0]), list):
            errors.append(f"--set {key}: '{parts[0]}' is a list field; dotted paths are not supported, assign the whole value (e.g. --set '{parts[0]}=[300,600]')")
            continue
        node = flag_cfg
        bad = False
        for part in parts[:-1]:
            nxt = node.get(part)
            if nxt is None:
                nxt = {}
                node[part] = nxt
            elif not isinstance(nxt, dict):
                errors.append(f"--set {key}: '{part}' is not an object ({type(nxt).__name__}); "
                              f"dotted paths are not supported; assign list fields as a whole")
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
            print(f"[dsh-wiki] FAIL invalid config: {e}", file=sys.stderr)
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
    commit = _source_commit(repo)
    if commit:
        meta["sourceCommit"] = commit
    print(json.dumps(resolved, ensure_ascii=False, indent=2))
    for w in warns:
        print(f"[dsh-wiki] WARN {w}", file=sys.stderr)
    if args.dry_run:
        return
    out = repo / ".dsh-wiki" / "generation-meta.json"
    try:
        out.parent.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        sys.exit(f"[dsh-wiki] cannot create {out.parent}: {exc}")
    _write_text(out, json.dumps(meta, ensure_ascii=False, indent=2))
    src_desc = ", ".join(f"{k}←{v}" for k, v in prov.items() if v != "builtin") or "all defaults"
    print(f"[dsh-wiki] effective config written to {out} (overrides: {src_desc})", file=sys.stderr)
    for w in warns:
        print(f"[dsh-wiki] WARN {w}", file=sys.stderr)


def _source_commit(repo: Path):
    """仓库当前 HEAD 的完整 sha（供 005 增量更新对比）；非 git 仓库/无 git 时返回 None。
    只调用本地 `git rev-parse HEAD`，不联网、不读对象内容。"""
    import subprocess
    try:
        p = subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"],
                           capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return None
    sha = p.stdout.strip()
    return sha if p.returncode == 0 and re.fullmatch(r"[0-9a-f]{40}([0-9a-f]{24})?", sha) else None


# ---------------------------------------------------------------- diff impact (spec 007 T002)

_DIFF_TIMEOUT = 5
_DIFF_LINE_RE = re.compile(r":\d+(?:-\d+)?$")


def _diff_fail(msg) -> None:
    """diff-impact 的所有失败都用 exit 2 + 一行清晰原因（调用方按退出码区分失败类型）。"""
    print(f"[dsh-wiki] {msg}", file=sys.stderr)
    sys.exit(2)


def _diff_git(repo: Path, args, label: str) -> str:
    """跑一条本地 git 命令（参数数组 + shell=False + 5s 超时）；失败一律清晰报错 exit 2。

    diff-impact 只读：git 只读 refs/对象，不写工作区、不联网、无副作用。
    """
    try:
        p = subprocess.run(["git", "-C", str(repo), *args],
                           capture_output=True, text=True, timeout=_DIFF_TIMEOUT)
    except FileNotFoundError:
        _diff_fail("diff-impact failed: git is not installed or not on PATH")
    except subprocess.TimeoutExpired:
        _diff_fail(f"diff-impact failed: git {label} timed out after {_DIFF_TIMEOUT}s")
    except (OSError, subprocess.SubprocessError) as exc:
        _diff_fail(f"diff-impact failed: cannot run git {label} ({exc})")
    if p.returncode != 0:
        lines = (p.stderr or p.stdout or "").strip().splitlines()
        first = lines[0].strip() if lines else f"exit {p.returncode}"
        _diff_fail(f"diff-impact failed: git {label} failed: {first}")
    return p.stdout


def _diff_rev(rev, label: str) -> str:
    """拒绝会改变 `<from>..<to>` 语义的 rev 写法（选项注入、二次范围、空白）。"""
    rev = str(rev if rev is not None else "").strip()
    if not rev or rev.startswith("-") or ".." in rev or re.search(r"\s", rev):
        _diff_fail(f"diff-impact failed: invalid {label} revision {rev!r}")
    return rev


def _diff_resolve(repo: Path, rev, label: str) -> str:
    """把 rev 解析成完整 commit sha（报告里的 from/to 用 sha，可跨运行比对）。"""
    out = _diff_git(repo, ["rev-parse", "--verify", f"{_diff_rev(rev, label)}^{{commit}}"],
                    f"resolve {label}")
    sha = out.strip().splitlines()[0].strip() if out.strip() else ""
    if not re.fullmatch(r"[0-9a-f]{40}(?:[0-9a-f]{24})?", sha):
        _diff_fail(f"diff-impact failed: cannot resolve {label} revision {rev!r}")
    return sha


def _diff_path(path) -> str:
    """路径归一：正斜杠、去 ./ 前缀与尾部 /、去 :line（卡片 keyFiles 允许带行号）。"""
    p = str(path or "").strip().replace("\\", "/")
    p = _DIFF_LINE_RE.sub("", p)
    while p.startswith("./"):
        p = p[2:]
    return p.rstrip("/")


def _diff_match(changed: str, entry: str) -> bool:
    """精确文件命中，或目录前缀命中（entry `lib` 覆盖 `lib/a.py`，不覆盖 `library/a.py`）。"""
    return bool(entry) and (changed == entry or changed.startswith(entry + "/"))


def _diff_hits(changed, raw_entries):
    """改动的文件里，被这一组 filePaths/keyFiles 覆盖的部分（保持 git 输出顺序）。"""
    entries = [_diff_path(x) for x in _as_str_list(raw_entries)]
    return [f for f in changed if any(_diff_match(f, e) for e in entries)]


def cmd_diff_impact(args):
    """把 `<from>..<to>` 改动的文件映射到受影响的页面/卡片，JSON 报告写到 stdout。

    严格只读：不 build、不写 config、不联网；仓库根默认取 wiki.json 的 repoId，
    from 默认取 generation-meta.json（其次 wiki.json）记录的 sourceCommit，to 默认 HEAD。
    """
    wiki_dir = Path(args.wiki).expanduser()
    wj = wiki_dir / "wiki.json"
    data = _read_json(wj, "wiki.json")
    if not isinstance(data, dict):
        sys.exit(f"[dsh-wiki] {wj}: top level must be a JSON object")
    meta = {}
    gm = wiki_dir / "generation-meta.json"
    if gm.is_file():
        loaded = _read_json(gm, "generation-meta.json")
        meta = loaded if isinstance(loaded, dict) else {}
    if args.repo:
        repo = Path(args.repo).expanduser()
        if not repo.is_absolute():
            repo = repo.resolve()
    else:
        repo_id = str(data.get("repoId") or "").strip()
        if not repo_id:
            _diff_fail("diff-impact failed: no repository to diff "
                       "(wiki.json has no repoId; pass --repo <abs repo path>)")
        repo = Path(repo_id).expanduser()
        # 相对 repoId 以 wiki 目录为基准解析（与引用机检一致，不随 CWD 漂移）
        repo = (wiki_dir / repo).resolve() if not repo.is_absolute() else repo
    if not repo.is_dir():
        _diff_fail(f"diff-impact failed: repository path is not a directory: {repo}")
    from_rev = args.from_rev or meta.get("sourceCommit") or data.get("sourceCommit")
    if not str(from_rev or "").strip():
        _diff_fail("diff-impact failed: no source commit to diff from "
                   "(generation-meta.json/wiki.json has no sourceCommit; pass --from <commit>)")
    from_sha = _diff_resolve(repo, from_rev, "--from")
    to_sha = _diff_resolve(repo, args.to_rev or "HEAD", "--to")
    # core.quotePath=false：非 ASCII 路径按 UTF-8 原样输出，不被转义成 "\304\201"
    out = _diff_git(repo, ["-c", "core.quotePath=false", "diff", "--name-only",
                           f"{from_sha}..{to_sha}", "--"], "diff")
    changed = []
    for line in out.splitlines():
        f = line.strip()
        if f and f not in changed:
            changed.append(f)
    affected_pages, affected_cards = [], []
    for p in data.get("pages") or []:
        if not isinstance(p, dict):
            continue
        raw_id = p.get("id") if p.get("id") is not None else p.get("title")
        if raw_id is None or not str(raw_id).strip():
            continue
        hits = _diff_hits(changed, p.get("filePaths"))
        if hits:
            affected_pages.append({"id": str(raw_id),
                                   "title": str(p.get("title") or raw_id),
                                   "matchedFiles": hits})
    for c in data.get("cards") or []:
        if not isinstance(c, dict):
            continue
        raw_id = c.get("id") if c.get("id") is not None else c.get("title")
        if raw_id is None or not str(raw_id).strip():
            continue
        hits = _diff_hits(changed, c.get("keyFiles"))
        if hits:
            affected_cards.append({"id": str(raw_id),
                                   "title": str(c.get("title") or raw_id),
                                   "matchedFiles": hits})
    mapped = {f for item in affected_pages + affected_cards for f in item["matchedFiles"]}
    report = {
        "from": from_sha,
        "to": to_sha,
        "changedFiles": changed,
        "affectedPages": affected_pages,
        "affectedCards": affected_cards,
        "unmappedFiles": [f for f in changed if f not in mapped],
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    print(f"[dsh-wiki] diff-impact: {len(changed)} changed files, {len(affected_pages)} pages, "
          f"{len(affected_cards)} cards, {len(report['unmappedFiles'])} unmapped", file=sys.stderr)


# ---------------------------------------------------------------- check translation (spec 007 T003)
# 翻译快照的完整性比较只有一个实现：scripts/wiki_translations.py（报告 schema
# repo-wiki-translation-check/1）。本子命令只做三件事——定位三份输入、把比较整体委托给
# 该模块、把结果分别以人类可读（stderr）和 JSON（--json 时 stdout）输出。构建器绝不
# 复制一份更弱的本地检查：模块导入失败就直接 exit 2。
#
# 退出码：0 = 全部单元 ok；1 = 存在 stale/missing/invalid/error；2 = 用法或 IO 问题
# （缺 canonical/translation 目录、meta 不可读、模块导入失败）。命令严格只读：不写
# canonical、不写 locales、不写其它任何位置（导入前就关掉 .pyc 落盘）。

_CT_ID_PREVIEW = 10


def _ct_fail(msg, command="check-translation") -> None:
    """check-translation 的用法/IO 失败：一行清晰原因 + exit 2，不裸 traceback。"""
    print(f"[dsh-wiki] {command} failed: {msg}", file=sys.stderr)
    sys.exit(2)


def _load_translation_module():
    """从同一 scripts 目录导入共享的翻译完整性模块（唯一的比较实现）。

    导入失败（文件缺失、语法错误、被改名）一律 exit 2：降级成构建器自己的检查会让
    "已验证"变成空话，所以这里没有 fallback。
    """
    scripts_dir = Path(__file__).resolve().parent
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    # 只读命令：连字节码都不要落在被检查的项目旁边
    sys.dont_write_bytecode = True
    try:
        import wiki_translations as module
    except Exception as exc:   # ImportError/SyntaxError/导入期任何异常
        _ct_fail(f"cannot import the shared integrity module wiki_translations.py from "
                 f"{scripts_dir} ({type(exc).__name__}: {exc}); the builder carries no "
                 f"fallback comparison")
    if not callable(getattr(module, "check_translation", None)):
        _ct_fail(f"wiki_translations.py in {scripts_dir} does not expose check_translation(); "
                 f"refusing to fall back to a local check")
    return module


def _ct_read_json(path: Path, label: str):
    """读取并解析 JSON；任何问题都是 exit 2（用法/IO），与报告内的 status=error 区分。"""
    if path.is_dir():
        _ct_fail(f"{label} is a directory, not a file: {path}")
    if not path.is_file():
        _ct_fail(f"{label} does not exist: {path}")
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        _ct_fail(f"{label} is not UTF-8 text: {path} ({exc})")
    except OSError as exc:
        _ct_fail(f"{label} is not readable: {path} ({exc})")
    try:
        return json.loads(text)
    except RecursionError:
        _ct_fail(f"{label}: JSON nested too deeply to parse: {path}")
    except json.JSONDecodeError as exc:
        _ct_fail(f"{label} is not valid JSON: {path} ({exc})")


def _translation_locale_problem(module, tag):
    """--lang 的校验规则必须与共享模块完全一致（不另写一套更松的规则）。

    优先复用模块自己的校验函数；模块若没有它，就用模块自己的正则/长度常量（强度不变）；
    两者都拿不到时返回问题而不是放行。
    """
    validator = getattr(module, "_locale_problem", None)
    if callable(validator):
        return validator(tag, "--lang")
    pattern = getattr(module, "_LOCALE_RE", None)
    limit = getattr(module, "_LOCALE_MAX", None)
    if not isinstance(pattern, re.Pattern) or not isinstance(limit, int):
        return ("cannot validate --lang: wiki_translations.py exposes no locale policy; "
                "pass --translation <abs wiki dir> instead")
    if not isinstance(tag, str) or not tag:
        return "--lang is empty"
    if len(tag) > limit:
        return f"--lang is too long ({len(tag)} > {limit} chars)"
    if ".." in tag or "/" in tag or "\\" in tag or "\x00" in tag:
        return f"--lang contains path traversal characters: {tag!r}"
    if not pattern.fullmatch(tag):
        return f"--lang is not a BCP47-ish locale: {tag!r}"
    return None


def translation_check_report(canonical_dir, translation_dir, meta_path) -> dict:
    """读取 canonical/translation/meta，把比较整体交给 wiki_translations.check_translation。

    返回值就是模块生成的报告对象本身（schema repo-wiki-translation-check/1）；本函数
    不修改、不补充、不重算任何字段。
    """
    module = _load_translation_module()
    canonical = _ct_read_json(Path(canonical_dir) / "wiki.json", "canonical wiki.json")
    translated = _ct_read_json(Path(translation_dir) / "wiki.json", "translated wiki.json")
    meta = _ct_read_json(Path(meta_path), "translation-meta.json")
    try:
        return module.check_translation(canonical, translated, meta)
    except RecursionError:
        _ct_fail("input is nested too deeply to evaluate (recursion limit); "
                 "reduce nesting and retry")


def _ct_ids(ids) -> str:
    shown = ", ".join(str(i) for i in ids[:_CT_ID_PREVIEW])
    if len(ids) > _CT_ID_PREVIEW:
        shown += f", +{len(ids) - _CT_ID_PREVIEW} more"
    return shown


def _translation_summary(report: dict, canonical_wiki: Path, translation_wiki: Path):
    """把模块报告压成 stderr 上的人类可读摘要（机器数据仍只在 stdout 的 --json 里）。"""
    counts = report.get("counts") or {}
    pages = counts.get("pages") or {}
    cards = counts.get("cards") or {}
    src = report.get("sourceLang") or "?"
    dst = report.get("targetLang") or "?"
    head = "OK" if report.get("ok") else f"FAILED (status={report.get('status')})"
    lines = [
        f"check-translation: {head} — {src} -> {dst}; "
        f"{pages.get('canonical', 0)} pages / {cards.get('canonical', 0)} cards canonical, "
        f"{pages.get('translated', 0)} / {cards.get('translated', 0)} translated",
        f"  canonical: {canonical_wiki}",
        f"  translation: {translation_wiki}",
    ]
    if report.get("ok"):
        return lines
    for kind in ("pages", "cards"):
        bucket = report.get(kind) or {}
        c = counts.get(kind) or {}
        lines.append(
            f"  {kind}: {c.get('missing', 0)} missing, {c.get('stale', 0)} stale, "
            f"{c.get('invalid', 0)} invalid, {c.get('added', 0)} added, "
            f"{c.get('metaMissing', 0)} without metadata, {c.get('metaExtra', 0)} extra metadata")
        for name in ("missing", "stale", "added", "metaMissing", "metaExtra"):
            ids = bucket.get(name) or []
            if ids:
                lines.append(f"    {name} {kind[:-1]}: {_ct_ids(ids)}")
        for entry in bucket.get("invalid") or []:
            reasons = "; ".join(entry.get("reasons") or [])
            lines.append(f"    invalid {kind[:-1]} {entry.get('id')!r}: {reasons}")
    for err in report.get("errors") or []:
        lines.append(f"  error: {err}")
    for warn in report.get("warnings") or []:
        lines.append(f"  warning: {warn}")
    return lines


def cmd_check_translation(args):
    """校验一份已翻译快照；严格只读，比较逻辑全部委托给 wiki_translations.py。"""
    module = _load_translation_module()
    canonical_dir = Path(args.canonical).expanduser()
    if not canonical_dir.is_dir():
        _ct_fail(f"canonical wiki directory is not a directory or does not exist: {canonical_dir}")
    if args.lang is not None and args.translation is not None:
        _ct_fail("use either --lang <tag> or --translation <dir>, not both")
    if args.lang is not None:
        problem = _translation_locale_problem(module, args.lang)
        if problem:
            _ct_fail(problem)
        # --lang 便利写法：翻译快照固定位于 <canonical>/locales/<lang>/
        translation_dir = canonical_dir / "locales" / args.lang
    elif args.translation is not None:
        translation_dir = Path(args.translation).expanduser()
    else:
        _ct_fail("one of --translation <dir> or --lang <tag> is required")
    if not translation_dir.is_dir():
        _ct_fail(f"translation wiki directory is not a directory or does not exist: {translation_dir}")
    meta_path = (Path(args.meta).expanduser() if args.meta
                 else translation_dir / "translation-meta.json")
    report = translation_check_report(canonical_dir, translation_dir, meta_path)
    if args.json:
        # 数据流：报告原文（ASCII 安全 + key 排序，便于跨平台/跨运行比对）
        print(json.dumps(report, ensure_ascii=True, indent=2, sort_keys=True))
    for line in _translation_summary(report, canonical_dir / "wiki.json",
                                     translation_dir / "wiki.json"):
        print(f"[dsh-wiki] {line}", file=sys.stderr)
    sys.exit(0 if report.get("ok") else 1)


# ---------------------------------------------------------------- locales init (spec 007 T022)
# 翻译快照的骨架由本子命令生成，但哈希与校验仍然只有 scripts/wiki_translations.py 一份
# 实现：这里只复制结构、清空可翻译文本，并对每个单元调用模块的 canonical_unit_hash()。
# 写入采用"locales 下的兄弟临时目录 + 一次 rename"：任何失败都清掉临时目录，绝不留下
# 半成品目的地；--force 先把旧目的地移到备份，最终 rename 失败时把备份移回去。
#
# 退出码：0 = 目的地已创建/替换；2 = 用法、IO 或拒绝（已存在且未给 --force）。

_LI_PAGE_TEXT_FALLBACK = ("title", "description", "markdown")
_LI_CARD_TEXT_FALLBACK = ("title", "summary")


def _li_text_fields(module, kind):
    """可翻译文本字段以共享模块的定义为准（不另写一套 schema），模块缺常量时才兜底。"""
    names = getattr(module, "_PAGE_TEXT_FIELDS" if kind == "page" else "_CARD_TEXT_FIELDS", None)
    if isinstance(names, (list, tuple)) and names:
        return tuple(names)
    return _LI_PAGE_TEXT_FALLBACK if kind == "page" else _LI_CARD_TEXT_FALLBACK


def _li_skeleton(canonical, lang, module):
    """纯函数：canonical wiki → (空文本骨架, translation-meta)，不落盘。

    结构字段（id/顺序/parentId/order/filePaths/keyFiles/related/tags/pageIds/sources
    以及未知扩展字段）逐字保留；只有可翻译文本清空，language 写成目标标签——否则
    check-translation 会因 translated.language 与 targetLang 不一致而无法评估。
    """
    if not isinstance(canonical, dict):
        raise ValueError("canonical wiki.json must be a JSON object")
    for key in ("pages", "cards"):
        value = canonical.get(key)
        if value is None:
            continue
        if not isinstance(value, list):
            raise ValueError(f"canonical {key} must be an array")
        for index, item in enumerate(value):
            if not isinstance(item, dict):
                raise ValueError(f"canonical {key}[{index}] is not an object")
            item_id = item.get("id")
            if not isinstance(item_id, str) or not item_id.strip():
                raise ValueError(f"canonical {key}[{index}] has no non-empty string id")
    skeleton = copy.deepcopy(canonical)
    skeleton["language"] = lang
    if "title" in skeleton:
        skeleton["title"] = ""
    for kind, key in (("page", "pages"), ("card", "cards")):
        for item in skeleton.get(key) or []:
            for field in _li_text_fields(module, kind):
                if field in item:
                    item[field] = ""
    source_lang = canonical.get("language")
    meta = {
        "schema": "repo-wiki-translation-meta/1",
        "sourceLang": source_lang if isinstance(source_lang, str) and source_lang else "en",
        "targetLang": lang,
        "pages": {item["id"]: {"sourceContentHash": module.canonical_unit_hash("page", item)}
                  for item in canonical.get("pages") or []},
        "cards": {item["id"]: {"sourceContentHash": module.canonical_unit_hash("card", item)}
                  for item in canonical.get("cards") or []},
    }
    return skeleton, meta


def _li_write_json(path: Path, data) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


def _li_rename(src: Path, dst: Path) -> None:
    os.replace(src, dst)


def _li_remove(path: Path) -> None:
    if path.is_symlink() or path.is_file():
        try:
            path.unlink()
        except OSError:
            pass
    elif path.is_dir():
        shutil.rmtree(path, ignore_errors=True)


def locales_init(canonical_dir, lang, force=False) -> dict:
    """创建 <canonical>/locales/<lang>/ 空翻译骨架；返回机器摘要（打印由 CLI 负责）。"""
    module = _load_translation_module()
    problem = _translation_locale_problem(module, lang)
    if problem:
        _ct_fail(problem, "locales-init")
    canonical_dir = Path(canonical_dir).expanduser()
    if not canonical_dir.is_dir():
        _ct_fail(f"canonical wiki directory is not a directory or does not exist: {canonical_dir}",
                 "locales-init")
    canonical = _ct_read_json(canonical_dir / "wiki.json", "canonical wiki.json")
    try:
        skeleton, meta = _li_skeleton(canonical, lang, module)
    except ValueError as exc:
        _ct_fail(str(exc), "locales-init")
    locales_dir = canonical_dir / "locales"
    destination = locales_dir / lang
    if (destination.exists() or destination.is_symlink()) and not force:
        _ct_fail(f"destination already exists: {destination} (pass --force to replace it)",
                 "locales-init")

    unique = f"{os.getpid()}-{uuid.uuid4().hex[:8]}"
    locales_created = not locales_dir.exists()
    temp = locales_dir / f".{lang}.tmp-{unique}"
    backup = locales_dir / f".{lang}.bak-{unique}"
    replaced = False
    failure = None
    try:
        if locales_dir.exists():
            if not locales_dir.is_dir():
                raise OSError(f"{locales_dir} exists and is not a directory")
        else:
            locales_dir.mkdir(parents=True)
        temp.mkdir()
        _li_write_json(temp / "wiki.json", skeleton)
        _li_write_json(temp / "translation-meta.json", meta)
        if destination.exists() or destination.is_symlink():
            # --force：先让旧目的地让位，最终 rename 失败则原样移回，目的地不会缺失。
            _li_rename(destination, backup)
            try:
                _li_rename(temp, destination)
            except OSError:
                _li_rename(backup, destination)
                raise
            replaced = True
        else:
            _li_rename(temp, destination)
    except Exception as exc:   # 写入/rename 的任何异常都不能留下半成品
        failure = exc
    finally:
        _li_remove(temp)
        if failure is None:
            _li_remove(backup)
        elif locales_created:
            # 本次运行才创建的 locales/ 在失败后不留空壳；已存在时绝不删除。
            try:
                locales_dir.rmdir()
            except OSError:
                pass
    if failure is not None:
        _ct_fail(f"cannot create {destination}: {type(failure).__name__}: {failure}",
                 "locales-init")
    return {
        "ok": True,
        "canonical": str(canonical_dir),
        "destination": str(destination),
        "lang": lang,
        "replaced": replaced,
        "pages": len(skeleton.get("pages") or []),
        "cards": len(skeleton.get("cards") or []),
        "wiki": str(destination / "wiki.json"),
        "meta": str(destination / "translation-meta.json"),
    }


def cmd_locales_init(args):
    """生成空翻译骨架：数据摘要只在 --json 时进 stdout，人读结果固定进 stderr。"""
    summary = locales_init(Path(args.canonical), args.lang, force=args.force)
    if args.json:
        print(json.dumps(summary, ensure_ascii=True, indent=2, sort_keys=True))
    action = "replaced" if summary["replaced"] else "created"
    print(f"[dsh-wiki] locales-init: {action} {summary['destination']} "
          f"({summary['pages']} pages, {summary['cards']} cards, lang {summary['lang']}); "
          f"fill the text fields, then verify with "
          f"check-translation --canonical {summary['canonical']} --lang {summary['lang']}",
          file=sys.stderr)


# ---------------------------------------------------------------- assemble

_FM_KEYS_PAGE = ("id", "parentId", "order", "title", "description", "filePaths")
_FM_KEYS_CARD = ("id", "title", "kind", "keyFiles", "related", "tags", "pageIds")


def _parse_front_matter(text: str, label: str):
    """极简 front-matter：首行 `---`，到下一个 `---` 为止；每行 `key: value`，
    value 先按 JSON 解析（数组/数字/null/带引号字符串），失败则当作纯字符串。"""
    text = text.replace("\r\n", "\n").lstrip("\ufeff")
    if not text.startswith("---\n"):
        return None, text
    end = text.find("\n---", 4)
    if end < 0:
        sys.exit(f"[dsh-wiki] {label}: unterminated front-matter (missing closing ---)")
    head, body = text[4:end], text[end + 4:]
    body = body[1:] if body.startswith("\n") else body
    meta = {}
    for n, line in enumerate(head.split("\n"), 2):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if ":" not in line:
            sys.exit(f"[dsh-wiki] {label}:{n}: front-matter lines must be key: value")
        k, v = line.split(":", 1)
        v = v.strip()
        try:
            meta[k.strip()] = json.loads(v) if v else ""
        except json.JSONDecodeError:
            meta[k.strip()] = v
    return meta, body


def _assemble_files(src_dir: Path, wiki_dir: Path, warns, label: str):
    """列出可组装的 *.md：跳过符号链接与解析后落在 wiki 目录之外的文件（防止把仓库外内容拼进 wiki）。"""
    root = wiki_dir.resolve()
    out = []
    for f in sorted(src_dir.glob("*.md")):
        if f.is_symlink():
            warns.append(f"{label}/{f.name} is a symlink; skipped")
            continue
        try:
            real = f.resolve()
            real.relative_to(root)
        except (OSError, ValueError):
            warns.append(f"{label}/{f.name} resolves outside the wiki directory; skipped")
            continue
        if not real.is_file():
            continue
        out.append(f)
    return out


def _fm_text_fields(meta: dict, keys, where: str, warns) -> bool:
    """front-matter 的 id/title 必须是字符串：数字转成字符串并告警；其它类型（列表/对象/布尔/null）告警并跳过该文件。"""
    for k in keys:
        if k not in meta:
            continue
        v = meta[k]
        if isinstance(v, str) or (v is None and k == "parentId"):  # parentId: null = 根页面
            continue
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            meta[k] = str(v)
            warns.append(f"{where}: front-matter {k} is not a string ({v!r}); converted to {meta[k]!r}")
            continue
        warns.append(f"{where}: front-matter {k} has invalid type ({type(v).__name__}); file skipped")
        return False
    return True


def cmd_assemble(args):
    """pages/*.md（+ 可选 cards/*.md）→ wiki.json。保留 wiki.json 里其它顶层键；
    cards/ 目录存在时以其为准替换 cards，否则沿用 wiki.json 现有 cards。"""
    wiki_dir = Path(args.wiki).expanduser()
    pages_dir = wiki_dir / "pages"
    if not pages_dir.is_dir():
        sys.exit(f"[dsh-wiki] assemble failed: missing {pages_dir}")
    wj = wiki_dir / "wiki.json"
    data = _read_json(wj, "wiki.json") if wj.exists() else {}
    if not isinstance(data, dict):
        sys.exit(f"[dsh-wiki] {wj}: top level must be a JSON object")
    data.setdefault("schema", "repo-wiki-local/1")
    for key in ("repo", "title", "language"):
        val = getattr(args, key, None)
        if val:
            data["repoId" if key == "repo" else key] = val
    if not data.get("repoId"):
        sys.exit("[dsh-wiki] assemble failed: wiki.json has no repoId; pass --repo <repository path>")
    data["generatedBy"] = data.get("generatedBy") or "agent"
    warns, pages = [], []
    for f in _assemble_files(pages_dir, wiki_dir, warns, "pages"):
        meta, body = _parse_front_matter(f.read_text(encoding="utf-8"), str(f))
        if meta is None:
            warns.append(f"{f.name} has no front-matter; id taken from the file name")
            meta = {}
        if not _fm_text_fields(meta, ("id", "title", "parentId", "description"), f"pages/{f.name}", warns):
            continue
        unknown = set(meta) - set(_FM_KEYS_PAGE)
        if unknown:
            warns.append(f"{f.name}: ignoring unknown front-matter keys {', '.join(sorted(unknown))}")
        page = {k: meta[k] for k in _FM_KEYS_PAGE if k in meta}
        page.setdefault("id", f.stem)
        page.setdefault("parentId", None)
        page["markdown"] = body
        pages.append(page)
    if not pages:
        sys.exit(f"[dsh-wiki] assemble failed: no *.md in {pages_dir}")
    pages.sort(key=lambda p: (0, p["order"]) if isinstance(p.get("order"), (int, float)) else (1, 0))
    data["pages"] = pages
    cards_dir = wiki_dir / "cards"
    if cards_dir.is_dir():
        cards = []
        for f in _assemble_files(cards_dir, wiki_dir, warns, "cards"):
            meta, body = _parse_front_matter(f.read_text(encoding="utf-8"), str(f))
            meta = meta or {}
            if not _fm_text_fields(meta, ("id", "title", "kind"), f"cards/{f.name}", warns):
                continue
            unknown = set(meta) - set(_FM_KEYS_CARD)
            if unknown:
                warns.append(f"cards/{f.name}: ignoring unknown front-matter keys {', '.join(sorted(unknown))}")
            card = {k: meta[k] for k in _FM_KEYS_CARD if k in meta}
            card.setdefault("id", f.stem)
            card["summary"] = " ".join(body.split())
            cards.append(card)
        data["cards"] = cards
    for w in warns:
        print(f"[dsh-wiki] WARN {w}", file=sys.stderr)
    _write_text(wj, json.dumps(data, ensure_ascii=False, indent=1) + "\n")
    n_cards = len(data.get("cards") or []) if isinstance(data.get("cards"), list) else 0
    print(f"[dsh-wiki] assemble: {len(pages)} pages, {n_cards} cards -> {wj}")


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
                bad_files.append(f"{f.name}: top level is not a JSON object")
                continue
            if p.get("markdown") is not None and not isinstance(p.get("markdown"), str):
                bad_files.append(f"{f.name}: markdown is not a string")
                continue
            if _page_has_markdown(p):
                pages.append(p)
    if bad_files:
        print(f"[dsh-wiki] WARN {len(bad_files)} draft-pages files could not be parsed: "
              f"{'; '.join(bad_files[:5])}", file=sys.stderr)
    if not pages:
        detail = f" ({len(bad_files)} files failed to parse)" if bad_files else ""
        sys.exit(f"[dsh-wiki] {source} has neither a wiki.json with page bodies nor usable draft-pages{detail}")
    draft = {}
    dj = source / "draft.json"
    if dj.exists():
        d = _read_json(dj, "legacy draft.json")
        draft = d if isinstance(d, dict) else {}
    catalog = meta_src.get("catalogTree") or draft.get("catalogTree") or []
    if not isinstance(catalog, list):
        print("[dsh-wiki] WARN legacy catalogTree is not a list; ignored", file=sys.stderr)
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
        warns.append(f"catalogTree node is not an object ({type(bad).__name__}); skipped")

    while stack:
        nd, parent_actual = stack.pop()
        nid = str(nd.get("id") or "")
        if nid and nid in seen_nodes:
            warns.append(f"duplicate catalogTree node id: {nid}")
        seen_nodes.add(nid)
        kids = nd.get("children")
        if kids is None:
            kids = []
        elif not isinstance(kids, list):
            warns.append(f"catalogTree node {nid or '?'}: children is not a list; ignored")
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
                warns.append(f"catalogTree node {nid or '?'} references page {pid} again; generated a section overview instead")
            base = nid or "section"
            sid, k = base, 2
            while sid in used:
                sid = f"{base}-sec{k}"
                k += 1
            used.add(sid)
            toc = "## In this section\n\n" + "\n".join(
                f"- {c.get('title')}" for c in kids if isinstance(c, dict)) if kids else ""
            merged.append({
                "id": sid,
                "parentId": parent_actual or None,
                "title": nd.get("title") or nid or "Section",
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
                warns.append(f"catalogTree node is not an object ({type(k).__name__}); skipped")
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
        sys.exit(f"[dsh-wiki] not found: {src}")
    meta_src, draft, raw_pages, catalog = load_legacy(src)
    warns: list = []
    merged, total, orphans = merge_catalog(catalog, raw_pages, warns)
    for w in warns:
        print(f"[dsh-wiki] WARN {w}", file=sys.stderr)
    if orphans:
        print(f"[dsh-wiki] WARN {orphans} content pages are not in the catalog tree; promoted to roots", file=sys.stderr)
    deduped = 0
    for p in merged:
        md = p.get("markdown")
        if isinstance(md, str):
            stripped = _strip_leading_h1(md, str(p.get("title") or ""))
            if stripped != md:
                p["markdown"] = stripped
                deduped += 1
    if deduped:
        print(f"[dsh-wiki] removed a leading heading duplicating the page title on {deduped} pages")
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
        sys.exit(f"[dsh-wiki] path resolution failed: {exc}")
    where = "--dest" if explicit_dest else "default destination (derived from repoId)"
    if dest_res == src_res:
        sys.exit(f"[dsh-wiki] import refused: {where} is the legacy source directory itself ({src}); that would irreversibly overwrite the source")
    if dest_res in src_res.parents:
        # dest 是 src 的上级（如指向 legacy 库根）：会把产物写进库根，拒绝
        sys.exit(f"[dsh-wiki] import refused: {where} ({dest}) is a parent of the legacy source directory; use a separate directory")
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
                sys.exit(f"[dsh-wiki] import refused: {where} ({dest}) is inside the legacy source directory and already has other files; "
                         f"use an empty subdirectory (e.g. <src>/.dsh-wiki) or a separate directory")
    if dest.exists() and not dest.is_dir():
        sys.exit(f"[dsh-wiki] import refused: --dest exists and is not a directory: {dest}")
    dest_wj = dest / "wiki.json"
    if dest_wj.is_file():
        try:
            prev = json.loads(dest_wj.read_text(encoding="utf-8"))
        except Exception:
            prev = None
        if not isinstance(prev, dict) or prev.get("generatedBy") != "import-legacy":
            sys.exit(f"[dsh-wiki] import refused: {dest_wj} exists and was not produced by this importer; "
                     f"choose another --dest or move that directory away first")
    try:
        dest.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        sys.exit(f"[dsh-wiki] cannot create destination directory {dest}: {exc}")
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
        sys.exit(f"[dsh-wiki] cannot create {pages_dir}: {exc}")
    for f in pages_dir.glob("*.md"):
        try:
            f.unlink()
        except OSError as exc:
            sys.exit(f"[dsh-wiki] cannot remove old export {f}: {exc}")
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
    print(f"[dsh-wiki] import complete: {src.name} -> {dest_res}")
    print(f"[dsh-wiki] {info['pages']} pages, site {info['path']} ({info['bytes'] // 1024} KB), "
          f"mermaid offline rendering {'yes' if info['mermaid'] else 'no (source only)'}")
    print(f"[dsh-wiki] open in a browser: {info['path']}")


# ---------------------------------------------------------------- build / selfcheck

def cmd_build(args):
    info = build_site(Path(args.wiki).expanduser())
    cards = f" + {info['cards']} cards" if info.get("cards") else ""
    print(f"[dsh-wiki] build: {info['pages']} pages{cards} -> {info['path']} ({info['bytes'] // 1024} KB), "
          f"mermaid offline rendering {'yes' if info['mermaid'] else 'no (source only)'}")


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
                found.append(f"<{tag}> srcdoc=<inline HTML document>")
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
_REF_SKIP_WARN = "citation check skipped (repository root unavailable; relative paths cannot be resolved)"
# 简写引用回退解析时跳过的目录：VCS、依赖、缓存、本 wiki 输出目录（wiki_dir 整棵子树）。
_REF_IGNORE_DIRS = frozenset({
    ".git", ".hg", ".svn", "node_modules", "__pycache__", ".cache", ".mypy_cache",
    ".pytest_cache", ".ruff_cache", ".tox", ".venv", "venv"})
_REF_WIKI_SUBDIRS = ("site", "locales")


def _basename_index(repo_root: Path, wiki_dir: Path):
    """basename → 仓库内相对路径列表，供简写引用的唯一命中回退使用。

    只遍历一次；跳过 VCS/依赖/缓存目录与本次 wiki 的输出目录，因此只存在于被忽略
    目录里的同名文件永远不会成为候选（引用它仍然失败）。
    """
    wiki_abs = os.path.normcase(os.path.abspath(str(wiki_dir)))
    repo_abs = os.path.normcase(os.path.abspath(str(repo_root)))
    skip_abs = {wiki_abs}
    if wiki_abs == repo_abs:
        # repoId "." 时 wiki 目录就是仓库根：单独跳过构建器自己的产物目录，
        # 否则 site/index.html 这类文件会被当成仓库文件命中简写引用。
        skip_abs.update(os.path.normcase(os.path.abspath(os.path.join(repo_abs, d)))
                        for d in _REF_WIKI_SUBDIRS)
    index = defaultdict(list)
    for dirpath, dirnames, filenames in os.walk(str(repo_root)):
        kept = []
        for d in dirnames:
            if d in _REF_IGNORE_DIRS or d.endswith("_cache"):
                continue
            if os.path.normcase(os.path.abspath(os.path.join(dirpath, d))) in skip_abs:
                continue
            kept.append(d)
        dirnames[:] = kept
        for name in filenames:
            rel = os.path.relpath(os.path.join(dirpath, name), str(repo_root))
            index[name].append(rel.replace(os.sep, "/"))
    return index


def _check_refs(repo_id, pages, problems, warns, wiki_dir: Path):
    """常开质量门：所有 path:line 引用必须文件存在且行号在界内，且不得越出仓库。

    仓库根取 wiki.json 的 repoId：绝对路径直接用；相对路径以 wiki 目录为基准解析
    （不随 CWD 漂移）。仓库已移动/删除的存量 wiki 降级为警告而非失败。
    """
    repo_id = str(repo_id or "")
    if not repo_id:
        warns.append(_REF_SKIP_WARN + ": not recorded")
        return
    repo_root = Path(repo_id).expanduser()
    if not repo_root.is_absolute():
        repo_root = (wiki_dir / repo_root).resolve()
    if not repo_root.exists():
        warns.append(_REF_SKIP_WARN + f": {repo_root}")
        return
    line_counts = {}
    file_lines = {}
    n_checked = 0
    n_before = len(problems)
    # 简写回退索引：整次检查最多构建一次，且只有出现第 1 步解析不了的引用时才构建。
    index_holder = []

    def basename_matches(name):
        if not index_holder:
            index_holder.append(_basename_index(repo_root, wiki_dir))
        return sorted(index_holder[0].get(name) or [])

    for p in pages:
        for m in _REF_RE.finditer(p.get("markdown") or ""):
            n_checked += 1
            rel, s = m.group(1), int(m.group(2))
            e = int(m.group(3) or m.group(2))
            rel_norm = os.path.normpath(rel)
            if os.path.isabs(rel_norm) or rel_norm == ".." or rel_norm.startswith(".." + os.sep):
                problems.append(f"page {p.get('id')}: citation escapes the repository {rel}")
                continue
            f = repo_root / rel_norm
            if not f.is_file():
                # 第 2 步：仓库根相对解析失败后，才允许"唯一文件名"回退；多命名歧义仍失败。
                shorthand = f"{rel}:{s}" + (f"-{e}" if e != s else "")
                matches = basename_matches(os.path.basename(rel_norm))
                if len(matches) == 1:
                    f = repo_root / matches[0]
                    warns.append(
                        f"page {p.get('id')}: citation uses the bare filename {shorthand} "
                        f"(unique match -> {matches[0]}; cite the full path)")
                elif len(matches) > 1:
                    shown = ", ".join(matches[:5])
                    if len(matches) > 5:
                        shown += f", +{len(matches) - 5} more"
                    problems.append(
                        f"page {p.get('id')}: cited file is AMBIGUOUS {shorthand} (matches "
                        f"{len(matches)}: {shown}; cite the full path)")
                    continue
                else:
                    problems.append(f"page {p.get('id')}: cited file does not exist {rel}")
                    continue
            if rel not in line_counts:
                try:
                    text = f.read_text(encoding="utf-8", errors="replace")
                except OSError:
                    problems.append(f"page {p.get('id')}: cited file is not readable {rel}")
                    continue
                line_counts[rel] = text.count("\n") + 1
                file_lines[rel] = text.split("\n")
            if s < 1 or e < s or e > line_counts[rel]:
                problems.append(
                    f"page {p.get('id')}: line out of range {rel}:{s}-{e} (file has {line_counts[rel]} lines)")
            elif not file_lines[rel][s - 1:e] or not any(x.strip() for x in file_lines[rel][s - 1:e]):
                # 行号在界内但指向空行：多半是写作时行号偏移，机检放行但提示复核
                warns.append(f"page {p.get('id')}: citation points to a blank line {rel}:{s}" + (f"-{e}" if e != s else "")
                             + " (line numbers may have shifted; please re-check)")
    if n_checked:
        n_bad = len(problems) - n_before
        if n_bad:
            print(f"[dsh-wiki] citation check: {n_bad} of {n_checked} failed (see FAIL)")
        else:
            print(f"[dsh-wiki] citation check: all {n_checked} path:line citations resolve")


def cmd_selfcheck(args):
    wiki_dir = Path(args.wiki).expanduser()
    problems, warns = [], []
    wj = wiki_dir / "wiki.json"
    if not wj.exists():
        sys.exit(f"[dsh-wiki] selfcheck failed: missing {wj}")
    data = _read_json(wj, "wiki.json")
    if not isinstance(data, dict):
        sys.exit(f"[dsh-wiki] selfcheck failed: {wj}: top level must be a JSON object")
    pages = normalize_pages(data.get("pages") or [], warns)
    ids = {p["id"] for p in pages}
    for p in pages:
        pid = p.get("parentId")
        if pid and pid not in ids:
            warns.append(f"page {p['id']}: parent {pid} missing (promoted to root)")
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
                    problems.append(f"page tree has a cycle: {' -> '.join(cycle + [cur])}")
                break
            seen[cur] = len(chain)
            chain.append(cur)
            cur = parent[cur]
    site = wiki_dir / "site" / "index.html"
    if not site.is_file():
        problems.append(f"missing site file {site}")
    else:
        try:
            doc = site.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError) as exc:
            doc = None
            problems.append(f"site file unreadable/corrupt {site} ({exc})")
        if doc is not None:
            if len(doc) < 512 or "<!DOCTYPE html" not in doc or "<main" not in doc:
                problems.append(f"site file incomplete ({len(doc)} chars, missing DOCTYPE/main structure): {site}")
            for ref in _external_refs(doc):
                problems.append(f"external link {ref}")
            if not _mermaid_inlined(doc):
                warns.append("site does not inline the mermaid runtime (diagrams will show source only)")
    raw_cards = data.get("cards")
    if raw_cards is not None and not isinstance(raw_cards, list):
        problems.append(f"cards is not an array ({type(raw_cards).__name__})")
    card_warns = []
    cards = normalize_cards(raw_cards if isinstance(raw_cards, list) else None, ids, card_warns)
    warns.extend(card_warns)
    if isinstance(raw_cards, list):
        dropped = sum(1 for x in raw_cards if isinstance(x, dict)) - len(cards)
        bad_items = sum(1 for x in raw_cards if not isinstance(x, dict))
        if bad_items or dropped > 0:
            problems.append(f"cards has {bad_items + max(dropped, 0)} invalid entries (see WARN)")
    # 卡片证据与页面引用走同一道机检：伪页面 id 为 card:<id>
    ref_pages = list(pages) + [
        {"id": f"card:{c['id']}", "markdown": " ".join(f"`{k}`" for k in c["keyFiles"])}
        for c in cards]
    _check_refs(data.get("repoId"), ref_pages, problems, warns, wiki_dir)
    for w in warns:
        print(f"[dsh-wiki] WARN {w}", file=sys.stderr)
    if problems:
        for p in problems:
            print(f"[dsh-wiki] FAIL {p}", file=sys.stderr)
        sys.exit(1)
    extra = f" + {len(cards)} cards" if cards else ""
    print(f"[dsh-wiki] selfcheck passed: {len(pages)} pages{extra}, site self-contained, zero external links")


# ---------------------------------------------------------------- cli

def main():
    ap = argparse.ArgumentParser(prog="build_wiki_site.py", description="dsh-wiki local builder")
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build", help="build a self-contained site from wiki.json")
    b.add_argument("--wiki", required=True)
    im = sub.add_parser("import-legacy", help="import legacy repo-wiki data and build")
    im.add_argument("source")
    im.add_argument("--dest", default=None)
    sc = sub.add_parser("selfcheck", help="tree integrity + zero external links + citation checks")
    sc.add_argument("--wiki", required=True)
    asm = sub.add_parser("assemble", help="assemble wiki.json from pages/*.md (+ cards/*.md) front-matter")
    asm.add_argument("--wiki", required=True)
    asm.add_argument("--repo", default=None, help="set repoId (absolute repository path)")
    asm.add_argument("--title", default=None)
    asm.add_argument("--language", default=None)
    rc = sub.add_parser("resolve-config", help="merge config layers and write generation-meta.json")
    rc.add_argument("--repo", required=True, help="repository path")
    rc.add_argument("--set", action="append", default=[], metavar="K=V",
                    help="override a field by dotted path (repeatable, e.g. --set language=en --set pages.max=24)")
    rc.add_argument("--dry-run", action="store_true", help="print the effective config only; write nothing")
    di = sub.add_parser("diff-impact", help="map git-changed files to affected pages/cards (read-only JSON)")
    di.add_argument("--wiki", required=True)
    di.add_argument("--repo", default=None, help="repository path (default: repoId from wiki.json)")
    di.add_argument("--from", dest="from_rev", default=None, metavar="COMMIT",
                    help="base revision (default: sourceCommit from generation-meta.json/wiki.json)")
    di.add_argument("--to", dest="to_rev", default=None, metavar="COMMIT", help="target revision (default: HEAD)")
    ct = sub.add_parser("check-translation",
                        help="verify a translated locale snapshot against the canonical English wiki (read-only)")
    ct.add_argument("--canonical", required=True,
                    help="canonical .dsh-wiki directory (English wiki.json)")
    ct.add_argument("--translation", default=None,
                    help="translated wiki directory, e.g. <canonical>/locales/vi")
    ct.add_argument("--lang", default=None, metavar="TAG",
                    help="locale tag; resolves --translation to <canonical>/locales/<tag>")
    ct.add_argument("--meta", default=None,
                    help="translation-meta.json (default: <translation>/translation-meta.json)")
    ct.add_argument("--json", action="store_true",
                    help="print the full machine report as JSON on stdout")
    li = sub.add_parser("locales-init",
                        help="create an empty translation skeleton under <canonical>/locales/<lang>/")
    li.add_argument("--canonical", required=True,
                    help="canonical .dsh-wiki directory (English wiki.json)")
    li.add_argument("--lang", required=True, metavar="TAG",
                    help="locale tag; destination is <canonical>/locales/<tag>")
    li.add_argument("--force", action="store_true",
                    help="replace an existing destination (restored if the final rename fails)")
    li.add_argument("--json", action="store_true",
                    help="print a machine summary object as JSON on stdout")
    args = ap.parse_args()
    try:
        if args.cmd == "build":
            cmd_build(args)
        elif args.cmd == "import-legacy":
            cmd_import(args)
        elif args.cmd == "selfcheck":
            cmd_selfcheck(args)
        elif args.cmd == "assemble":
            cmd_assemble(args)
        elif args.cmd == "resolve-config":
            cmd_resolve(args)
        elif args.cmd == "diff-impact":
            cmd_diff_impact(args)
        elif args.cmd == "check-translation":
            cmd_check_translation(args)
        elif args.cmd == "locales-init":
            cmd_locales_init(args)
    except RecursionError:
        sys.exit("[dsh-wiki] input nested too deeply (recursion limit): reduce markdown nesting / page-tree depth and retry")


if __name__ == "__main__":
    main()
