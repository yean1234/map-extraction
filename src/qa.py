"""Run image/ID checks and sample original atlas textures through uv.exr."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import OpenEXR
import numpy as np
from PIL import Image


def read_channels(path: Path) -> dict[str, np.ndarray]:
    with OpenEXR.File(str(path), separate_channels=True) as image:
        if len(image.parts) != 1:
            raise ValueError(f"Expected a single-part EXR: {path}")
        return {name: channel.pixels for name, channel in image.channels().items()}


def srgb_to_linear(values: np.ndarray) -> np.ndarray:
    return np.where(values <= 0.04045, values / 12.92, ((values + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(values: np.ndarray) -> np.ndarray:
    values = np.clip(values, 0.0, 1.0)
    return np.where(values <= 0.0031308, values * 12.92, 1.055 * values ** (1 / 2.4) - 0.055)


def sample_texture(
    path: Path,
    uv: np.ndarray,
    settings: dict,
    flip_u: bool = False,
    flip_v: bool = False,
) -> np.ndarray:
    image = np.asarray(Image.open(path).convert("RGBA"), dtype=np.float32) / 255.0
    rgb = image[:, :, :3]
    if settings.get("sRGB", True):
        rgb = srgb_to_linear(rgb)
    alpha = image[:, :, 3:4]
    source = np.concatenate((rgb, alpha), axis=2)
    height, width = source.shape[:2]

    u = uv[:, 0].copy()
    v = uv[:, 1].copy()
    if flip_u:
        u = 1.0 - u
    if flip_v:
        v = 1.0 - v
    wrap_u = settings.get("wrapU", "clamp")
    wrap_v = settings.get("wrapV", "clamp")
    if wrap_u == "repeat":
        u = np.mod(u, 1.0)
    elif wrap_u in {"mirror", "mirrorOnce"}:
        u = np.mod(u, 2.0)
        u = np.where(u > 1.0, 2.0 - u, u)
    else:
        u = np.clip(u, 0.0, 1.0)
    if wrap_v == "repeat":
        v = np.mod(v, 1.0)
    elif wrap_v in {"mirror", "mirrorOnce"}:
        v = np.mod(v, 2.0)
        v = np.where(v > 1.0, 2.0 - v, v)
    else:
        v = np.clip(v, 0.0, 1.0)

    x = u * width - 0.5
    y = v * height - 0.5  # Package textures use flipY=false.
    if settings.get("filter") == "point":
        x0 = np.floor(x + 0.5).astype(np.int64)
        y0 = np.floor(y + 0.5).astype(np.int64)
        if wrap_u == "repeat":
            x0 %= width
        elif wrap_u in {"mirror", "mirrorOnce"}:
            x0 = np.where(x0 < 0, -x0 - 1, x0)
            x0 = np.where(x0 >= width, (2 * width - x0 - 1) % (2 * width), x0)
            x0 = np.minimum(x0, width - 1)
        else:
            x0 = np.clip(x0, 0, width - 1)
        if wrap_v == "repeat":
            y0 %= height
        elif wrap_v in {"mirror", "mirrorOnce"}:
            y0 = np.where(y0 < 0, -y0 - 1, y0)
            y0 = np.where(y0 >= height, (2 * height - y0 - 1) % (2 * height), y0)
            y0 = np.minimum(y0, height - 1)
        else:
            y0 = np.clip(y0, 0, height - 1)
        return source[y0, x0]

    x_floor = np.floor(x)
    y_floor = np.floor(y)
    tx = (x - x_floor)[:, None]
    ty = (y - y_floor)[:, None]
    x0 = x_floor.astype(np.int64)
    y0 = y_floor.astype(np.int64)
    x1 = x0 + 1
    y1 = y0 + 1
    if wrap_u == "repeat":
        x0 %= width
        x1 %= width
    elif wrap_u in {"mirror", "mirrorOnce"}:
        x0 = np.where(x0 < 0, -x0 - 1, x0)
        x1 = np.where(x1 < 0, -x1 - 1, x1)
        x0 = np.where(x0 >= width, 2 * width - x0 - 1, x0)
        x1 = np.where(x1 >= width, 2 * width - x1 - 1, x1)
        x0 = np.clip(x0, 0, width - 1)
        x1 = np.clip(x1, 0, width - 1)
    else:
        x0 = np.clip(x0, 0, width - 1)
        x1 = np.clip(x1, 0, width - 1)
    if wrap_v == "repeat":
        y0 %= height
        y1 %= height
    elif wrap_v in {"mirror", "mirrorOnce"}:
        y0 = np.where(y0 < 0, -y0 - 1, y0)
        y1 = np.where(y1 < 0, -y1 - 1, y1)
        y0 = np.where(y0 >= height, 2 * height - y0 - 1, y0)
        y1 = np.where(y1 >= height, 2 * height - y1 - 1, y1)
        y0 = np.clip(y0, 0, height - 1)
        y1 = np.clip(y1, 0, height - 1)
    else:
        y0 = np.clip(y0, 0, height - 1)
        y1 = np.clip(y1, 0, height - 1)

    top = source[y0, x0] * (1 - tx) + source[y0, x1] * tx
    bottom = source[y1, x0] * (1 - tx) + source[y1, x1] * tx
    return top * (1 - ty) + bottom * ty


def psnr(expected: np.ndarray, actual: np.ndarray) -> float:
    if expected.size == 0:
        return float("nan")
    mse = float(np.mean((expected.astype(np.float64) - actual.astype(np.float64)) ** 2))
    if mse == 0:
        return float("inf")
    return 10 * math.log10(1.0 / mse)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", type=Path, required=True)
    parser.add_argument("--package", type=Path, required=True)
    args = parser.parse_args()
    run_dir = args.run_dir.resolve()
    package = args.package.resolve()
    metadata = json.loads((run_dir / "qa-input.json").read_text(encoding="utf-8"))

    id_image = np.asarray(Image.open(run_dir / "views/game/instance_id.png").convert("RGB"))
    beauty_repeat_path = run_dir / ".beauty-repeat.png"
    beauty_repeat = np.asarray(Image.open(beauty_repeat_path).convert("RGBA"))
    beauty_first = np.asarray(Image.open(run_dir / "views/game/beauty.png").convert("RGBA"))
    if beauty_repeat.shape != beauty_first.shape:
        raise ValueError("Repeated beauty render dimensions differ")
    beauty_difference = np.abs(beauty_first.astype(np.int16) - beauty_repeat.astype(np.int16))
    beauty_repeat_report = {
        "differentPixels": int(np.count_nonzero(np.any(beauty_difference != 0, axis=2))),
        "maximumChannelDifference": int(beauty_difference.max()),
        "meanAbsoluteChannelDifference": float(beauty_difference.mean()),
    }
    packed_ids = (
        id_image[:, :, 0].astype(np.uint32)
        + (id_image[:, :, 1].astype(np.uint32) << 8)
        + (id_image[:, :, 2].astype(np.uint32) << 16)
    )
    present_ids, pixel_counts = np.unique(packed_ids[packed_ids != 0], return_counts=True)
    known_ids = {int(row["id"]) for row in metadata["ids"]}
    unknown_ids = sorted(set(map(int, present_ids)) - known_ids)

    uv_channels = read_channels(run_dir / "uv.exr")
    required_uv_channels = {"U", "V", "TextureID", "Valid"}
    if not required_uv_channels.issubset(uv_channels):
        raise ValueError(f"uv.exr missing channels: {sorted(required_uv_channels - set(uv_channels))}")
    uv = np.stack((uv_channels["U"], uv_channels["V"]), axis=2)
    texture_ids = np.rint(uv_channels["TextureID"]).astype(np.int32)
    valid_uv = (uv_channels["Valid"] > 0.5) & (texture_ids > 0)
    albedo = np.asarray(Image.open(run_dir / "views/game/albedo.png").convert("RGB"), dtype=np.float32) / 255.0
    if albedo.shape[:2] != texture_ids.shape:
        raise ValueError("albedo.png and uv.exr dimensions differ")

    texture_by_id = metadata["textures"]
    sampled_pixels = np.zeros(texture_ids.shape, dtype=bool)
    missing_texture_ids = []
    orientations = {
        "flipY=false": (False, False),
        "flipY=true": (False, True),
        "flipU=true": (True, False),
        "flipUV=true": (True, True),
    }
    squared_error = {name: 0.0 for name in orientations}
    compared_values = 0
    for texture_id in np.unique(texture_ids[valid_uv]):
        info = texture_by_id.get(str(int(texture_id)))
        if not info:
            missing_texture_ids.append(int(texture_id))
            continue
        mask = valid_uv & (texture_ids == texture_id)
        texture_path = package / "assets" / info["output"]
        if not texture_path.is_file():
            missing_texture_ids.append(int(texture_id))
            continue
        settings = info.get("importSettings") or {}
        for name, (flip_u, flip_v) in orientations.items():
            sampled = sample_texture(texture_path, uv[mask], settings, flip_u, flip_v)
            sampled_rgb = linear_to_srgb(sampled[:, :3])
            difference = albedo[mask] - sampled_rgb
            squared_error[name] += float(np.sum(difference.astype(np.float64) ** 2))
        compared_values += int(np.count_nonzero(mask)) * 3
        sampled_pixels[mask] = True

    psnr_by_orientation = {}
    for name, total_error in squared_error.items():
        if not compared_values:
            psnr_by_orientation[name] = float("nan")
        elif total_error == 0:
            psnr_by_orientation[name] = float("inf")
        else:
            psnr_by_orientation[name] = 10 * math.log10(compared_values / total_error)
    selected_orientation = max(psnr_by_orientation, key=lambda name: psnr_by_orientation[name])
    roundtrip_psnr = psnr_by_orientation[selected_orientation]

    depth_channels = read_channels(run_dir / "depth.exr")
    if not {"Z", "Valid"}.issubset(depth_channels):
        raise ValueError("depth.exr must contain Z and Valid channels")
    depth_valid = (depth_channels["Valid"] > 0.5) & (depth_channels["Z"] > 0)
    visible_count = len(present_ids)
    missing_meshes = int(metadata.get("missingMeshes", 0))
    repeated = metadata.get("determinism", {})
    psnr_passed = not math.isnan(roundtrip_psnr) and roundtrip_psnr >= 40
    psnr_for_json = roundtrip_psnr if math.isfinite(roundtrip_psnr) else (
        "Infinity" if roundtrip_psnr > 0 else None
    )
    checks = {
        "nonEmptyInstanceId": bool(np.any(packed_ids)),
        "idPixelsMapToKnownInstances": not unknown_ids,
        "uvTextureReferencesResolve": not missing_texture_ids and bool(np.any(valid_uv)),
        "depthContainsVisibleGeometry": bool(np.any(depth_valid)),
        "uvRoundtripPsnrAtLeast40dB": psnr_passed,
        "repeatedPassHashesMatch": bool(repeated.get("allMatch")),
        "noMissingMeshes": missing_meshes == 0,
    }
    pixels_with_objects = int(np.count_nonzero(packed_ids))
    total_pixels = int(packed_ids.size)
    report = {
        "schemaVersion": 1,
        "passed": all(checks.values()),
        "checks": checks,
        "dimensions": {"width": int(packed_ids.shape[1]), "height": int(packed_ids.shape[0])},
        "instanceCoverage": {
            "visibleInstanceCount": visible_count,
            "knownInstanceCount": len(known_ids),
            "invisibleInstanceCount": len(known_ids - set(map(int, present_ids))),
            "pixelsWithObjects": pixels_with_objects,
            "imagePixels": total_pixels,
            "pixelCoverage": pixels_with_objects / total_pixels if total_pixels else 0,
            "unknownIds": unknown_ids,
            "pixelsById": {str(int(key)): int(value) for key, value in zip(present_ids, pixel_counts)},
        },
        "uvRoundtrip": {
            "psnrDb": psnr_for_json,
            "sampledPixels": int(np.count_nonzero(sampled_pixels)),
            "psnrByOrientation": {
                name: value if math.isfinite(value) else ("Infinity" if value > 0 else None)
                for name, value in psnr_by_orientation.items()
            },
            "validUvPixels": int(np.count_nonzero(valid_uv)),
            "missingTextureIds": missing_texture_ids,
            "textureOrientation": selected_orientation,
        },
        "depth": {"validPixels": int(np.count_nonzero(depth_valid))},
        "missingMeshes": missing_meshes,
        "determinism": repeated,
        "beautyRepeat": beauty_repeat_report,
    }
    (run_dir / "qa-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    (run_dir / "qa-input.json").unlink(missing_ok=True)
    beauty_repeat_path.unlink(missing_ok=True)
    print(json.dumps({"passed": report["passed"], "checks": checks, "uvPsnrDb": report["uvRoundtrip"]["psnrDb"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
