#!/usr/bin/env python3
"""Run SDPose on DGX and evaluate whether an image is a usable full-body T-pose."""

from __future__ import annotations

import argparse
import json
import math
import sys
import uuid
from collections import deque
from pathlib import Path
from typing import Any

import requests
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageOps

from comfy_client import (
    SCRIPT_DIR,
    ComfyUIClient,
    RemoteArtifact,
    add_connection_arguments,
    client_from_args,
    execute_workflow,
    load_workflow,
    resolve_local_file,
    workflow_input_name,
)


WORKFLOW_FILE = SCRIPT_DIR / "TPose_QA_SDPose.json"
MIN_CONFIDENCE = 0.25
BACKGROUND_BORDER_RATIO = 0.08
MIN_WHITE_BORDER_RATIO = 0.96
MIN_CONNECTED_BACKGROUND_WHITE_RATIO = 0.94
WHITE_CHANNEL_MIN = 245
WHITE_CHANNEL_SPREAD_MAX = 12
MIN_BODY_COVERAGE = 0.42
MAX_ARM_HORIZONTAL_ERROR = 0.19
KEYPOINT_CANVAS_MARGIN = 0.01
FOREGROUND_MASK_PADDING = 0.015
FOREGROUND_MASK_DILATION = 0.10
FOREGROUND_MASK_MAX_DIMENSION = 256
MIN_FOREGROUND_ANCHOR_RATIO = 0.002
MAX_FOREGROUND_ANCHOR_RATIO = 0.45
MAX_FOREGROUND_BOX_RATIO = 0.75
MAX_POSE_GROUND_ARTIFACT_RATIO = 0.01


def is_light_neutral(rgb: tuple[int, int, int] | list[float]) -> bool:
    values = [float(value) for value in rgb]
    return min(values) >= 180 and max(values) - min(values) <= 55


def pose_foreground_mask(size: tuple[int, int], metrics: dict[str, Any] | None) -> Image.Image | None:
    points = (metrics or {}).get("poseKeypoints")
    if not isinstance(points, dict):
        return None

    def point(name: str) -> tuple[float, float] | None:
        value = points.get(name)
        if not isinstance(value, list) or len(value) < 2:
            return None
        return float(value[0]), float(value[1])

    names = (
        "nose", "neck", "rightShoulder", "rightElbow", "rightWrist",
        "leftShoulder", "leftElbow", "leftWrist", "rightHip", "rightKnee",
        "rightAnkle", "leftHip", "leftKnee", "leftAnkle",
    )
    resolved = {name: point(name) for name in names}
    if any(value is None for value in resolved.values()):
        return None
    shoulder_width = math.dist(resolved["rightShoulder"], resolved["leftShoulder"])
    if shoulder_width < 4:
        return None
    mask = Image.new("L", size, 0)
    draw = ImageDraw.Draw(mask)

    def line(names_to_draw: tuple[str, ...], width_ratio: float) -> None:
        draw.line(
            [tuple(round(axis) for axis in resolved[name]) for name in names_to_draw],
            fill=255,
            width=max(6, round(shoulder_width * width_ratio)),
            joint="curve",
        )

    line(("rightShoulder", "rightElbow", "rightWrist"), 0.28)
    line(("leftShoulder", "leftElbow", "leftWrist"), 0.28)
    line(("rightHip", "rightKnee", "rightAnkle"), 0.34)
    line(("leftHip", "leftKnee", "leftAnkle"), 0.34)
    torso_mid = (
        (resolved["rightKnee"][0] + resolved["leftKnee"][0]) / 2,
        (resolved["rightKnee"][1] + resolved["leftKnee"][1]) / 2,
    )
    draw.line(
        [tuple(round(axis) for axis in resolved["neck"]), tuple(round(axis) for axis in torso_mid)],
        fill=255,
        width=max(8, round(shoulder_width * 1.35)),
    )
    head_center = (
        (resolved["nose"][0] + resolved["neck"][0]) / 2,
        (resolved["nose"][1] + resolved["neck"][1]) / 2,
    )
    head_rx = shoulder_width * 0.58
    head_ry = max(abs(resolved["neck"][1] - resolved["nose"][1]) * 1.25, shoulder_width * 0.5)
    draw.ellipse(
        (
            round(head_center[0] - head_rx), round(head_center[1] - head_ry),
            round(head_center[0] + head_rx), round(head_center[1] + head_ry),
        ),
        fill=255,
    )
    padding = max(1, round(shoulder_width * 0.04))
    return mask.filter(ImageFilter.MaxFilter(padding * 2 + 1))


def pose_constrained_foreground_mask(image: Image.Image, metrics: dict[str, Any] | None) -> Image.Image | None:
    pose_mask = pose_foreground_mask(image.size, metrics)
    if pose_mask is None:
        return None
    scale = min(1.0, FOREGROUND_MASK_MAX_DIMENSION / max(image.size))
    small_size = (max(1, round(image.width * scale)), max(1, round(image.height * scale)))
    reduced = image.resize(small_size, Image.Resampling.BOX)
    pose_small = pose_mask.resize(small_size, Image.Resampling.NEAREST)
    anchors = bytearray(
        0 if is_light_neutral(pixel) else 1
        for pixel in reduced.get_flattened_data()
    )
    pose_bytes = pose_small.tobytes()
    visited = bytearray(len(anchors))
    retained = Image.new("L", small_size, 0)
    retained_pixels = retained.load()
    points = (metrics or {}).get("poseKeypoints") or {}
    ankle_y = min(float(points["rightAnkle"][1]), float(points["leftAnkle"][1])) * scale
    shoulder_width = abs(float(points["rightShoulder"][0]) - float(points["leftShoulder"][0])) * scale

    for start in range(len(anchors)):
        if not anchors[start] or visited[start]:
            continue
        queue = deque([start])
        visited[start] = 1
        component: list[int] = []
        touches_pose = False
        left, top = small_size[0], small_size[1]
        right = bottom = -1
        while queue:
            index = queue.popleft()
            component.append(index)
            x, y = index % small_size[0], index // small_size[0]
            left, top = min(left, x), min(top, y)
            right, bottom = max(right, x), max(bottom, y)
            touches_pose = touches_pose or pose_bytes[index] > 0
            for neighbor in (index - 1, index + 1, index - small_size[0], index + small_size[0]):
                if neighbor < 0 or neighbor >= len(anchors) or visited[neighbor] or not anchors[neighbor]:
                    continue
                neighbor_x = neighbor % small_size[0]
                if abs(neighbor_x - x) > 1:
                    continue
                visited[neighbor] = 1
                queue.append(neighbor)
        component_width = right - left + 1
        component_height = bottom - top + 1
        looks_like_ground = (
            bottom >= ankle_y - max(2, shoulder_width * 0.1)
            and component_width >= max(8, shoulder_width * 0.8)
            and component_height <= component_width * 0.45
        )
        if touches_pose and not looks_like_ground:
            for index in component:
                retained_pixels[index % small_size[0], index // small_size[0]] = 255

    dilation_radius = max(1, round(min(small_size) * FOREGROUND_MASK_DILATION))
    visual_subject = retained.filter(ImageFilter.MaxFilter(dilation_radius * 2 + 1))
    visual_pixels = visual_subject.load()
    ground_cutoff = max(0, round(ankle_y - max(1, shoulder_width * 0.05)))
    for y in range(ground_cutoff, small_size[1]):
        for x in range(small_size[0]):
            visual_pixels[x, y] = 0
    combined = ImageChops.lighter(pose_small, visual_subject)
    return combined.resize(image.size, Image.Resampling.NEAREST)


def evaluate_background(image_path: Path, pose_metrics: dict[str, Any] | None = None) -> dict[str, Any]:
    with Image.open(image_path) as source:
        source.load()
        image = ImageOps.exif_transpose(source).convert("RGB")
        width, height = image.size
        border = max(2, round(min(width, height) * BACKGROUND_BORDER_RATIO))
        pixels = image.load()
        white_count = 0
        sample_count = 0
        channel_totals = [0, 0, 0]
        for y in range(height):
            for x in range(width):
                if border <= x < width - border and border <= y < height - border:
                    continue
                red, green, blue = pixels[x, y]
                sample_count += 1
                channel_totals[0] += red
                channel_totals[1] += green
                channel_totals[2] += blue
                if min(red, green, blue) >= WHITE_CHANNEL_MIN and max(red, green, blue) - min(red, green, blue) <= WHITE_CHANNEL_SPREAD_MAX:
                    white_count += 1
        white_ratio = white_count / max(sample_count, 1)
        mean_rgb = [round(total / max(sample_count, 1), 2) for total in channel_totals]
        visited = bytearray(width * height)
        queue: deque[tuple[int, int]] = deque()

        # Build a conservative foreground envelope from strongly non-background
        # pixels. White fur and clothing can be edge-connected to a white canvas;
        # excluding the anchored character prevents their shading from lowering
        # the measured background purity. If anchors reach the canvas edge or
        # cover most of the image, the scene is not safely separable and no mask
        # is applied, so colored/complex backgrounds still fail closed.
        anchor_count = 0
        anchor_left, anchor_top = width, height
        anchor_right = anchor_bottom = -1
        for y in range(height):
            for x in range(width):
                if not is_light_neutral(pixels[x, y]):
                    anchor_count += 1
                    anchor_left = min(anchor_left, x)
                    anchor_top = min(anchor_top, y)
                    anchor_right = max(anchor_right, x)
                    anchor_bottom = max(anchor_bottom, y)
        anchor_ratio = anchor_count / max(width * height, 1)
        foreground_bounds: tuple[int, int, int, int] | None = None
        foreground_anchor_bounds: tuple[int, int, int, int] | None = None
        foreground_mask: bytes | None = None
        if anchor_count and MIN_FOREGROUND_ANCHOR_RATIO <= anchor_ratio <= MAX_FOREGROUND_ANCHOR_RATIO:
            left, top, right, bottom = anchor_left, anchor_top, anchor_right, anchor_bottom
            minimum_margin = max(2, round(min(width, height) * KEYPOINT_CANVAS_MARGIN))
            box_ratio = ((right - left + 1) * (bottom - top + 1)) / max(width * height, 1)
            safely_inside_canvas = (
                left >= minimum_margin
                and top >= minimum_margin
                and right < width - minimum_margin
                and bottom < height - minimum_margin
            )
            if safely_inside_canvas and box_ratio <= MAX_FOREGROUND_BOX_RATIO:
                foreground_anchor_bounds = (left, top, right, bottom)
                padding = max(2, round(min(width, height) * FOREGROUND_MASK_PADDING))
                foreground_bounds = (
                    max(0, left - padding),
                    max(0, top - padding),
                    min(width - 1, right + padding),
                    min(height - 1, bottom + padding),
                )
                scale = min(1.0, FOREGROUND_MASK_MAX_DIMENSION / max(width, height))
                mask_width = max(1, round(width * scale))
                mask_height = max(1, round(height * scale))
                reduced = image.resize((mask_width, mask_height), Image.Resampling.BOX)
                anchor_mask = Image.new("L", reduced.size)
                anchor_mask.putdata([0 if is_light_neutral(pixel) else 255 for pixel in reduced.get_flattened_data()])
                dilation_radius = max(1, round(min(mask_width, mask_height) * FOREGROUND_MASK_DILATION))
                foreground = anchor_mask.filter(ImageFilter.MaxFilter(dilation_radius * 2 + 1))
                foreground_mask = foreground.resize((width, height), Image.Resampling.NEAREST).tobytes()

        pose_mask_image = pose_constrained_foreground_mask(image, pose_metrics)
        pose_mask_applied = pose_mask_image is not None
        if pose_mask_image is not None:
            foreground_mask = pose_mask_image.tobytes()

        def is_foreground(x: int, y: int) -> bool:
            if foreground_mask is None:
                return False
            return foreground_mask[y * width + x] > 0

        wide_ground_shadow = False
        if foreground_anchor_bounds is not None:
            _, anchor_top, _, anchor_bottom = foreground_anchor_bounds
            lower_start = max(anchor_top, anchor_bottom - round(height * 0.15))
            for y in range(lower_start, min(height, anchor_bottom + 1)):
                muted = [
                    x for x in range(width)
                    if (not pose_mask_applied or not is_foreground(x, y))
                    and is_light_neutral(pixels[x, y])
                    and not (
                        min(pixels[x, y]) >= WHITE_CHANNEL_MIN
                        and max(pixels[x, y]) - min(pixels[x, y]) <= WHITE_CHANNEL_SPREAD_MAX
                    )
                ]
                if (
                    len(muted) >= width * 0.22
                    and muted[-1] - muted[0] >= width * 0.38
                ):
                    wide_ground_shadow = True
                    break

        def enqueue(x: int, y: int) -> None:
            index = y * width + x
            if visited[index] or is_foreground(x, y) or not is_light_neutral(pixels[x, y]):
                return
            visited[index] = 1
            queue.append((x, y))

        for x in range(width):
            enqueue(x, 0)
            enqueue(x, height - 1)
        for y in range(height):
            enqueue(0, y)
            enqueue(width - 1, y)

        connected_count = 0
        connected_white_count = 0
        while queue:
            x, y = queue.popleft()
            red, green, blue = pixels[x, y]
            connected_count += 1
            if min(red, green, blue) >= WHITE_CHANNEL_MIN and max(red, green, blue) - min(red, green, blue) <= WHITE_CHANNEL_SPREAD_MAX:
                connected_white_count += 1
            if x > 0:
                enqueue(x - 1, y)
            if x + 1 < width:
                enqueue(x + 1, y)
            if y > 0:
                enqueue(x, y - 1)
            if y + 1 < height:
                enqueue(x, y + 1)

        connected_white_ratio = connected_white_count / max(connected_count, 1)
        outside_count = 0
        outside_white_count = 0
        pose_ground_artifact_count = 0
        pose_ground_start = round(height * 0.5)
        pose_points = (pose_metrics or {}).get("poseKeypoints")
        if isinstance(pose_points, dict):
            ankle_values = [pose_points.get(name, [0, 0])[1] for name in ("rightAnkle", "leftAnkle")]
            if all(isinstance(value, (int, float)) for value in ankle_values):
                pose_ground_start = max(0, round(min(ankle_values)))
        if pose_mask_applied:
            for y in range(height):
                for x in range(width):
                    if is_foreground(x, y):
                        continue
                    outside_count += 1
                    red, green, blue = pixels[x, y]
                    is_white = min(red, green, blue) >= WHITE_CHANNEL_MIN and max(red, green, blue) - min(red, green, blue) <= WHITE_CHANNEL_SPREAD_MAX
                    if is_white:
                        outside_white_count += 1
                    elif y >= pose_ground_start:
                        pose_ground_artifact_count += 1
        pose_background_white_ratio = outside_white_count / max(outside_count, 1) if pose_mask_applied else None
        pose_ground_artifact_ratio = pose_ground_artifact_count / max(width * height, 1) if pose_mask_applied else None
        return {
            "passed": (
                white_ratio >= MIN_WHITE_BORDER_RATIO
                and connected_white_ratio >= MIN_CONNECTED_BACKGROUND_WHITE_RATIO
                and not wide_ground_shadow
                and (pose_background_white_ratio is None or pose_background_white_ratio >= MIN_CONNECTED_BACKGROUND_WHITE_RATIO)
                and (pose_ground_artifact_ratio is None or pose_ground_artifact_ratio <= MAX_POSE_GROUND_ARTIFACT_RATIO)
            ),
            "whiteBorderRatio": round(white_ratio, 4),
            "connectedBackgroundWhiteRatio": round(connected_white_ratio, 4),
            "connectedBackgroundPixelRatio": round(connected_count / max(width * height, 1), 4),
            "foregroundMaskApplied": foreground_bounds is not None,
            "foregroundBounds": list(foreground_bounds) if foreground_bounds is not None else None,
            "foregroundAnchorBounds": list(foreground_anchor_bounds) if foreground_anchor_bounds is not None else None,
            "wideGroundShadowDetected": wide_ground_shadow,
            "poseForegroundMaskApplied": pose_mask_applied,
            "poseBackgroundWhiteRatio": round(pose_background_white_ratio, 4) if pose_background_white_ratio is not None else None,
            "poseGroundArtifactRatio": round(pose_ground_artifact_ratio, 4) if pose_ground_artifact_ratio is not None else None,
            "borderMeanRgb": mean_rgb,
            "borderRatio": BACKGROUND_BORDER_RATIO,
            "imageWidth": width,
            "imageHeight": height,
        }


def _points(value: list[float]) -> list[tuple[float, float, float]]:
    return [
        (float(value[index]), float(value[index + 1]), float(value[index + 2]))
        for index in range(0, len(value) - 2, 3)
    ]


def _angle(a: tuple[float, float, float], b: tuple[float, float, float], c: tuple[float, float, float]) -> float:
    ba = (a[0] - b[0], a[1] - b[1])
    bc = (c[0] - b[0], c[1] - b[1])
    denominator = math.hypot(*ba) * math.hypot(*bc)
    if denominator == 0:
        return 0.0
    cosine = max(-1.0, min(1.0, (ba[0] * bc[0] + ba[1] * bc[1]) / denominator))
    return math.degrees(math.acos(cosine))


def evaluate_pose(payload: list[dict[str, Any]]) -> dict[str, Any]:
    if not payload:
        return {"passed": False, "score": 0, "summary": "SDPose 未返回画面", "metrics": {}}

    frame = payload[0]
    people = frame.get("people") or []
    if len(people) != 1:
        return {
            "passed": False,
            "score": 0,
            "summary": f"需要且只能有 1 个人物，检测到 {len(people)} 个",
            "metrics": {"personCount": len(people)},
        }

    body = _points(people[0].get("pose_keypoints_2d") or [])
    if len(body) < 14:
        return {"passed": False, "score": 5, "summary": "人体关键点数量不足", "metrics": {}}

    # OpenPose body order: nose, neck, R shoulder/elbow/wrist, L shoulder/elbow/wrist,
    # R hip/knee/ankle, L hip/knee/ankle.
    nose, neck = body[0], body[1]
    right_shoulder, right_elbow, right_wrist = body[2], body[3], body[4]
    left_shoulder, left_elbow, left_wrist = body[5], body[6], body[7]
    right_hip, right_knee, right_ankle = body[8], body[9], body[10]
    left_hip, left_knee, left_ankle = body[11], body[12], body[13]
    required = [
        nose, neck, right_shoulder, right_elbow, right_wrist,
        left_shoulder, left_elbow, left_wrist, right_hip, right_knee,
        right_ankle, left_hip, left_knee, left_ankle,
    ]
    min_confidence = min(point[2] for point in required)
    visible = min_confidence >= MIN_CONFIDENCE

    shoulder_width = max(abs(left_shoulder[0] - right_shoulder[0]), 1.0)
    canvas_width = float(frame.get("canvas_width") or 1)
    canvas_height = float(frame.get("canvas_height") or 1)
    arm_horizontal_error = max(
        abs(right_elbow[1] - right_shoulder[1]),
        abs(right_wrist[1] - right_shoulder[1]),
        abs(left_elbow[1] - left_shoulder[1]),
        abs(left_wrist[1] - left_shoulder[1]),
    ) / shoulder_width
    right_elbow_angle = _angle(right_shoulder, right_elbow, right_wrist)
    left_elbow_angle = _angle(left_shoulder, left_elbow, left_wrist)
    shoulder_tilt = abs(left_shoulder[1] - right_shoulder[1]) / shoulder_width
    hip_width = max(abs(left_hip[0] - right_hip[0]), 1.0)
    hip_tilt = abs(left_hip[1] - right_hip[1]) / hip_width
    body_height = max(left_ankle[1], right_ankle[1]) - nose[1]
    required_x = [point[0] for point in required]
    required_y = [point[1] for point in required]
    pose_bounds = [min(required_x), min(required_y), max(required_x), max(required_y)]
    keypoints_within_canvas = (
        min(required_x) >= canvas_width * KEYPOINT_CANVAS_MARGIN
        and max(required_x) <= canvas_width * (1 - KEYPOINT_CANVAS_MARGIN)
        and min(required_y) >= canvas_height * KEYPOINT_CANVAS_MARGIN
        and max(required_y) <= canvas_height * (1 - KEYPOINT_CANVAS_MARGIN)
    )
    full_body = (
        visible
        and keypoints_within_canvas
        and body_height >= canvas_height * MIN_BODY_COVERAGE
        and nose[1] < min(left_hip[1], right_hip[1])
        and max(left_hip[1], right_hip[1]) < min(left_ankle[1], right_ankle[1])
    )
    shoulder_mid_x = (left_shoulder[0] + right_shoulder[0]) / 2
    hip_mid_x = (left_hip[0] + right_hip[0]) / 2
    torso_center_error = abs(shoulder_mid_x - hip_mid_x) / canvas_width
    right_span = abs(right_wrist[0] - right_shoulder[0])
    left_span = abs(left_wrist[0] - left_shoulder[0])
    arm_symmetry_error = abs(right_span - left_span) / max(right_span, left_span, 1.0)

    score = 15  # exactly one person
    score += 20 if visible else max(0, round(20 * min_confidence / MIN_CONFIDENCE))
    score += max(0, round(20 * (1 - arm_horizontal_error / 0.20)))
    score += max(0, round(10 * min(right_elbow_angle, left_elbow_angle) / 175))
    score += 10 if shoulder_tilt <= 0.08 and hip_tilt <= 0.18 else 3
    score += 15 if full_body else 0
    score += max(0, round(10 * (1 - max(torso_center_error / 0.08, arm_symmetry_error / 0.25))))
    score = max(0, min(100, score))

    critical_pass = (
        visible
        and arm_horizontal_error <= MAX_ARM_HORIZONTAL_ERROR
        and right_elbow_angle >= 160
        and left_elbow_angle >= 160
        and shoulder_tilt <= 0.10
        and full_body
    )
    passed = critical_pass and score >= 80
    if passed:
        summary = f"SDPose 自动检查通过：综合得分 {score}（通过线 {TPOSE_PASS_SCORE}）"
    else:
        reasons = []
        if not visible:
            reasons.append("关键点置信度不足")
        if arm_horizontal_error > MAX_ARM_HORIZONTAL_ERROR:
            reasons.append("双臂不够水平")
        if min(right_elbow_angle, left_elbow_angle) < 160:
            reasons.append("肘部未充分伸直")
        if shoulder_tilt > 0.10:
            reasons.append("肩线倾斜")
        if not full_body:
            reasons.append("未识别到完整全身")
        summary = "SDPose 自动检查未通过：" + "、".join(reasons or ["综合得分不足"])

    return {
        "passed": passed,
        "score": score,
        "summary": summary,
        "metrics": {
            "personCount": 1,
            "minConfidence": round(min_confidence, 4),
            "armHorizontalError": round(arm_horizontal_error, 4),
            "rightElbowAngle": round(right_elbow_angle, 2),
            "leftElbowAngle": round(left_elbow_angle, 2),
            "shoulderTilt": round(shoulder_tilt, 4),
            "hipTilt": round(hip_tilt, 4),
            "torsoCenterError": round(torso_center_error, 4),
            "armSymmetryError": round(arm_symmetry_error, 4),
            "bodyCoverage": round(body_height / canvas_height, 4),
            "fullBody": full_body,
            "keypointsWithinCanvas": keypoints_within_canvas,
            "poseKeypoints": {
                "nose": list(nose),
                "neck": list(neck),
                "rightShoulder": list(right_shoulder),
                "rightElbow": list(right_elbow),
                "rightWrist": list(right_wrist),
                "leftShoulder": list(left_shoulder),
                "leftElbow": list(left_elbow),
                "leftWrist": list(left_wrist),
                "rightHip": list(right_hip),
                "rightKnee": list(right_knee),
                "rightAnkle": list(right_ankle),
                "leftHip": list(left_hip),
                "leftKnee": list(left_knee),
                "leftAnkle": list(left_ankle),
            },
            "poseBounds": [round(value, 2) for value in pose_bounds],
        },
    }


def run_qa(client: ComfyUIClient, image_path: Path, workflow_file=WORKFLOW_FILE) -> dict[str, Any]:
    uploaded = client.upload_file(image_path)
    token = uuid.uuid4().hex
    prefix = f"sim_tpose_qa/{token}"
    workflow = load_workflow(Path(workflow_file))
    workflow["1"]["inputs"]["image"] = workflow_input_name(uploaded)
    workflow["4"]["inputs"]["filename_prefix"] = prefix
    result = execute_workflow(client, "qa", workflow)
    keypoint_file = result.run_dir / "pose_keypoints.json"
    client.download(
        RemoteArtifact("4", f"{token}_00001.json", "sim_tpose_qa", "output"),
        keypoint_file,
    )
    evaluation = evaluate_pose(json.loads(keypoint_file.read_text(encoding="utf-8")))
    background = evaluate_background(image_path, evaluation.get("metrics"))
    anchor_bounds = background["foregroundAnchorBounds"]
    pose_bounds = evaluation.get("metrics", {}).get("poseBounds")
    subject_bounds = None
    if isinstance(anchor_bounds, list) and isinstance(pose_bounds, list):
        width, height = background["imageWidth"], background["imageHeight"]
        padding = max(2, round(min(width, height) * 0.04))
        subject_bounds = [
            max(0, round(min(anchor_bounds[0], pose_bounds[0])) - padding),
            max(0, round(min(anchor_bounds[1], pose_bounds[1])) - padding),
            min(width - 1, round(max(anchor_bounds[2], pose_bounds[2])) + padding),
            min(height - 1, round(max(anchor_bounds[3], pose_bounds[3])) + padding),
        ]
    evaluation.setdefault("metrics", {}).update({
        "backgroundPassed": background["passed"],
        "whiteBorderRatio": background["whiteBorderRatio"],
        "connectedBackgroundWhiteRatio": background["connectedBackgroundWhiteRatio"],
        "connectedBackgroundPixelRatio": background["connectedBackgroundPixelRatio"],
        "foregroundMaskApplied": background["foregroundMaskApplied"],
        "foregroundBounds": background["foregroundBounds"],
        "foregroundAnchorBounds": background["foregroundAnchorBounds"],
        "wideGroundShadowDetected": background["wideGroundShadowDetected"],
        "poseForegroundMaskApplied": background["poseForegroundMaskApplied"],
        "poseBackgroundWhiteRatio": background["poseBackgroundWhiteRatio"],
        "poseGroundArtifactRatio": background["poseGroundArtifactRatio"],
        "subjectBounds": subject_bounds,
        "borderMeanRgb": background["borderMeanRgb"],
        "borderRatio": background["borderRatio"],
        "imageWidth": background["imageWidth"],
        "imageHeight": background["imageHeight"],
    })
    if not background["passed"]:
        evaluation["passed"] = False
        evaluation["score"] = min(int(evaluation.get("score") or 0), TPOSE_PASS_SCORE - 1)
        background_reason = (
            f"背景不是纯白（边缘纯白占比 {background['whiteBorderRatio']:.1%}，"
            f"连通背景纯白占比 {background['connectedBackgroundWhiteRatio']:.1%}）"
        )
        current_summary = str(evaluation.get("summary") or "").rstrip("。")
        evaluation["summary"] = f"{current_summary}；{background_reason}" if current_summary else background_reason
    evaluation.update({
        "promptId": result.prompt_id,
        "keypointsPath": str(keypoint_file),
        "overlayPath": str(result.downloads[0].local_path) if result.downloads else None,
    })
    return evaluation


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Automatically validate a T-pose with DGX SDPose.")
    parser.add_argument("image", help="Local input image")
    parser.add_argument("--workflow-file", default=WORKFLOW_FILE, help="ComfyUI workflow JSON file")
    add_connection_arguments(parser)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    client = client_from_args(args)
    client.check_ready()
    print(json.dumps(run_qa(client, resolve_local_file(args.image), args.workflow_file), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, TimeoutError, ValueError, requests.RequestException) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
