"""Convert tightly packed bottom-up RGBA float pixels to scanline OpenEXR."""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import OpenEXR


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--kind", choices=("uv", "depth"), required=True)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--width", type=int, required=True)
    parser.add_argument("--height", type=int, required=True)
    args = parser.parse_args()

    if args.width <= 0 or args.height <= 0:
        parser.error("width and height must be positive")
    expected_bytes = args.width * args.height * 4 * np.dtype("<f4").itemsize
    raw = args.input.read_bytes()
    if len(raw) != expected_bytes:
        raise SystemExit(
            f"Expected {expected_bytes} bytes of RGBA float pixels; received {len(raw)}"
        )

    pixels = np.frombuffer(raw, dtype="<f4").reshape(args.height, args.width, 4)
    pixels = np.ascontiguousarray(pixels[::-1], dtype=np.float32)
    if args.kind == "uv":
        channels = {
            "U": np.ascontiguousarray(pixels[:, :, 0]),
            "V": np.ascontiguousarray(pixels[:, :, 1]),
            "TextureID": np.ascontiguousarray(pixels[:, :, 2]),
            "Valid": np.ascontiguousarray(pixels[:, :, 3]),
        }
    else:
        channels = {
            "Z": np.ascontiguousarray(pixels[:, :, 0]),
            "Valid": np.ascontiguousarray(pixels[:, :, 3]),
        }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    header = {
        "compression": OpenEXR.ZIP_COMPRESSION,
        "type": OpenEXR.scanlineimage,
    }
    with OpenEXR.File(header, channels) as image:
        image.write(str(args.output))


if __name__ == "__main__":
    main()
