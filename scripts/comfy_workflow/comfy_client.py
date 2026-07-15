"""Shared ComfyUI HTTP client and output handling for project workflows."""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path, PurePosixPath
from typing import Any, Iterator
from urllib.parse import urljoin

import requests


SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parents[1]
OUTPUT_ROOT = PROJECT_ROOT / "output"
DEFAULT_COMFYUI_URL = "http://100.120.236.113:8188"
DEFAULT_COMFYUI_ROOT = "/home/sidney/comfy/ComfyUI"
POLL_INTERVAL_SECONDS = 5
DOWNLOADABLE_SUFFIXES = {
    ".bin", ".gif", ".glb", ".gltf", ".jpeg", ".jpg", ".json",
    ".mp4", ".mtl", ".obj", ".ply", ".png", ".stl", ".webm",
    ".webp", ".zip",
}


@dataclass(frozen=True)
class RemoteArtifact:
    node_id: str
    filename: str
    subfolder: str = ""
    file_type: str = "output"


@dataclass(frozen=True)
class DownloadedArtifact:
    remote: RemoteArtifact
    local_path: Path


@dataclass(frozen=True)
class WorkflowResult:
    prompt_id: str
    run_dir: Path
    remote_artifacts: tuple[RemoteArtifact, ...]
    downloads: tuple[DownloadedArtifact, ...]


class ComfyUIClient:
    def __init__(self, base_url: str, timeout: int = 1800) -> None:
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
        last_response: requests.Response | None = None
        for candidate in (f"api/{path.lstrip('/')}", path.lstrip("/")):
            response = self.session.request(method, self._url(candidate), **kwargs)
            last_response = response
            if response.status_code != 404:
                response.raise_for_status()
                return response
            response.close()
        assert last_response is not None
        last_response.raise_for_status()
        raise RuntimeError(f"ComfyUI endpoint not found: {path}")

    def check_ready(self) -> None:
        response = self._request_with_api_fallback(
            "GET", "system_stats", timeout=10
        )
        response.json()

    def upload_file(self, file_path: Path) -> RemoteArtifact:
        with file_path.open("rb") as input_file:
            response = self.session.post(
                self._url("upload/image"),
                files={"image": (file_path.name, input_file)},
                data={"overwrite": "true", "type": "input"},
                timeout=120,
            )
        response.raise_for_status()
        payload = response.json()
        return RemoteArtifact(
            node_id="upload",
            filename=str(payload.get("name") or file_path.name),
            subfolder=str(payload.get("subfolder") or ""),
            file_type=str(payload.get("type") or "input"),
        )

    def submit(self, workflow: dict[str, Any]) -> str:
        response = self._request_with_api_fallback(
            "POST", "prompt", json={"prompt": workflow}, timeout=30
        )
        payload = response.json()
        if payload.get("error"):
            raise RuntimeError(json.dumps(payload, ensure_ascii=False))
        if "prompt_id" not in payload:
            raise RuntimeError(f"ComfyUI did not return prompt_id: {payload}")
        return str(payload["prompt_id"])

    def wait_for_completion(self, prompt_id: str) -> dict[str, Any]:
        deadline = time.monotonic() + self.timeout
        while time.monotonic() < deadline:
            time.sleep(POLL_INTERVAL_SECONDS)
            try:
                response = self._request_with_api_fallback(
                    "GET", f"history/{prompt_id}", timeout=15
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


def resolve_local_file(value: str) -> Path:
    path = Path(value).expanduser().resolve()
    if not path.is_file():
        raise FileNotFoundError(f"Input file does not exist: {path}")
    return path


def workflow_input_name(artifact: RemoteArtifact) -> str:
    return (
        f"{artifact.subfolder}/{artifact.filename}"
        if artifact.subfolder
        else artifact.filename
    )


def server_path_for_artifact(
    artifact: RemoteArtifact,
    comfyui_root: str,
) -> str:
    parts = [comfyui_root.rstrip("/"), artifact.file_type]
    if artifact.subfolder:
        parts.append(artifact.subfolder.strip("/"))
    parts.append(artifact.filename)
    return str(PurePosixPath(*parts))


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


def _artifact_from_string(node_id: str, value: str) -> RemoteArtifact | None:
    normalized = value.replace("\\", "/")
    if Path(normalized).suffix.lower() not in DOWNLOADABLE_SUFFIXES:
        return None

    for file_type in ("output", "temp", "input"):
        marker = f"/{file_type}/"
        if marker in normalized:
            relative = normalized.split(marker, 1)[1]
            path = PurePosixPath(relative)
            return RemoteArtifact(
                node_id=node_id,
                filename=path.name,
                subfolder=str(path.parent) if str(path.parent) != "." else "",
                file_type=file_type,
            )

    path = PurePosixPath(normalized)
    return RemoteArtifact(
        node_id=node_id,
        filename=path.name,
        subfolder=str(path.parent) if not path.is_absolute() and str(path.parent) != "." else "",
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
    elif isinstance(value, str):
        artifact = _artifact_from_string(node_id, value)
        if artifact is not None:
            yield artifact


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


def _safe_local_filename(artifact: RemoteArtifact, index: int) -> str:
    filename = PurePosixPath(artifact.filename.replace("\\", "/")).name
    return f"node-{artifact.node_id}_{index:02d}_{filename or f'artifact-{index}'}"


def _create_run_dir(kind: str, prompt_id: str) -> Path:
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    run_dir = (OUTPUT_ROOT / kind / f"{timestamp}_{prompt_id}").resolve()
    output_root = OUTPUT_ROOT.resolve()
    if output_root not in run_dir.parents:
        raise RuntimeError(f"Refusing to write outside project output directory: {run_dir}")
    run_dir.mkdir(parents=True, exist_ok=False)
    return run_dir


def _save_json(path: Path, payload: Any) -> None:
    path.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8"
    )


def execute_workflow(
    client: ComfyUIClient,
    kind: str,
    workflow: dict[str, Any],
) -> WorkflowResult:
    prompt_id = client.submit(workflow)
    print(f"[{kind}] submitted prompt_id={prompt_id}", file=sys.stderr)
    history = client.wait_for_completion(prompt_id)
    run_dir = _create_run_dir(kind, prompt_id)
    _save_json(run_dir / "submitted_workflow.json", workflow)
    _save_json(run_dir / "history.json", history)

    remote_artifacts = tuple(collect_artifacts(history.get("outputs", {})))
    downloads: list[DownloadedArtifact] = []
    for index, artifact in enumerate(remote_artifacts, start=1):
        destination = run_dir / _safe_local_filename(artifact, index)
        try:
            client.download(artifact, destination)
        except requests.RequestException as error:
            print(
                f"[{kind}] could not download {artifact.filename}: {error}",
                file=sys.stderr,
            )
            continue
        downloads.append(DownloadedArtifact(artifact, destination))
        print(f"[{kind}] saved {destination}", file=sys.stderr)

    _save_json(
        run_dir / "artifacts.json",
        [
            {
                "remote": asdict(item.remote),
                "local_path": str(item.local_path),
            }
            for item in downloads
        ],
    )
    return WorkflowResult(prompt_id, run_dir, remote_artifacts, tuple(downloads))


def find_remote_artifact(
    result: WorkflowResult,
    node_id: str,
    suffixes: set[str],
) -> RemoteArtifact:
    for artifact in result.remote_artifacts:
        if artifact.node_id == node_id and Path(artifact.filename).suffix.lower() in suffixes:
            return artifact
    raise RuntimeError(
        f"Workflow completed but node {node_id} returned no expected artifact; "
        f"inspect {result.run_dir}"
    )


def find_downloaded_artifact(
    result: WorkflowResult,
    node_id: str,
    suffixes: set[str],
) -> DownloadedArtifact:
    for item in result.downloads:
        if item.remote.node_id == node_id and item.local_path.suffix.lower() in suffixes:
            return item
    raise RuntimeError(
        f"Workflow completed but node {node_id} artifact was not downloaded; "
        f"inspect {result.run_dir}"
    )


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
        help="Maximum workflow wait in seconds (default: 1800)",
    )


def add_seed_argument(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--seed", type=int, help="Base seed; omitted means a random 32-bit seed"
    )


def client_from_args(args: argparse.Namespace) -> ComfyUIClient:
    return ComfyUIClient(args.comfyui_url, timeout=args.timeout)
