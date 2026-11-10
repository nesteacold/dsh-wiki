#!/usr/bin/env python3
"""Unit/CLI tests for wiki_translations.py (spec 007 translation integrity).

Pure standard library, no network/model calls, no repository writes:

    python plugins/dsh-wiki/tests/test_wiki_translations.py

All temporary inputs live in a TemporaryDirectory.  A final ``N/N passed`` line
is printed and the process exits 1 if any check failed.
"""

import copy
import json
import pathlib
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
SCRIPTS = HERE.parent / "scripts"
SCRIPT = SCRIPTS / "wiki_translations.py"
sys.path.insert(0, str(SCRIPTS))

import wiki_translations as wt  # noqa: E402

RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append((name, ok))
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail and not ok else ""))


def eq(name, actual, expected):
    check(name, actual == expected, f"expected {expected!r}, got {actual!r}")


# ------------------------------------------------------------------ fixtures

def make_page(pid, title, markdown, parent=None, order=1, description="Description",
              file_paths=None, sources=None):
    return {
        "id": pid,
        "parentId": parent,
        "order": order,
        "title": title,
        "description": description,
        "filePaths": list(file_paths or []),
        "sources": list(sources or []),
        "markdown": markdown,
    }


def make_card(cid, title, summary, kind="concept", key_files=None, related=None,
              tags=None, page_ids=None):
    return {
        "id": cid,
        "title": title,
        "kind": kind,
        "summary": summary,
        "keyFiles": list(key_files or []),
        "related": list(related or []),
        "tags": list(tags or []),
        "pageIds": list(page_ids or []),
    }


PAGE_ONE_MD = (
    "# Overview\n\nSee `app.py:4`.\n\n"
    "```mermaid\nflowchart TB\n  A-->B\n```\n\n"
    "```python\nprint('x')\n```\n"
)
PAGE_TWO_MD = "# Child\n\nUse `lib/util.py:8-9`.\n\n```text\nplain\n```\n"

PAGE_ONE_VI_MD = (
    "# Tổng quan\n\nXem `app.py:4`.\n\n"
    "```mermaid\nflowchart TB\n  A-->B\n```\n\n"
    "```python\nprint('x')\n```\n"
)
PAGE_TWO_VI_MD = "# Con\n\nDùng `lib/util.py:8-9`.\n\n```text\nplain\n```\n"


def canonical_wiki():
    return {
        "schema": "repo-wiki-local/1",
        "repoId": ".",
        "language": "en",
        "pages": [
            make_page("overview", "Overview", PAGE_ONE_MD,
                      description="Repository overview",
                      file_paths=["app.py"],
                      sources=[{"path": "app.py", "startLine": 4}]),
            make_page("child", "Child", PAGE_TWO_MD, parent="overview", order=2,
                      description="Child page", file_paths=["lib/util.py"]),
        ],
        "cards": [
            make_card("api", "API", "Public API surface.", kind="api",
                      key_files=["app.py:4"], related=["model"],
                      tags=["api", "public"], page_ids=["overview"]),
            make_card("model", "Model", "Data model.", kind="concept",
                      key_files=["lib/util.py:8"], related=["api"],
                      tags=["data"], page_ids=["child"]),
        ],
    }


def translated_wiki():
    return {
        "schema": "repo-wiki-local/1",
        "repoId": ".",
        "language": "vi",
        "pages": [
            make_page("overview", "Tổng quan", PAGE_ONE_VI_MD,
                      description="Tổng quan kho mã",
                      file_paths=["app.py"],
                      sources=[{"path": "app.py", "startLine": 4}]),
            make_page("child", "Con", PAGE_TWO_VI_MD, parent="overview", order=2,
                      description="Trang con", file_paths=["lib/util.py"]),
        ],
        "cards": [
            make_card("api", "Giao diện API", "Bề mặt API công khai.", kind="api",
                      key_files=["app.py:4"], related=["model"],
                      tags=["api", "công khai"], page_ids=["overview"]),
            make_card("model", "Mô hình", "Mô hình dữ liệu.", kind="concept",
                      key_files=["lib/util.py:8"], related=["api"],
                      tags=["dữ liệu"], page_ids=["child"]),
        ],
    }


def meta_for(canonical, source="en", target="vi"):
    return {
        "schema": "repo-wiki-translation-meta/1",
        "sourceLang": source,
        "targetLang": target,
        "pages": {
            page["id"]: {"sourceContentHash": wt.canonical_unit_hash("page", page)}
            for page in canonical.get("pages", [])
        },
        "cards": {
            card["id"]: {"sourceContentHash": wt.canonical_unit_hash("card", card)}
            for card in canonical.get("cards", [])
        },
    }


def valid_triplet():
    canonical = canonical_wiki()
    return canonical, translated_wiki(), meta_for(canonical)


def reasons_text(report, kind, unit_id=None):
    return " | ".join(
        " ".join(entry["reasons"])
        for entry in report[kind]["invalid"]
        if unit_id is None or entry["id"] == unit_id)


def run_cli(*args):
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        capture_output=True, text=True, encoding="utf-8")


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=1), encoding="utf-8")


# ---------------------------------------------------------------------- main

def main():
    tmp = tempfile.TemporaryDirectory(prefix="wiki-translations-tests-")

    # ---- canonical_unit_hash -------------------------------------------
    vector_item = {
        "id": "p1",
        "title": "Title",
        "description": "Desc",
        "filePaths": ["a.py"],
        "sources": [{"path": "a.py", "startLine": 4}],
        "markdown": "# Title\n\nSee `a.py:4`.\n\n```mermaid\nflowchart TB\n A-->B\n```\n",
    }
    vector_hash = "5f79b009e34deef1eed8ffa4ba7eea29dbe864f55a4ceb5edbb5481d8179c2c9"
    eq("hash: fixed SHA-256 vector", wt.canonical_unit_hash("page", vector_item), vector_hash)
    eq("hash: 'pages' and 'page' are synonyms",
       wt.canonical_unit_hash("pages", vector_item), vector_hash)
    reordered = {key: vector_item[key] for key in reversed(list(vector_item))}
    eq("hash: insertion order is irrelevant",
       wt.canonical_unit_hash("page", reordered), vector_hash)
    crlf = copy.deepcopy(vector_item)
    crlf["markdown"] = crlf["markdown"].replace("\n", "\r\n")
    eq("hash: markdown CRLF is normalised to LF",
       wt.canonical_unit_hash("page", crlf), vector_hash)
    minimal = {"id": "p1"}
    expanded = {
        "id": "p1", "parentId": None, "order": None, "title": "", "description": "",
        "filePaths": [], "sources": [], "markdown": "",
    }
    eq("hash: missing optional fields equal explicit empty defaults",
       wt.canonical_unit_hash("page", minimal), wt.canonical_unit_hash("page", expanded))
    bookkeeping = copy.deepcopy(vector_item)
    bookkeeping.update({"sourceContentHash": "x", "sourceCommit": "abc", "stale": True,
                        "_private": "ignored"})
    eq("hash: bookkeeping keys do not change the source hash",
       wt.canonical_unit_hash("page", bookkeeping), vector_hash)
    changed = copy.deepcopy(vector_item)
    changed["x_extra"] = 1
    check("hash: unknown extra fields are covered",
          wt.canonical_unit_hash("page", changed) != vector_hash)
    check("hash: page and card namespaces cannot collide",
          wt.canonical_unit_hash("page", {"id": "x", "title": "T"})
          != wt.canonical_unit_hash("card", {"id": "x", "title": "T"}))

    for field, value in (
            ("parentId", "other"), ("order", 9), ("filePaths", ["b.py"]),
            ("sources", [{"path": "b.py", "startLine": 1}]),
            ("title", "Other"), ("description", "Other"), ("markdown", "# Other")):
        mutated = copy.deepcopy(vector_item)
        mutated[field] = value
        check(f"hash: structural/translatable page field '{field}' is covered",
              wt.canonical_unit_hash("page", mutated) != vector_hash, field)

    card = make_card("c1", "Card", "Summary", tags=["a", "b"],
                     key_files=["a.py:1"], related=["c2"], page_ids=["p1"])
    card_hash = wt.canonical_unit_hash("card", card)
    for field, value in (
            ("title", "Other"), ("summary", "Other"), ("kind", "api"),
            ("keyFiles", ["b.py:2"]), ("related", []), ("tags", ["a"]),
            ("pageIds", [])):
        mutated = copy.deepcopy(card)
        mutated[field] = value
        check(f"hash: card field '{field}' is covered",
              wt.canonical_unit_hash("card", mutated) != card_hash, field)
    check("hash: rejects an unknown unit kind",
          _raises_value_error(lambda: wt.canonical_unit_hash("widget", {"id": "x"})))

    # ---- clean pair -----------------------------------------------------
    canonical, translated, meta = valid_triplet()
    report = wt.check_translation(canonical, translated, meta)
    eq("report: valid pair is ok", report["ok"], True)
    eq("report: valid pair status", report["status"], "ok")
    eq("report: report schema", report["schema"], "repo-wiki-translation-check/1")
    eq("report: page counts", report["counts"]["pages"]["canonical"], 2)
    eq("report: card counts", report["counts"]["cards"]["translated"], 2)
    check("report: every unit list empty when ok",
          all(not report[kind][name]
              for kind in ("pages", "cards")
              for name in ("missing", "stale", "invalid", "added", "metaMissing", "metaExtra")))
    check("report: pages and cards are separate sections",
          set(report["pages"]) == set(report["cards"])
          == {"missing", "stale", "invalid", "added", "metaMissing", "metaExtra"})

    # ---- missing / added / duplicates ----------------------------------
    missing_page = copy.deepcopy(translated)
    missing_page["pages"] = [p for p in missing_page["pages"] if p["id"] != "child"]
    report = wt.check_translation(canonical, missing_page, meta)
    eq("missing: page id detected", report["pages"]["missing"], ["child"])
    eq("missing: cards unaffected", report["cards"]["missing"], [])
    eq("missing: status", report["status"], "missing")
    eq("missing: ok false", report["ok"], False)

    missing_card = copy.deepcopy(translated)
    missing_card["cards"] = [c for c in missing_card["cards"] if c["id"] != "api"]
    report = wt.check_translation(canonical, missing_card, meta)
    eq("missing: card id detected", report["cards"]["missing"], ["api"])
    eq("missing: page lists unaffected", report["pages"]["missing"], [])

    added = copy.deepcopy(translated)
    added["pages"].append({"id": "extra-page"})
    added["cards"].append({"id": "extra-card"})
    report = wt.check_translation(canonical, added, meta)
    eq("added: page id detected", report["pages"]["added"], ["extra-page"])
    eq("added: card id detected", report["cards"]["added"], ["extra-card"])
    eq("added: status invalid", report["status"], "invalid")

    non_object = copy.deepcopy(translated)
    non_object["pages"].append("not-an-object")
    report = wt.check_translation(canonical, non_object, meta)
    check("invalid: non-object translated page is reported",
          any(entry["id"] is None and "not an object" in " ".join(entry["reasons"])
              for entry in report["pages"]["invalid"]), report["pages"]["invalid"])

    duplicate = copy.deepcopy(translated)
    duplicate["pages"].append(copy.deepcopy(duplicate["pages"][0]))
    report = wt.check_translation(canonical, duplicate, meta)
    check("invalid: duplicate translated page id is reported",
          any(entry["id"] == "overview" and "duplicate" in " ".join(entry["reasons"])
              for entry in report["pages"]["invalid"]), report["pages"]["invalid"])

    # Page and card may legally share an id; missing one must not mask the other.
    shared_page = make_page("shared", "Shared", "# Shared\n")
    shared_card = make_card("shared", "Shared card", "Shared summary",
                            key_files=["app.py:1"], page_ids=["shared"])
    shared_canonical = {"schema": "repo-wiki-local/1", "language": "en",
                        "pages": [shared_page], "cards": [shared_card]}
    shared_translated = copy.deepcopy(shared_canonical)
    shared_translated["language"] = "vi"
    shared_translated["cards"] = []
    shared_meta = meta_for(shared_canonical)
    report = wt.check_translation(shared_canonical, shared_translated, shared_meta)
    eq("collision: page 'shared' is not missing", report["pages"]["missing"], [])
    eq("collision: card 'shared' is missing", report["cards"]["missing"], ["shared"])

    shared_valid = copy.deepcopy(shared_canonical)
    shared_valid["language"] = "vi"
    report = wt.check_translation(shared_canonical, shared_valid, shared_meta)
    eq("collision: separate page/card metadata hashes both validate", report["ok"], True)

    # ---- structure ------------------------------------------------------
    page_mutations = {
        "parentId": "elsewhere",
        "order": 99,
        "filePaths": ["other.py"],
        "sources": [{"path": "other.py", "startLine": 2}],
    }
    for field, value in page_mutations.items():
        mutated = copy.deepcopy(translated)
        mutated["pages"][0][field] = value
        report = wt.check_translation(canonical, mutated, meta)
        check(f"structure: page {field} mismatch invalid",
              report["status"] == "invalid" and field in reasons_text(report, "pages", "overview"),
              reasons_text(report, "pages", "overview"))

    card_mutations = {
        "kind": "module",
        "keyFiles": ["other.py:2"],
        "related": [],
        "pageIds": [],
    }
    for field, value in card_mutations.items():
        mutated = copy.deepcopy(translated)
        mutated["cards"][0][field] = value
        report = wt.check_translation(canonical, mutated, meta)
        check(f"structure: card {field} mismatch invalid",
              report["status"] == "invalid" and field in reasons_text(report, "cards", "api"),
              reasons_text(report, "cards", "api"))

    # ---- stale ----------------------------------------------------------
    stale_page = copy.deepcopy(canonical)
    stale_page["pages"][0]["title"] = "Overview v2"
    report = wt.check_translation(stale_page, translated, meta)
    eq("stale: changed page prose marks only that page stale",
       report["pages"]["stale"], ["overview"])
    eq("stale: cards stay fresh when a page changes", report["cards"]["stale"], [])
    eq("stale: status stale", report["status"], "stale")
    eq("stale: ok false", report["ok"], False)

    stale_card = copy.deepcopy(canonical)
    stale_card["cards"][1]["summary"] = "Changed summary."
    report = wt.check_translation(stale_card, translated, meta)
    eq("stale: changed card summary marks that card stale",
       report["cards"]["stale"], ["model"])
    eq("stale: pages stay fresh", report["pages"]["stale"], [])

    structural_only = copy.deepcopy(canonical)
    structural_only["pages"][1]["filePaths"] = ["changed.py"]
    report = wt.check_translation(structural_only, translated, meta)
    check("stale: structural change also changes sourceContentHash",
          "child" in report["pages"]["stale"], report["pages"])

    # ---- metadata -------------------------------------------------------
    no_page_hash = copy.deepcopy(meta)
    del no_page_hash["pages"]["overview"]
    report = wt.check_translation(canonical, translated, no_page_hash)
    eq("metadata: missing page hash detected", report["pages"]["metaMissing"], ["overview"])
    eq("metadata: missing hash status stale", report["status"], "stale")

    no_card_hash = copy.deepcopy(meta)
    del no_card_hash["cards"]["api"]
    report = wt.check_translation(canonical, translated, no_card_hash)
    eq("metadata: missing card hash detected", report["cards"]["metaMissing"], ["api"])

    extra_meta = copy.deepcopy(meta)
    extra_meta["pages"]["ghost"] = {"sourceContentHash": "0" * 64}
    report = wt.check_translation(canonical, translated, extra_meta)
    eq("metadata: extra page id detected", report["pages"]["metaExtra"], ["ghost"])
    eq("metadata: extra id status invalid", report["status"], "invalid")

    extra_card_meta = copy.deepcopy(meta)
    extra_card_meta["cards"]["ghost-card"] = {"sourceContentHash": "0" * 64}
    report = wt.check_translation(canonical, translated, extra_card_meta)
    eq("metadata: extra card id detected", report["cards"]["metaExtra"], ["ghost-card"])

    bad_hash = copy.deepcopy(meta)
    bad_hash["pages"]["overview"] = {"sourceContentHash": "abc"}
    report = wt.check_translation(canonical, translated, bad_hash)
    check("metadata: malformed hash is invalid",
          "64-character" in reasons_text(report, "pages", "overview"),
          reasons_text(report, "pages", "overview"))

    string_hash = copy.deepcopy(meta)
    string_hash["pages"] = {
        page["id"]: wt.canonical_unit_hash("page", page)
        for page in canonical["pages"]
    }
    report = wt.check_translation(canonical, translated, string_hash)
    eq("metadata: plain-string hash values are accepted", report["ok"], True)

    legacy = copy.deepcopy(meta)
    legacy["items"] = {}
    legacy["items"].update(legacy.pop("pages"))
    legacy["items"].update(legacy.pop("cards"))
    report = wt.check_translation(canonical, translated, legacy)
    check("metadata: legacy flat 'items' still validates",
          report["ok"] is True and any("legacy" in warning for warning in report["warnings"]),
          report["warnings"])

    missing_mapping = {"sourceLang": "en", "targetLang": "vi"}
    report = wt.check_translation(canonical, translated, missing_mapping)
    eq("metadata: missing pages mapping is an error", report["status"], "error")
    check("metadata: missing mapping is named",
          any("pages" in error for error in report["errors"]), report["errors"])

    # ---- code fences / diagrams ----------------------------------------
    changed_mermaid = copy.deepcopy(translated)
    changed_mermaid["pages"][0]["markdown"] = PAGE_ONE_VI_MD.replace("A-->B", "A-->C")
    report = wt.check_translation(canonical, changed_mermaid, meta)
    check("fences: changed mermaid block invalid",
          "mermaid" in reasons_text(report, "pages", "overview"),
          reasons_text(report, "pages", "overview"))

    changed_code = copy.deepcopy(translated)
    changed_code["pages"][0]["markdown"] = PAGE_ONE_VI_MD.replace("print('x')", "print('y')")
    report = wt.check_translation(canonical, changed_code, meta)
    check("fences: changed code block invalid",
          "code fence" in reasons_text(report, "pages", "overview"),
          reasons_text(report, "pages", "overview"))

    extra_fence = copy.deepcopy(translated)
    extra_fence["pages"][0]["markdown"] += "\n```text\nextra\n```\n"
    report = wt.check_translation(canonical, extra_fence, meta)
    check("fences: fence count mismatch invalid",
          "code fences changed" in reasons_text(report, "pages", "overview"),
          reasons_text(report, "pages", "overview"))

    changed_language = copy.deepcopy(translated)
    changed_language["pages"][0]["markdown"] = PAGE_ONE_VI_MD.replace(
        "```mermaid", "```text")
    report = wt.check_translation(canonical, changed_language, meta)
    check("fences: mermaid info string is preserved",
          "info changed" in reasons_text(report, "pages", "overview"),
          reasons_text(report, "pages", "overview"))

    # ---- path:line citations -------------------------------------------
    removed_citation = copy.deepcopy(translated)
    removed_citation["pages"][0]["markdown"] = PAGE_ONE_VI_MD.replace(
        "`app.py:4`", "`app.py`")
    report = wt.check_translation(canonical, removed_citation, meta)
    check("citations: removed path:line citation invalid",
          "path:line citations changed" in reasons_text(report, "pages", "overview"),
          reasons_text(report, "pages", "overview"))

    added_citation = copy.deepcopy(translated)
    added_citation["pages"][0]["markdown"] = PAGE_ONE_VI_MD.replace(
        "`app.py:4`", "`app.py:4` and `app.py:8`")
    report = wt.check_translation(canonical, added_citation, meta)
    check("citations: added path:line citation invalid",
          "added" in reasons_text(report, "pages", "overview"),
          reasons_text(report, "pages", "overview"))

    changed_range = copy.deepcopy(translated)
    changed_range["pages"][1]["markdown"] = PAGE_TWO_VI_MD.replace(
        "`lib/util.py:8-9`", "`lib/util.py:8`")
    report = wt.check_translation(canonical, changed_range, meta)
    check("citations: changed line range invalid",
          "citations" in reasons_text(report, "pages", "child"),
          reasons_text(report, "pages", "child"))

    # ---- empty translatable fields -------------------------------------
    empty_markdown = copy.deepcopy(translated)
    empty_markdown["pages"][0]["markdown"] = ""
    report = wt.check_translation(canonical, empty_markdown, meta)
    check("invalid: empty translated markdown",
          "translated markdown is empty" in reasons_text(report, "pages", "overview"),
          reasons_text(report, "pages", "overview"))

    empty_title = copy.deepcopy(translated)
    empty_title["cards"][0]["title"] = ""
    report = wt.check_translation(canonical, empty_title, meta)
    check("invalid: empty translated card title",
          "translated title is empty" in reasons_text(report, "cards", "api"),
          reasons_text(report, "cards", "api"))

    empty_summary = copy.deepcopy(translated)
    empty_summary["cards"][0]["summary"] = "   "
    report = wt.check_translation(canonical, empty_summary, meta)
    check("invalid: whitespace-only translated summary",
          "translated summary is empty" in reasons_text(report, "cards", "api"),
          reasons_text(report, "cards", "api"))

    # ---- locales / language contract ------------------------------------
    wrong_canonical_lang = copy.deepcopy(canonical)
    wrong_canonical_lang["language"] = "zh-CN"
    report = wt.check_translation(wrong_canonical_lang, translated, meta)
    eq("locale: non-English canonical wiki is an error", report["status"], "error")
    check("locale: non-English canonical error is explicit",
          any("must be English" in error for error in report["errors"]), report["errors"])

    en_variant = copy.deepcopy(canonical)
    en_variant["language"] = "en-US"
    report = wt.check_translation(en_variant, translated, meta_for(en_variant, source="en-US"))
    eq("locale: en-* canonical variant accepted", report["ok"], True)

    wrong_source = copy.deepcopy(meta)
    wrong_source["sourceLang"] = "vi"
    report = wt.check_translation(canonical, translated, wrong_source)
    eq("locale: wrong sourceLang is an error", report["status"], "error")
    check("locale: wrong sourceLang is named",
          any("sourceLang" in error for error in report["errors"]), report["errors"])

    wrong_translated_lang = copy.deepcopy(translated)
    wrong_translated_lang["language"] = "zh-CN"
    report = wt.check_translation(canonical, wrong_translated_lang, meta)
    check("locale: translated language must match targetLang",
          any("does not match" in error for error in report["errors"]), report["errors"])

    same_lang = copy.deepcopy(meta)
    same_lang["targetLang"] = "en"
    report = wt.check_translation(canonical, translated, same_lang)
    check("locale: targetLang equal to sourceLang rejected",
          any("must differ" in error for error in report["errors"]), report["errors"])

    for bad_locale in ("../../etc", "vi/../en", "vi\\x", "..", "en_US",
                       "vietnamese!", "vi--x", "zh-CN-", "vi\x00"):
        bad_meta = copy.deepcopy(meta)
        bad_meta["targetLang"] = bad_locale
        report = wt.check_translation(canonical, translated, bad_meta)
        check(f"locale: traversal/invalid targetLang {bad_locale!r} rejected",
              report["status"] == "error"
              and any("targetLang" in error for error in report["errors"]),
              report["errors"])

    missing_source = copy.deepcopy(meta)
    del missing_source["sourceLang"]
    report = wt.check_translation(canonical, translated, missing_source)
    check("locale: missing sourceLang rejected",
          any("sourceLang is missing" in error for error in report["errors"]),
          report["errors"])

    missing_target = copy.deepcopy(meta)
    del missing_target["targetLang"]
    report = wt.check_translation(canonical, translated, missing_target)
    check("locale: missing targetLang rejected",
          any("targetLang is missing" in error for error in report["errors"]),
          report["errors"])

    missing_translated_lang = copy.deepcopy(translated)
    del missing_translated_lang["language"]
    report = wt.check_translation(canonical, missing_translated_lang, meta)
    check("locale: missing translated language rejected",
          any("translated.language is missing" in error for error in report["errors"]),
          report["errors"])

    no_canonical_language = copy.deepcopy(canonical)
    del no_canonical_language["language"]
    report = wt.check_translation(no_canonical_language, translated, meta)
    check("locale: missing canonical language warns and assumes en",
          report["ok"] is True and any("assumed 'en'" in warning
                                       for warning in report["warnings"]),
          report["warnings"])

    schema_mismatch = copy.deepcopy(translated)
    schema_mismatch["schema"] = "repo-wiki-local/2"
    report = wt.check_translation(canonical, schema_mismatch, meta)
    check("schema: mismatch is an error",
          any("schema differs" in error for error in report["errors"]), report["errors"])

    # ---- malformed inputs never crash ----------------------------------
    for name, args in (
            ("canonical is None", (None, translated, meta)),
            ("translated is a list", (canonical, [], meta)),
            ("meta is None", (canonical, translated, None)),
            ("all inputs missing", (None, None, None))):
        report = wt.check_translation(*args)
        check(f"malformed: {name} returns an error report without raising",
              report["status"] == "error" and report["ok"] is False
              and bool(report["errors"]), report)

    pages_not_array = copy.deepcopy(canonical)
    pages_not_array["pages"] = {"not": "an array"}
    report = wt.check_translation(pages_not_array, translated, meta)
    check("malformed: canonical.pages not an array is an error",
          report["status"] == "error"
          and any("must be an array" in error for error in report["errors"]),
          report["errors"])

    translated_pages_not_array = copy.deepcopy(translated)
    translated_pages_not_array["pages"] = {"not": "an array"}
    report = wt.check_translation(canonical, translated_pages_not_array, meta)
    check("malformed: translated.pages not an array is invalid",
          report["status"] == "invalid"
          and any(entry["id"] is None for entry in report["pages"]["invalid"]),
          report["pages"]["invalid"])

    # ---- determinism ---------------------------------------------------
    report_one = wt.check_translation(canonical, translated, meta)
    report_two = wt.check_translation(copy.deepcopy(canonical),
                                      copy.deepcopy(translated),
                                      copy.deepcopy(meta))
    eq("determinism: identical inputs produce identical reports",
       json.dumps(report_one, ensure_ascii=False, sort_keys=True),
       json.dumps(report_two, ensure_ascii=False, sort_keys=True))

    # ---- CLI -----------------------------------------------------------
    base = pathlib.Path(tmp.name)
    canonical_path = base / "wiki.json"
    translation_path = base / "vi-wiki.json"
    meta_path = base / "translation-meta.json"
    write_json(canonical_path, canonical)
    write_json(translation_path, translated)
    write_json(meta_path, meta)

    proc = run_cli("--canonical", str(canonical_path),
                   "--translation", str(translation_path),
                   "--meta", str(meta_path))
    try:
        cli_report = json.loads(proc.stdout)
    except ValueError:
        cli_report = {}
    check("cli: valid snapshot exits 0 and prints a JSON report",
          proc.returncode == 0 and cli_report.get("ok") is True,
          (proc.stdout + proc.stderr)[-300:])

    write_json(canonical_path, stale_page)
    proc = run_cli("--canonical", str(canonical_path),
                   "--translation", str(translation_path),
                   "--meta", str(meta_path))
    try:
        cli_report = json.loads(proc.stdout)
    except ValueError:
        cli_report = {}
    check("cli: stale snapshot exits 1 with status stale",
          proc.returncode == 1 and cli_report.get("status") == "stale",
          (proc.stdout + proc.stderr)[-300:])

    invalid_translation = copy.deepcopy(translated)
    invalid_translation["pages"][0]["parentId"] = "elsewhere"
    write_json(canonical_path, canonical)
    write_json(translation_path, invalid_translation)
    proc = run_cli("--canonical", str(canonical_path),
                   "--translation", str(translation_path),
                   "--meta", str(meta_path))
    try:
        cli_report = json.loads(proc.stdout)
    except ValueError:
        cli_report = {}
    check("cli: invalid structure exits 1 with status invalid",
          proc.returncode == 1 and cli_report.get("status") == "invalid",
          (proc.stdout + proc.stderr)[-300:])

    missing_file = base / "does-not-exist.json"
    proc = run_cli("--canonical", str(missing_file),
                   "--translation", str(translation_path),
                   "--meta", str(meta_path))
    try:
        cli_report = json.loads(proc.stdout)
    except ValueError:
        cli_report = {}
    check("cli: unreadable input exits 1 and still emits a JSON error report",
          proc.returncode == 1 and cli_report.get("status") == "error"
          and any("does not exist" in error for error in cli_report.get("errors", [])),
          (proc.stdout + proc.stderr)[-300:])

    proc = run_cli("--canonical", str(canonical_path))
    eq("cli: missing required arguments uses argparse exit 2", proc.returncode, 2)

    failed = [name for name, ok in RESULTS if not ok]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} passed" +
          (f"; FAILURES: {failed}" if failed else ""))
    tmp.cleanup()
    return 1 if failed else 0


def _raises_value_error(fn):
    try:
        fn()
    except ValueError:
        return True
    return False


if __name__ == "__main__":
    sys.exit(main())
