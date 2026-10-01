"""Inspect a local tilemap package and rank privacy-safe pilot candidates."""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
EXCLUDED_STATUSES = {"outOfSync", "unreadable"}
PILOT_MIN_EXTENT = 20
PILOT_MAX_EXTENT = 40
MAX_PILOT_JSON_BYTES = 5_000_000


def read_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def resolve_path(value: str, base: Path) -> Path:
    path = Path(os.path.expandvars(value)).expanduser()
    return path if path.is_absolute() else (base / path).resolve()


def resolve_paths(args: argparse.Namespace) -> tuple[Path, Path]:
    env = read_env(ROOT / ".env")
    package_value = args.package or os.environ.get("PACKAGE_DIR") or env.get("PACKAGE_DIR")
    if not package_value:
        raise SystemExit("PACKAGE_DIR가 없습니다. .env.example을 .env로 복사하고 경로를 지정하세요.")
    package = resolve_path(package_value, ROOT)
    if not (package / "manifest.json").is_file():
        raise SystemExit(f"manifest.json을 찾을 수 없습니다: {package}")
    out_value = args.out or os.environ.get("OUT_DIR") or env.get("OUT_DIR", "out")
    out = resolve_path(out_value, ROOT)
    return package, out


def read_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as stream:
        return json.load(stream)


def file_exists(package: Path, relative: str | None) -> bool:
    return bool(relative) and (package / "assets" / relative).is_file()


def build_render_index(package: Path) -> tuple[dict[str, dict], dict[tuple[str, str], set[str]]]:
    render_assets_path = package / "assets" / "render-assets.json"
    if not render_assets_path.is_file():
        return {}, {}
    render_assets = read_json(render_assets_path)
    models = {item.get("asset"): item for item in render_assets.get("models", [])}
    textures_by_identity: dict[tuple[str, str], set[str]] = {}
    for material in render_assets.get("materials", []):
        key = (str(material.get("asset", "")), str(material.get("fileId", "")))
        textures_by_identity[key] = {
            str(entry.get("texture", {}).get("asset"))
            for entry in material.get("textures", [])
            if entry.get("texture", {}).get("asset")
        }
    return models, textures_by_identity


def prototype_has_missing_mesh(prototype: dict, models: dict[str, dict], package: Path) -> bool:
    mesh_references = [
        reference
        for node in prototype.get("nodes", [])
        for component in node.get("components", [])
        for reference in component.get("assetReferences", [])
        if str(reference.get("property", "")).endswith(".m_Mesh")
    ]
    for reference in mesh_references:
        model = models.get(reference.get("asset"))
        if not model or not file_exists(package, model.get("output")):
            return True
        matching_object = next(
            (
                item for item in model.get("objects", [])
                if str(item.get("fileId")) == str(reference.get("fileId"))
            ),
            None,
        )
        if matching_object is None or not isinstance(matching_object.get("glbNodeIndex"), int):
            return True
    return False


def map_dimensions(instances: list[dict]) -> tuple[int, int, dict[str, float] | None]:
    positions = [
        instance.get("position", {})
        for instance in instances
        if all(math.isfinite(float(instance.get("position", {}).get(axis, math.nan))) for axis in ("x", "z"))
    ]
    if not positions:
        return 0, 0, None
    min_x = min(float(position["x"]) for position in positions)
    max_x = max(float(position["x"]) for position in positions)
    min_z = min(float(position["z"]) for position in positions)
    max_z = max(float(position["z"]) for position in positions)
    bounds = {"minX": min_x, "maxX": max_x, "minZ": min_z, "maxZ": max_z}
    return math.ceil(max_x - min_x + 1), math.ceil(max_z - min_z + 1), bounds


def inspect_map(
    package: Path,
    entry: dict,
    tileset_entries: dict[str, dict],
    prototype_cache: dict[str, dict[str, dict]],
    missing_cache: dict[tuple[str, str], bool],
    models: dict[str, dict],
) -> dict:
    map_path = package / entry["path"]
    if not map_path.is_file():
        return {"id": entry.get("id"), "name": entry.get("name"), "unreadable": "map JSON missing"}
    try:
        map_data = read_json(map_path)
    except (OSError, json.JSONDecodeError) as error:
        return {"id": entry.get("id"), "name": entry.get("name"), "unreadable": str(error)}

    instances = [
        instance
        for layer in map_data.get("layers", [])
        for instance in layer.get("instances", [])
    ]
    width, depth, bounds = map_dimensions(instances)
    pair_status = entry.get("pair", {}).get("status", "unknown")
    map_tilesets = map_data.get("tilesets", [])
    used_tilesets = []
    tileset_by_index = {}
    for map_tileset in map_tilesets:
        tileset_id = map_tileset.get("packageId")
        tileset_entry = tileset_entries.get(tileset_id)
        tileset_name = map_tileset.get("name", "unknown")
        if tileset_entry:
            tileset_name = Path(tileset_entry.get("source") or tileset_entry["path"]).parent.name
        used_tilesets.append({"id": tileset_id, "name": tileset_name, "resolved": bool(map_tileset.get("resolved"))})
        if tileset_id:
            tileset_by_index[map_tileset.get("index")] = tileset_id

    unresolved_instances = 0
    missing_mesh_instances = 0
    missing_prototypes = set()
    used_prototype_ids = set()
    for instance in instances:
        prototype_id = instance.get("prototypeId")
        if not prototype_id:
            unresolved_instances += 1
            continue
        used_prototype_ids.add(prototype_id)
        package_id = prototype_id.split(":", 1)[0]
        if package_id not in prototype_cache:
            tileset_entry = tileset_entries.get(package_id)
            if not tileset_entry:
                prototype_cache[package_id] = {}
            else:
                tileset_path = package / tileset_entry["path"]
                try:
                    prototype_cache[package_id] = {
                        item.get("id"): item
                        for item in read_json(tileset_path).get("prototypes", [])
                    }
                except (OSError, json.JSONDecodeError):
                    prototype_cache[package_id] = {}
        prototype = prototype_cache[package_id].get(prototype_id)
        if prototype is None:
            unresolved_instances += 1
            continue
        if prototype_id not in missing_cache:
            missing_cache[prototype_id] = prototype_has_missing_mesh(prototype, models, package)
        if missing_cache[prototype_id]:
            missing_prototypes.add(prototype_id)
            missing_mesh_instances += 1

    warnings = map_data.get("warnings", [])
    warning_codes = Counter(str(item.get("code", "unknown")) for item in warnings if isinstance(item, dict))
    dimensions_match = PILOT_MIN_EXTENT <= width <= PILOT_MAX_EXTENT and PILOT_MIN_EXTENT <= depth <= PILOT_MAX_EXTENT
    source_has_json = bool((entry.get("sources", {}).get("json") or {}).get("path"))
    eligible_source = pair_status == "matched" or source_has_json or entry.get("selectedSource") == "json"
    eligible_status = pair_status not in EXCLUDED_STATUSES
    candidate = (
        eligible_source
        and eligible_status
        and map_path.stat().st_size <= MAX_PILOT_JSON_BYTES
        and dimensions_match
        and bool(used_tilesets)
    )
    return {
        "id": entry.get("id"),
        "name": map_data.get("map", {}).get("name", entry.get("name")),
        "path": entry["path"],
        "pairStatus": pair_status,
        "selectedSource": entry.get("selectedSource"),
        "hasJsonSource": source_has_json,
        "jsonBytes": map_path.stat().st_size,
        "tileInstances": len(instances),
        "uniquePrototypes": len(used_prototype_ids),
        "dimensions": {"width": width, "depth": depth, "bounds": bounds},
        "tilesets": used_tilesets,
        "warnings": {"total": len(warnings), "byCode": dict(warning_codes)},
        "unresolvedInstances": unresolved_instances,
        "missingMeshInstances": missing_mesh_instances,
        "missingPrototypeIds": sorted(missing_prototypes),
        "candidate": candidate,
    }


def select_pilots(summaries: list[dict]) -> list[dict]:
    eligible = [
        item for item in summaries
        if item.get("candidate")
        and not item.get("unresolvedInstances")
        and not item.get("missingMeshInstances")
    ]
    eligible.sort(
        key=lambda item: (
            0 if item.get("pairStatus") == "matched" else 1,
            item.get("tileInstances", 0),
            item.get("warnings", {}).get("total", 0),
            abs(item["dimensions"]["width"] - 30) + abs(item["dimensions"]["depth"] - 30),
            item["id"],
        )
    )
    selected = []
    seen_themes = set()
    for item in eligible:
        theme = item["tilesets"][0].get("id") or item["tilesets"][0]["name"]
        if theme in seen_themes:
            continue
        selected.append(item)
        seen_themes.add(theme)
        if len(selected) == 3:
            break
    return selected


def main() -> None:
    parser = argparse.ArgumentParser(description="Scan map package and suggest 3 small pilot maps.")
    parser.add_argument("--package", help="Local package directory (overrides PACKAGE_DIR).")
    parser.add_argument("--out", help="Local output directory (default: out/).")
    args = parser.parse_args()
    package, out = resolve_paths(args)

    manifest = read_json(package / "manifest.json")
    tileset_entries = {item.get("id"): item for item in manifest.get("tilesets", [])}
    models, _ = build_render_index(package)
    prototype_cache: dict[str, dict[str, dict]] = {}
    missing_cache: dict[tuple[str, str], bool] = {}
    status_counts = Counter(item.get("pair", {}).get("status", "unknown") for item in manifest.get("maps", []))
    summaries = []
    for index, entry in enumerate(manifest.get("maps", []), start=1):
        status = entry.get("pair", {}).get("status", "unknown")
        has_json_source = bool((entry.get("sources", {}).get("json") or {}).get("path"))
        if status in EXCLUDED_STATUSES or (status != "matched" and not has_json_source and entry.get("selectedSource") != "json"):
            continue
        summaries.append(
            inspect_map(package, entry, tileset_entries, prototype_cache, missing_cache, models)
        )
        if index % 250 == 0:
            print(f"진행 {index}/{len(manifest.get('maps', []))} 맵", file=sys.stderr)

    candidates = [item for item in summaries if item.get("candidate")]
    pilots = select_pilots(summaries)
    output = {
        "schemaVersion": 1,
        "sourcePackage": str(package),
        "mapCount": len(manifest.get("maps", [])),
        "tilesetCount": len(manifest.get("tilesets", [])),
        "pairStatus": dict(status_counts),
        "eligibility": {
            "source": "matched or JSON source; outOfSync/unreadable excluded",
            "mapExtent": [PILOT_MIN_EXTENT, PILOT_MAX_EXTENT],
            "maxMapJsonBytes": MAX_PILOT_JSON_BYTES,
        },
        "candidateCount": len(candidates),
        "pilotCandidates": candidates,
        "selectedPilots": pilots,
        "scanSummary": {
            "eligibleMapsScanned": len(summaries),
            "mapsWithUnresolvedInstances": sum(bool(item.get("unresolvedInstances")) for item in summaries),
            "mapsWithMissingMeshes": sum(bool(item.get("missingMeshInstances")) for item in summaries),
        },
    }

    out.mkdir(parents=True, exist_ok=True)
    destination = out / "inventory.json"
    destination.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"맵 {output['mapCount']}개, 타일셋 {output['tilesetCount']}개")
    print(f"적격 맵 {len(summaries)}개 · 20~40 유닛 후보 {len(candidates)}개 · 서로 다른 테마 파일럿 {len(pilots)}개")
    for pilot in pilots:
        print(
            f"  {pilot['name']} ({pilot['pairStatus']}, {pilot['tileInstances']} placements, "
            f"{pilot['dimensions']['width']}×{pilot['dimensions']['depth']}, "
            f"theme={pilot['tilesets'][0]['name']})"
        )
    print(f"상세 기록: {destination}")


if __name__ == "__main__":
    main()
