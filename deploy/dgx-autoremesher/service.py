#!/usr/bin/env python3
"""Small private-network HTTP service around Blender and AutoRemesher."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


HOST = os.environ.get("TOPOLOGY_HOST", "0.0.0.0")
PORT = int(os.environ.get("TOPOLOGY_PORT", "8190"))
AUTOREMESHER = os.environ.get("AUTOREMESHER_BIN", "/opt/autoremesher/autoremesher")
BLENDER = os.environ.get("BLENDER_BIN", "/usr/bin/blender")
BRIDGE = Path(os.environ.get("TOPOLOGY_BLENDER_BRIDGE", "/opt/autoremesher-api/blender_bridge.py"))
MAX_INPUT_BYTES = int(os.environ.get("TOPOLOGY_MAX_INPUT_BYTES", str(512 * 1024 * 1024)))
TIMEOUT_SECONDS = int(os.environ.get("TOPOLOGY_JOB_TIMEOUT_SECONDS", "3600"))
TEXTURE_SIZE = int(os.environ.get("TOPOLOGY_TEXTURE_SIZE", "2048"))
WORK_ROOT = Path(os.environ.get("TOPOLOGY_WORK_ROOT", "/var/tmp/autoremesher-api"))
JOB_LOCK = threading.Semaphore(max(1, int(os.environ.get("TOPOLOGY_MAX_CONCURRENCY", "1"))))


def run(command: list[str], cwd: Path, env: dict[str, str] | None = None) -> None:
    result = subprocess.run(
        command,
        cwd=cwd,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        timeout=TIMEOUT_SECONDS,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(f"Command failed ({result.returncode}): {' '.join(command[:3])}\n{result.stdout[-8000:]}")


def validate_glb(path: Path) -> None:
    if not path.is_file() or path.stat().st_size < 20:
        raise RuntimeError("GLB output is missing or empty")
    with path.open("rb") as stream:
        if stream.read(4) != b"glTF":
            raise RuntimeError("Output is not a GLB")


def remesh(work_dir: Path, input_glb: Path, target_quads: int) -> Path:
    input_obj = work_dir / "source.obj"
    output_obj = work_dir / "retopologized.obj"
    output_glb = work_dir / "retopologized.glb"
    report = work_dir / "autoremesher-report.txt"

    run([
        BLENDER, "--background", "--python", str(BRIDGE), "--",
        "export-obj", "--input", str(input_glb), "--output", str(input_obj),
    ], work_dir)

    env = {**os.environ, "QT_QPA_PLATFORM": os.environ.get("QT_QPA_PLATFORM", "offscreen")}
    run([
        AUTOREMESHER,
        "--input", str(input_obj),
        "--output", str(output_obj),
        "--report", str(report),
        "--target-quads", str(target_quads),
        "--edge-scaling", os.environ.get("TOPOLOGY_EDGE_SCALING", "1.0"),
        "--sharp-edge", os.environ.get("TOPOLOGY_SHARP_EDGE", "90.0"),
        "--smooth-normal", os.environ.get("TOPOLOGY_SMOOTH_NORMAL", "0.0"),
        "--adaptivity", os.environ.get("TOPOLOGY_ADAPTIVITY", "1.0"),
    ], work_dir, env)
    if not output_obj.is_file() or output_obj.stat().st_size == 0:
        raise RuntimeError("AutoRemesher did not produce an OBJ")

    run([
        BLENDER, "--background", "--python", str(BRIDGE), "--",
        "rebuild-glb", "--source", str(input_glb), "--topology", str(output_obj),
        "--output", str(output_glb), "--texture-size", str(TEXTURE_SIZE),
    ], work_dir)
    validate_glb(output_glb)
    return output_glb


class Handler(BaseHTTPRequestHandler):
    server_version = "AutoRemesherAPI/1.0"

    def send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if urlparse(self.path).path == "/healthz":
            ready = all(Path(item).is_file() for item in (AUTOREMESHER, BLENDER, BRIDGE))
            self.send_json(HTTPStatus.OK if ready else HTTPStatus.SERVICE_UNAVAILABLE, {
                "ready": ready,
                "architecture": os.uname().machine,
                "maxConcurrency": int(os.environ.get("TOPOLOGY_MAX_CONCURRENCY", "1")),
            })
            return
        self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path != "/v1/remesh":
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            target_quads = int(parse_qs(parsed.query).get("target_quads", ["50000"])[0])
        except ValueError:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid numeric parameter"})
            return
        if length < 20 or length > MAX_INPUT_BYTES:
            self.send_json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "invalid GLB size"})
            return
        if not 1_000 <= target_quads <= 1_000_000:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "target_quads must be between 1,000 and 1,000,000"})
            return
        if not JOB_LOCK.acquire(blocking=False):
            self.send_json(HTTPStatus.TOO_MANY_REQUESTS, {"error": "topology worker is busy"})
            return

        work_dir: Path | None = None
        try:
            WORK_ROOT.mkdir(parents=True, exist_ok=True)
            work_dir = Path(tempfile.mkdtemp(prefix="job-", dir=WORK_ROOT))
            input_glb = work_dir / "input.glb"
            remaining = length
            with input_glb.open("wb") as target:
                while remaining:
                    chunk = self.rfile.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise RuntimeError("request body ended early")
                    target.write(chunk)
                    remaining -= len(chunk)
            validate_glb(input_glb)
            output = remesh(work_dir, input_glb, target_quads)
            size = output.stat().st_size
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "model/gltf-binary")
            self.send_header("Content-Length", str(size))
            self.send_header("X-Topology-Target-Quads", str(target_quads))
            self.end_headers()
            with output.open("rb") as source:
                shutil.copyfileobj(source, self.wfile, 1024 * 1024)
        except (OSError, RuntimeError, subprocess.SubprocessError) as error:
            self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(error)[-8000:]})
        finally:
            if work_dir:
                shutil.rmtree(work_dir, ignore_errors=True)
            JOB_LOCK.release()

    def log_message(self, fmt: str, *args: object) -> None:
        print(f"{self.address_string()} - {fmt % args}", flush=True)


if __name__ == "__main__":
    WORK_ROOT.mkdir(parents=True, exist_ok=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
