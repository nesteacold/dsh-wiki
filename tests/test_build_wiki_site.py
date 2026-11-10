#!/usr/bin/env python3
"""repo-wiki 构建器回归测试（纯标准库，可直接运行）。

    python3 dsh-wiki/tests/test_build_wiki_site.py

覆盖：fixture 构建/自检、配置合并与校验边界、注入与净化（含两轮审核的
Chrome 级 PoC）、失败路径的干净报错与写入原子性。全部在临时目录中进行，
不写仓库（fixture 会被复制到 tmp 后再构建）。
"""
import inspect
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


def find_node():
    """node 可执行文件（GUI 环境 PATH 常缺 node，常见安装位置兜底）。"""
    node = shutil.which("node")
    if node:
        return node
    for cand in sorted(pathlib.Path.home().glob(".nvm/versions/node/*/bin/node"), reverse=True) + [
            pathlib.Path("/opt/homebrew/bin/node"),
            pathlib.Path("/usr/local/bin/node"),
            pathlib.Path("C:/Program Files/nodejs/node.exe")]:
        if cand.is_file():
            return str(cand)
    return None


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
          p.returncode != 0 and "Traceback" not in p.stderr and "is not valid JSON" in p.stderr,
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
    check("ref escape: rejected", "escapes the repository" in p.stderr)

    d = pathlib.Path(tmp) / "empty"; (d / "site").mkdir(parents=True)
    write_wiki(d, [{"id": "a", "markdown": "x"}])
    (d / "site" / "index.html").write_text("")
    p = cli("selfcheck", "--wiki", str(d))
    check("empty site: FAIL", p.returncode != 0 and "incomplete" in p.stderr)

    d = pathlib.Path(tmp) / "nop"; d.mkdir()
    (d / "wiki.json").write_text('{"repoId":".","pages":[1,"x",null]}')
    p = cli("build", "--wiki", str(d))
    check("empty pages: warns flushed", "is not an object" in p.stderr and "contains no pages" in p.stderr)

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
          p.returncode != 0 and "import refused" in p.stderr, p.stderr.strip()[-90:])

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
          p.returncode == 0 and "Traceback" not in p.stderr and "could not be parsed" in p.stderr,
          p.stderr.strip()[-90:])

    # ---- R5: legacy-src fixture consumed end-to-end
    d = stage_fixture("legacy-src", tmp)
    p = cli("import-legacy", str(d), "--dest", str(pathlib.Path(tmp) / "impfixture"))
    check("R5: legacy-src fixture imports", p.returncode == 0 and "import complete" in p.stdout,
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
    node = find_node()
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
          and "2 cards" in p.stdout, p.stdout + p.stderr[-200:])
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
          p.returncode == 0 and "2 cards" in p.stdout and "citations resolve" in p.stdout, p.stdout + p.stderr[-200:])

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
    check("cards: invalid entries FAIL selfcheck", p.returncode == 1 and "cards has 2 invalid entries" in p.stderr,
          p.stderr[-200:])
    d = card_wiki("cards-notlist", {"id": "a"})
    p = cli("build", "--wiki", str(d))
    p2 = cli("selfcheck", "--wiki", str(d))
    check("cards: non-array cards -> build WARN, selfcheck FAIL",
          p.returncode == 0 and "cards is not an array" in p.stderr and p2.returncode == 1, p2.stderr[-200:])

    # ---- cards: card ref out of range fails selfcheck
    d = card_wiki("cards-badref", [{"id": "b", "summary": "s", "keyFiles": ["sample.py:999"]}])
    cli("build", "--wiki", str(d))
    p = cli("selfcheck", "--wiki", str(d))
    check("cards: out-of-range keyFiles FAIL selfcheck with card id",
          p.returncode == 1 and "card:b" in p.stderr and "line out of range" in p.stderr, p.stderr[-200:])

    # ---- cards: > 200 warns
    many = [{"id": f"c{i}", "summary": "s", "keyFiles": ["sample.py"]} for i in range(201)]
    d = card_wiki("cards-many", many)
    p = cli("build", "--wiki", str(d))
    check("cards: more than 200 cards WARN", p.returncode == 0 and "exceed 200" in p.stderr, p.stderr[-200:])

    # ---- links: page -> card
    pages = [{"id": "overview", "title": "总览", "markdown":
              "See [the add card](#card-add-fn) and [gone](#card-nope) and [ext](http://x.example)."}]
    d = card_wiki("cards-links", good, pages=pages)
    p = cli("build", "--wiki", str(d))
    site = (d / "site" / "index.html").read_text(encoding="utf-8") if p.returncode == 0 else ""
    check("links: [t](#card-id) becomes in-site anchor",
          '<a class="cardlink" href="#card-add-fn">the add card</a>' in site, p.stderr[-200:])
    check("links: missing card target -> plain text + WARN",
          'href="#card-nope"' not in site and "nope" in p.stderr and "card link targets missing" in p.stderr)
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
          p.returncode == 0 and "citation points to a blank line sample.py:2" in p.stderr and "sample.py:4" not in p.stderr,
          p.stderr[-200:])

    # ---- selfcheck: bare-filename citation fallback (unique match => WARN, outcome unchanged)
    roadmap_rel = "specs/005-goal-and-roadmap/ROADMAP.md"
    roadmap_lines = "".join(f"roadmap line {i}\n" for i in range(1, 21))

    def ref_wiki(name, pages, files=()):
        d = card_wiki(name, None, pages=pages)
        for rel, text in files:
            (d / rel).parent.mkdir(parents=True, exist_ok=True)
            (d / rel).write_text(text, encoding="utf-8")
        cli("build", "--wiki", str(d))
        return d, cli("selfcheck", "--wiki", str(d))

    # the real 31-page-candidate case: six full citations + one bare `ROADMAP.md:4`
    roadmap_md = ("# Repository operations\n\n"
                  + " ".join(f"`{roadmap_rel}:{n}`" for n in (2, 4, 6, 8, 10, 12))
                  + " and the shorthand `ROADMAP.md:4`.\n")
    d, p = ref_wiki("bare-ref-roadmap",
                    [{"id": "repository-operations", "title": "Repository operations",
                      "markdown": roadmap_md}],
                    [(roadmap_rel, roadmap_lines)])
    check("selfcheck: unique bare filename passes and WARNs the resolved path",
          p.returncode == 0 and "citation check: all 7 path:line citations resolve" in p.stdout
          and "WARN" in p.stderr and "ROADMAP.md:4" in p.stderr and roadmap_rel in p.stderr,
          f"rc={p.returncode} {p.stdout[-160:]} {p.stderr[-220:]}")

    # zero matches: a citation that resolves nowhere must still fail
    d, p = ref_wiki("bare-ref-ghost",
                    [{"id": "ghost", "markdown": "Nowhere `no-such-file.md:1`."}])
    check("selfcheck: bare filename with no match still FAILs",
          p.returncode == 1 and "cited file does not exist no-such-file.md" in p.stderr,
          p.stderr[-200:])

    # two matches: ambiguity must still fail and list the candidates
    d, p = ref_wiki("bare-ref-ambiguous",
                    [{"id": "amb", "markdown": "Ambiguous `x.md:1`."}],
                    [("a/x.md", "x\n"), ("b/x.md", "x\n")])
    check("selfcheck: bare filename matching two files FAILs as AMBIGUOUS",
          p.returncode == 1 and "AMBIGUOUS" in p.stderr and "x.md:1" in p.stderr
          and "a/x.md" in p.stderr and "b/x.md" in p.stderr,
          p.stderr[-220:])

    # out-of-range line on an otherwise resolvable bare filename still fails
    d, p = ref_wiki("bare-ref-range",
                    [{"id": "range", "markdown": "Too far `ROADMAP.md:9999`."}],
                    [(roadmap_rel, roadmap_lines)])
    check("selfcheck: out-of-range line on a resolvable bare filename still FAILs",
          p.returncode == 1 and "line out of range ROADMAP.md:9999" in p.stderr,
          p.stderr[-200:])

    # a file that exists only inside an ignored directory is not a candidate
    d, p = ref_wiki("bare-ref-ignored",
                    [{"id": "ignored", "markdown": "Vendored `ROADMAP.md:1`."}],
                    [("node_modules/pkg/ROADMAP.md", "line\n")])
    check("selfcheck: bare filename found only under node_modules still FAILs",
          p.returncode == 1 and "cited file does not exist ROADMAP.md" in p.stderr
          and "unique match" not in p.stderr, p.stderr[-200:])

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
          b.returncode == 0 and s.returncode == 0 and "1 cards" in s.stdout, b.stderr[-150:] + s.stderr[-150:])
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
          and "'a/../../b.py'" in p.stderr and "card t2 has no valid keyFiles" in p.stderr
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
          and "card-dup-2 collides with a page id" in p.stderr, p.stderr[-200:])

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
          and "b.md: front-matter id has invalid type" in p.stderr and "c.md: front-matter title has invalid type" in p.stderr
          and "k.md: front-matter id has invalid type" in p.stderr, p.stdout + p.stderr[-300:])

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
              and "SECRET" not in json.dumps(data) and "z-link.md is a symlink" in p.stderr, p.stderr[-200:])
    else:
        print("SKIP review: symlink in pages/ (symlink creation not permitted here)")

    # ---- site chrome follows wiki.json language (en default, zh for zh*)
    for lang, expect, absent in (("en", "Knowledge cards", "知识卡片"), (None, "Knowledge cards", "知识卡片"),
                                 ("fr", "Knowledge cards", "知识卡片"), ("zh-CN", "知识卡片", "Knowledge cards")):
        d = card_wiki(f"chrome-{lang}", good)
        data = json.loads((d / "wiki.json").read_text(encoding="utf-8"))
        if lang is None:
            data.pop("language", None)
        else:
            data["language"] = lang
        (d / "wiki.json").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        p = cli("build", "--wiki", str(d))
        site = (d / "site" / "index.html").read_text(encoding="utf-8") if p.returncode == 0 else ""
        chrome = re.sub(r"<script>.*?</script>", "", site, flags=re.S)
        check(f"chrome: language={lang} -> {'zh' if expect == '知识卡片' else 'en'} UI strings",
              p.returncode == 0 and expect in chrome and absent not in chrome
              and (lang != "zh-CN" or 'placeholder="全文搜索…"' in site)
              and (lang == "zh-CN" or 'placeholder="Search…"' in site), p.stderr[-150:])

    # ---- standalone theme toggle (defect 3): the old control was a 12px glyph in the window's
    #      top-right drag/caption strip, and the only theme code lived at the END of the 3 MB
    #      viewer script. New contract: boot script in <head> (applies before first paint and
    #      works even if the viewer script dies), high-specificity dark rules with a hard-coded
    #      fallback, labelled pill below the caption buttons with -webkit-app-region:no-drag,
    #      localStorage persistence, and a runtime check that toggling really flips data-theme.
    d = card_wiki("theme-toggle", good)
    # 固定 en：主题按钮文案跟随 wiki.json 的 language（fixture 默认 zh-CN）
    data = json.loads((d / "wiki.json").read_text(encoding="utf-8"))
    data["language"] = "en"
    (d / "wiki.json").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    p = cli("build", "--wiki", str(d))
    site = (d / "site" / "index.html").read_text(encoding="utf-8") if p.returncode == 0 else ""
    head_end = site.find("</head>")
    boot_at = site.find('<script id="rw-theme">')
    check("theme: head boot script applies the theme before first paint",
          p.returncode == 0 and boot_at != -1 and boot_at < head_end
          and "<body" not in site[boot_at:head_end], f"boot_at={boot_at} head_end={head_end}")
    check("theme: dark rules are html[data-theme=\"dark\"] with a hard-coded body fallback",
          'html[data-theme="dark"]{' in site
          and 'html[data-theme="dark"],html[data-theme="dark"] body{background:#0d1117;color:#e6edf3}' in site
          and "color-scheme:dark" in site and "[data-theme=dark]" not in site)
    check("theme: toggle is a labelled, caption-safe, no-drag pill (not a 12px float)",
          'id="tbtn"' in site and "🌙 Dark" in site
          and re.search(r"#tbtn\{position:fixed;top:44px;right:16px", site) is not None
          and "-webkit-app-region:no-drag" in site
          and "#tbtn{float" not in site)
    check("theme: label flips between 🌙 Dark and ☀️ Light, aria-pressed tracks state",
          "dark?'☀️ '+LIGHT:'🌙 '+DARK" in site and "aria-pressed" in site)
    check("theme: persists under localStorage key rw-theme",
          "var KEY='rw-theme'" in site and "localStorage.setItem(KEY,t)" in site
          and "localStorage.getItem(KEY)" in site)
    check("theme: viewer script defers to one implementation (no second applyTheme)",
          "function applyTheme(" not in site and "window.__rwAfterTheme=function(){renderMermaids();}" in site)
    if node is None:
        print("SKIP theme toggle runtime check (node not found; CI installs it)")
    else:
        m = re.search(r'<script id="rw-theme">(.*?)</script>', site, re.S)
        probe = pathlib.Path(tmp) / "theme-probe.js"
        probe.write_text(
            "const fs=require('fs');\n"
            "const src=fs.readFileSync(process.argv[2],'utf8');\n"
            "const store={};const attrs={};const btn={textContent:'',attrs:{},"
            "setAttribute(k,v){this.attrs[k]=String(v);}};\n"
            "const doc={documentElement:{attrs:{},setAttribute(k,v){this.attrs[k]=String(v);},"
            "getAttribute(k){return this.attrs[k]===undefined?null:this.attrs[k];},dataset:{}},"
            "body:null,getElementById(id){return id==='tbtn'?btn:null;},"
            "addEventListener(ev,fn){this['on_'+ev]=fn;}};\n"
            "global.document=doc;global.window=global;\n"
            "global.localStorage={getItem(k){return store[k]===undefined?null:store[k];},"
            "setItem(k,v){store[k]=String(v);}};\n"
            "global.matchMedia=function(){return {matches:false};};\n"
            "eval(src);\n"
            "const boot=doc.documentElement.getAttribute('data-theme');\n"
            "const api=window.__rwTheme;\n"
            "api.toggle();\n"
            "const dark=doc.documentElement.getAttribute('data-theme');\n"
            "const saved=store['rw-theme'];\n"
            "const labelLight=btn.textContent.indexOf('Light')>=0&&/^\\u2600/.test(btn.textContent);\n"
            "const ariaDark=btn.attrs['aria-pressed'];\n"
            "api.toggle();\n"
            "const light=doc.documentElement.getAttribute('data-theme');\n"
            "const labelDark=btn.textContent.indexOf('Dark')>=0&&/^\\u{1F319}/u.test(btn.textContent);\n"
            "console.log(JSON.stringify({boot,dark,saved,labelLight,ariaDark,light,labelDark,"
            "bodyTheme:!!api,toggleFn:typeof api.toggle}));\n", encoding="utf-8")
        src_file = pathlib.Path(tmp) / "theme-probe-src.js"
        src_file.write_text(m.group(1) if m else "", encoding="utf-8")
        r = run([node, str(probe), str(src_file)])
        try:
            got = json.loads(r.stdout.strip().splitlines()[-1]) if r.returncode == 0 else {}
        except (ValueError, IndexError):
            got = {}
        check("theme: runtime toggle flips data-theme, persists, and updates the label",
              got.get("boot") == "light" and got.get("dark") == "dark" and got.get("saved") == "dark"
              and got.get("labelLight") is True and got.get("ariaDark") == "true"
              and got.get("light") == "light" and got.get("labelDark") is True,
              (r.stdout + r.stderr).strip()[-200:])
    # 文案跟随 wiki.json 的 language：zh 站点按钮为 🌙 深色 / ☀️ 浅色
    data["language"] = "zh-CN"
    (d / "wiki.json").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    cli("build", "--wiki", str(d))
    site_zh = (d / "site" / "index.html").read_text(encoding="utf-8")
    check("theme: label localized (zh: 🌙 深色 / ☀️ 浅色)",
          "🌙 深色" in site_zh and 'LIGHT="浅色"' in site_zh and 'DARK="深色"' in site_zh)

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

    # ================================================================ spec 007 T001: Vietnamese site chrome
    # SITE CHROME 只由 wiki.json 的 language 决定：vi* -> vi，zh* -> zh，其它 -> en。
    # en 表原样保留（英文输出逐字节不变），所以这里把 en 表钉成快照。
    en_snapshot = {
        "image": "image", "imageNote": " (offline viewer does not load external images)",
        "sources": "Sources", "emptyPage": "(this page has no content)",
        "kindModule": "Module", "kindConcept": "Concept", "kindApi": "API",
        "all": "All", "cards": "Knowledge cards",
        "cardsDesc": "{n} cards: atomic overviews of modules, concepts and APIs, each with machine-checked evidence.",
        "noSummary": "(no summary)", "keyFiles": "Key files", "related": "Related cards",
        "refBy": "Pages referencing this card",
        "cardTag": "card", "theme": "Toggle theme", "search": "Search…",
        "noscript": "This viewer needs JavaScript to switch pages and search; open it in a browser with JavaScript enabled.",
        "footer": "generated locally, nothing uploaded", "noHits": "No results", "light": "Light", "dark": "Dark",
    }
    vi_snapshot = B.UI_STRINGS.get("vi") or {}
    check("chrome vi: en table unchanged (byte-identical English output)",
          B.UI_STRINGS["en"] == en_snapshot,
          f"diff={sorted(set(en_snapshot.items()) ^ set(B.UI_STRINGS['en'].items()))[:4]}")
    check("chrome vi: table mirrors every en key",
          set(vi_snapshot) == set(en_snapshot),
          f"missing={sorted(set(en_snapshot) - set(vi_snapshot))} extra={sorted(set(vi_snapshot) - set(en_snapshot))}")
    check("chrome vi: every value is a non-empty string",
          all(isinstance(v, str) and v.strip() for v in vi_snapshot.values()),
          str([k for k, v in vi_snapshot.items() if not (isinstance(v, str) and v.strip())]))
    check("chrome vi: card labels are Vietnamese (plan.md 1.2 wording)",
          vi_snapshot.get("cards") == "Thẻ tri thức" and vi_snapshot.get("search") == "Tìm toàn văn…"
          and vi_snapshot.get("keyFiles") == "Tệp tham chiếu" and vi_snapshot.get("light") == "Sáng"
          and vi_snapshot.get("dark") == "Tối", str(sorted(vi_snapshot.items()))[:120])
    for lang, want in (("vi", "vi"), ("vi-VN", "vi"), ("VI-vn", "vi"), ("zh", "zh"), ("zh-CN", "zh"),
                       ("ZH-hans-cn", "zh"), ("en", "en"), ("en-US", "en"), ("fr", "en"),
                       ("", "en"), (None, "en")):
        check(f"chrome: locale selection ui_lang({lang!r}) -> {want}", B.ui_lang(lang) == want, B.ui_lang(lang))

    def chrome_site(name, language):
        """同一份 wiki 内容 + 同一 repoId（品牌位一致）只改 language，构建后返回 site 文本。"""
        d = card_wiki(name, good)
        data = json.loads((d / "wiki.json").read_text(encoding="utf-8"))
        data["repoId"] = "chrome-repo"
        if language is None:
            data.pop("language", None)
        else:
            data["language"] = language
        (d / "wiki.json").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        p = cli("build", "--wiki", str(d))
        site = (d / "site" / "index.html").read_text(encoding="utf-8") if p.returncode == 0 else ""
        return p, site

    def without_footer_date(doc):
        return re.sub(r" · \d{4}-\d{2}-\d{2} \d{2}:\d{2} [+-]\d{4}</footer>", "</footer>", doc)

    for i, lang in enumerate(("vi", "vi-VN", "VI-vn")):
        p, site = chrome_site(f"chrome-vi-{i}", lang)
        chrome = re.sub(r"<script>.*?</script>", "", site, flags=re.S)
        check(f"chrome vi: language={lang} renders Vietnamese chrome",
              p.returncode == 0 and "<h1>Thẻ tri thức</h1>" in chrome
              and 'placeholder="Tìm toàn văn…"' in site and 'title="Đổi giao diện"' in site
              and "🌙 Tối" in site and 'LIGHT="Sáng"' in site and 'DARK="Tối"' in site
              and 'none.textContent="Không có kết quả"' in site
              and "Tất cả" in chrome and "Tệp tham chiếu" in chrome
              and "Knowledge cards" not in chrome and "知识卡片" not in chrome
              and "tạo cục bộ, không tải lên" in chrome, p.stderr[-180:])

    p, site_zh = chrome_site("chrome-zh-new", "zh-CN")
    check("chrome zh: zh-CN fallback unchanged (no vi leak)",
          p.returncode == 0 and "<h1>知识卡片</h1>" in site_zh and 'placeholder="全文搜索…"' in site_zh
          and "🌙 深色" in site_zh and "全部" in site_zh
          and "Thẻ tri thức" not in site_zh and "Tìm toàn văn…" not in site_zh, p.stderr[-180:])

    p_en, site_en = chrome_site("chrome-en-new", "en")
    p_def, site_def = chrome_site("chrome-default-new", None)
    chrome_en = re.sub(r"<script>.*?</script>", "", site_en, flags=re.S)
    check("chrome en: explicit en keeps the English chrome",
          p_en.returncode == 0 and "<h1>Knowledge cards</h1>" in chrome_en
          and 'placeholder="Search…"' in site_en and "🌙 Dark" in site_en
          and 'none.textContent="No results"' in site_en and "Key files" in chrome_en
          and "Thẻ tri thức" not in chrome_en and "知识卡片" not in chrome_en, p_en.stderr[-180:])
    check("chrome en: no language field defaults to en and is byte-identical",
          p_def.returncode == 0 and without_footer_date(site_en) == without_footer_date(site_def),
          f"en={len(site_en)} default={len(site_def)}")
    p_vi, site_vi = chrome_site("chrome-vi-diff", "vi")
    check("chrome: vi output differs from en only in the localized chrome strings",
          p_vi.returncode == 0 and without_footer_date(site_vi) != without_footer_date(site_en)
          and 'placeholder="Search…"' not in site_vi and 'placeholder="Tìm toàn văn…"' not in site_en)

    # ================================================================ spec 007 T002: diff-impact
    if git:
        imp = pathlib.Path(tmp) / "impact-repo"
        for sub in ("src", "lib", "docs", "library"):
            (imp / sub).mkdir(parents=True)
        (imp / ".dsh-wiki").mkdir()
        (imp / ".gitignore").write_text(".dsh-wiki/\n", encoding="utf-8")
        (imp / "src" / "app.py").write_text("def add(a, b):\n    return a + b\n", encoding="utf-8")
        (imp / "lib" / "util.py").write_text("one\ntwo\nthree\nfour\nfive\n", encoding="utf-8")
        (imp / "docs" / "guide.md").write_text("# guide\n", encoding="utf-8")
        (imp / "library" / "other.py").write_text("x = 1\n", encoding="utf-8")
        (imp / "README.md").write_text("readme\n", encoding="utf-8")
        gi = lambda *a: subprocess.run([git, "-C", str(imp), "-c", "user.name=t", "-c", "user.email=t@t", *a],
                                       capture_output=True, text=True)
        imp_pages = [
            {"id": "overview", "title": "Overview", "filePaths": ["src/app.py"], "markdown": "a"},
            {"id": "modules", "title": "Modules", "filePaths": ["lib", "docs/guide.md"], "markdown": "b"},
            {"id": "readme", "title": "README", "filePaths": ["README.md"], "markdown": "c"},
        ]
        imp_cards = [
            {"id": "api-add", "title": "add()", "kind": "api", "summary": "Adds.", "keyFiles": ["src/app.py:1"]},
            {"id": "util", "title": "util", "kind": "module", "summary": "Util.", "keyFiles": ["lib/util.py:2-3"]},
            {"id": "libdir", "title": "lib dir", "kind": "module", "summary": "Dir.", "keyFiles": ["lib/"]},
        ]
        wdir = imp / ".dsh-wiki"
        (wdir / "wiki.json").write_text(json.dumps({"schema": "repo-wiki-local/1", "repoId": str(imp),
                                                    "language": "en", "pages": imp_pages,
                                                    "cards": imp_cards}), encoding="utf-8")
        gi("init", "-q")
        gi("add", "-A")
        gi("commit", "-qm", "base")
        base_sha = gi("rev-parse", "HEAD").stdout.strip()
        (wdir / "generation-meta.json").write_text(json.dumps(
            {"schema": "repo-wiki-local/1", "kind": "generation-meta", "sourceCommit": base_sha}),
            encoding="utf-8")
        (imp / "src" / "app.py").write_text("def add(a, b):\n    return a + b  # changed\n", encoding="utf-8")
        (imp / "lib" / "util.py").write_text("one\ntwo\nthree\nfour\nfive  # changed\n", encoding="utf-8")
        (imp / "docs" / "guide.md").write_text("# guide changed\n", encoding="utf-8")
        (imp / "library" / "other.py").write_text("x = 2\n", encoding="utf-8")
        (imp / "notes.md").write_text("new\n", encoding="utf-8")
        gi("add", "-A")
        gi("commit", "-qm", "change")
        head_sha = gi("rev-parse", "HEAD").stdout.strip()

        def tree_state(root):
            """仓库工作区快照（跳过 .git）：路径 -> (大小, mtime, 内容)。"""
            state = {}
            for f in sorted(root.rglob("*")):
                rel = f.relative_to(root).as_posix()
                if rel.split("/")[0] == ".git" or not f.is_file():
                    continue
                st = f.stat()
                state[rel] = (st.st_size, st.st_mtime_ns, f.read_bytes())
            return state

        before = tree_state(imp)
        p = cli("diff-impact", "--wiki", str(wdir))
        after = tree_state(imp)
        report = json.loads(p.stdout) if p.returncode == 0 and p.stdout.strip() else {}
        check("diff-impact: exit 0 and pure JSON on stdout",
              p.returncode == 0 and isinstance(report, dict), p.stderr[-200:])
        check("diff-impact: from = sourceCommit, to = HEAD sha",
              report.get("from") == base_sha and report.get("to") == head_sha,
              f"from={report.get('from')} to={report.get('to')}")
        check("diff-impact: changedFiles = git diff --name-only set",
              sorted(report.get("changedFiles") or [])
              == ["docs/guide.md", "lib/util.py", "library/other.py", "notes.md", "src/app.py"],
              str(report.get("changedFiles")))
        pages_hit = {x.get("id"): x.get("matchedFiles") for x in report.get("affectedPages") or []}
        check("diff-impact: page hit by filePaths (exact match)",
              pages_hit.get("overview") == ["src/app.py"], str(pages_hit))
        check("diff-impact: directory-prefix + exact match on one page",
              pages_hit.get("modules") == ["docs/guide.md", "lib/util.py"], str(pages_hit))
        check("diff-impact: page whose files did not change is not affected",
              "readme" not in pages_hit, str(sorted(pages_hit)))
        cards_hit = {x.get("id"): x.get("matchedFiles") for x in report.get("affectedCards") or []}
        check("diff-impact: card hit by keyFiles (line suffix stripped)",
              cards_hit.get("api-add") == ["src/app.py"], str(cards_hit))
        check("diff-impact: card range suffix and directory-prefix match",
              cards_hit.get("util") == ["lib/util.py"] and cards_hit.get("libdir") == ["lib/util.py"],
              str(cards_hit))
        check("diff-impact: unmapped file listed; directory prefix respects path boundary",
              sorted(report.get("unmappedFiles") or []) == ["library/other.py", "notes.md"],
              str(report.get("unmappedFiles")))
        check("diff-impact: writes nothing (worktree byte-identical before/after)", before == after,
              str(sorted(set(before) ^ set(after))[:5]))
        p2 = cli("diff-impact", "--wiki", str(wdir), "--repo", str(imp),
                 "--from", base_sha, "--to", head_sha)
        rep2 = json.loads(p2.stdout) if p2.returncode == 0 and p2.stdout.strip() else {}
        check("diff-impact: explicit --repo/--from/--to accepted",
              p2.returncode == 0 and rep2.get("changedFiles") == report.get("changedFiles")
              and rep2.get("from") == base_sha and rep2.get("to") == head_sha, p2.stderr[-200:])
        p3 = cli("diff-impact", "--wiki", str(wdir), "--from", base_sha, "--to", base_sha)
        empty = json.loads(p3.stdout) if p3.returncode == 0 and p3.stdout.strip() else {}
        check("diff-impact: empty range -> empty report",
              p3.returncode == 0 and empty.get("from") == empty.get("to") == base_sha
              and empty.get("changedFiles") == [] and empty.get("affectedPages") == []
              and empty.get("affectedCards") == [] and empty.get("unmappedFiles") == [], p3.stderr[-200:])
        nm = pathlib.Path(tmp) / "impact-nometa" / ".dsh-wiki"
        nm.mkdir(parents=True)
        (nm / "wiki.json").write_text(json.dumps({"repoId": str(imp), "pages": imp_pages}),
                                      encoding="utf-8")
        p4 = cli("diff-impact", "--wiki", str(nm))
        check("diff-impact: missing sourceCommit -> clear error exit 2",
              p4.returncode == 2 and "no source commit" in p4.stderr and "Traceback" not in p4.stderr,
              f"rc={p4.returncode} {p4.stderr.strip()[-160:]}")
        wjm = pathlib.Path(tmp) / "impact-wikimeta" / ".dsh-wiki"
        wjm.mkdir(parents=True)
        (wjm / "wiki.json").write_text(json.dumps(
            {"repoId": str(imp), "language": "en", "sourceCommit": base_sha,
             "pages": imp_pages, "cards": imp_cards}), encoding="utf-8")
        p5 = cli("diff-impact", "--wiki", str(wjm))
        rep5 = json.loads(p5.stdout) if p5.returncode == 0 and p5.stdout.strip() else {}
        check("diff-impact: wiki.json sourceCommit used when generation-meta is absent",
              p5.returncode == 0 and rep5.get("from") == base_sha, p5.stderr[-200:])
        ng = pathlib.Path(tmp) / "impact-nogit"
        (ng / ".dsh-wiki").mkdir(parents=True)
        (ng / ".dsh-wiki" / "wiki.json").write_text(json.dumps({"repoId": str(ng), "pages": imp_pages}),
                                                    encoding="utf-8")
        (ng / ".dsh-wiki" / "generation-meta.json").write_text(json.dumps({"sourceCommit": base_sha}),
                                                               encoding="utf-8")
        p6 = cli("diff-impact", "--wiki", str(ng / ".dsh-wiki"))
        check("diff-impact: repo without git -> clear error exit 2, no traceback",
              p6.returncode == 2 and "diff-impact failed" in p6.stderr and "Traceback" not in p6.stderr,
              f"rc={p6.returncode} {p6.stderr.strip()[-160:]}")
    else:
        print("SKIP diff-impact (git not found)")

    # ================================================================ spec 007 T003/T004: check-translation
    # 构建器不实现第二套（更弱的）完整性检查：它只负责定位三份输入，把比较整体交给
    # scripts/wiki_translations.py 的 check_translation()，再把结果分到 stderr（人读）
    # 与 stdout（--json）。这里的每条检查都对着三个不变量：委托、只读、退出码 0/1/2。
    import wiki_translations as WT  # noqa: E402  (scripts/ 已加入 sys.path)

    CT_LISTS = ("missing", "stale", "invalid", "added", "metaMissing", "metaExtra")

    def ct_canonical(repo):
        """tiny canonical (en) wiki：2 pages + 2 cards，引用与图表都可被 selfcheck 机检。"""
        return {
            "schema": "repo-wiki-local/1",
            "repoId": str(repo),
            "language": "en",
            "pages": [
                {"id": "overview", "parentId": None, "order": 1,
                 "title": "Overview", "description": "Repository overview",
                 "filePaths": ["sample.py"],
                 "sources": [{"path": "sample.py", "startLine": 4}],
                 "markdown": "# Overview\n\nEntry point at `sample.py:4`.\n\n"
                             "```mermaid\nflowchart LR\n  A-->B\n```\n\n"
                             "```python\nprint('x')\n```\n"},
                {"id": "builder", "parentId": "overview", "order": 2,
                 "title": "Builder", "description": "Builder page",
                 "filePaths": ["sample.py"], "sources": [],
                 "markdown": "# Builder\n\nMultiply at `sample.py:8-9`.\n\n```text\nplain\n```\n"},
            ],
            "cards": [
                {"id": "api-add", "title": "add()", "kind": "api",
                 "summary": "Adds two numbers.", "keyFiles": ["sample.py:4"],
                 "related": ["api-mul"], "tags": ["math"], "pageIds": ["overview"]},
                {"id": "api-mul", "title": "mul()", "kind": "api",
                 "summary": "Multiplies two numbers.", "keyFiles": ["sample.py:8-9"],
                 "related": ["api-add"], "tags": ["math"], "pageIds": ["builder"]},
            ],
        }

    CT_PAGE_VI = {
        "overview": ("Tổng quan", "Tổng quan kho mã",
                     "# Tổng quan\n\nĐiểm vào tại `sample.py:4`.\n\n"
                     "```mermaid\nflowchart LR\n  A-->B\n```\n\n"
                     "```python\nprint('x')\n```\n"),
        "builder": ("Bộ dựng", "Trang bộ dựng",
                    "# Bộ dựng\n\nNhân tại `sample.py:8-9`.\n\n```text\nplain\n```\n"),
    }
    CT_CARD_VI = {"api-add": ("Hàm add()", "Cộng hai số."), "api-mul": ("Hàm mul()", "Nhân hai số.")}

    def ct_translated(canonical, target="vi"):
        """忠实的翻译：只翻 prose，id/树/证据/图表原样保留（hand-written，不经模型）。"""
        tr = json.loads(json.dumps(canonical))
        tr["language"] = target
        for page in tr["pages"]:
            page["title"], page["description"], page["markdown"] = CT_PAGE_VI[page["id"]]
        for card in tr["cards"]:
            card["title"], card["summary"] = CT_CARD_VI[card["id"]]
        return tr

    def ct_meta(canonical, target="vi"):
        return {
            "schema": "repo-wiki-translation-meta/1",
            "sourceLang": "en",
            "targetLang": target,
            "sourceCommit": "0" * 40,
            "pages": {p["id"]: {"sourceContentHash": WT.canonical_unit_hash("page", p)}
                      for p in canonical["pages"]},
            "cards": {c["id"]: {"sourceContentHash": WT.canonical_unit_hash("card", c)}
                      for c in canonical["cards"]},
        }

    def ct_write_locale(locale, translated, meta):
        (locale / "wiki.json").write_text(
            json.dumps(translated, ensure_ascii=False, indent=1), encoding="utf-8")
        (locale / "translation-meta.json").write_text(
            json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")

    def ct_repo(name, target="vi"):
        """canonical .dsh-wiki（pages+cards）+ 一份忠实翻译的 locales/<target>/ 快照。"""
        repo = pathlib.Path(tmp) / name
        shutil.rmtree(repo, ignore_errors=True)
        repo.mkdir()
        shutil.copy(FIXTURE / "valid" / "sample.py", repo / "sample.py")
        wiki = repo / ".dsh-wiki"
        wiki.mkdir()
        canonical = ct_canonical(repo)
        (wiki / "wiki.json").write_text(
            json.dumps(canonical, ensure_ascii=False, indent=1), encoding="utf-8")
        locale = wiki / "locales" / target
        locale.mkdir(parents=True)
        translated = ct_translated(canonical, target)
        meta = ct_meta(canonical, target)
        ct_write_locale(locale, translated, meta)
        return repo, wiki, locale, canonical, translated, meta

    def ct_json(*args):
        p = cli(*args)
        try:
            report = json.loads(p.stdout) if p.stdout.strip() else None
        except ValueError:
            report = None
        return p, report

    def ct_reasons(report, kind, unit_id):
        return " | ".join(" ".join(entry["reasons"]) for entry in report[kind]["invalid"]
                          if entry["id"] == unit_id)

    # ---- happy path: a real canonical wiki (built + selfchecked) vs a faithful translation
    (happy_repo, happy_wiki, happy_locale,
     happy_canonical, happy_translated, happy_meta) = ct_repo("ct-happy")
    b = cli("build", "--wiki", str(happy_wiki))
    s = cli("selfcheck", "--wiki", str(happy_wiki))
    check("check-translation: tiny canonical wiki (2 pages + 2 cards) builds and selfchecks green",
          b.returncode == 0 and s.returncode == 0 and "2 pages" in s.stdout,
          (b.stdout + b.stderr + s.stderr)[-200:])

    p = cli("check-translation", "--canonical", str(happy_wiki), "--translation", str(happy_locale))
    check("check-translation: faithful translation exits 0",
          p.returncode == 0 and "check-translation: OK" in p.stderr,
          f"rc={p.returncode} {p.stderr.strip()[-220:]}")
    check("check-translation: human summary on stderr, no data on stdout without --json",
          p.stdout.strip() == "" and "en -> vi" in p.stderr and "2 pages" in p.stderr
          and "cards canonical" in p.stderr, p.stderr.strip()[-220:])

    p, report = ct_json("check-translation", "--canonical", str(happy_wiki),
                        "--translation", str(happy_locale), "--json")
    check("check-translation: --json emits the module report (schema repo-wiki-translation-check/1)",
          p.returncode == 0 and isinstance(report, dict)
          and report.get("schema") == WT.REPORT_SCHEMA == "repo-wiki-translation-check/1"
          and report.get("ok") is True and report.get("status") == "ok",
          f"rc={p.returncode} report={str(report)[:180]}")
    check("check-translation: --json report equals the module's own result for the same inputs",
          report == WT.check_translation(happy_canonical, happy_translated, happy_meta),
          str(report)[:200])
    check("check-translation: report carries per-kind counts and all six unit lists",
          (report.get("counts") or {}).get("pages", {}).get("canonical") == 2
          and (report.get("counts") or {}).get("cards", {}).get("translated") == 2
          and set(report.get("pages") or {}) == set(CT_LISTS) == set(report.get("cards") or {}),
          str(report.get("counts"))[:160])

    # ---- stale: canonical prose moved on, recorded sourceContentHash no longer matches
    _, v_wiki, v_locale, v_canonical, v_translated, v_meta = ct_repo("ct-stale")
    mutated = json.loads(json.dumps(v_canonical))
    mutated["pages"][0]["description"] = "Repository overview (revised)"
    (v_wiki / "wiki.json").write_text(
        json.dumps(mutated, ensure_ascii=False, indent=1), encoding="utf-8")
    p, report = ct_json("check-translation", "--canonical", str(v_wiki),
                        "--translation", str(v_locale), "--json")
    check("check-translation: stale canonical page exits 1 and is reported stale",
          p.returncode == 1 and report and report.get("status") == "stale"
          and report["pages"]["stale"] == ["overview"]
          and report["pages"]["invalid"] == [] and report["cards"]["stale"] == [],
          f"rc={p.returncode} status={report and report.get('status')} "
          f"stale={report and report['pages']['stale']}")
    check("check-translation: stale summary names the stale page",
          "status=stale" in p.stderr and "stale page: overview" in p.stderr,
          p.stderr.strip()[-200:])

    # ---- missing unit: a canonical page has no translated counterpart
    _, v_wiki, v_locale, _, v_translated, v_meta = ct_repo("ct-missing")
    dropped = json.loads(json.dumps(v_translated))
    dropped["pages"] = [x for x in dropped["pages"] if x["id"] != "builder"]
    ct_write_locale(v_locale, dropped, v_meta)
    p, report = ct_json("check-translation", "--canonical", str(v_wiki),
                        "--translation", str(v_locale), "--json")
    check("check-translation: missing translated unit exits 1 and is reported missing",
          p.returncode == 1 and report and report.get("status") == "missing"
          and report["pages"]["missing"] == ["builder"] and report["pages"]["stale"] == [],
          f"rc={p.returncode} status={report and report.get('status')} "
          f"missing={report and report['pages']['missing']}")
    check("check-translation: missing summary names the unit and its kind",
          "missing page: builder" in p.stderr, p.stderr.strip()[-200:])

    # ---- invalid structure 1: a dropped path:line citation
    _, v_wiki, v_locale, _, v_translated, v_meta = ct_repo("ct-invalid-citation")
    broken = json.loads(json.dumps(v_translated))
    for page in broken["pages"]:
        if page["id"] == "builder":
            page["markdown"] = "# Bộ dựng\n\nNhân tại.\n\n```text\nplain\n```\n"
    ct_write_locale(v_locale, broken, v_meta)
    p, report = ct_json("check-translation", "--canonical", str(v_wiki),
                        "--translation", str(v_locale), "--json")
    reasons = ct_reasons(report, "pages", "builder") if report else ""
    check("check-translation: dropped path:line citation exits 1 as invalid",
          p.returncode == 1 and report and report.get("status") == "invalid"
          and any(e["id"] == "builder" for e in report["pages"]["invalid"])
          and "citations changed" in reasons and "sample.py:8-9" in reasons,
          f"rc={p.returncode} reasons={reasons[:200]}")
    check("check-translation: invalid summary prints the reason",
          "invalid page 'builder'" in p.stderr and "citations changed" in p.stderr,
          p.stderr.strip()[-200:])

    # ---- invalid structure 1b: an ambiguous bare shorthand still cannot replace the canonical citation
    _, v_wiki, v_locale, _, v_translated, v_meta = ct_repo("ct-ambiguous-citation")
    for rel in ("a/x.md", "b/x.md"):
        (v_wiki.parent / rel).parent.mkdir(parents=True, exist_ok=True)
        (v_wiki.parent / rel).write_text("x\n", encoding="utf-8")
    ambiguous = json.loads(json.dumps(v_translated))
    for page in ambiguous["pages"]:
        if page["id"] == "builder":
            page["markdown"] = "# Bộ dựng\n\nNhân tại `x.md:1`.\n\n```text\nplain\n```\n"
    ct_write_locale(v_locale, ambiguous, v_meta)
    p, report = ct_json("check-translation", "--canonical", str(v_wiki),
                        "--translation", str(v_locale), "--json")
    reasons = ct_reasons(report, "pages", "builder") if report else ""
    check("check-translation: ambiguous bare shorthand is still rejected as invalid",
          p.returncode == 1 and report and report.get("status") == "invalid"
          and any(e["id"] == "builder" for e in report["pages"]["invalid"])
          and "citations changed" in reasons and "x.md:1" in reasons,
          f"rc={p.returncode} reasons={reasons[:200]}")
    check("check-translation: --json keeps a list warnings array alongside the rejection",
          report is not None and isinstance(report.get("warnings"), list)
          and isinstance(report.get("counts", {}).get("warnings"), int),
          str(report and report.get("warnings"))[:120])

    # ---- --json warnings array still carries the shared module's warnings (faithful translation)
    warned_meta = dict(v_meta, items={"legacy": "0" * 64})
    ct_write_locale(v_locale, v_translated, warned_meta)
    p, report = ct_json("check-translation", "--canonical", str(v_wiki),
                        "--translation", str(v_locale), "--json")
    check("check-translation: module warnings still surface in the --json warnings array",
          p.returncode == 0 and report and report.get("ok") is True
          and any("takes precedence" in w for w in report.get("warnings") or []),
          str(report and report.get("warnings"))[:160])

    # ---- invalid structure 2: code fences reordered (same fences, wrong order)
    _, v_wiki, v_locale, _, v_translated, v_meta = ct_repo("ct-invalid-fence")
    swapped = json.loads(json.dumps(v_translated))
    for page in swapped["pages"]:
        if page["id"] == "overview":
            page["markdown"] = ("# Tổng quan\n\nĐiểm vào tại `sample.py:4`.\n\n"
                                "```python\nprint('x')\n```\n\n"
                                "```mermaid\nflowchart LR\n  A-->B\n```\n")
    ct_write_locale(v_locale, swapped, v_meta)
    p, report = ct_json("check-translation", "--canonical", str(v_wiki),
                        "--translation", str(v_locale), "--json")
    reasons = ct_reasons(report, "pages", "overview") if report else ""
    check("check-translation: reordered code fence exits 1 as invalid",
          p.returncode == 1 and report and report.get("status") == "invalid"
          and any(e["id"] == "overview" for e in report["pages"]["invalid"])
          and "code fence #1 info changed" in reasons and "mermaid" in reasons,
          f"rc={p.returncode} reasons={reasons[:200]}")
    check("check-translation: reordering fences is not a citation change",
          "citations changed" not in reasons and report["pages"]["stale"] == [],
          reasons[:200])

    # ---- usage/IO errors are exit 2 (distinct from report status=error which is exit 1)
    p = cli("check-translation", "--canonical", str(pathlib.Path(tmp) / "ct-nope"), "--lang", "vi")
    check("check-translation: missing canonical directory exits 2",
          p.returncode == 2 and "canonical wiki directory" in p.stderr
          and "Traceback" not in p.stderr, f"rc={p.returncode} {p.stderr.strip()[-200:]}")
    p = cli("check-translation", "--canonical", str(happy_wiki),
            "--translation", str(pathlib.Path(tmp) / "ct-no-such-locale"))
    check("check-translation: missing translation directory exits 2",
          p.returncode == 2 and "translation wiki directory" in p.stderr
          and "Traceback" not in p.stderr, f"rc={p.returncode} {p.stderr.strip()[-200:]}")
    p = cli("check-translation", "--canonical", str(happy_wiki))
    check("check-translation: neither --translation nor --lang exits 2",
          p.returncode == 2 and "one of --translation" in p.stderr,
          f"rc={p.returncode} {p.stderr.strip()[-200:]}")
    p = cli("check-translation", "--canonical", str(happy_wiki),
            "--translation", str(happy_locale), "--lang", "vi")
    check("check-translation: --lang together with --translation exits 2",
          p.returncode == 2 and "not both" in p.stderr, f"rc={p.returncode} {p.stderr.strip()[-200:]}")
    for bad in ("../vi", "locales/vi", "auto"):
        p = cli("check-translation", "--canonical", str(happy_wiki), "--lang", bad)
        check(f"check-translation: CLI rejects --lang {bad!r} with exit 2",
              p.returncode == 2 and "check-translation failed" in p.stderr
              and "Traceback" not in p.stderr, f"rc={p.returncode} {p.stderr.strip()[-160:]}")
    p = cli("check-translation", "--canonical", str(happy_wiki), "--translation", str(happy_locale),
            "--meta", str(pathlib.Path(tmp) / "no-such-meta.json"))
    check("check-translation: unreadable meta exits 2",
          p.returncode == 2 and "translation-meta.json does not exist" in p.stderr,
          f"rc={p.returncode} {p.stderr.strip()[-200:]}")
    bad_meta = pathlib.Path(tmp) / "ct-bad-meta.json"
    bad_meta.write_text("{ not json", encoding="utf-8")
    p = cli("check-translation", "--canonical", str(happy_wiki), "--translation", str(happy_locale),
            "--meta", str(bad_meta))
    check("check-translation: malformed meta JSON exits 2",
          p.returncode == 2 and "is not valid JSON" in p.stderr,
          f"rc={p.returncode} {p.stderr.strip()[-200:]}")
    empty_wiki = pathlib.Path(tmp) / "ct-empty-wiki" / ".dsh-wiki"
    empty_wiki.mkdir(parents=True)
    p = cli("check-translation", "--canonical", str(empty_wiki),
            "--translation", str(happy_locale))
    check("check-translation: canonical wiki.json missing exits 2",
          p.returncode == 2 and "canonical wiki.json does not exist" in p.stderr,
          f"rc={p.returncode} {p.stderr.strip()[-200:]}")

    # --lang 的标签校验必须与共享模块同一套策略（traversal/NUL/绝对路径/非 BCP47/过长）
    for tag in ("../vi", "..", "/abs/vi", "C:\\vi", "vi\x00x", "vi_VN", "vi-", "auto", "",
                "a" * 80):
        problem = B._translation_locale_problem(WT, tag)
        check(f"check-translation: --lang {tag!r} rejected by the module's locale policy",
              problem is not None, str(problem))
    for tag in ("vi", "vi-VN", "VI-vn", "zh-Hans-CN"):
        problem = B._translation_locale_problem(WT, tag)
        check(f"check-translation: --lang {tag!r} accepted", problem is None, str(problem))

    # ---- --lang convenience resolves <canonical>/locales/<tag>
    p, report = ct_json("check-translation", "--canonical", str(happy_wiki), "--lang", "vi", "--json")
    check("check-translation: --lang resolves to <canonical>/locales/<lang> and passes",
          p.returncode == 0 and report and report.get("ok") is True
          and report.get("targetLang") == "vi", f"rc={p.returncode} {p.stderr.strip()[-200:]}")
    check("check-translation: --lang summary prints the resolved translation path",
          str(happy_locale) in p.stderr and "locales" in p.stderr, p.stderr.strip()[-200:])
    p, report = ct_json("check-translation", "--canonical", str(happy_wiki), "--lang", "vi",
                        "--meta", str(happy_locale / "translation-meta.json"), "--json")
    check("check-translation: --lang combined with an explicit --meta",
          p.returncode == 0 and report and report.get("ok") is True,
          f"rc={p.returncode} {p.stderr.strip()[-200:]}")

    # ---- read-only proof: byte + mtime snapshot of the whole repo around two runs
    def ct_snapshot(root):
        state = {}
        for f in sorted(root.rglob("*")):
            if f.is_file():
                st = f.stat()
                state[f.relative_to(root).as_posix()] = (st.st_size, st.st_mtime_ns, f.read_bytes())
        return state

    before = ct_snapshot(happy_repo)
    p_ok = cli("check-translation", "--canonical", str(happy_wiki),
               "--translation", str(happy_locale), "--json")
    p_bad = cli("check-translation", "--canonical", str(happy_wiki),
                "--translation", str(happy_locale), "--meta", str(bad_meta))
    after = ct_snapshot(happy_repo)
    check("check-translation: read-only (repo bytes/mtimes identical after a passing run)",
          p_ok.returncode == 0 and before == after,
          f"rc={p_ok.returncode} changed={sorted(set(before) ^ set(after))[:5]}")
    check("check-translation: read-only even on the failing usage path",
          p_bad.returncode == 2 and ct_snapshot(happy_repo) == before,
          f"rc={p_bad.returncode} changed={sorted(set(before) ^ set(ct_snapshot(happy_repo)))[:5]}")
    check("check-translation: canonical wiki.json and locale snapshot untouched (mtime proof)",
          all(before[k] == after[k] for k in (".dsh-wiki/wiki.json",
                                              ".dsh-wiki/locales/vi/wiki.json",
                                              ".dsh-wiki/locales/vi/translation-meta.json")
              if k in before), str(sorted(before))[:160])

    # ---- delegation proof: the comparison is the module's, not a private reimplementation
    check("check-translation: builder imports the shared module object (identity, not a copy)",
          B._load_translation_module() is WT)
    sentinel = {"schema": WT.REPORT_SCHEMA, "ok": True, "status": "ok",
                "sourceLang": "en", "targetLang": "vi", "counts": {}, "pages": {}, "cards": {},
                "errors": [], "warnings": [], "delegatedSentinel": True}
    calls = []
    orig_check = WT.check_translation

    def _ct_spy(canonical_arg, translated_arg, meta_arg):
        calls.append((canonical_arg, translated_arg, meta_arg))
        return sentinel

    WT.check_translation = _ct_spy
    try:
        got = B.translation_check_report(happy_wiki, happy_locale,
                                         happy_locale / "translation-meta.json")
    finally:
        WT.check_translation = orig_check
    check("check-translation: builder returns the module's report object itself (no local recompute)",
          got is sentinel and len(calls) == 1
          and calls[0][0]["language"] == "en" and calls[0][1]["language"] == "vi"
          and calls[0][2]["targetLang"] == "vi",
          f"calls={len(calls)} same={got is sentinel}")
    bsource = inspect.getsource(B)
    check("check-translation: builder carries no hash/citation implementation of its own",
          not hasattr(B, "canonical_unit_hash") and not hasattr(B, "check_translation")
          and "hashlib" not in bsource and "sha256" not in bsource.lower(),
          f"hashlib={'hashlib' in bsource} sha256={'sha256' in bsource.lower()}")

    # ---- import failure: exit 2 with no report and no weaker local fallback
    iso = pathlib.Path(tmp) / "ct-isolated"
    iso.mkdir()
    shutil.copy(SCRIPT, iso / "build_wiki_site.py")
    p = subprocess.run([sys.executable, str(iso / "build_wiki_site.py"), "check-translation",
                        "--canonical", str(happy_wiki), "--translation", str(happy_locale)],
                       capture_output=True, text=True, cwd=str(iso))
    check("check-translation: module import failure exits 2 and prints no report",
          p.returncode == 2 and "cannot import the shared integrity module" in p.stderr
          and "Traceback" not in p.stderr and p.stdout.strip() == "",
          f"rc={p.returncode} out={p.stdout.strip()[:80]} err={p.stderr.strip()[-160:]}")

    p = cli("check-translation", "--help")
    check("check-translation: --help documents the flags and exits 0",
          p.returncode == 0 and "--canonical" in p.stdout and "--translation" in p.stdout
          and "--lang" in p.stdout and "--meta" in p.stdout and "--json" in p.stdout)

    # ================================================================ spec 007 T022: locales-init
    # locales-init 只派生结构（id/顺序/树/证据原样）并清空可翻译文本；每个单元的
    # sourceContentHash 由共享模块 canonical_unit_hash 计算，builder 自算不实现哈希。
    LI_PAGE_TEXT = ("title", "description", "markdown")
    LI_CARD_TEXT = ("title", "summary")

    def li_repo(name):
        """canonical .dsh-wiki（English，2 pages + 2 cards），尚无 locales/ 目录。"""
        repo = pathlib.Path(tmp) / name
        shutil.rmtree(repo, ignore_errors=True)
        repo.mkdir()
        shutil.copy(FIXTURE / "valid" / "sample.py", repo / "sample.py")
        wiki = repo / ".dsh-wiki"
        wiki.mkdir()
        canonical = ct_canonical(repo)
        canonical["title"] = "Sample repository wiki"
        (wiki / "wiki.json").write_text(
            json.dumps(canonical, ensure_ascii=False, indent=1), encoding="utf-8")
        return repo, wiki, canonical

    def li_calls_exit(fn, *args, **kwargs):
        """In-process 调用：捕获 _ct_fail 的 SystemExit，返回 (结果, 退出码)。"""
        try:
            return fn(*args, **kwargs), None
        except SystemExit as exc:
            return None, exc.code

    def li_files(root):
        return {f.relative_to(root).as_posix(): f.read_bytes()
                for f in root.rglob("*") if f.is_file()}

    def li_leftovers(locales_dir):
        if not locales_dir.is_dir():
            return []
        return sorted(x.name for x in locales_dir.iterdir() if x.name.startswith("."))

    li_repo_a, li_wiki_a, li_canonical_a = li_repo("li-basic")
    p = cli("locales-init", "--canonical", str(li_wiki_a), "--lang", "vi")
    li_dest = li_wiki_a / "locales" / "vi"
    check("locales-init: creates the destination and exits 0",
          p.returncode == 0 and (li_dest / "wiki.json").is_file()
          and (li_dest / "translation-meta.json").is_file()
          and "locales-init: created" in p.stderr and "Traceback" not in p.stderr,
          f"rc={p.returncode} {p.stderr.strip()[-220:]}")
    skeleton = json.loads((li_dest / "wiki.json").read_text(encoding="utf-8"))
    meta = json.loads((li_dest / "translation-meta.json").read_text(encoding="utf-8"))

    def li_struct(item, text_fields):
        return {k: v for k, v in item.items() if k not in text_fields}

    check("locales-init: structure identical to canonical (ids/order/parents/evidence)",
          skeleton.get("schema") == li_canonical_a["schema"]
          and skeleton.get("repoId") == li_canonical_a["repoId"]
          and [x["id"] for x in skeleton["pages"]]
          == [x["id"] for x in li_canonical_a["pages"]]
          and [x["id"] for x in skeleton["cards"]]
          == [x["id"] for x in li_canonical_a["cards"]]
          and all(li_struct(s, LI_PAGE_TEXT) == li_struct(c, LI_PAGE_TEXT)
                  for s, c in zip(skeleton["pages"], li_canonical_a["pages"]))
          and all(li_struct(s, LI_CARD_TEXT) == li_struct(c, LI_CARD_TEXT)
                  for s, c in zip(skeleton["cards"], li_canonical_a["cards"])),
          json.dumps(skeleton, ensure_ascii=False)[:220])
    check("locales-init: translatable text fields are empty, locale is the target tag",
          skeleton.get("title") == "" and skeleton.get("language") == "vi"
          and all(page.get(f) == "" for page in skeleton["pages"] for f in LI_PAGE_TEXT)
          and all(card.get(f) == "" for card in skeleton["cards"] for f in LI_CARD_TEXT),
          json.dumps(skeleton["pages"][0], ensure_ascii=False)[:220])
    check("locales-init: sourceContentHash equals wiki_translations.canonical_unit_hash per unit",
          meta.get("schema") == "repo-wiki-translation-meta/1"
          and meta.get("sourceLang") == "en" and meta.get("targetLang") == "vi"
          and all(meta["pages"][u["id"]]["sourceContentHash"]
                  == WT.canonical_unit_hash("page", u) for u in li_canonical_a["pages"])
          and all(meta["cards"][u["id"]]["sourceContentHash"]
                  == WT.canonical_unit_hash("card", u) for u in li_canonical_a["cards"]),
          json.dumps(meta, ensure_ascii=False)[:220])

    p, report = ct_json("check-translation", "--canonical", str(li_wiki_a),
                        "--lang", "vi", "--json")
    check("locales-init: skeleton loads in check-translation with every unit present",
          p.returncode == 1 and report is not None
          and report.get("status") == "invalid"
          and all(report[k][name] == [] for k in ("pages", "cards")
                  for name in ("missing", "added", "stale", "metaMissing", "metaExtra"))
          and report["counts"]["pages"]["translated"] == 2
          and report["counts"]["cards"]["translated"] == 2,
          f"rc={p.returncode} status={report and report.get('status')} "
          f"pages={report and report['pages']}")

    before_refuse = li_files(li_dest)
    p = cli("locales-init", "--canonical", str(li_wiki_a), "--lang", "vi")
    check("locales-init: existing destination without --force exits 2 and is untouched",
          p.returncode == 2 and "already exists" in p.stderr and "--force" in p.stderr
          and "Traceback" not in p.stderr and li_files(li_dest) == before_refuse,
          f"rc={p.returncode} {p.stderr.strip()[-220:]}")

    (li_dest / "stale-marker.txt").write_text("old destination", encoding="utf-8")
    p = cli("locales-init", "--canonical", str(li_wiki_a), "--lang", "vi",
            "--force", "--json")
    summary = json.loads(p.stdout) if p.stdout.strip() else None
    check("locales-init: --force replaces the destination and prints a JSON summary",
          p.returncode == 0 and "locales-init: replaced" in p.stderr
          and not (li_dest / "stale-marker.txt").exists()
          and isinstance(summary, dict) and summary.get("ok") is True
          and summary.get("replaced") is True and summary.get("lang") == "vi"
          and summary.get("pages") == 2 and summary.get("cards") == 2
          and li_leftovers(li_wiki_a / "locales") == [],
          f"rc={p.returncode} summary={str(summary)[:200]}")

    # ---- all-or-neither: 写 meta 时注入异常，目的地不得留下任何半成品
    _, li_wiki_b, _ = li_repo("li-midwrite")
    orig_write = B._li_write_json

    def li_bad_write(path, data):
        if path.name == "translation-meta.json":
            raise OSError("injected mid-write failure")
        return orig_write(path, data)

    B._li_write_json = li_bad_write
    try:
        _, rc = li_calls_exit(B.locales_init, li_wiki_b, "vi")
    finally:
        B._li_write_json = orig_write
    li_b_dest = li_wiki_b / "locales" / "vi"
    check("locales-init: mid-write failure exits 2 and leaves no partial destination",
          rc == 2 and not li_b_dest.exists()
          and not (li_wiki_b / "locales").exists()
          and li_leftovers(li_wiki_b / "locales") == [],
          f"rc={rc} dest={li_b_dest.exists()} "
          f"locales={(li_wiki_b / 'locales').exists()} "
          f"leftovers={li_leftovers(li_wiki_b / 'locales')}")

    # ---- --force rollback: 最终 rename 注入失败，旧目的地必须原样回来
    _, li_wiki_c, _ = li_repo("li-rollback")
    first = cli("locales-init", "--canonical", str(li_wiki_c), "--lang", "vi")
    li_c_dest = li_wiki_c / "locales" / "vi"
    (li_c_dest / "marker.txt").write_text("previous destination", encoding="utf-8")
    previous = li_files(li_c_dest)
    orig_rename = B._li_rename
    rename_calls = []

    def li_flaky_rename(src, dst):
        rename_calls.append((str(src), str(dst)))
        if len(rename_calls) == 2:
            raise OSError("injected final-rename failure")
        return orig_rename(src, dst)

    B._li_rename = li_flaky_rename
    try:
        _, rc = li_calls_exit(B.locales_init, li_wiki_c, "vi", force=True)
    finally:
        B._li_rename = orig_rename
    check("locales-init: --force rollback restores the previous destination on final-rename failure",
          first.returncode == 0 and rc == 2 and len(rename_calls) == 3
          and li_files(li_c_dest) == previous
          and li_leftovers(li_wiki_c / "locales") == [],
          f"rc={rc} calls={len(rename_calls)} restored={li_files(li_c_dest) == previous} "
          f"leftovers={li_leftovers(li_wiki_c / 'locales')}")

    # ---- read-only proof for the canonical repo (only the new locale appears)
    li_repo_r, li_wiki_r, _ = li_repo("li-readonly")
    li_before = ct_snapshot(li_repo_r)
    p = cli("locales-init", "--canonical", str(li_wiki_r), "--lang", "vi")
    li_after = ct_snapshot(li_repo_r)
    rewritten = [k for k, v in li_before.items() if li_after.get(k) != v]
    added = [k for k in li_after if k not in li_before]
    check("locales-init: canonical repo stays byte/mtime identical (only locales/vi is new)",
          p.returncode == 0 and rewritten == []
          and all(k.startswith(".dsh-wiki/locales/vi/") for k in added),
          f"rc={p.returncode} rewritten={rewritten[:5]} added={added[:5]}")

    # ---- --lang policy: same policy as wiki_translations, rejected before any filesystem write
    _, li_wiki_p, _ = li_repo("li-policy")
    # NUL cannot cross CreateProcess on Windows; exercise it in-process like the
    # check-translation policy test does, and the rest through the real CLI.
    li_bad_tags = ("../vi", "..", "/abs/vi", "C:\\vi", "auto", "", "a" * 80)
    li_rejected = []
    for bad in li_bad_tags:
        p = cli("locales-init", "--canonical", str(li_wiki_p), "--lang", bad)
        if p.returncode != 2 or "locales-init failed" not in p.stderr \
                or "Traceback" in p.stderr:
            li_rejected.append((bad, p.returncode))
    _, li_nul_rc = li_calls_exit(B.locales_init, li_wiki_p, "vi\x00x")
    check("locales-init: --lang policy rejects traversal/absolute/NUL/auto/empty/overlong",
          not li_rejected and li_nul_rc == 2 and not (li_wiki_p / "locales").exists(),
          f"accepted={li_rejected[:3]} nul_rc={li_nul_rc} "
          f"locales_exists={(li_wiki_p / 'locales').exists()}")

    p = cli("locales-init", "--help")
    check("locales-init: --help exits 0 and documents the flags",
          p.returncode == 0 and "--canonical" in p.stdout and "--lang" in p.stdout
          and "--force" in p.stdout and "--json" in p.stdout)

    failed = [n for n, ok in RESULTS if not ok]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} passed" +
          (f"; FAILURES: {failed}" if failed else ""))
    shutil.rmtree(tmp, ignore_errors=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
