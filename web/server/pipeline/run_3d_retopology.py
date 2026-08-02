#!/usr/bin/env python3
"""Send a GLB to the DGX AutoRemesher service and save the remeshed GLB."""

from __future__ import annotations

import argparse
import os
import sys
import time
import uuid
from pathlib import Path
from urllib.parse import urlparse

import requests


DEFAULT_TIMEOUT = 60 * 60
DEFAULT_TARGET_QUADS = 50_000
MAX_RESPONSE_BYTES = 512 * 1024 * 1024
MAX_REQUEST_ATTEMPTS = 3
RETRYABLE_HTTP_STATUSES = frozenset({502, 503, 504})


def service_endpoint(base_url: str) -> str:
    value = base_url.strip().rstrip("/")
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("Topology service URL must be an HTTP(S) URL")
    return value if value.endswith("/v1/remesh") else f"{value}/v1/remesh"


def validate_glb(path: Path) -> None:
    if not path.is_file() or path.stat().st_size < 20:
        raise RuntimeError(f"Topology output is not a usable file: {path}")
    with path.open("rb") as stream:
        if stream.read(4) != b"glTF":
            raise RuntimeError("Topology service did not return a GLB")


def response_error_detail(response: requests.Response) -> str:
    try:
        payload = response.json()
    except (requests.RequestException, ValueError):
        payload = None
    if isinstance(payload, dict) and isinstance(payload.get("error"), str):
        return payload["error"][:2_000].strip()
    return response.text[:2_000].strip()


def topology_session() -> requests.Session:
    session = requests.Session()
    # The topology API normally lives on Tailscale or an SSH loopback tunnel.
    # A desktop/corporate proxy cannot route those addresses and commonly
    # answers with an empty 502 instead of reaching the DGX service.
    session.trust_env = False
    return session


def retry_delay(attempt: int) -> int:
    return 2 ** (attempt - 1)


def run_retopology(
    mesh: Path,
    service_url: str,
    output_root: Path,
    target_quads: int,
    timeout: int,
    token: str = "",
) -> Path:
    mesh = mesh.expanduser().resolve()
    validate_glb(mesh)
    if not 1_000 <= target_quads <= 1_000_000:
        raise ValueError("target-quads must be between 1,000 and 1,000,000")

    run_dir = output_root.expanduser().resolve() / uuid.uuid4().hex
    run_dir.mkdir(parents=True, exist_ok=False)
    output_path = run_dir / "retopologized.glb"
    headers = {
        "Content-Type": "model/gltf-binary",
        "Accept": "model/gltf-binary",
        "X-Input-Filename": mesh.name,
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"

    print("[topology] progress=10 message=uploading_glb", file=sys.stderr, flush=True)
    session = topology_session()
    try:
        response: requests.Response | None = None
        for attempt in range(1, MAX_REQUEST_ATTEMPTS + 1):
            with mesh.open("rb") as source:
                response = session.post(
                    service_endpoint(service_url),
                    params={"target_quads": target_quads},
                    data=source,
                    headers=headers,
                    timeout=(30, timeout),
                    stream=True,
                )
            if response.ok:
                break
            detail = response_error_detail(response) or (
                "empty response; verify the topology /healthz endpoint and the Tailscale/SSH route"
            )
            if response.status_code not in RETRYABLE_HTTP_STATUSES or attempt == MAX_REQUEST_ATTEMPTS:
                raise RuntimeError(f"Topology service returned HTTP {response.status_code}: {detail}")
            response.close()
            delay = retry_delay(attempt)
            print(
                f"[topology] retry={attempt} delay={delay} reason=http_{response.status_code}",
                file=sys.stderr,
                flush=True,
            )
            time.sleep(delay)

        assert response is not None
        print("[topology] progress=85 message=downloading_glb", file=sys.stderr, flush=True)
        received = 0
        with output_path.open("wb") as target:
            for chunk in response.iter_content(1024 * 1024):
                if not chunk:
                    continue
                received += len(chunk)
                if received > MAX_RESPONSE_BYTES:
                    raise RuntimeError("Topology service response exceeds 512 MB")
                target.write(chunk)
    finally:
        session.close()
    validate_glb(output_path)
    print("[topology] progress=95 message=validating_glb", file=sys.stderr, flush=True)
    return output_path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Retopologize a GLB through the DGX AutoRemesher service.")
    parser.add_argument("mesh", type=Path, help="Local static GLB")
    parser.add_argument(
        "--service-url",
        default=os.environ.get("TOPOLOGY_SERVICE_URL", ""),
        help="DGX topology service base URL",
    )
    parser.add_argument(
        "--service-token",
        default=os.environ.get("TOPOLOGY_SERVICE_TOKEN", ""),
        help="Optional bearer token",
    )
    parser.add_argument(
        "--output-root",
        type=Path,
        default=Path(os.environ.get("TOPOLOGY_OUTPUT_ROOT", "output/topology")),
    )
    parser.add_argument(
        "--target-quads",
        type=int,
        default=int(os.environ.get("TOPOLOGY_TARGET_QUADS", DEFAULT_TARGET_QUADS)),
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=int(os.environ.get("TOPOLOGY_TIMEOUT_SECONDS", DEFAULT_TIMEOUT)),
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.service_url:
        raise ValueError("TOPOLOGY_SERVICE_URL is not configured")
    result = run_retopology(
        args.mesh,
        args.service_url,
        args.output_root,
        args.target_quads,
        args.timeout,
        args.service_token,
    )
    print(result)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, ValueError, requests.RequestException) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
