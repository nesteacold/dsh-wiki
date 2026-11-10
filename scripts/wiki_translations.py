#!/usr/bin/env python3
"""Translation integrity checker for the dsh-wiki English-canonical pipeline (spec 007).

The canonical wiki (``.dsh-wiki/wiki.json``, English) is the source of structure,
``path:line`` evidence and knowledge cards.  A translation snapshot
(``.dsh-wiki/locales/<lang>/wiki.json``) must keep every page/card identity,
tree edge, evidence list and diagram while translating prose only.

This module is pure standard library, makes no network/model calls, reads and
writes nothing except when the CLI is invoked, and is safe to import from the
builder or Host tooling.

Primary API
-----------

``check_translation(canonical: dict, translated: dict, meta: dict) -> dict``
    Pure function.  Never raises for malformed JSON-shaped input; it returns a
    deterministic machine report.  ``canonical`` and ``translated`` are decoded
    ``wiki.json`` objects, ``meta`` is a decoded ``translation-meta.json``.

``canonical_unit_hash(kind, item) -> str``
    SHA-256 hex digest of one canonical unit.  ``kind`` is ``"page"``/``"pages"``
    or ``"card"``/``"cards"``.  The hash covers *all* translatable and structural
    fields, not just prose::

        page: id, parentId, order, title, description, filePaths, sources, markdown
        card: id, title, kind, summary, keyFiles, related, tags, pageIds

    plus any unknown extra field on the item.  Bookkeeping keys
    (``sourceContentHash``, ``sourceCommit``, ``stale``) and keys starting with
    ``_`` are excluded so provenance can be added without changing the source
    hash.  Optional fields are normalised to the builder's semantics: missing
    ``parentId``/``order`` become ``null``, missing/empty list fields become
    ``[]``, missing text becomes ``""``, and markdown line endings are
    normalised to LF.  The payload is deterministic JSON
    (``sort_keys=True``, fixed separators, UTF-8, no ASCII escaping), wrapped as
    ``{"unitKind": ..., "fields": {...}}`` so a page and a card can never share
    a hash merely because their field names overlap.

    Translation metadata must store this function's output as
    ``sourceContentHash``; a prose-only digest is deliberately not accepted.

Metadata schema (``translation-meta.json``)
-------------------------------------------

::

    {
      "schema": "repo-wiki-translation-meta/1",   # optional
      "sourceLang": "en",
      "targetLang": "vi",
      "sourceCommit": "<git sha>",                # optional
      "model": {"provider": "...", "model": "..."},  # optional
      "pages": {"<page id>": {"sourceContentHash": "<64 hex>"}, ...},
      "cards": {"<card id>": {"sourceContentHash": "<64 hex>"}, ...}
    }

``pages``/``cards`` are separate key spaces on purpose: a page id and a card id
may legally be equal, and their hashes must not collide.  A mapping value may
also be the hash string itself.  For backward compatibility a flat legacy
``items`` object is accepted when a per-kind mapping is absent; this is reported
as a warning and cannot distinguish a page/card id collision.

Report shape (``schema = repo-wiki-translation-check/1``)
---------------------------------------------------------

::

    {
      "schema": "repo-wiki-translation-check/1",
      "ok": false,
      "status": "invalid",          # ok | missing | stale | invalid | error
      "sourceLang": "en",
      "targetLang": "vi",
      "counts": {
        "pages": {"canonical": 2, "translated": 2, "missing": 0, "stale": 0,
                  "invalid": 1, "added": 0, "metaMissing": 0, "metaExtra": 0},
        "cards": {...},
        "errors": 0,
        "warnings": 0
      },
      "pages": {
        "missing": ["id"],          # canonical id absent from translation
        "stale": ["id"],            # sourceContentHash differs from canonical
        "invalid": [{"id": "id", "index": 3, "reasons": ["..."]}],
        "added": ["id"],            # translation id absent from canonical
        "metaMissing": ["id"],      # canonical id has no metadata hash
        "metaExtra": ["id"]         # metadata id absent from canonical
      },
      "cards": { ...same keys... },
      "errors": ["..."],            # configuration/input errors (status=error)
      "warnings": ["..."]
    }

``ok`` is true only when every list above is empty.  ``status`` is the most
severe outcome: ``error`` (input/config could not be evaluated), ``invalid``
(structure/content/metadata mismatch or added/extra ids), ``missing``,
``stale`` (including a missing metadata hash), then ``ok``.  ``index`` is the
index in the translation array when a translated unit exists, otherwise the
canonical array index; it is ``null`` for entries that are not objects.

Checks performed
----------------

* exact page/card ids; duplicate ids are invalid.
* exact ``parentId``, ``order``, ``filePaths``, ``sources`` (pages) and
  ``kind``, ``keyFiles``, ``related``, ``pageIds`` (cards).
* translated ``title``/``description``/``markdown`` (pages) and
  ``title``/``summary`` (cards) are non-empty where the canonical text is
  non-empty.
* every fenced code block, including ``mermaid``, is unchanged (info string,
  body and closing fence) and in the same order.
* the multiset of backticked ``path:line`` / ``path:start-end`` citations is
  unchanged (the builder's citation syntax).
* metadata ``sourceLang``/``targetLang`` are valid BCP47-ish locales (ASCII
  only, no ``..``, ``/``, ``\\``, NUL or other traversal material), match the
  canonical/translated ``language`` fields, and are not equal to each other.
* canonical language is English (``en`` or an ``en-*`` variant).
* schema is identical between canonical and translation when either is present.
* removed/added ids are detected across canonical, translation and metadata.

CLI
---

::

    python scripts/wiki_translations.py \
        --canonical .dsh-wiki/wiki.json \
        --translation .dsh-wiki/locales/vi/wiki.json \
        --meta .dsh-wiki/locales/vi/translation-meta.json

The report is printed to stdout as ASCII-safe, key-sorted JSON.  Exit status:

* ``0`` — report ``ok`` (no errors, missing, stale or invalid units).
* ``1`` — report is not ok (invalid/missing/stale/error), including unreadable
  or malformed JSON input (a report with ``status: "error"`` is still emitted).
* ``2`` — argparse usage error (missing required arguments).

No model calls, network access, credentials or repository writes occur.
"""

from __future__ import annotations

import argparse
import collections
import hashlib
import json
import re
import sys
from pathlib import Path

REPORT_SCHEMA = "repo-wiki-translation-check/1"

__all__ = ["REPORT_SCHEMA", "canonical_unit_hash", "check_translation"]

_PAGE_STRUCT_FIELDS = ("parentId", "order", "filePaths", "sources")
_CARD_STRUCT_FIELDS = ("kind", "keyFiles", "related", "pageIds")
_PAGE_TEXT_FIELDS = ("title", "description", "markdown")
_CARD_TEXT_FIELDS = ("title", "summary")

# Bookkeeping/provenance is not part of the canonical source hash.
_IGNORED_ITEM_KEYS = frozenset({"sourceContentHash", "sourceCommit", "stale"})

# Same BCP47-ish pattern as build_wiki_site.py, plus explicit traversal guards.
_LOCALE_RE = re.compile(r"^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$")
_LOCALE_MAX = 64
_HEX64_RE = re.compile(r"^[0-9a-fA-F]{64}$")

# Same citation syntax/syntax whitelist as build_wiki_site.py's _REF_RE.
_REF_EXTS = ("ts|tsx|js|jsx|cjs|mjs|json|md|wxml|py|go|rs|swift|kt|java|vue|yml|yaml|toml"
             "|cpp|cc|hpp|hxx|cs|css|scss|less|html|htm|xml|sql|rb|php|lua|dart|mm|pl"
             "|sh|bash|zsh|c|h|m|txt|ini|cfg|conf|env|properties|gradle|proto|graphql|tf")
_CITATION_RE = re.compile(
    r"`([A-Za-z0-9._\-/]+\.(?:" + _REF_EXTS + r")):(\d+)(?:-(\d+))?`", re.I)

_FENCE_OPEN_RE = re.compile(r"^[ \t]{0,3}(`{3,}|~{3,})(.*)$")
_FENCE_CLOSE_RE = re.compile(r"^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$")


# --------------------------------------------------------------------- helpers

def _kind_key(kind: str) -> str:
    """Normalise ``page``/``pages``/``card``/``cards`` to a singular kind."""
    if kind in ("page", "pages"):
        return "page"
    if kind in ("card", "cards"):
        return "card"
    raise ValueError(f"unknown unit kind {kind!r}; expected page/pages or card/cards")


def _clean_text(value) -> str:
    """Coerce to text and repair lone surrogates/NUL like the builder's _clean_text."""
    text = value if isinstance(value, str) else ("" if value is None else str(value))
    text = text.replace("\x00", "")
    try:
        return text.encode("utf-8", "surrogatepass").decode("utf-8", "replace")
    except UnicodeDecodeError:
        return text.encode("utf-8", "replace").decode("utf-8", "replace")


def _norm_newlines(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n")


def _as_text_list(value) -> list:
    """Builder-compatible list coercion (string -> [string], non-strings -> [])."""
    if isinstance(value, str):
        return [_clean_text(value)]
    if isinstance(value, list):
        return [_clean_text(item) for item in value if item is not None]
    return []


def _as_sources(value) -> list:
    """Builder-compatible sources coercion; keeps evidence fields verbatim."""
    items = [value] if isinstance(value, dict) else (value if isinstance(value, list) else [])
    out = []
    for source in items:
        if isinstance(source, dict):
            out.append(_jsonable(source))
        elif isinstance(source, str):
            out.append({"path": _clean_text(source)})
        else:
            out.append(_jsonable(source))
    return out


def _jsonable(value):
    """Recursively make a value deterministic-JSON-safe (no sets/tuples/odd keys)."""
    if isinstance(value, dict):
        return {(_clean_text(key) if isinstance(key, str) else str(key)): _jsonable(val)
                for key, val in sorted(value.items(), key=lambda kv: str(kv[0]))}
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    if isinstance(value, (set, frozenset)):
        return [_jsonable(item) for item in sorted(
            value,
            key=lambda item: json.dumps(_jsonable(item), ensure_ascii=False,
                                        sort_keys=True, separators=(",", ":")))]
    if isinstance(value, str):
        return _clean_text(value)
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    return _clean_text(str(value))


def _json_dumps(value) -> str:
    """Deterministic JSON used by both the hash and report equality checks."""
    return json.dumps(_jsonable(value), ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"))


def _values_equal(left, right) -> bool:
    return _json_dumps(left) == _json_dumps(right)


def _short(value, limit: int = 180) -> str:
    text = _json_dumps(value)
    return text if len(text) <= limit else text[:limit - 3] + "..."


def _card_kind(item: dict) -> str:
    """Missing/empty card kind behaves like the builder's ``concept`` default."""
    value = item.get("kind")
    if value is None or value == "":
        return "concept"
    return _clean_text(value)


def _parent_id(item: dict):
    value = item.get("parentId")
    return None if value is None or value == "" else _jsonable(value)


def _canonical_unit(kind: str, item: dict) -> dict:
    """All translatable + structural fields of one unit, with builder defaults."""
    if not isinstance(item, dict):
        raise TypeError("item must be a dict")
    if kind == "page":
        fields = {
            "id": _clean_text(item.get("id")),
            "parentId": _parent_id(item),
            "order": _jsonable(item.get("order")),
            "title": _clean_text(item.get("title")),
            "description": _clean_text(item.get("description")),
            "filePaths": _as_text_list(item.get("filePaths")),
            "sources": _as_sources(item.get("sources")),
            "markdown": _norm_newlines(_clean_text(item.get("markdown"))),
        }
    else:
        fields = {
            "id": _clean_text(item.get("id")),
            "title": _clean_text(item.get("title")),
            "kind": _card_kind(item),
            "summary": _clean_text(item.get("summary")),
            "keyFiles": _as_text_list(item.get("keyFiles")),
            "related": _as_text_list(item.get("related")),
            "tags": _as_text_list(item.get("tags")),
            "pageIds": _as_text_list(item.get("pageIds")),
        }
    known = set(fields)
    for key, value in item.items():
        key_text = key if isinstance(key, str) else str(key)
        if key_text in known or key_text in _IGNORED_ITEM_KEYS or key_text.startswith("_"):
            continue
        fields[key_text] = _jsonable(value)
    return fields


def canonical_unit_hash(kind: str, item: dict) -> str:
    """Return the deterministic SHA-256 source hash for one canonical unit.

    ``kind`` accepts ``page``/``pages``/``card``/``cards``.  The hash covers
    every translatable and structural field (see module docstring) and is
    namespaced by unit kind so page/card field overlap cannot collide.
    """
    kind_key = _kind_key(kind)
    payload = {"unitKind": kind_key, "fields": _canonical_unit(kind_key, item)}
    blob = _json_dumps(payload).encode("utf-8")
    return hashlib.sha256(blob).hexdigest()


# ------------------------------------------------------------------ structure

def _struct_value(kind: str, field: str, item: dict):
    if kind == "page":
        if field == "parentId":
            return _parent_id(item)
        if field == "order":
            return _jsonable(item.get("order"))
        if field == "filePaths":
            return _as_text_list(item.get("filePaths"))
        if field == "sources":
            return _as_sources(item.get("sources"))
    else:
        if field == "kind":
            return _card_kind(item)
        if field == "keyFiles":
            return _as_text_list(item.get("keyFiles"))
        if field == "related":
            return _as_text_list(item.get("related"))
        if field == "pageIds":
            return _as_text_list(item.get("pageIds"))
    raise KeyError(f"unknown {kind} structural field {field!r}")


def _check_structure(kind: str, canonical: dict, translated: dict, reasons: list) -> None:
    fields = _PAGE_STRUCT_FIELDS if kind == "page" else _CARD_STRUCT_FIELDS
    for field in fields:
        expected = _struct_value(kind, field, canonical)
        actual = _struct_value(kind, field, translated)
        if not _values_equal(expected, actual):
            reasons.append(
                f"{field} differs: canonical {_short(expected)}, translation {_short(actual)}")


def _extract_code_fences(markdown: str) -> list:
    """Parse CommonMark-ish fenced blocks (```/~~~) as (info, body, closed)."""
    lines = _norm_newlines(markdown).split("\n")
    fences = []
    index = 0
    while index < len(lines):
        match = _FENCE_OPEN_RE.match(lines[index])
        if not match:
            index += 1
            continue
        marker = match.group(1)
        info = match.group(2).strip()
        if marker[0] == "`" and "`" in info:
            # A backtick fence's info string cannot contain backticks.
            index += 1
            continue
        body = []
        cursor = index + 1
        closed = False
        while cursor < len(lines):
            close = _FENCE_CLOSE_RE.match(lines[cursor])
            if close and close.group(1)[0] == marker[0] \
                    and len(close.group(1)) >= len(marker):
                closed = True
                break
            body.append(lines[cursor])
            cursor += 1
        fences.append({"info": info, "body": "\n".join(body), "closed": closed})
        index = cursor + 1 if closed else cursor
    return fences


def _extract_citations(markdown: str) -> list:
    return [match.group(0) for match in _CITATION_RE.finditer(_norm_newlines(markdown))]


def _fmt_examples(items: list, limit: int = 5) -> str:
    shown = ", ".join(f"`{item}`" for item in items[:limit])
    if len(items) > limit:
        shown += ", ..."
    return shown


def _check_fences(canonical_md: str, translated_md: str, reasons: list) -> None:
    canonical_fences = _extract_code_fences(canonical_md)
    translated_fences = _extract_code_fences(translated_md)
    if len(canonical_fences) != len(translated_fences):
        reasons.append(
            f"code fences changed: canonical has {len(canonical_fences)}, "
            f"translation has {len(translated_fences)}")
    for number, (expected, actual) in enumerate(
            zip(canonical_fences, translated_fences), 1):
        expected_info = expected["info"]
        actual_info = actual["info"]
        if expected_info != actual_info:
            reasons.append(
                f"code fence #{number} info changed: {expected_info!r} -> {actual_info!r}")
        if expected["body"] != actual["body"]:
            if expected_info.casefold().startswith("mermaid") \
                    or actual_info.casefold().startswith("mermaid"):
                reasons.append(f"mermaid block #{number} changed")
            else:
                reasons.append(f"code fence #{number} content changed")
        if expected["closed"] != actual["closed"]:
            reasons.append(f"code fence #{number} closing fence changed")


def _check_citations(canonical_md: str, translated_md: str, reasons: list) -> None:
    expected = collections.Counter(_extract_citations(canonical_md))
    actual = collections.Counter(_extract_citations(translated_md))
    missing = sorted((expected - actual).elements())
    extra = sorted((actual - expected).elements())
    if not missing and not extra:
        return
    parts = []
    if missing:
        parts.append(f"missing {len(missing)} ({_fmt_examples(missing)})")
    if extra:
        parts.append(f"added {len(extra)} ({_fmt_examples(extra)})")
    reasons.append("path:line citations changed: " + "; ".join(parts))


def _check_unit(kind: str, canonical: dict, translated: dict) -> list:
    reasons = []
    _check_structure(kind, canonical, translated, reasons)
    text_fields = _PAGE_TEXT_FIELDS if kind == "page" else _CARD_TEXT_FIELDS
    for field in text_fields:
        expected = _clean_text(canonical.get(field))
        actual = _clean_text(translated.get(field))
        if expected.strip() and not actual.strip():
            reasons.append(f"translated {field} is empty (canonical {field} has text)")
    if kind == "page":
        canonical_md = _clean_text(canonical.get("markdown"))
        translated_md = _clean_text(translated.get("markdown"))
        _check_fences(canonical_md, translated_md, reasons)
        _check_citations(canonical_md, translated_md, reasons)
    return reasons


# ------------------------------------------------------------------- metadata

def _locale_problem(value, label: str):
    if not isinstance(value, str):
        return f"{label} must be a string"
    if not value:
        return f"{label} is empty"
    if len(value) > _LOCALE_MAX:
        return f"{label} is too long ({len(value)} > {_LOCALE_MAX} chars)"
    if ".." in value or "/" in value or "\\" in value or "\x00" in value:
        return f"{label} contains path traversal characters: {value!r}"
    if not _LOCALE_RE.fullmatch(value):
        return f"{label} is not a BCP47-ish locale: {value!r}"
    return None


def _is_english(locale: str) -> bool:
    return locale.split("-", 1)[0].casefold() == "en"


def _checked_locale(value, label: str, errors: list):
    problem = _locale_problem(value, label)
    if problem:
        errors.append(problem)
        return None
    return value


def _recorded_hash(value):
    if isinstance(value, str):
        return value, None
    if isinstance(value, dict):
        recorded = value.get("sourceContentHash")
        if isinstance(recorded, str):
            return recorded, None
        return None, "metadata entry is missing a string sourceContentHash"
    return None, "metadata entry must be a sourceContentHash string or object"


def _meta_map(meta: dict, key: str, errors: list, warnings: list, required: bool):
    """Return ``(mapping, legacy_used)``; ``(None, False)`` means unusable/absent."""
    if key in meta:
        value = meta[key]
        if not isinstance(value, dict):
            errors.append(f"metadata.{key} must be an object mapping id -> sourceContentHash")
            return None, False
        legacy_items = meta.get("items")
        if isinstance(legacy_items, dict) and legacy_items:
            warnings.append(
                f"metadata.{key} takes precedence over the legacy flat 'items' object")
        elif legacy_items is not None and not isinstance(legacy_items, dict):
            warnings.append("metadata.items is not an object; ignored")
        return {str(item_id): item for item_id, item in value.items()}, False
    legacy_items = meta.get("items")
    if legacy_items is None:
        if required:
            errors.append(f"metadata is missing the '{key}' mapping")
            return None, False
        return {}, False
    if not isinstance(legacy_items, dict):
        errors.append("metadata.items must be an object mapping id -> sourceContentHash")
        return None, False
    warnings.append(
        f"metadata.{key} missing; using legacy flat 'items' "
        "(page/card id collisions cannot be distinguished)")
    return {str(item_id): item for item_id, item in legacy_items.items()}, True


def _meta_status(kind_key: str, item_id: str, canonical: dict, meta_map):
    """Return (stale, meta_missing, reason) for one canonical unit."""
    if meta_map is None:
        return False, False, None
    if item_id not in meta_map:
        return False, True, None
    recorded, problem = _recorded_hash(meta_map[item_id])
    if problem:
        return False, False, problem
    if not _HEX64_RE.fullmatch(recorded):
        return False, False, "metadata sourceContentHash is not a 64-character hex SHA-256"
    expected = canonical_unit_hash(kind_key, canonical)
    if recorded.casefold() != expected:
        return True, False, None
    return False, False, None


# ---------------------------------------------------------------- unit tables

def _collect_units(wiki: dict, key: str):
    """Return ([(index, item)], [malformed dicts]) for one wiki collection."""
    raw = wiki.get(key)
    if raw is None:
        return [], []
    if not isinstance(raw, list):
        return [], [{
            "index": None,
            "id": None,
            "reason": f"{key} must be an array",
        }]
    units = []
    malformed = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            malformed.append({
                "index": index,
                "id": None,
                "reason": f"{key}[{index}] is not an object",
            })
            continue
        item_id = item.get("id")
        if not isinstance(item_id, str) or not item_id.strip():
            malformed.append({
                "index": index,
                "id": item_id if isinstance(item_id, str) else None,
                "reason": f"{key}[{index}] has no non-empty string id",
            })
            continue
        units.append((index, item))
    return units, malformed


def _index_units(units: list):
    by_id = {}
    duplicates = []
    for index, item in units:
        item_id = item["id"]
        if item_id in by_id:
            duplicates.append((index, item_id, by_id[item_id][0]))
        else:
            by_id[item_id] = (index, item)
    return by_id, duplicates


def _empty_bucket() -> dict:
    return {
        "missing": [],
        "stale": [],
        "invalid": [],
        "added": [],
        "metaMissing": [],
        "metaExtra": [],
    }


def _add_invalid(bucket: dict, item_id, index, reason: str) -> None:
    for entry in bucket["invalid"]:
        if entry["id"] == item_id and entry["index"] == index:
            entry["reasons"].append(reason)
            return
    bucket["invalid"].append({"id": item_id, "index": index, "reasons": [reason]})


def _sort_invalid(bucket: dict) -> None:
    bucket["invalid"].sort(key=lambda entry: (
        entry["id"] is None,
        entry["id"] or "",
        -1 if entry["index"] is None else entry["index"],
    ))


# --------------------------------------------------------------------- report

def _counts(bucket: dict, canonical_count: int, translated_count: int) -> dict:
    return {
        "canonical": canonical_count,
        "translated": translated_count,
        "missing": len(bucket["missing"]),
        "stale": len(bucket["stale"]),
        "invalid": len(bucket["invalid"]),
        "added": len(bucket["added"]),
        "metaMissing": len(bucket["metaMissing"]),
        "metaExtra": len(bucket["metaExtra"]),
    }


def _build_report(source_lang, target_lang, buckets, errors, warnings,
                  canonical_counts, translated_counts) -> dict:
    has_issue = bool(errors)
    for bucket in buckets.values():
        has_issue = has_issue or any(bucket.values())
    ok = not has_issue

    if ok:
        status = "ok"
    elif errors:
        status = "error"
    elif any(buckets[key][name] for key in buckets
             for name in ("invalid", "added", "metaExtra")):
        status = "invalid"
    elif any(buckets[key]["missing"] for key in buckets):
        status = "missing"
    elif any(buckets[key][name] for key in buckets for name in ("stale", "metaMissing")):
        status = "stale"
    else:  # defensive: every branch above should be reachable
        status = "invalid"

    for bucket in buckets.values():
        for name in ("missing", "stale", "added", "metaMissing", "metaExtra"):
            bucket[name] = sorted(bucket[name])
        _sort_invalid(bucket)

    return {
        "schema": REPORT_SCHEMA,
        "ok": ok,
        "status": status,
        "sourceLang": source_lang,
        "targetLang": target_lang,
        "counts": {
            "pages": _counts(buckets["pages"], canonical_counts["pages"],
                             translated_counts["pages"]),
            "cards": _counts(buckets["cards"], canonical_counts["cards"],
                             translated_counts["cards"]),
            "errors": len(errors),
            "warnings": len(warnings),
        },
        "pages": buckets["pages"],
        "cards": buckets["cards"],
        "errors": errors,
        "warnings": warnings,
    }


def _error_report(message: str) -> dict:
    buckets = {"pages": _empty_bucket(), "cards": _empty_bucket()}
    return _build_report(
        None, None, buckets, [message], [],
        {"pages": 0, "cards": 0}, {"pages": 0, "cards": 0})


def check_translation(canonical: dict, translated: dict, meta: dict) -> dict:
    """Validate one translated wiki snapshot against the canonical English wiki.

    Args:
        canonical: decoded canonical ``wiki.json`` (English).
        translated: decoded translated ``wiki.json`` for one locale.
        meta: decoded ``translation-meta.json`` for that locale.

    Returns:
        A deterministic JSON-serialisable report (see module docstring).  The
        function never raises for malformed JSON-shaped input; unreadable input
        shapes become ``status: "error"`` with details in ``errors``.

    This function performs no I/O and no model/network calls.
    """
    buckets = {"pages": _empty_bucket(), "cards": _empty_bucket()}
    errors = []
    warnings = []

    if not isinstance(canonical, dict):
        errors.append("canonical wiki must be a JSON object")
    if not isinstance(translated, dict):
        errors.append("translated wiki must be a JSON object")
    if not isinstance(meta, dict):
        errors.append("translation-meta must be a JSON object")
    if errors:
        report = _build_report(None, None, buckets, errors, warnings,
                               {"pages": 0, "cards": 0}, {"pages": 0, "cards": 0})
        return report

    # ---- language / schema contract -------------------------------------
    canonical_lang = canonical.get("language")
    if canonical_lang is None:
        canonical_lang = "en"
        warnings.append("canonical.language is missing; assumed 'en'")
    else:
        canonical_lang = _checked_locale(canonical_lang, "canonical.language", errors)
    if canonical_lang is not None and not _is_english(canonical_lang):
        errors.append(
            f"canonical.language must be English ('en' or en-*), got {canonical_lang!r}")

    source_lang = meta.get("sourceLang")
    if source_lang is None:
        errors.append("metadata.sourceLang is missing")
    else:
        source_lang = _checked_locale(source_lang, "metadata.sourceLang", errors)
    if canonical_lang is not None and source_lang is not None \
            and canonical_lang.casefold() != source_lang.casefold():
        errors.append(
            f"metadata.sourceLang {source_lang!r} does not match canonical.language "
            f"{canonical_lang!r}")

    target_lang = meta.get("targetLang")
    if target_lang is None:
        errors.append("metadata.targetLang is missing")
    else:
        target_lang = _checked_locale(target_lang, "metadata.targetLang", errors)
    if source_lang is not None and target_lang is not None \
            and source_lang.casefold() == target_lang.casefold():
        errors.append(
            f"metadata.targetLang must differ from metadata.sourceLang ({target_lang!r})")

    translated_lang = translated.get("language")
    if translated_lang is None:
        errors.append("translated.language is missing")
    else:
        translated_lang = _checked_locale(translated_lang, "translated.language", errors)
    if target_lang is not None and translated_lang is not None \
            and target_lang.casefold() != translated_lang.casefold():
        errors.append(
            f"translated.language {translated_lang!r} does not match "
            f"metadata.targetLang {target_lang!r}")

    canonical_schema = canonical.get("schema")
    translated_schema = translated.get("schema")
    if canonical_schema != translated_schema:
        errors.append(
            f"schema differs: canonical {canonical_schema!r}, translation "
            f"{translated_schema!r}")

    # ---- collect units ---------------------------------------------------
    canonical_pages, canonical_page_bad = _collect_units(canonical, "pages")
    canonical_cards, canonical_card_bad = _collect_units(canonical, "cards")
    translated_pages, translated_page_bad = _collect_units(translated, "pages")
    translated_cards, translated_card_bad = _collect_units(translated, "cards")

    for bad in canonical_page_bad:
        errors.append(f"canonical.{bad['reason']}")
    for bad in canonical_card_bad:
        errors.append(f"canonical.{bad['reason']}")
    if not canonical_pages and not canonical_page_bad:
        errors.append("canonical.pages is empty")

    for bad in translated_page_bad:
        _add_invalid(buckets["pages"], bad["id"], bad["index"], bad["reason"])
    for bad in translated_card_bad:
        _add_invalid(buckets["cards"], bad["id"], bad["index"], bad["reason"])

    canonical_page_map, canonical_page_dups = _index_units(canonical_pages)
    canonical_card_map, canonical_card_dups = _index_units(canonical_cards)
    translated_page_map, translated_page_dups = _index_units(translated_pages)
    translated_card_map, translated_card_dups = _index_units(translated_cards)

    for index, item_id, first in canonical_page_dups:
        errors.append(
            f"canonical.pages has duplicate id {item_id!r} (indices {first} and {index})")
    for index, item_id, first in canonical_card_dups:
        errors.append(
            f"canonical.cards has duplicate id {item_id!r} (indices {first} and {index})")
    for index, item_id, first in translated_page_dups:
        _add_invalid(buckets["pages"], item_id, index,
                     f"duplicate id in translation.pages (first at index {first})")
    for index, item_id, first in translated_card_dups:
        _add_invalid(buckets["cards"], item_id, index,
                     f"duplicate id in translation.cards (first at index {first})")

    # ---- metadata mappings ----------------------------------------------
    meta_pages, legacy_pages = _meta_map(
        meta, "pages", errors, warnings, bool(canonical_page_map))
    meta_cards, legacy_cards = _meta_map(
        meta, "cards", errors, warnings, bool(canonical_card_map))
    all_canonical_ids = set(canonical_page_map) | set(canonical_card_map)

    specs = (
        ("page", "pages", canonical_page_map, translated_page_map,
         meta_pages, legacy_pages),
        ("card", "cards", canonical_card_map, translated_card_map,
         meta_cards, legacy_cards),
    )

    for kind, key, canonical_map, translated_map, meta_map, legacy in specs:
        bucket = buckets[key]
        for item_id in sorted(canonical_map):
            canonical_index, canonical_item = canonical_map[item_id]
            translated_entry = translated_map.get(item_id)
            reasons = []
            if translated_entry is None:
                bucket["missing"].append(item_id)
                index = canonical_index
            else:
                index, translated_item = translated_entry
                reasons.extend(_check_unit(kind, canonical_item, translated_item))
            stale, meta_missing, meta_problem = _meta_status(
                kind, item_id, canonical_item, meta_map)
            if meta_missing:
                bucket["metaMissing"].append(item_id)
            if meta_problem:
                reasons.append(meta_problem)
            if stale and translated_entry is not None:
                bucket["stale"].append(item_id)
            if reasons:
                _add_invalid(bucket, item_id, index, reasons[0])
                for reason in reasons[1:]:
                    _add_invalid(bucket, item_id, index, reason)

        for item_id in sorted(translated_map):
            if item_id not in canonical_map:
                bucket["added"].append(item_id)

        if meta_map is not None:
            universe = all_canonical_ids if legacy else set(canonical_map)
            bucket["metaExtra"].extend(
                item_id for item_id in meta_map if item_id not in universe)

    return _build_report(
        source_lang if source_lang is not None else canonical_lang,
        target_lang if target_lang is not None else translated_lang,
        buckets, errors, warnings,
        {"pages": len(canonical_page_map), "cards": len(canonical_card_map)},
        {"pages": len(translated_page_map), "cards": len(translated_card_map)})


# ------------------------------------------------------------------------ CLI

def _load_json(path: Path, label: str):
    if path.is_dir():
        return None, f"{label} is a directory, not a file: {path}"
    if not path.is_file():
        return None, f"{label} does not exist: {path}"
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        return None, f"{label} is not UTF-8 text: {path} ({exc})"
    except OSError as exc:
        return None, f"{label} is not readable: {path} ({exc})"
    try:
        return json.loads(text), None
    except RecursionError:
        return None, f"{label}: JSON nested too deeply to parse: {path}"
    except json.JSONDecodeError as exc:
        return None, f"{label} is not valid JSON: {path} ({exc})"


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="wiki_translations.py",
        description="Check a translated dsh-wiki snapshot against the canonical English wiki.",
        epilog="Exit codes: 0 report ok; 1 invalid/missing/stale/error (report still printed); "
               "2 argparse usage error.")
    parser.add_argument("--canonical", required=True,
                        help="canonical English wiki.json")
    parser.add_argument("--translation", required=True,
                        help="translated wiki.json (e.g. .dsh-wiki/locales/vi/wiki.json)")
    parser.add_argument("--meta", required=True,
                        help="translation-meta.json for the translated snapshot")
    args = parser.parse_args(argv)

    loaded = {}
    for label, key, raw in (
            ("canonical wiki.json", "canonical", args.canonical),
            ("translated wiki.json", "translation", args.translation),
            ("translation-meta.json", "meta", args.meta)):
        value, problem = _load_json(Path(raw).expanduser(), label)
        if problem:
            report = _error_report(problem)
            print(json.dumps(report, ensure_ascii=True, indent=2, sort_keys=True))
            return 1
        loaded[key] = value

    report = check_translation(loaded["canonical"], loaded["translation"], loaded["meta"])
    print(json.dumps(report, ensure_ascii=True, indent=2, sort_keys=True))
    return 0 if report.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
