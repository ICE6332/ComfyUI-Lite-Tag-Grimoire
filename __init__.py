import csv
import json
import logging
from functools import lru_cache
from pathlib import Path

from aiohttp import web

try:
    from server import PromptServer
except Exception:  # pragma: no cover - only happens outside ComfyUI
    PromptServer = None


WEB_DIRECTORY = "web"
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

BASE_DIR = Path(__file__).resolve().parent
TRANSLATIONS_DIR = BASE_DIR / "data" / "translations"
SOURCES_DIR = BASE_DIR / "data" / "sources"

GENERAL_LAYER = TRANSLATIONS_DIR / "danbooru_cn_preferred_v3.csv"
COPYRIGHT_LAYER = TRANSLATIONS_DIR / "danbooru_copyright_cn_preferred_v1.csv"
CHARACTER_INDEX = SOURCES_DIR / "noob-wiki" / "danbooru_character.csv"

INDEX_VERSION = "2026-05-25"
MAX_CHARACTER_ROWS = 60000


def _split_aliases(value):
    if not value:
        return []
    out = []
    for sep in ("|", ","):
        if sep in value:
            parts = value.split(sep)
            break
    else:
        parts = [value]
    for part in parts:
        item = part.strip()
        if item and item not in out:
            out.append(item)
    return out


def _read_translation_layer(path, layer):
    rows = []
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            tag = (row.get("tag") or "").strip()
            if not tag:
                continue
            preferred = (row.get("preferred_cn") or "").strip() or tag
            rows.append(
                {
                    "tag": tag,
                    "preferred": preferred,
                    "translation": preferred,
                    "aliases": _split_aliases(row.get("alternatives") or ""),
                    "category": int(row.get("category") or 0),
                    "post_count": int(float(row.get("post_count") or 0)),
                    "kind": layer,
                }
            )
    return rows


def _read_character_layer(copyright_lookup):
    if not CHARACTER_INDEX.exists():
        return []

    rows = []
    with CHARACTER_INDEX.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            character = (row.get("character") or "").strip()
            if not character:
                continue
            copyright_name = (row.get("copyright") or "").strip()
            copyright_item = copyright_lookup.get(copyright_name, {})
            copyright_preferred = copyright_item.get("preferred") or copyright_name
            count = int(float(row.get("count") or 0))
            rows.append(
                {
                    "tag": character,
                    "preferred": character,
                    "translation": f"角色 · 来自：{copyright_preferred}" if copyright_preferred else "角色",
                    "aliases": _split_aliases(row.get("trigger") or ""),
                    "category": 4,
                    "post_count": count,
                    "kind": "character",
                    "copyright": copyright_name,
                    "source_tag": copyright_name,
                    "source_preferred": copyright_preferred,
                }
            )

    rows.sort(key=lambda item: item["post_count"], reverse=True)
    return rows[:MAX_CHARACTER_ROWS]


@lru_cache(maxsize=1)
def _build_index():
    general_rows = _read_translation_layer(GENERAL_LAYER, "general")
    copyright_rows = _read_translation_layer(COPYRIGHT_LAYER, "copyright")
    copyright_lookup = {item["tag"]: item for item in copyright_rows}

    items = []
    items.extend(general_rows)
    items.extend(copyright_rows)
    items.extend(_read_character_layer(copyright_lookup))

    seen = set()
    compact = []
    for item in sorted(items, key=lambda entry: entry.get("post_count", 0), reverse=True):
        tag = item["tag"]
        if tag in seen:
            continue
        seen.add(tag)
        compact.append(item)

    return {
        "version": INDEX_VERSION,
        "counts": {
            "total": len(compact),
            "general": sum(1 for item in compact if item["kind"] == "general"),
            "copyright": sum(1 for item in compact if item["kind"] == "copyright"),
            "character": sum(1 for item in compact if item["kind"] == "character"),
        },
        "items": compact,
    }


def _register_routes():
    if PromptServer is None or PromptServer.instance is None:
        return

    routes = PromptServer.instance.routes

    @routes.get("/lite-tag-grimoire/index")
    async def get_index(_request):
        try:
            return web.json_response(_build_index())
        except Exception as exc:
            logging.exception("[lite-tag-grimoire] failed to build tag index")
            return web.json_response({"error": str(exc)}, status=500)

    @routes.get("/lite-tag-grimoire/health")
    async def get_health(_request):
        index = _build_index()
        return web.json_response(
            {
                "ok": True,
                "version": index["version"],
                "counts": index["counts"],
                "files": {
                    "general": str(GENERAL_LAYER),
                    "copyright": str(COPYRIGHT_LAYER),
                    "characters": str(CHARACTER_INDEX),
                },
            }
        )


_register_routes()
