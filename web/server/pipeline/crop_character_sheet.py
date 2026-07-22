#!/usr/bin/env python3
"""Crop normalized character boxes from a collection image."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Crop characters from a collection image")
    parser.add_argument("source")
    parser.add_argument("output_dir")
    parser.add_argument("boxes_json")
    return parser.parse_args()


def expand_interval(start: float, length: float, minimum_length: float) -> tuple[float, float]:
    target_length = min(1.0, max(length, minimum_length))
    center = start + length / 2
    expanded_start = center - target_length / 2
    expanded_end = center + target_length / 2
    if expanded_start < 0.0:
        expanded_end -= expanded_start
        expanded_start = 0.0
    if expanded_end > 1.0:
        expanded_start -= expanded_end - 1.0
        expanded_end = 1.0
    return max(0.0, expanded_start), min(1.0, expanded_end)


def safe_box(item: dict, width: int, height: int, character_count: int = 1) -> tuple[int, int, int, int]:
    x = max(0.0, min(1.0, float(item["x"])))
    y = max(0.0, min(1.0, float(item["y"])))
    box_width = max(0.02, min(1.0 - x, float(item["width"])))
    box_height = max(0.02, min(1.0 - y, float(item["height"])))
    safe_count = max(1, character_count)

    # Vision models sometimes return equal-width character lanes instead of true
    # silhouette bounds. Preserve enough horizontal context for wide equipment
    # such as shields, staffs, capes, and hats; a neighboring fragment is safer
    # for downstream generation than cutting off the target character itself.
    minimum_width = min(0.75, 1.45 / safe_count)
    x, expanded_right = expand_interval(x, box_width, minimum_width)
    y, expanded_bottom = expand_interval(y, box_height, 0.96)
    box_width = expanded_right - x
    box_height = expanded_bottom - y

    padding_x = box_width * 0.03
    padding_y = box_height * 0.03
    left = round(max(0.0, x - padding_x) * width)
    top = round(max(0.0, y - padding_y) * height)
    right = round(min(1.0, expanded_right + padding_x) * width)
    bottom = round(min(1.0, expanded_bottom + padding_y) * height)
    if right - left < 16 or bottom - top < 16:
        raise ValueError("角色裁切区域过小")
    return left, top, right, bottom


def main() -> int:
    args = parse_args()
    try:
        from PIL import Image
    except ModuleNotFoundError as error:
        raise RuntimeError(
            "缺少 Pillow；请运行 uv sync --locked --project web/server/pipeline"
        ) from error
    source = Path(args.source).resolve()
    output_dir = Path(args.output_dir).resolve()
    boxes = json.loads(args.boxes_json)
    if not source.is_file():
        raise ValueError("合集原画不存在")
    if not isinstance(boxes, list) or not 1 <= len(boxes) <= 24:
        raise ValueError("角色裁切数量必须为 1–24 个")
    output_dir.mkdir(parents=True, exist_ok=True)

    results: list[str] = []
    with Image.open(source) as image:
        image.load()
        canvas = image.convert("RGBA")
        for index, item in enumerate(boxes, start=1):
            crop = canvas.crop(safe_box(item, canvas.width, canvas.height, len(boxes)))
            destination = output_dir / f"character-{index:02d}.png"
            crop.save(destination, format="PNG")
            results.append(str(destination.resolve()))

    print(json.dumps(results, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, ValueError, KeyError, TypeError, json.JSONDecodeError) as error:
        print(f"[crop] {error}", file=sys.stderr)
        raise SystemExit(1)
