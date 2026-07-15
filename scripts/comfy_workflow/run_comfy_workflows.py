#!/usr/bin/env python3
"""Run the project's 2D and 3D ComfyUI API workflows."""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Iterator
from urllib.parse import urljoin

import requests


SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parents[1]
OUTPUT_ROOT = PROJECT_ROOT / "output"
WORKFLOW_2D = SCRIPT_DIR / "2D_Gen_QwenImage2512.json"
WORKFLOW_3D = SCRIPT_DIR / "3D_Gen_Pixal3D.json"
DEFAULT_COMFYUI_URL = "http://100.120.236.113:8188"
POLL_INTERVAL_SECONDS = 5
DOWNLOADABLE_SUFFIXES = {
    ".bin",
    ".gif",
    ".glb",
    ".gltf",
    ".jpeg",
    ".jpg",
    ".json",
    ".mp4",
    ".mtl",
    ".obj",
    ".ply",
    ".png",
    ".stl",
    ".webm",
    ".webp",
    ".zip",
}


@dataclass(frozen=True)
class RemoteArtifact:
    node_id: str
    filename: str
    subfolder: str = ""
    file_type: str = "output"


@dataclass(frozen=True)
class WorkflowResult:
    prompt_id: str
    run_dir: Path
    artifacts: tuple[Path, ...]


class ComfyUIClient:
    def __init__(self, base_url: str, timeout: int = 600) -> None:
        self.base_url = base_url.rstrip("/") + "/"
        self.timeout = timeout
        self.session = requests.Session()

    def _url(self, path: str) -> str:
        return urljoin(self.base_url, path.lstrip("/"))

    def _request_with_api_fallback(
        self,
        method: str,
        path: str,
        **kwargs: Any,
    ) -> requests.Response:
        paths = (f"api/{path.lstrip('/')}", path.lstrip("/"))
        last_response: requests.Response | None = None
        for candidate in paths:
            response = self.session.request(method, self._url(candidate), **kwargs)
            last_response = response
            if response.status_code != 404:
                response.raise_for_status()
                return response
        assert last_response is not None
        last_response.raise_for_status()
        raise RuntimeError(f"ComfyUI endpoint not found: {path}")

    def check_ready(self) -> None:
        response = self._request_with_api_fallback(
            "GET",
            "system_stats",
            timeout=10,
        )
        response.json()

    def upload_image(self, image_path: Path) -> str:
        with image_path.open("rb") as image_file:
            response = self.session.post(
                self._url("upload/image"),
                files={"image": (image_path.name, image_file)},
                data={"overwrite": "true", "type": "input"},
                timeout=60,
            )
        response.raise_for_status()
        payload = response.json()
        name = payload.get("name", image_path.name)
        subfolder = payload.get("subfolder") or ""
        return f"{subfolder}/{name}" if subfolder else name

    def submit(self, workflow: dict[str, Any]) -> str:
        response = self._request_with_api_fallback(
            "POST",
            "prompt",
            json={"prompt": workflow},
            timeout=30,
        )
        payload = response.json()
        if payload.get("error"):
            raise RuntimeError(json.dumps(payload, ensure_ascii=False))
        try:
            return payload["prompt_id"]
        except KeyError as error:
            raise RuntimeError(f"ComfyUI did not return prompt_id: {payload}") from error

    def wait_for_completion(self, prompt_id: str) -> dict[str, Any]:
        deadline = time.monotonic() + self.timeout
        while time.monotonic() < deadline:
            time.sleep(POLL_INTERVAL_SECONDS)
            try:
                response = self._request_with_api_fallback(
                    "GET",
                    f"history/{prompt_id}",
                    timeout=15,
                )
            except requests.RequestException:
                continue

            entry = response.json().get(prompt_id)
            if entry is None:
                continue

            status = entry.get("status", {})
            for message in status.get("messages", []):
                if isinstance(message, list) and message and message[0] == "execution_error":
                    detail = message[1] if len(message) > 1 else message
                    raise RuntimeError(f"ComfyUI execution error: {detail}")

            if status.get("completed") or status.get("status_str") == "success":
                return entry
            if status.get("status_str") in {"error", "failed"}:
                raise RuntimeError(f"ComfyUI workflow failed: {status}")

        raise TimeoutError(
            f"ComfyUI prompt {prompt_id} did not finish within {self.timeout} seconds"
        )

    def download(self, artifact: RemoteArtifact, destination: Path) -> None:
        response = self._request_with_api_fallback(
            "GET",
            "view",
            params={
                "filename": artifact.filename,
                "subfolder": artifact.subfolder,
                "type": artifact.file_type,
            },
            timeout=120,
            stream=True,
        )
        destination.parent.mkdir(parents=True, exist_ok=True)
        with destination.open("wb") as output_file:
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    output_file.write(chunk)


def load_workflow(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def random_seed() -> int:
    return random.randint(1, 2**32 - 1)


def patch_2d_workflow(
    workflow: dict[str, Any],
    positive_prompt: str,
    negative_prompt: str,
    seed: int,
) -> None:
    workflow["268"]["inputs"]["text"] = positive_prompt
    workflow["269"]["inputs"]["text"] = negative_prompt
    workflow["282"]["inputs"]["value"] = seed


def patch_3d_workflow(
    workflow: dict[str, Any],
    uploaded_image_name: str,
    seed: int,
) -> None:
    workflow["122"]["inputs"]["image"] = uploaded_image_name
    workflow["309"]["inputs"]["seed"] = seed
    workflow["313"]["inputs"]["seed"] = seed + 2


def _artifact_from_dict(node_id: str, value: dict[str, Any]) -> RemoteArtifact | None:
    filename = value.get("filename")
    if not isinstance(filename, str) or not filename:
        return None
    return RemoteArtifact(
        node_id=node_id,
        filename=filename,
        subfolder=str(value.get("subfolder") or ""),
        file_type=str(value.get("type") or "output"),
    )


def _walk_artifacts(node_id: str, value: Any) -> Iterator[RemoteArtifact]:
    if isinstance(value, dict):
        artifact = _artifact_from_dict(node_id, value)
        if artifact is not None:
            yield artifact
            return
        for child in value.values():
            yield from _walk_artifacts(node_id, child)
    elif isinstance(value, list):
        for child in value:
            yield from _walk_artifacts(node_id, child)
    elif isinstance(value, str) and Path(value).suffix.lower() in DOWNLOADABLE_SUFFIXES:
        normalized = value.replace("\\", "/")
        remote_path = Path(normalized)
        yield RemoteArtifact(
            node_id=node_id,
            filename=remote_path.name,
            subfolder="/".join(remote_path.parts[:-1]),
        )


def collect_artifacts(outputs: dict[str, Any]) -> list[RemoteArtifact]:
    artifacts: list[RemoteArtifact] = []
    seen: set[tuple[str, str, str]] = set()
    for node_id, node_output in outputs.items():
        for artifact in _walk_artifacts(node_id, node_output):
            key = (artifact.filename, artifact.subfolder, artifact.file_type)
            if key not in seen:
                seen.add(key)
                artifacts.append(artifact)
    return artifacts


def safe_local_filename(artifact: RemoteArtifact, index: int) -> str:
    filename = Path(artifact.filename.replace("\\", "/")).name
    if not filename:
        filename = f"artifact-{index}"
    return f"node-{artifact.node_id}_{index:02d}_{filename}"


def create_run_dir(kind: str, prompt_id: str) -> Path:
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    run_dir = (OUTPUT_ROOT / kind / f"{timestamp}_{prompt_id}").resolve()
    output_root = OUTPUT_ROOT.resolve()
    if output_root not in run_dir.parents:
        raise RuntimeError(f"Refusing to write outside project output directory: {run_dir}")
    run_dir.mkdir(parents=True, exist_ok=False)
    return run_dir


def save_json(path: Path, payload: Any) -> None:
    path.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )


def execute_workflow(
    client: ComfyUIClient,
    kind: str,
    workflow: dict[str, Any],
) -> WorkflowResult:
    prompt_id = client.submit(workflow)
    print(f"[{kind}] submitted prompt_id={prompt_id}", file=sys.stderr)
    history = client.wait_for_completion(prompt_id)
    run_dir = create_run_dir(kind, prompt_id)

    save_json(run_dir / "submitted_workflow.json", workflow)
    save_json(run_dir / "history.json", history)

    local_artifacts: list[Path] = []
    remote_artifacts = collect_artifacts(history.get("outputs", {}))
    for index, artifact in enumerate(remote_artifacts, start=1):
        destination = run_dir / safe_local_filename(artifact, index)
        try:
            client.download(artifact, destination)
        except requests.RequestException as error:
            print(
                f"[{kind}] could not download {artifact.filename}: {error}",
                file=sys.stderr,
            )
            continue
        local_artifacts.append(destination)
        print(f"[{kind}] saved {destination}", file=sys.stderr)

    return WorkflowResult(prompt_id, run_dir, tuple(local_artifacts))


def first_generated_image(result: WorkflowResult) -> Path:
    for artifact in result.artifacts:
        if artifact.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}:
            return artifact
    raise RuntimeError(
        f"The 2D workflow completed but no image was downloaded; inspect {result.run_dir}"
    )


def resolve_input_image(path: str) -> Path:
    image_path = Path(path).expanduser().resolve()
    if not image_path.is_file():
        raise FileNotFoundError(f"Input image does not exist: {image_path}")
    return image_path


def add_connection_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--comfyui-url",
        default=os.environ.get("COMFYUI_URL", DEFAULT_COMFYUI_URL),
        help=f"ComfyUI URL (default: {DEFAULT_COMFYUI_URL})",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=1800,
        help="Maximum wait per workflow in seconds (default: 1800)",
    )
    parser.add_argument(
        "--seed",
        type=int,
        help="Base seed; omitted means a random 32-bit seed",
    )


def add_prompt_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--positive", required=True, help="2D positive prompt")
    parser.add_argument("--negative", required=True, help="2D negative prompt")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Call the Super-Idol-Master ComfyUI workflows."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    parser_2d = subparsers.add_parser("2d", help="Generate a 2D character image")
    add_connection_arguments(parser_2d)
    add_prompt_arguments(parser_2d)

    parser_3d = subparsers.add_parser("3d", help="Generate 3D assets from an image")
    add_connection_arguments(parser_3d)
    parser_3d.add_argument("image", help="Source image path")

    parser_pipeline = subparsers.add_parser(
        "pipeline",
        help="Generate a 2D image and feed it into the 3D workflow",
    )
    add_connection_arguments(parser_pipeline)
    add_prompt_arguments(parser_pipeline)

    return parser.parse_args()


def main() -> int:
    args = parse_args()
    seed = args.seed if args.seed is not None else random_seed()
    client = ComfyUIClient(args.comfyui_url, timeout=args.timeout)

    print(f"Checking ComfyUI at {args.comfyui_url}", file=sys.stderr)
    client.check_ready()

    if args.command in {"2d", "pipeline"}:
        workflow_2d = load_workflow(WORKFLOW_2D)
        patch_2d_workflow(workflow_2d, args.positive, args.negative, seed)
        result_2d = execute_workflow(client, "2d", workflow_2d)
        print(result_2d.run_dir)
        if args.command == "2d":
            return 0
        input_image = first_generated_image(result_2d)
    else:
        input_image = resolve_input_image(args.image)

    uploaded_name = client.upload_image(input_image)
    workflow_3d = load_workflow(WORKFLOW_3D)
    patch_3d_workflow(workflow_3d, uploaded_name, seed)
    result_3d = execute_workflow(client, "3d", workflow_3d)
    print(result_3d.run_dir)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, TimeoutError, requests.RequestException) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
