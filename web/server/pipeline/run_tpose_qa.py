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
from PIL import Image, ImageOps

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


def evaluate_background(image_path: Path) -> dict[str, Any]:
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

        def is_light_neutral(red: int, green: int, blue: int) -> bool:
            return min(red, green, blue) >= 180 and max(red, green, blue) - min(red, green, blue) <= 55

        def enqueue(x: int, y: int) -> None:
            index = y * width + x
            if visited[index] or not is_light_neutral(*pixels[x, y]):
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
        return {
            "passed": white_ratio >= MIN_WHITE_BORDER_RATIO and connected_white_ratio >= MIN_CONNECTED_BACKGROUND_WHITE_RATIO,
            "whiteBorderRatio": round(white_ratio, 4),
            "connectedBackgroundWhiteRatio": round(connected_white_ratio, 4),
            "connectedBackgroundPixelRatio": round(connected_count / max(width * height, 1), 4),
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
    full_body = (
        body_height >= canvas_height * 0.55
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
        and arm_horizontal_error <= 0.12
        and right_elbow_angle >= 160
        and left_elbow_angle >= 160
        and shoulder_tilt <= 0.10
        and full_body
    )
    passed = critical_pass and score >= 80
    if passed:
        summary = "SDPose 自动检查通过：单人全身、双臂水平、肘部伸直"
    else:
        reasons = []
        if not visible:
            reasons.append("关键点置信度不足")
        if arm_horizontal_error > 0.12:
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
        },
    }


def run_qa(client: ComfyUIClient, image_path: Path, workflow_file=WORKFLOW_FILE) -> dict[str, Any]:
    background = evaluate_background(image_path)
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
    evaluation.setdefault("metrics", {}).update({
        "backgroundPassed": background["passed"],
        "whiteBorderRatio": background["whiteBorderRatio"],
        "connectedBackgroundWhiteRatio": background["connectedBackgroundWhiteRatio"],
        "connectedBackgroundPixelRatio": background["connectedBackgroundPixelRatio"],
        "borderMeanRgb": background["borderMeanRgb"],
        "borderRatio": background["borderRatio"],
        "imageWidth": background["imageWidth"],
        "imageHeight": background["imageHeight"],
    })
    if not background["passed"]:
        evaluation["passed"] = False
        evaluation["score"] = min(int(evaluation.get("score") or 0), 79)
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
