#!/usr/bin/env python3
"""repo-wiki 构建器回归测试（纯标准库，可直接运行）。

    python3 dsh-wiki/tests/test_build_wiki_site.py

覆盖：fixture 构建/自检、配置合并与校验边界、注入与净化（含两轮审核的
Chrome 级 PoC）、失败路径的干净报错与写入原子性。全部在临时目录中进行，
不写仓库（fixture 会被复制到 tmp 后再构建）。
"""
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
BASE = HERE.parent
SCRIPT = BASE / "scripts" / "build_wiki_site.py"
FIXTURE = HERE / "fixture"

RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append((name, ok))
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail and not ok else ""))


def run(cmd, home=None):
    env = dict(os.environ)
    if home:
        env["HOME"] = str(home)
    return subprocess.run(cmd, capture_output=True, text=True, env=env, cwd=str(BASE))


def cli(*args, home=None):
    return run([sys.executable, str(SCRIPT), *args], home=home)


def stage_fixture(name, tmp):
    dst = pathlib.Path(tmp) / name
    shutil.rmtree(dst, ignore_errors=True)
    shutil.copytree(FIXTURE / name, dst)
    for site in dst.rglob("site"):
        shutil.rmtree(site, ignore_errors=True)
    return dst


def write_wiki(d, pages, repo_id="."):
    (d / "wiki.json").write_text(json.dumps({"repoId": repo_id, "pages": pages}), encoding="utf-8")


def main():
    tmp = tempfile.mkdtemp(prefix="rw-tests-")
    home = pathlib.Path(tmp) / "home"
    home.mkdir()

    # ---- fixtures: build + selfcheck
    for name in ("valid", "rel-repo", "nonwhite-ref", "payload"):
        d = stage_fixture(name, tmp)
        b = cli("build", "--wiki", str(d))
        s = cli("selfcheck", "--wiki", str(d))
        check(f"fixture {name}: build+selfcheck exit 0",
              b.returncode == 0 and s.returncode == 0,
              f"build={b.returncode} selfcheck={s.returncode} {s.stderr.strip()[:80]}")

    d = stage_fixture("bad-json", tmp)
    p = cli("build", "--wiki", str(d))
    check("bad-json: clean error, no traceback",
          p.returncode != 0 and "Traceback" not in p.stderr and "不是合法 JSON" in p.stderr,
          p.stderr.strip()[-90:])

    # payload fixture: no live injected tags in the built site
    d = stage_fixture("payload", tmp)
    cli("build", "--wiki", str(d))
    site = (d / "site" / "index.html").read_text(encoding="utf-8")
    check("payload: no live <script>/onerror tags",
          not re.search(r"<script>__PWN|<img src=x onerror=__PWN_2", site)
          and "u003cscript" in site)

    # ---- config matrix
    d = stage_fixture("valid", tmp)
    base = ["resolve-config", "--repo", str(d), "--dry-run"]

    p = cli(*base, "--set", "profile=legacy", home=home)
    resolved = json.loads(p.stdout) if p.returncode == 0 else {}
    check("config: profile via --set expands", resolved.get("granularity") == "file"
          and resolved.get("pages") == {"min": 20, "max": 40}, p.stderr.strip()[-80:])

    p = cli(*base, "--set", "pages.max=24", home=home)
    check("config: dot-path nested set", p.returncode == 0 and '"max": 24' in p.stdout)

    p = cli(*base, "--set", "wordsPerPage=[300,600]", home=home)
    check("config: whole-list set", p.returncode == 0 and '"wordsPerPage": [' in p.stdout)

    for bad in ("unknownFoo=1", "pages.mxa=12", "pages..max=12", "profile=bogus",
                "profile=null", "profile={\"a\":1}", "pages.min=true", "wordsPerPage.0=300"):
        p = cli(*base, "--set", bad, home=home)
        check(f"config: rejected {bad}", p.returncode != 0 and "Traceback" not in p.stderr,
              p.stderr.strip()[-80:])

    p = cli("resolve-config", "--repo", str(d), "--set", "profile=compact",
            "--set", "granularity=file", "--dry-run", home=home)
    check("config: dry-run still prints WARN", "WARN" in p.stderr, p.stderr.strip()[-80:])

    # ---- security: SVG sanitizer vs mutation bypasses
    sys.path.insert(0, str(BASE / "scripts"))
    sys.dont_write_bytecode = True
    import build_wiki_site as B  # noqa: E402

    raw_tag = re.compile(r"<\s*(script|iframe|foreignobject|meta|style|object|form|base)\b", re.I)
    for case in ("<svg><scr<script>ipt>x</scr<script>ipt></svg>",
                 "<svg/onload=alert(1)>",
                 '<svg><scr onx="z"ipt>x</scr onx="z"ipt></svg>',
                 '<svg><for<iframe>eignObject>x</foreignObject></svg>',
                 '<svg><meta http-equiv="refresh" content="0;url=file:///x"/></svg>',
                 '<svg><image href="htt&#112;://evil/x"/></svg>'):
        out = B.md_to_html(case)
        check(f"svg sanitize: {case[:34]!r}", not raw_tag.search(out))

    out = B.md_to_html('<svg xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="#i"/>'
                       '<rect width="4" height="4"/></svg>')
    check("svg sanitize: legitimate svg preserved", "<rect" in out and "#i" in out)

    # ---- security: external reference scanner
    for doc, want in (('<img srcset="a 1x, https://evil/x 2x">', True),
                      ('<iframe srcdoc="x">', True),
                      ('<a href="#sec">t</a>', False),
                      ('<p>&lt;img src="https://evil/x"&gt;</p>', False),
                      ('<a href="java&#115;cript:alert(1)">t</a>', True)):
        check(f"external scanner: {doc[:36]!r}", bool(B._external_refs(doc)) == want,
              str(B._external_refs(doc)))

    # ---- robustness
    d = pathlib.Path(tmp) / "sur"; d.mkdir()
    write_wiki(d, [{"id": "a", "title": "t", "markdown": "ok"}])
    cli("build", "--wiki", str(d))
    size1 = (d / "site" / "index.html").stat().st_size
    (d / "wiki.json").write_text('{"repoId": ".", "pages": [{"id": "a", "markdown": "x \\ud800 y"}]}')
    p = cli("build", "--wiki", str(d))
    size2 = (d / "site" / "index.html").stat().st_size
    check("surrogate: clean build, site not zeroed",
          p.returncode == 0 and size2 > 1000 and "Traceback" not in p.stderr)

    d = pathlib.Path(tmp) / "deep"; d.mkdir()
    write_wiki(d, [{"id": "p", "markdown": ">" * 3000 + " deep\n\n" + "\n".join("- x" for _ in range(5))}])
    p = cli("build", "--wiki", str(d))
    check("deep nesting: no RecursionError", p.returncode == 0 and "Traceback" not in p.stderr,
          p.stderr.strip()[-80:])

    d = pathlib.Path(tmp) / "mal"; d.mkdir()
    (d / "wiki.json").write_text('{"repoId":".","pages":["oops"]}')
    p = cli("selfcheck", "--wiki", str(d))
    check("malformed pages: selfcheck clean", "Traceback" not in p.stderr)

    d = pathlib.Path(tmp) / "esc"; d.mkdir()
    write_wiki(d, [{"id": "p", "markdown": "see `../outside.txt:1`"}])
    cli("build", "--wiki", str(d))
    p = cli("selfcheck", "--wiki", str(d))
    check("ref escape: rejected", "越出仓库范围" in p.stderr)

    d = pathlib.Path(tmp) / "empty"; (d / "site").mkdir(parents=True)
    write_wiki(d, [{"id": "a", "markdown": "x"}])
    (d / "site" / "index.html").write_text("")
    p = cli("selfcheck", "--wiki", str(d))
    check("empty site: FAIL", p.returncode != 0 and "不完整" in p.stderr)

    d = pathlib.Path(tmp) / "nop"; d.mkdir()
    (d / "wiki.json").write_text('{"repoId":".","pages":[1,"x",null]}')
    p = cli("build", "--wiki", str(d))
    check("empty pages: warns flushed", "不是对象" in p.stderr and "中没有页面" in p.stderr)

    # ---- R4: injection via sources.startLine
    d = pathlib.Path(tmp) / "srcinj"; d.mkdir()
    write_wiki(d, [{"id": "a", "title": "T", "markdown": "x",
                    "sources": [{"path": "y.py", "startLine": '"><img src=x onerror=alert(1)>'}]}])
    p = cli("build", "--wiki", str(d))
    site = (d / "site" / "index.html").read_text(encoding="utf-8")
    check("R4: sources.startLine cannot inject DOM",
          "<img src=x onerror=alert(1)>" not in site.replace("&lt;", "").replace("&gt;", "")
          and "onerror" not in site.split("</script>")[0].replace("&lt;", ""))

    # ---- R4: url() in prose must not false-positive
    d = pathlib.Path(tmp) / "csstext"; d.mkdir()
    write_wiki(d, [{"id": "a", "title": "CSS",
                    "markdown": "写法：`background:url(https://example.com/a.png)`"}])
    cli("build", "--wiki", str(d))
    p = cli("selfcheck", "--wiki", str(d))
    check("R4: url() prose not flagged", p.returncode == 0 and "FAIL" not in p.stderr,
          p.stderr.strip()[-90:])

    # ---- R4: presentation-attr external url dropped, style/animation/kept, data URI kept
    sys.path.insert(0, str(BASE / "scripts"))
    import build_wiki_site as B2  # noqa: E402
    out = B2.md_to_html('<svg xmlns="http://www.w3.org/2000/svg">'
                        '<rect fill="url(https://evil/x#g)" width="4" height="4"/></svg>')
    check("R4: external fill url() dropped", "evil" not in out and "<rect" in out, out[:90])
    out = B2.md_to_html('<svg xmlns="http://www.w3.org/2000/svg"><style>.a{fill:red}</style>'
                        '<text class="a">L</text></svg>')
    check("R5: svg <style> element removed (R5 decision)",
          "<style" not in out and "<text" in out, out[:90])
    out = B2.md_to_html('<svg xmlns="http://www.w3.org/2000/svg">'
                        '<image href="data:image/png;base64,iVBORw0KGgo="/></svg>')
    check("R4: svg data:image kept", "data:image/png;base64" in out, out[:90])
    out = B2.md_to_html('<svg xmlns="http://www.w3.org/2000/svg">'
                        '<image href="https://evil/x.png"/></svg>')
    check("R4: svg external image dropped", "evil" not in out, out[:90])
    out = B2.md_to_html('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg> 说明文字')
    check("R4: single-line svg keeps trailing text", "<rect" in out and "说明文字" in out
          and "<pre" not in out, out[:120])
    try:
        B2.sanitize_svg('<svg xmlns="http://www.w3.org/2000/svg">' + "<g>" * 1200
                        + "<rect/>" + "</g>" * 1200 + "</svg>")
        deep_ok = True
    except RecursionError:
        deep_ok = False
    check("R4: deep svg no RecursionError", deep_ok)

    # ---- R4: nav HTML well-formed (<li> paired)
    d = pathlib.Path(tmp) / "nav"; d.mkdir()
    write_wiki(d, [{"id": "a", "title": "A"}, {"id": "b", "parentId": "a", "title": "B"},
                   {"id": "c", "title": "C"}])
    cli("build", "--wiki", str(d))
    site = (d / "site" / "index.html").read_text(encoding="utf-8")
    nav = site.split('<nav id="tree">', 1)[1].split("</nav>", 1)[0]
    check("R4: nav li tags paired", nav.count("<li>") == nav.count("</li>"),
          f"{nav.count('<li>')} vs {nav.count('</li>')}")

    # ---- R4: _write_text preserves mode
    if os.name != "nt":
        f = d / "site" / "index.html"
        os.chmod(f, 0o600)
        cli("build", "--wiki", str(d))
        check("R4: rebuild preserves file mode", (f.stat().st_mode & 0o777) == 0o600,
              oct(f.stat().st_mode & 0o777))

    # ---- R4: import dest inside source allowed; legacy-meta from draft.json
    src = pathlib.Path(tmp) / "legacyrel"; (src / "draft-pages").mkdir(parents=True)
    (src / "draft-pages" / "p.json").write_text(
        json.dumps({"id": "p", "title": "P", "markdown": "# P\n\n正文。\n"}), encoding="utf-8")
    (src / "draft.json").write_text(json.dumps({"repoId": ".", "generationModel": "m1"}),
                                    encoding="utf-8")
    p = cli("import-legacy", str(src))
    check("R4: default dest inside source allowed", p.returncode == 0, p.stderr.strip()[-90:])
    check("R4: legacy-meta from draft.json",
          (src / ".dsh-wiki" / "legacy-meta.json").is_file()
          and "m1" in (src / ".dsh-wiki" / "legacy-meta.json").read_text(encoding="utf-8"))
    p = cli("import-legacy", str(src), "--dest", str(src / "draft-pages"))
    check("R4: dest into source subdir with non-product files still clean",
          p.returncode != 0 and "拒绝导入" in p.stderr, p.stderr.strip()[-90:])

    # ---- R5: CSS-escape / animation external-URL channels must be closed
    out = B2.md_to_html('<svg xmlns="http://www.w3.org/2000/svg">'
                        '<image href="data:image/png;base64,iVBORw0KGgo=">'
                        '<animate attributeName="href" values="http://evil/x.png" dur="1s"/>'
                        '</image></svg>')
    check("R5: animate retargeting href dropped", "evil" not in out and "<animate" not in out, out[:100])
    out = B2.md_to_html('<svg xmlns="http://www.w3.org/2000/svg">'
                        '<style>rect{fill:u\\72l(http://evil/c.png)}</style><rect/></svg>')
    check("R5: svg <style> removed entirely", "<style" not in out and "evil" not in out, out[:100])
    out = B2.md_to_html('<svg xmlns="http://www.w3.org/2000/svg">'
                        '<rect style="fill:u\\72l(http://evil/e.png)"/></svg>')
    check("R5: style attribute removed", "style=" not in out and "evil" not in out, out[:100])
    out = B2.md_to_html('<svg xmlns="http://www.w3.org/2000/svg">'
                        '<rect fill="u\\72l(http://evil/e.png)"/></svg>')
    check("R5: escaped url() in paint attr dropped", "evil" not in out, out[:100])
    out = B2.md_to_html('<svg xmlns="http://www.w3.org/2000/svg">'
                        '<rect fill="#0a7" stroke="black" opacity="0.5" width="4" height="4"/></svg>')
    check("R5: presentation attributes preserved", "#0a7" in out and "opacity" in out, out[:110])

    for doc, want in (('<style>@import "https://evil/x.css";</style>', True),
                      ("<style>@im\\70 ort \"https://evil/x.css\";</style>", True),
                      ('<div style=background:url(https://evil/x.png)>t</div>', True),
                      ('<img srcset="data:image/png;base64,AAAA 1x">', False),
                      ('<svg><animate attributeName="href" values="http://evil/x"/></svg>', True)):
        check(f"R5 scanner: {doc[:44]!r}", bool(B2._external_refs(doc)) == want,
              str(B2._external_refs(doc)))

    # ---- R5: import-legacy tolerates non-string markdown
    src = pathlib.Path(tmp) / "legacynonstr"; (src / "draft-pages").mkdir(parents=True)
    (src / "draft-pages" / "ok.json").write_text(
        json.dumps({"id": "ok", "title": "OK", "markdown": "# OK\n\n正文。\n"}), encoding="utf-8")
    (src / "draft-pages" / "bad.json").write_text(
        json.dumps({"id": "bad", "title": "B", "markdown": {"x": 1}}), encoding="utf-8")
    p = cli("import-legacy", str(src), "--dest", str(pathlib.Path(tmp) / "impnonstr"))
    check("R5: non-str markdown is a clean warn, not a crash",
          p.returncode == 0 and "Traceback" not in p.stderr and "不可解析" in p.stderr,
          p.stderr.strip()[-90:])

    # ---- R5: legacy-src fixture consumed end-to-end
    d = stage_fixture("legacy-src", tmp)
    p = cli("import-legacy", str(d), "--dest", str(pathlib.Path(tmp) / "impfixture"))
    check("R5: legacy-src fixture imports", p.returncode == 0 and "导入完成" in p.stdout,
          (p.stdout + p.stderr).strip()[-90:])

    # ---- site brand: optional top-level `title` drives the display name
    d = pathlib.Path(tmp) / "brand-title"
    d.mkdir()
    (d / "wiki.json").write_text(json.dumps(
        {"repoId": "../..", "title": "zcode-repo-wiki",
         "pages": [{"id": "a", "title": "A", "markdown": "# A\n\n正文。\n"}]}), encoding="utf-8")
    cli("build", "--wiki", str(d))
    site = (d / "site" / "index.html").read_text(encoding="utf-8")
    check("brand: top-level title wins over repoId",
          '<div id="repo">zcode-repo-wiki</div>' in site
          and "<title>zcode-repo-wiki</title>" in site)

    d = pathlib.Path(tmp) / "brand-fallback"
    d.mkdir()
    write_wiki(d, [{"id": "a", "title": "A", "markdown": "# A\n\n正文。\n"}], repo_id="my-repo")
    cli("build", "--wiki", str(d))
    site = (d / "site" / "index.html").read_text(encoding="utf-8")
    check("brand: falls back to repoId when title is absent",
          '<div id="repo">my-repo</div>' in site)

    # ---- viewer: the inlined viewer script must actually parse
    # A syntax error here kills search / theme toggle / mermaid at once and is
    # invisible to substring assertions, so it gets a real parser, not a regex.
    d = pathlib.Path(tmp) / "viewer-js"
    d.mkdir()
    write_wiki(d, [{"id": "a", "title": "A",
                    "markdown": "# A\n\n```mermaid\nflowchart LR\n  X --> Y\n```\n"}])
    cli("build", "--wiki", str(d))
    scripts = re.findall(r"<script\b[^>]*>(.*?)</script>",
                         (d / "site" / "index.html").read_text(encoding="utf-8"), re.S)
    node = shutil.which("node")
    if node is None:                      # 常见安装位置兜底（GUI 环境 PATH 常缺 node）
        for cand in sorted(pathlib.Path.home().glob(".nvm/versions/node/*/bin/node"),
                           reverse=True) + [pathlib.Path("/opt/homebrew/bin/node"),
                                            pathlib.Path("/usr/local/bin/node")]:
            if cand.is_file():
                node = str(cand)
                break
    if node is None:
        print("SKIP viewer JS syntax check (node not found; CI installs it)")
    else:
        bad = []
        for i, s in enumerate(scripts):
            f = pathlib.Path(tmp) / f"viewer-{i}.js"
            f.write_text(s, encoding="utf-8")
            p = run([node, "--check", str(f)])
            if p.returncode != 0:
                lines = [ln.strip() for ln in p.stderr.strip().splitlines() if ln.strip()]
                err = next((ln for ln in lines if "Error" in ln), lines[-1] if lines else "?")
                bad.append(f"script[{i}]: {err[:70]}")
        check(f"viewer: {len(scripts)} inlined script(s) parse (node --check)", not bad,
              "; ".join(bad))

    # ---- viewer: 内联 JS 不得残留 HTML 边界标签字面量（假 <body>/</body> 会把
    # 宿主侧朴素注入器的 <script>…</script> 骗进脚本中间，注入的 </script>
    # 提前闭合脚本并把 bundle 余下部分泄漏为正文 JS 墙）。
    # 不变量：整份站点文档里 body/head 边界标签各只出现一次（模板的真标签）。
    d = pathlib.Path(tmp) / "boundary-tags"
    d.mkdir()
    write_wiki(d, [{"id": "a", "title": "A",
                    "markdown": "# A\n\n正文提到 <body>、</body></html> 与 <head> 字面量。\n"}])
    cli("build", "--wiki", str(d))
    site = (d / "site" / "index.html").read_text(encoding="utf-8")
    lower = site.lower()
    counts = {t: lower.count(t) for t in ("<body", "</body", "<head", "</head")}
    check("viewer: HTML 边界标签在整份文档中各只出现一次（内联 JS 里的假标签已打断）",
          all(v == 1 for v in counts.values()), f"counts={counts}")
    naive = re.search(r"<body(?:\s[^>]*)?>", site, re.I)
    check("viewer: 朴素 <body> 定位器命中的是真 body 标签",
          naive is not None and naive.group(0) == "<body>",
          f"hit={naive.group(0) if naive else None}")

    # ---- import-legacy: 正文自带 # 标题首行时与页头 h1 去重（查看器已按元数据渲染 h1）
    d = pathlib.Path(tmp) / "legacy-h1-dedup"
    (d / "draft-pages").mkdir(parents=True)
    (d / "wiki.json").write_text(json.dumps({
        "repoId": "legacy-repo",
        "pages": [{"id": "ov", "title": "Overview",
                   "markdown": "# Overview\n\n正文内容。\n"},
                  {"id": "kv", "title": "Keep",
                   "markdown": "# 另起标题\n\n保留该标题，不与页头重复。\n"}]}),
        encoding="utf-8")
    dest = pathlib.Path(tmp) / "legacy-dest" / ".dsh-wiki"
    p = cli("import-legacy", str(d), "--dest", str(dest))
    ok = p.returncode == 0 and dest.is_dir()
    site = (dest / "site" / "index.html").read_text(encoding="utf-8") if ok else ""
    check("import: 与页头重复的首行 # 标题被去掉（不同标题保留）",
          ok and site.count("<h1>Overview</h1>") == 1
          and site.count("<h1>Keep</h1>") == 1
          and site.count("<h1>另起标题</h1>") == 1,
          f"rc={p.returncode} h1s=ov:{site.count('<h1>Overview</h1>')} "
          f"keep:{site.count('<h1>Keep</h1>')} alt:{site.count('<h1>另起标题</h1>')}")

    # ================================================================ 0.2.0: knowledge cards (spec 004)
    def card_wiki(name, cards, pages=None, repo_id=None):
        d = pathlib.Path(tmp) / name
        shutil.rmtree(d, ignore_errors=True)
        shutil.copytree(FIXTURE / "valid", d)
        shutil.rmtree(d / "site", ignore_errors=True)
        data = json.loads((d / "wiki.json").read_text(encoding="utf-8"))
        data["repoId"] = repo_id or str(d)
        if pages is not None:
            data["pages"] = pages
        if cards is not None:
            data["cards"] = cards
        (d / "wiki.json").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        return d

    good = [
        {"id": "add-fn", "title": "add()", "kind": "api", "summary": "Adds two numbers.",
         "keyFiles": ["sample.py:4"], "related": ["mul-fn"], "tags": ["math"], "pageIds": ["overview"]},
        {"id": "mul-fn", "title": "mul()", "kind": "api", "summary": "Multiplies.",
         "keyFiles": ["sample.py:8-9"], "related": ["add-fn", "ghost"], "tags": ["math"]},
    ]

    # ---- cards: no-card wiki carries none of the card markup
    d = card_wiki("cards-none", None)
    p = cli("build", "--wiki", str(d))
    site = (d / "site" / "index.html").read_text(encoding="utf-8") if p.returncode == 0 else ""
    check("cards: wiki without cards has no card markup/placeholders",
          p.returncode == 0 and "__CARD" not in site and "cgrid" not in site
          and "card-grid" not in site and "cfilt" not in site, p.stderr[-120:])

    # ---- cards: valid build + selfcheck
    d = card_wiki("cards-valid", good)
    p = cli("build", "--wiki", str(d))
    site = (d / "site" / "index.html").read_text(encoding="utf-8") if p.returncode == 0 else ""
    check("cards: valid cards build (grid + per-card sections + nav)",
          p.returncode == 0 and 'id="pg-card-grid"' in site and 'id="pg-card-add-fn"' in site
          and 'id="pg-card-mul-fn"' in site and 'data-page="card-grid"' in site
          and "2 张卡片" in p.stdout, p.stdout + p.stderr[-200:])
    check("cards: dangling related dropped with WARN",
          "ghost" in p.stderr and "related" in p.stderr and 'href="#card-ghost"' not in site)
    m = re.search(r'window\.INDEX=JSON\.parse\((".*?")\);', site, re.S)
    idx = json.loads(json.loads(m.group(1))) if m else {}
    check("cards: cards are in search INDEX under card- keys",
          "card-add-fn" in idx and "overview" in idx and "Adds two numbers." in idx["card-add-fn"]["desc"])
    check("cards: referenced-by lists pageIds", 'pg-card-add-fn' in site and
          re.search(r'id="pg-card-add-fn".*?data-page="overview".*?</section>', site, re.S) is not None)
    p = cli("selfcheck", "--wiki", str(d))
    check("cards: selfcheck passes and counts card refs",
          p.returncode == 0 and "2 张卡片" in p.stdout and "全部可解析" in p.stdout, p.stdout + p.stderr[-200:])

    # ---- cards: escape-only text
    evil = [{"id": "x", "title": "<script>alert(1)</script>", "summary": "<img src=x onerror=alert(1)> <svg onload=1>",
             "keyFiles": ["sample.py:4"], "tags": ["<b>t</b>"]}]
    d = card_wiki("cards-escape", evil)
    p = cli("build", "--wiki", str(d))
    site = (d / "site" / "index.html").read_text(encoding="utf-8") if p.returncode == 0 else ""
    body = re.sub(r"<script>.*?</script>", "", site, flags=re.S)
    check("cards: title/summary/tags are HTML-escaped (no tags injected)",
          p.returncode == 0 and "<img src=x" not in body and "<svg onload" not in body
          and "&lt;script&gt;alert(1)&lt;/script&gt;" in body and "<b>t</b>" not in body)
    p = cli("selfcheck", "--wiki", str(d))
    check("cards: escaped card text keeps site free of external refs", p.returncode == 0, p.stderr[-200:])

    # ---- cards: invalid entries -> build WARN, selfcheck FAIL
    d = card_wiki("cards-invalid", [42, {"id": "nofiles", "summary": "x"}, good[0]])
    p = cli("build", "--wiki", str(d))
    check("cards: invalid entries dropped with WARN, build still succeeds",
          p.returncode == 0 and "cards[0]" in p.stderr and "nofiles" in p.stderr, p.stderr[-200:])
    p = cli("selfcheck", "--wiki", str(d))
    check("cards: invalid entries FAIL selfcheck", p.returncode == 1 and "cards 中有 2 个条目非法" in p.stderr,
          p.stderr[-200:])
    d = card_wiki("cards-notlist", {"id": "a"})
    p = cli("build", "--wiki", str(d))
    p2 = cli("selfcheck", "--wiki", str(d))
    check("cards: non-array cards -> build WARN, selfcheck FAIL",
          p.returncode == 0 and "cards 不是数组" in p.stderr and p2.returncode == 1, p2.stderr[-200:])

    # ---- cards: card ref out of range fails selfcheck
    d = card_wiki("cards-badref", [{"id": "b", "summary": "s", "keyFiles": ["sample.py:999"]}])
    cli("build", "--wiki", str(d))
    p = cli("selfcheck", "--wiki", str(d))
    check("cards: out-of-range keyFiles FAIL selfcheck with card id",
          p.returncode == 1 and "card:b" in p.stderr and "行号越界" in p.stderr, p.stderr[-200:])

    # ---- cards: > 200 warns
    many = [{"id": f"c{i}", "summary": "s", "keyFiles": ["sample.py"]} for i in range(201)]
    d = card_wiki("cards-many", many)
    p = cli("build", "--wiki", str(d))
    check("cards: more than 200 cards WARN", p.returncode == 0 and "超过 200" in p.stderr, p.stderr[-200:])

    # ---- links: page -> card
    pages = [{"id": "overview", "title": "总览", "markdown":
              "See [the add card](#card-add-fn) and [gone](#card-nope) and [ext](http://x.example)."}]
    d = card_wiki("cards-links", good, pages=pages)
    p = cli("build", "--wiki", str(d))
    site = (d / "site" / "index.html").read_text(encoding="utf-8") if p.returncode == 0 else ""
    check("links: [t](#card-id) becomes in-site anchor",
          '<a class="cardlink" href="#card-add-fn">the add card</a>' in site, p.stderr[-200:])
    check("links: missing card target -> plain text + WARN",
          'href="#card-nope"' not in site and "nope" in p.stderr and "卡片链接目标不存在" in p.stderr)
    check("links: ordinary links keep legacy linkref span",
          'class="linkref" title="http://x.example"' in site)
    d = card_wiki("cards-links-nocards", None, pages=pages)
    p = cli("build", "--wiki", str(d))
    site = (d / "site" / "index.html").read_text(encoding="utf-8") if p.returncode == 0 else ""
    check("links: without cards, #card- links render as legacy linkref",
          'class="cardlink"' not in site and 'title="#card-add-fn"' in site)

    # ---- selfcheck: blank-line citation WARN
    pages = [{"id": "overview", "title": "总览", "markdown": "Blank at `sample.py:2`, real at `sample.py:4`."}]
    d = card_wiki("blank-ref", None, pages=pages)
    cli("build", "--wiki", str(d))
    p = cli("selfcheck", "--wiki", str(d))
    check("selfcheck: citation to a blank line WARNs (still passes)",
          p.returncode == 0 and "引用指向空行 sample.py:2" in p.stderr and "sample.py:4" not in p.stderr,
          p.stderr[-200:])

    # ---- assemble roundtrip
    d = pathlib.Path(tmp) / "asm" / ".dsh-wiki"
    (d / "pages").mkdir(parents=True)
    (d / "cards").mkdir()
    shutil.copy(FIXTURE / "valid" / "sample.py", d.parent / "sample.py")
    (d / "pages" / "b.md").write_text(
        '---\nid: child\nparentId: root\norder: 2\ntitle: Child: page\nfilePaths: ["sample.py"]\n---\n'
        "# Child\n\nSee `sample.py:4` and [add](#card-add).\n", encoding="utf-8")
    (d / "pages" / "a.md").write_text(
        '---\nid: root\nparentId: null\norder: 1\ntitle: "Root"\ndescription: top page\nbogus: 1\n---\nRoot body.\n',
        encoding="utf-8")
    (d / "cards" / "add.md").write_text(
        '---\nkind: api\ntitle: add()\nkeyFiles: ["sample.py:4"]\ntags: ["math"]\npageIds: ["child"]\n---\n'
        "Adds\ntwo numbers.\n", encoding="utf-8")
    p = cli("assemble", "--wiki", str(d), "--repo", str(d.parent), "--language", "en")
    data = json.loads((d / "wiki.json").read_text(encoding="utf-8")) if p.returncode == 0 else {}
    pg = {x["id"]: x for x in data.get("pages", [])}
    check("assemble: pages/*.md front-matter -> wiki.json (order, ids, markdown)",
          p.returncode == 0 and [x["id"] for x in data["pages"]] == ["root", "child"]
          and pg["child"]["parentId"] == "root" and pg["child"]["title"] == "Child: page"
          and pg["child"]["markdown"].startswith("# Child") and pg["root"]["parentId"] is None
          and data["language"] == "en" and data["schema"] == "repo-wiki-local/1",
          p.stdout + p.stderr[-200:])
    check("assemble: unknown front-matter key WARNs", "bogus" in p.stderr)
    check("assemble: cards/*.md -> cards with summary from body",
          data.get("cards", [{}])[0].get("id") == "add" and data["cards"][0]["summary"] == "Adds two numbers."
          and data["cards"][0]["kind"] == "api")
    b = cli("build", "--wiki", str(d))
    s = cli("selfcheck", "--wiki", str(d))
    check("assemble: assembled wiki builds and selfchecks green",
          b.returncode == 0 and s.returncode == 0 and "1 张卡片" in s.stdout, b.stderr[-150:] + s.stderr[-150:])
    shutil.rmtree(d / "cards")
    (d / "wiki.json").write_text(json.dumps(dict(data, title="Kept")), encoding="utf-8")
    p = cli("assemble", "--wiki", str(d))
    data2 = json.loads((d / "wiki.json").read_text(encoding="utf-8"))
    check("assemble: without cards/ keeps existing cards and other keys",
          p.returncode == 0 and data2.get("cards") == data["cards"] and data2.get("title") == "Kept")
    e = pathlib.Path(tmp) / "asm-empty"
    e.mkdir()
    p = cli("assemble", "--wiki", str(e))
    check("assemble: missing pages/ is a clean error", p.returncode == 1 and "Traceback" not in p.stderr)

    # ---- review fixes (0.2.0): script-breakout text, path traversal, symlinks, dedup collision, front-matter types
    breakout = [{"id": "br", "title": "</script><img src=x onerror=x>",
                 "summary": "</script><img src=x onerror=x> tail", "keyFiles": ["sample.py:4"], "tags": ["t"]}]
    d = card_wiki("cards-breakout", breakout)
    p = cli("build", "--wiki", str(d))
    site = (d / "site" / "index.html").read_text(encoding="utf-8") if p.returncode == 0 else ""
    m = re.search(r'window\.INDEX=JSON\.parse\((".*?")\);', site, re.S)
    raw_idx = m.group(1) if m else ""
    idx = json.loads(json.loads(raw_idx)) if m else {}
    body = re.sub(r"<script>.*?</script>", "", site, flags=re.S)
    check("review: </script><img onerror> in card title/summary escaped in HTML",
          p.returncode == 0 and "<img src=x" not in body and "&lt;/script&gt;&lt;img" in body)
    check("review: </script><img onerror> in INDEX stays inside JSON string (no raw < or >)",
          m is not None and "<" not in raw_idx and ">" not in raw_idx
          and idx.get("card-br", {}).get("desc", "").startswith("</script><img"))
    plain = card_wiki("cards-breakout-ref", None)
    cli("build", "--wiki", str(plain))
    ref_site = (plain / "site" / "index.html").read_text(encoding="utf-8")
    check("review: breakout text adds no </script> (count equals no-card build)",
          site.lower().count("</script>") == ref_site.lower().count("</script>"),
          f"{site.lower().count('</script>')} vs {ref_site.lower().count('</script>')}")

    trav = [{"id": "t1", "summary": "s", "keyFiles": ["../../x.py:1", "/etc/passwd", "a/../../b.py", "sample.py:4"]},
            {"id": "t2", "summary": "s", "keyFiles": ["../sample.py"]}]
    d = card_wiki("cards-trav", trav)
    p = cli("build", "--wiki", str(d))
    data_site = (d / "site" / "index.html").read_text(encoding="utf-8") if p.returncode == 0 else ""
    check("review: keyFiles with .. segments or absolute paths rejected at normalize",
          p.returncode == 0 and "'../../x.py:1'" in p.stderr and "'/etc/passwd'" in p.stderr
          and "'a/../../b.py'" in p.stderr and "t2 没有合法 keyFiles" in p.stderr
          and "../../x.py" not in re.sub(r"<script>.*?</script>", "", data_site, flags=re.S),
          p.stderr[-300:])

    pages_c = [{"id": "overview", "title": "总览", "markdown": "x"},
               {"id": "card-dup-2", "title": "Clash", "markdown": "y"}]
    d = card_wiki("cards-dedup-collision", [
        {"id": "dup", "summary": "a", "keyFiles": ["sample.py:4"]},
        {"id": "dup", "summary": "b", "keyFiles": ["sample.py:8"]}], pages=pages_c)
    p = cli("build", "--wiki", str(d))
    site = (d / "site" / "index.html").read_text(encoding="utf-8") if p.returncode == 0 else ""
    check("review: dedup suffix colliding with a page id is caught after _safe_id",
          p.returncode == 0 and 'id="pg-card-dup"' in site and site.count('id="pg-card-dup-2"') == 1
          and "card-dup-2 与页面 id" in p.stderr, p.stderr[-200:])

    d = pathlib.Path(tmp) / "asm-types" / ".dsh-wiki"
    (d / "pages").mkdir(parents=True)
    (d / "cards").mkdir()
    shutil.copy(FIXTURE / "valid" / "sample.py", d.parent / "sample.py")
    (d / "pages" / "a.md").write_text("---\nid: 42\ntitle: 7\nparentId: null\n---\nA\n", encoding="utf-8")
    (d / "pages" / "b.md").write_text('---\nid: ["x"]\ntitle: B\n---\nB\n', encoding="utf-8")
    (d / "pages" / "c.md").write_text("---\nid: c\ntitle: {\"a\": 1}\n---\nC\n", encoding="utf-8")
    (d / "cards" / "k.md").write_text('---\nid: true\nkeyFiles: ["sample.py:4"]\n---\nK\n', encoding="utf-8")
    (d / "cards" / "ok.md").write_text('---\nid: 5\nkeyFiles: ["sample.py:4"]\n---\nOK\n', encoding="utf-8")
    p = cli("assemble", "--wiki", str(d), "--repo", str(d.parent))
    data = json.loads((d / "wiki.json").read_text(encoding="utf-8")) if p.returncode == 0 else {}
    check("review: non-string front-matter id/title -> numbers coerced, other types skipped with WARN",
          p.returncode == 0 and [x["id"] for x in data.get("pages", [])] == ["42"]
          and data["pages"][0]["title"] == "7" and [c["id"] for c in data.get("cards", [])] == ["5"]
          and "b.md: front-matter id 类型非法" in p.stderr and "c.md: front-matter title 类型非法" in p.stderr
          and "k.md: front-matter id 类型非法" in p.stderr, p.stdout + p.stderr[-300:])

    d = pathlib.Path(tmp) / "asm-link" / ".dsh-wiki"
    (d / "pages").mkdir(parents=True)
    (d / "pages" / "a.md").write_text("---\nid: a\ntitle: A\n---\nA\n", encoding="utf-8")
    outside = pathlib.Path(tmp) / "outside-secret.md"
    outside.write_text("---\nid: leak\ntitle: Leak\n---\nSECRET\n", encoding="utf-8")
    try:
        os.symlink(outside, d / "pages" / "z-link.md")
        linked = True
    except (OSError, NotImplementedError):
        linked = False
    if linked:
        p = cli("assemble", "--wiki", str(d), "--repo", str(d.parent))
        data = json.loads((d / "wiki.json").read_text(encoding="utf-8")) if p.returncode == 0 else {}
        check("review: symlinked pages/*.md skipped by assemble",
              p.returncode == 0 and [x["id"] for x in data.get("pages", [])] == ["a"]
              and "SECRET" not in json.dumps(data) and "z-link.md 是符号链接" in p.stderr, p.stderr[-200:])
    else:
        print("SKIP review: symlink in pages/ (symlink creation not permitted here)")

    # ---- resolve-config: sourceCommit
    git = shutil.which("git")
    if git:
        r = pathlib.Path(tmp) / "gitrepo"
        r.mkdir()
        g = lambda *a: subprocess.run([git, "-C", str(r), "-c", "user.name=t", "-c", "user.email=t@t",
                                       *a], capture_output=True, text=True)
        g("init", "-q")
        (r / "f.txt").write_text("x\n", encoding="utf-8")
        g("add", "f.txt")
        g("commit", "-qm", "init")
        head = g("rev-parse", "HEAD").stdout.strip()
        p = cli("resolve-config", "--repo", str(r), home=home)
        meta = json.loads((r / ".dsh-wiki" / "generation-meta.json").read_text(encoding="utf-8")) \
            if p.returncode == 0 else {}
        check("config: generation-meta records sourceCommit = git HEAD",
              len(head) == 40 and meta.get("sourceCommit") == head, f"{head} vs {meta.get('sourceCommit')}")
    else:
        print("SKIP config: sourceCommit (git not found)")
    r = pathlib.Path(tmp) / "nogit"
    r.mkdir()
    p = cli("resolve-config", "--repo", str(r), home=home)
    meta = json.loads((r / ".dsh-wiki" / "generation-meta.json").read_text(encoding="utf-8")) \
        if p.returncode == 0 else {"sourceCommit": "?"}
    check("config: no git repo -> sourceCommit omitted", "sourceCommit" not in meta)

    failed = [n for n, ok in RESULTS if not ok]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} passed" +
          (f"; FAILURES: {failed}" if failed else ""))
    shutil.rmtree(tmp, ignore_errors=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
