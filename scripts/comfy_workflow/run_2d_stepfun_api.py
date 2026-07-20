#!/usr/bin/env python3
"""Generate a 2D concept image through the Stepfun image edit API."""

from __future__ import annotations

import argparse
import base64
import io
import json
import os
import sys
import uuid
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

import requests
from PIL import Image


REPO_ROOT = Path(__file__).resolve().parents[2]
OUTPUT_ROOT = REPO_ROOT / "output" / "2d-api"
MAX_IMAGE_BYTES = 25 * 1024 * 1024


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run Stepfun 2D image editing")
    parser.add_argument("--positive", required=True)
    parser.add_argument("--negative", default="")
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--source-image")
    return parser.parse_args()


def response_error(response: requests.Response) -> str:
    try:
        payload = response.json()
    except ValueError:
        return response.text.strip() or f"HTTP {response.status_code}"
    return str(payload.get("error", {}).get("message") or payload.get("message") or payload)[:1200]


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

    run_dir = OUTPUT_ROOT / f"{datetime.now():%Y%m%d-%H%M%S}_{uuid.uuid4().hex}"
    run_dir.mkdir(parents=True, exist_ok=False)
    source_path = run_dir / ("source.png" if args.source_image else "blank-source.png")
    if args.source_image:
        input_path = Path(args.source_image).resolve()
        if not input_path.is_file():
            raise RuntimeError("2D API 输入图片不存在")
        try:
            with Image.open(input_path) as source_image:
                source_image.load()
                source_image.convert("RGB").save(source_path, format="PNG")
        except (OSError, ValueError) as error:
            raise RuntimeError("2D API 输入图片不是有效图片") from error
    else:
        Image.new("RGB", (1024, 1024), "white").save(source_path, format="PNG")

    prompt = args.positive.strip()
    if args.negative.strip():
        prompt = f"{prompt}\n请避免以下内容：{args.negative.strip()}"

    session = requests.Session()
    session.trust_env = False
    endpoint = f"{args.base_url.rstrip('/')}/images/edits"
    print(f"[2d-api] submitting model={args.model} endpoint={endpoint}", file=sys.stderr, flush=True)
    with source_path.open("rb") as image_file:
        response = session.post(
            endpoint,
            headers={"Authorization": f"Bearer {api_key}", "Accept": "application/json"},
            data={
                "model": args.model,
                "prompt": prompt,
                "size": "1024x1024",
                "response_format": "b64_json",
            },
            files={"image": (source_path.name, image_file, "image/png")},
            timeout=1800,
        )
    if not response.ok:
        raise RuntimeError(f"图像 API 请求失败：{response_error(response)}")
    try:
        payload = response.json()
    except json.JSONDecodeError as error:
        raise RuntimeError("图像 API 返回了非 JSON 响应") from error

    destination = run_dir / "concept.png"
    save_validated_png(decode_image(payload, session), destination)
    print(destination.resolve())
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, requests.RequestException) as error:
        print(f"[2d-api] {error}", file=sys.stderr)
        raise SystemExit(1)
