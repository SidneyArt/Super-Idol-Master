#!/usr/bin/env python3
"""Apply conservative, deterministic repairs to a failed T-pose image.

The repairer deliberately fails closed.  It only edits pixels when the QA
metrics provide enough geometry and the requested operation does not require
inventing character details.  Its JSON result tells the caller when an image
editing model is the safer strategy.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import uuid
from pathlib import Path
from typing import Any

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageOps

from run_tpose_qa import evaluate_background, is_light_neutral


MAX_DETERMINISTIC_ARM_ERROR = 0.35
MIN_DETERMINISTIC_ARM_ERROR = 0.19
MAX_LIGHT_FOREGROUND_RATIO_FOR_MATTING = 0.08


def _has_unsafe_pose_failure(metrics: dict[str, Any]) -> bool:
    person_count = int(metrics["personCount"]) if "personCount" in metrics else 1
    right_elbow = float(metrics["rightElbowAngle"]) if "rightElbowAngle" in metrics else 180
    left_elbow = float(metrics["leftElbowAngle"]) if "leftElbowAngle" in metrics else 180
    return (
        person_count != 1
        or ("minConfidence" in metrics and float(metrics["minConfidence"]) < 0.25)
        or float(metrics.get("armHorizontalError") or 0) > MAX_DETERMINISTIC_ARM_ERROR
        or right_elbow < 160
        or left_elbow < 160
        or float(metrics.get("shoulderTilt") or 0) > 0.10
    )


def _result_for_model(reason: str) -> dict[str, Any]:
    return {
        "applied": False,
        "strategy": "image_edit_model",
        "actions": [],
        "reason": reason,
        "outputPath": None,
    }


def _passes_current_pose_gate(metrics: dict[str, Any]) -> bool:
    full_body = metrics.get("fullBody")
    if full_body is None:
        full_body = float(metrics.get("bodyCoverage") or 0) >= 0.42
    return not _has_unsafe_pose_failure(metrics) and bool(full_body) and float(metrics.get("armHorizontalError") or 0) <= 0.19


def _destination(output_root: Path) -> Path:
    destination = output_root.resolve() / "qa-repair" / uuid.uuid4().hex / "concept.png"
    destination.parent.mkdir(parents=True, exist_ok=False)
    return destination


def _pose_point(points: dict[str, Any], name: str) -> tuple[float, float] | None:
    value = points.get(name)
    if not isinstance(value, list) or len(value) < 2:
        return None
    return float(value[0]), float(value[1])


def _validated_foreground_bounds(image: Image.Image, metrics: dict[str, Any]) -> tuple[int, int, int, int] | None:
    bounds = metrics.get("foregroundBounds")
    if not isinstance(bounds, list) or len(bounds) != 4:
        return None
    left, top, right, bottom = [int(value) for value in bounds]
    if not (0 <= left < right < image.width and 0 <= top < bottom < image.height):
        return None
    total = (right - left + 1) * (bottom - top + 1)
    light_count = sum(
        is_light_neutral(image.getpixel((x, y)))
        for y in range(top, bottom + 1)
        for x in range(left, right + 1)
    )
    if light_count / total > MAX_LIGHT_FOREGROUND_RATIO_FOR_MATTING:
        return None
    return left, top, right, bottom


def _arm_is_safely_segmentable(
    image: Image.Image,
    shoulder: tuple[float, float],
    elbow: tuple[float, float],
    wrist: tuple[float, float],
) -> bool:
    samples: list[tuple[int, int]] = []
    for start, end in ((shoulder, elbow), (elbow, wrist)):
        for index in range(1, 6):
            ratio = index / 6
            samples.append((round(start[0] + (end[0] - start[0]) * ratio), round(start[1] + (end[1] - start[1]) * ratio)))
    return all(
        0 <= x < image.width
        and 0 <= y < image.height
        and not is_light_neutral(image.getpixel((x, y)))
        for x, y in samples
    )


def _rotate_arm(
    image: Image.Image,
    shoulder: tuple[float, float],
    elbow: tuple[float, float],
    wrist: tuple[float, float],
    line_width: int,
) -> Image.Image:
    """Rotate a narrow arm-shaped pixel layer around its shoulder."""

    corridor = Image.new("L", image.size, 0)
    draw = ImageDraw.Draw(corridor)
    points = [tuple(round(value) for value in point) for point in (shoulder, elbow, wrist)]
    draw.line(points, fill=255, width=line_width, joint="curve")
    radius = max(2, line_width // 2)
    for x, y in points:
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=255)

    subject = Image.new("L", image.size)
    subject.putdata([0 if is_light_neutral(pixel) else 255 for pixel in image.get_flattened_data()])
    subject = subject.filter(ImageFilter.MaxFilter(9))
    mask = ImageChops.multiply(corridor, subject)

    layer = image.convert("RGBA")
    layer.putalpha(mask)
    cleared = image.copy()
    cleared.paste((255, 255, 255), mask=mask)

    dx, dy = wrist[0] - shoulder[0], wrist[1] - shoulder[1]
    current_angle = math.atan2(dy, dx)
    target_angle = math.pi if dx < 0 else 0.0
    angle = target_angle - current_angle
    cosine, sine = math.cos(angle), math.sin(angle)
    pivot_x, pivot_y = shoulder
    inverse = (
        cosine,
        sine,
        pivot_x - cosine * pivot_x - sine * pivot_y,
        -sine,
        cosine,
        pivot_y + sine * pivot_x - cosine * pivot_y,
    )
    rotated = layer.transform(
        image.size,
        Image.Transform.AFFINE,
        inverse,
        resample=Image.Resampling.BICUBIC,
    )
    return Image.alpha_composite(cleared.convert("RGBA"), rotated).convert("RGB")


def repair_tpose_image(
    image_path: Path,
    metrics: dict[str, Any],
    output_root: Path,
) -> dict[str, Any]:
    """Repair safe background/framing defects or request model-based repair."""

    image_path = image_path.resolve(strict=True)
    background_failed = metrics.get("backgroundPassed") is False
    if background_failed and evaluate_background(image_path)["passed"] and _passes_current_pose_gate(metrics):
        with Image.open(image_path) as source:
            source.load()
            repaired = ImageOps.exif_transpose(source).convert("RGB")
        destination = _destination(output_root)
        repaired.save(destination, format="PNG")
        return {
            "applied": True,
            "strategy": "deterministic_recheck",
            "actions": ["qa_recheck"],
            "reason": "旧失败指标在当前确定性门禁下已不成立，保留原图并重新质检",
            "outputPath": str(destination),
        }
    if _has_unsafe_pose_failure(metrics):
        return _result_for_model("姿态偏差需要重绘肢体细节，确定性像素变换不安全")

    arm_error = float(metrics.get("armHorizontalError") or 0)
    pose_failed = MIN_DETERMINISTIC_ARM_ERROR < arm_error <= MAX_DETERMINISTIC_ARM_ERROR
    framing_failed = (
        metrics.get("fullBody") is False
        and metrics.get("keypointsWithinCanvas") is True
        and 0 < float(metrics.get("bodyCoverage") or 0) < 0.42
    )
    if pose_failed and framing_failed:
        return _result_for_model("姿态和构图同时失败，连续像素变换会累积失真")
    border_mean = metrics.get("borderMeanRgb")
    if background_failed and (
        not isinstance(border_mean, list)
        or len(border_mean) != 3
        or not is_light_neutral(border_mean)
    ):
        return _result_for_model("背景不是可安全分离的浅色中性背景")
    if not background_failed and not framing_failed and not pose_failed:
        return _result_for_model("没有可安全执行的确定性背景或构图修复")

    with Image.open(image_path) as source:
        source.load()
        repaired = ImageOps.exif_transpose(source).convert("RGB")
    actions: list[str] = []
    if background_failed:
        if _validated_foreground_bounds(repaired, metrics) is None:
            return _result_for_model("前景包含大量浅色细节，确定性抠图可能擦除角色材质")
        pixels = repaired.load()
        for y in range(repaired.height):
            for x in range(repaired.width):
                if is_light_neutral(pixels[x, y]):
                    pixels[x, y] = (255, 255, 255)
        actions.append("background_matting")

    if framing_failed:
        bounds = _validated_foreground_bounds(repaired, metrics)
        if bounds is None:
            return _result_for_model("前景包含浅色细节或边界不可靠，不能确定性调整构图")
        left, top, right, bottom = bounds
        foreground = repaired.crop((left, top, right + 1, bottom + 1))
        target_width = round(repaired.width * 0.88)
        target_height = round(repaired.height * 0.82)
        scale = min(target_width / foreground.width, target_height / foreground.height)
        resized = foreground.resize(
            (max(1, round(foreground.width * scale)), max(1, round(foreground.height * scale))),
            Image.Resampling.LANCZOS,
        )
        canvas = Image.new("RGB", repaired.size, (255, 255, 255))
        canvas.paste(
            resized,
            ((canvas.width - resized.width) // 2, (canvas.height - resized.height) // 2),
        )
        repaired = canvas
        actions.append("reframe")

    if pose_failed:
        pose_points = metrics.get("poseKeypoints")
        if not isinstance(pose_points, dict):
            return _result_for_model("缺少肢体关键点，不能执行确定性姿态变换")
        right = tuple(_pose_point(pose_points, name) for name in ("rightShoulder", "rightElbow", "rightWrist"))
        left = tuple(_pose_point(pose_points, name) for name in ("leftShoulder", "leftElbow", "leftWrist"))
        if any(point is None for point in (*right, *left)):
            return _result_for_model("肢体关键点不完整，不能执行确定性姿态变换")
        if not _arm_is_safely_segmentable(repaired, right[0], right[1], right[2]) or not _arm_is_safely_segmentable(repaired, left[0], left[1], left[2]):
            return _result_for_model("手臂与浅色背景无法可靠分割，确定性姿态变换不安全")
        right_width = max(8, round(min(math.dist(right[0], right[1]), math.dist(right[1], right[2])) * 0.45))
        left_width = max(8, round(min(math.dist(left[0], left[1]), math.dist(left[1], left[2])) * 0.45))
        repaired = _rotate_arm(repaired, right[0], right[1], right[2], right_width)
        repaired = _rotate_arm(repaired, left[0], left[1], left[2], left_width)
        actions.append("straighten_arms")

    destination = _destination(output_root)
    repaired.save(destination, format="PNG")
    return {
        "applied": True,
        "strategy": (
            "deterministic_combined"
            if len(actions) > 1
            else "deterministic_background"
            if background_failed
            else "deterministic_framing"
            if framing_failed
            else "deterministic_pose"
        ),
        "actions": actions,
        "reason": "已执行可验证的确定性背景/构图修复",
        "outputPath": str(destination),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Deterministically repair a failed T-pose image when safe.")
    parser.add_argument("image", type=Path)
    parser.add_argument("--metrics-json", required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    metrics = json.loads(args.metrics_json)
    if not isinstance(metrics, dict):
        raise ValueError("metrics-json 必须是 JSON 对象")
    print(json.dumps(repair_tpose_image(args.image, metrics, args.output_root), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
