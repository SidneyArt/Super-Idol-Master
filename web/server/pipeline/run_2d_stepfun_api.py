#!/usr/bin/env python3
"""Generate or edit a 2D concept image through the StepFun image API."""

from __future__ import annotations

import argparse
import base64
import io
import json
import os
import sys
import uuid
from collections import deque
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

import requests
from PIL import Image, ImageOps


REPO_ROOT = Path(__file__).resolve().parents[3]
OUTPUT_ROOT = REPO_ROOT / "output" / "2d-api"
MAX_IMAGE_BYTES = 25 * 1024 * 1024
MAX_PROMPT_CHARS = 512
MAX_EDIT_IMAGE_DIMENSION = 4096
MIN_EDIT_ASPECT_RATIO = 0.34
MAX_EDIT_ASPECT_RATIO = 2.94
TPOSE_CANVAS_SIZE = 1024
TPOSE_SAFE_MARGIN_RATIO = 0.12
TPOSE_POSITIVE_CONSTRAINTS = (
    "最高优先级：只保留参考图的角色身份和服装。重新生成单人完整全身、严格正视的标准T-Pose，"
    "双臂水平伸直，手腕与肩同高；双手张开且完全空置，不拿任何道具、武器或装备；"
    "纯白背景RGB(255,255,255)，无阴影，四周留白。"
)
TPOSE_NEGATIVE_CONSTRAINTS = (
    "非T-Pose，A-Pose，V-Pose，手臂下垂，手臂倾斜，弯肘，手持物，道具，武器，"
    "非纯白背景，阴影，裁切"
)
STEPFUN_GENERATION_MODELS = {"step-image-edit-2", "step-2x-large", "step-1x-medium"}
STEPFUN_EDIT_MODELS = {"step-image-edit-2"}
CONTENT_BLOCK_MARKERS = (
    "blocked",
    "content_filtered",
    "content filtered",
    "moderation",
    "safety",
    "审核",
    "审查",
    "未审核通过",
)
SAFE_NEGATIVE_PROMPT = "低画质，重复角色，角色重叠，裁切，文字，水印，风格不一致"
SAFE_TPOSE_NEGATIVE_PROMPT = (
    "非T-Pose，A-Pose，V-Pose，手臂下垂，手臂倾斜，弯肘，手持物，道具，"
    "非纯白背景，阴影，裁切"
)


class ContentBlockedError(RuntimeError):
    """The provider rejected either the request or generated image in review."""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run Stepfun 2D image editing")
    parser.add_argument("--positive", required=True)
    parser.add_argument("--negative", default="")
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--source-image")
    parser.add_argument("--tpose-output", action="store_true")
    return parser.parse_args()


def prompt_with_required_constraints(value: str, constraints: str, label: str) -> str:
    prompt = " ".join(value.split()).strip()
    if not prompt:
        raise RuntimeError(f"{label}不能为空")
    separator = "，"
    source_prefix = "原始提示补充："
    available = MAX_PROMPT_CHARS - len(separator) - len(source_prefix) - len(constraints)
    if available <= 0:
        raise RuntimeError(f"{label}的必要约束超过接口字符限制")
    if len(prompt) > available:
        print(
            f"[2d-api] {label}已为 T-Pose 构图硬约束预留字符，原始内容已安全截断",
            file=sys.stderr,
            flush=True,
        )
        prompt = prompt[:available].rstrip(" ，,。")
    # StepFun image-edit follows early instructions more reliably. Keep the
    # non-negotiable pose/background contract first so a long identity prompt
    # or the source image's original pose cannot override it.
    return f"{constraints}{separator}{source_prefix}{prompt}"


def whiten_connected_background(image: Image.Image) -> Image.Image:
    """Replace the dominant light edge background with white without erasing armor highlights."""
    canvas = image.convert("RGB")
    width, height = canvas.size
    pixels = canvas.load()
    edge_samples = []
    for x in range(width):
        edge_samples.extend((pixels[x, 0], pixels[x, height - 1]))
    for y in range(height):
        edge_samples.extend((pixels[0, y], pixels[width - 1, y]))
    edge_samples = [
        color for color in edge_samples
        if min(color) >= 170 and max(color) - min(color) <= 60
    ]
    if not edge_samples:
        return canvas
    background = tuple(sorted(color[channel] for color in edge_samples)[len(edge_samples) // 2] for channel in range(3))
    background_warmth = background[0] - background[2]
    visited = bytearray(width * height)
    queue: deque[tuple[int, int]] = deque()

    def is_background(red: int, green: int, blue: int) -> bool:
        exact_white = min(red, green, blue) >= 250 and max(red, green, blue) - min(red, green, blue) <= 8
        close_to_dominant = (
            min(red, green, blue) >= 170
            and max(abs(red - background[0]), abs(green - background[1]), abs(blue - background[2])) <= 24
            and abs((red - blue) - background_warmth) <= 12
        )
        return exact_white or close_to_dominant

    def enqueue(x: int, y: int) -> None:
        index = y * width + x
        if visited[index] or not is_background(*pixels[x, y]):
            return
        visited[index] = 1
        queue.append((x, y))

    for x in range(width):
        enqueue(x, 0)
        enqueue(x, height - 1)
    for y in range(height):
        enqueue(0, y)
        enqueue(width - 1, y)

    while queue:
        x, y = queue.popleft()
        pixels[x, y] = (255, 255, 255)
        if x > 0:
            enqueue(x - 1, y)
        if x + 1 < width:
            enqueue(x + 1, y)
        if y > 0:
            enqueue(x, y - 1)
        if y + 1 < height:
            enqueue(x, y + 1)
    return canvas


def prepare_tpose_source(input_path: Path, destination: Path) -> None:
    with Image.open(input_path) as source:
        source.load()
        image = whiten_connected_background(ImageOps.exif_transpose(source)).convert("RGBA")
        usable_size = round(TPOSE_CANVAS_SIZE * (1 - 2 * TPOSE_SAFE_MARGIN_RATIO))
        image.thumbnail((usable_size, usable_size), Image.Resampling.LANCZOS)
        canvas = Image.new("RGBA", (TPOSE_CANVAS_SIZE, TPOSE_CANVAS_SIZE), (255, 255, 255, 255))
        offset = (
            (TPOSE_CANVAS_SIZE - image.width) // 2,
            (TPOSE_CANVAS_SIZE - image.height) // 2,
        )
        canvas.alpha_composite(image, offset)
        canvas.convert("RGB").save(destination, format="PNG")


def prepare_edit_source(input_path: Path, destination: Path) -> None:
    with Image.open(input_path) as source:
        source.load()
        image = ImageOps.exif_transpose(source).convert("RGBA")
        image.thumbnail(
            (MAX_EDIT_IMAGE_DIMENSION, MAX_EDIT_IMAGE_DIMENSION),
            Image.Resampling.LANCZOS,
        )
        aspect_ratio = image.width / image.height
        if MIN_EDIT_ASPECT_RATIO <= aspect_ratio <= MAX_EDIT_ASPECT_RATIO:
            image.convert("RGB").save(destination, format="PNG")
            return

        if aspect_ratio < MIN_EDIT_ASPECT_RATIO:
            canvas_size = (round(image.height * MIN_EDIT_ASPECT_RATIO + 0.5), image.height)
        else:
            canvas_size = (image.width, round(image.width / MAX_EDIT_ASPECT_RATIO + 0.5))
        canvas = Image.new("RGBA", canvas_size, (255, 255, 255, 255))
        offset = ((canvas.width - image.width) // 2, (canvas.height - image.height) // 2)
        canvas.alpha_composite(image, offset)
        canvas.convert("RGB").save(destination, format="PNG")


def response_error(response: requests.Response) -> str:
    try:
        payload = response.json()
    except ValueError:
        return response.text.strip() or f"HTTP {response.status_code}"
    return str(payload.get("error", {}).get("message") or payload.get("message") or payload)[:1200]


def normalize_prompt(value: str, label: str) -> str:
    prompt = " ".join(value.split()).strip()
    if not prompt:
        raise RuntimeError(f"{label}不能为空")
    if len(prompt) > MAX_PROMPT_CHARS:
        print(
            f"[2d-api] {label}超过 StepFun 的 {MAX_PROMPT_CHARS} 字符限制，已安全截断",
            file=sys.stderr,
            flush=True,
        )
        prompt = prompt[: MAX_PROMPT_CHARS - 1].rstrip() + "…"
    return prompt


def operation_for(source_image: str | None) -> str:
    return "edit" if source_image else "generation"


def validate_model_usage(base_url: str, model: str, operation: str) -> None:
    parsed = urlparse(base_url)
    if parsed.hostname != "api.stepfun.com":
        return
    if "/step_plan/" in parsed.path and model != "step-image-edit-2":
        raise RuntimeError("Step Plan 图片接口目前只支持 step-image-edit-2")
    allowed = STEPFUN_EDIT_MODELS if operation == "edit" else STEPFUN_GENERATION_MODELS
    if model not in allowed:
        capability = "图像编辑" if operation == "edit" else "文生图"
        raise RuntimeError(f"模型 {model} 不支持 StepFun {capability}接口")


def endpoint_for(base_url: str, operation: str) -> str:
    resource = "edits" if operation == "edit" else "generations"
    return f"{base_url.rstrip('/')}/images/{resource}"


def safe_semantic_rewrite(prompt: str) -> str:
    replacements = (
        ("暗杀", "秘密侦察"),
        ("刺杀", "潜行侦察"),
        ("杀戮", "竞技对抗"),
        ("杀手", "潜行专家"),
        ("刺客", "潜行侦察员"),
        ("鲜血", "红色装饰"),
        ("血腥", "激烈冲突"),
        ("尸体", "训练假人"),
        ("匕首", "装饰性短刃道具"),
        ("枪械", "科幻道具"),
    )
    rewritten = prompt
    for unsafe, safe in replacements:
        rewritten = rewritten.replace(unsafe, safe)
    prefix = "全年龄虚构游戏角色概念设计，不涉及现实人物、真实组织、伤害画面或恐怖内容。"
    return normalize_prompt(f"{prefix}{rewritten}", "安全改写提示词")


def content_block_reason(response: requests.Response, payload: dict | None = None) -> str | None:
    message = response_error(response)
    haystack = message.lower()
    if response.status_code == 451 or any(marker in haystack for marker in CONTENT_BLOCK_MARKERS):
        return message
    if payload:
        items = payload.get("data")
        if isinstance(items, list):
            for item in items:
                finish_reason = str(item.get("finish_reason", "")).lower() if isinstance(item, dict) else ""
                if finish_reason and finish_reason != "success" and any(
                    marker in finish_reason for marker in CONTENT_BLOCK_MARKERS
                ):
                    return finish_reason
    return None


def submit_request(
    session: requests.Session,
    *,
    endpoint: str,
    api_key: str,
    model: str,
    prompt: str,
    negative_prompt: str,
    source_path: Path | None,
) -> requests.Response:
    headers = {"Authorization": f"Bearer {api_key}", "Accept": "application/json"}
    common = {
        "model": model,
        "prompt": prompt,
        "negative_prompt": negative_prompt,
        "response_format": "b64_json",
        "cfg_scale": 1.5,
        "steps": 8,
        "text_mode": False,
    }
    if source_path is None:
        return session.post(
            endpoint,
            headers={**headers, "Content-Type": "application/json"},
            json={**common, "size": "1024x1024"},
            timeout=1800,
        )
    multipart = {key: str(value).lower() if isinstance(value, bool) else str(value) for key, value in common.items()}
    with source_path.open("rb") as image_file:
        return session.post(
            endpoint,
            headers=headers,
            data=multipart,
            files={"image": (source_path.name, image_file, "image/png")},
            timeout=1800,
        )


def parse_payload(response: requests.Response) -> dict:
    if not response.ok:
        reason = content_block_reason(response)
        if reason:
            raise ContentBlockedError(reason)
        raise RuntimeError(f"图像 API 请求失败（HTTP {response.status_code}）：{response_error(response)}")
    try:
        payload = response.json()
    except json.JSONDecodeError as error:
        raise RuntimeError("图像 API 返回了非 JSON 响应") from error
    reason = content_block_reason(response, payload)
    if reason:
        raise ContentBlockedError(reason)
    return payload


def request_with_content_retry(
    session: requests.Session,
    *,
    endpoint: str,
    api_key: str,
    model: str,
    prompt: str,
    negative_prompt: str,
    source_path: Path | None,
    safe_negative_prompt: str = SAFE_NEGATIVE_PROMPT,
) -> dict:
    current_prompt = prompt
    current_negative = negative_prompt
    for attempt in range(2):
        response = submit_request(
            session,
            endpoint=endpoint,
            api_key=api_key,
            model=model,
            prompt=current_prompt,
            negative_prompt=current_negative,
            source_path=source_path,
        )
        try:
            return parse_payload(response)
        except ContentBlockedError as error:
            if attempt == 1:
                raise RuntimeError(
                    "图像 API 内容审核拦截：原始请求及一次全年龄安全语义改写重试均未通过；"
                    "请调整角色名称、动作、道具或场景描述后重试。"
                ) from error
            print(
                "[2d-api] 内容审核拦截首个请求，正在使用全年龄安全语义改写重试一次",
                file=sys.stderr,
                flush=True,
            )
            current_prompt = safe_semantic_rewrite(current_prompt)
            current_negative = safe_negative_prompt
    raise RuntimeError("图像 API 没有返回结果")


def decode_image(payload: dict, session: requests.Session) -> bytes:
    items = payload.get("data")
    if not isinstance(items, list) or not items or not isinstance(items[0], dict):
        raise RuntimeError("图像 API 没有返回 data[0]")
    item = items[0]
    encoded = item.get("b64_json") or item.get("base64")
    if isinstance(encoded, str) and encoded:
        encoded = encoded.split(",", 1)[-1] if encoded.startswith("data:") else encoded
        try:
            return base64.b64decode(encoded, validate=True)
        except ValueError as error:
            raise RuntimeError("图像 API 返回了无效 Base64") from error

    image_url = item.get("url") or item.get("image_url")
    if not isinstance(image_url, str) or not image_url:
        raise RuntimeError("图像 API 没有返回 b64_json 或图片 URL")
    parsed = urlparse(image_url)
    if parsed.scheme not in {"http", "https"}:
        raise RuntimeError("图像 API 返回了不安全的图片 URL")
    response = session.get(image_url, timeout=120)
    response.raise_for_status()
    if len(response.content) > MAX_IMAGE_BYTES:
        raise RuntimeError("图像 API 返回的图片超过 25 MB")
    return response.content


def save_validated_png(data: bytes, destination: Path) -> None:
    if not data or len(data) > MAX_IMAGE_BYTES:
        raise RuntimeError("图像 API 返回的图片为空或超过 25 MB")
    try:
        with Image.open(io.BytesIO(data)) as image:
            image.load()
            image.convert("RGB").save(destination, format="PNG")
    except (OSError, ValueError) as error:
        raise RuntimeError("图像 API 返回的内容不是有效图片") from error


def main() -> int:
    args = parse_args()
    api_key = os.environ.get("STEPFUN_IMAGE_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("2D API Key 未配置")

    operation = operation_for(args.source_image)
    validate_model_usage(args.base_url, args.model, operation)
    if args.tpose_output:
        prompt = prompt_with_required_constraints(args.positive, TPOSE_POSITIVE_CONSTRAINTS, "正向提示词")
        negative_source = args.negative.strip() or "低画质，肢体畸形，手指畸形"
        negative_prompt = prompt_with_required_constraints(
            negative_source,
            TPOSE_NEGATIVE_CONSTRAINTS,
            "负向提示词",
        )
    else:
        prompt = normalize_prompt(args.positive, "正向提示词")
        negative_prompt = " ".join(args.negative.split()).strip()
        if len(negative_prompt) > MAX_PROMPT_CHARS:
            negative_prompt = negative_prompt[: MAX_PROMPT_CHARS - 1].rstrip() + "…"

    run_dir = OUTPUT_ROOT / f"{datetime.now():%Y%m%d-%H%M%S}_{uuid.uuid4().hex}"
    run_dir.mkdir(parents=True, exist_ok=False)
    source_path = run_dir / "source.png" if args.source_image else None
    if args.source_image:
        input_path = Path(args.source_image).resolve()
        if not input_path.is_file():
            raise RuntimeError("2D API 输入图片不存在")
        try:
            if args.tpose_output:
                prepare_tpose_source(input_path, source_path)
            else:
                prepare_edit_source(input_path, source_path)
        except (OSError, ValueError) as error:
            raise RuntimeError("2D API 输入图片不是有效图片") from error

    session = requests.Session()
    session.trust_env = False
    endpoint = endpoint_for(args.base_url, operation)
    print(f"[2d-api] submitting model={args.model} endpoint={endpoint}", file=sys.stderr, flush=True)
    payload = request_with_content_retry(
        session,
        endpoint=endpoint,
        api_key=api_key,
        model=args.model,
        prompt=prompt,
        negative_prompt=negative_prompt,
        source_path=source_path,
        safe_negative_prompt=SAFE_TPOSE_NEGATIVE_PROMPT if args.tpose_output else SAFE_NEGATIVE_PROMPT,
    )

    destination = run_dir / "concept.png"
    save_validated_png(decode_image(payload, session), destination)
    if args.tpose_output:
        with Image.open(destination) as image:
            if image.size != (TPOSE_CANVAS_SIZE, TPOSE_CANVAS_SIZE):
                raise RuntimeError(
                    f"T-Pose 输出尺寸异常：期望 {TPOSE_CANVAS_SIZE}x{TPOSE_CANVAS_SIZE}，"
                    f"实际 {image.width}x{image.height}"
                )
    print(destination.resolve())
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, requests.RequestException) as error:
        print(f"[2d-api] {error}", file=sys.stderr)
        raise SystemExit(1)
