#!/usr/bin/env python3
"""Run 3D_Skin_SkinTokens.json with one mesh_path input."""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import requests

from comfy_client import (
    DEFAULT_COMFYUI_ROOT,
    SCRIPT_DIR,
    ComfyUIClient,
    WorkflowResult,
    add_connection_arguments,
    client_from_args,
    execute_workflow,
    load_workflow,
    server_path_for_artifact,
)


WORKFLOW_FILE = SCRIPT_DIR / "3D_Skin_SkinTokens.json"


def run_3d_skinning(
    client: ComfyUIClient,
    server_mesh_path: str,
    workflow_file=WORKFLOW_FILE,
) -> WorkflowResult:
    workflow = load_workflow(Path(workflow_file))
    workflow["23"]["inputs"]["mesh_path"] = server_mesh_path

    # This disconnected preview branch points at a stale exported model and is
    # unrelated to SkinTokens generation. Keep the submitted graph single-input.
    for node_id in ("27", "28", "29"):
        workflow.pop(node_id, None)
    return execute_workflow(client, "skin", workflow)


def resolve_server_mesh_path(
    client: ComfyUIClient,
    value: str,
    comfyui_root: str,
) -> str:
    local_path = Path(value).expanduser()
    if local_path.is_file():
        uploaded = client.upload_file(local_path.resolve())
        return server_path_for_artifact(uploaded, comfyui_root)
    if value.startswith("/"):
        return value
    raise FileNotFoundError(
        "Mesh must be an existing local GLB or an absolute path on the ComfyUI server: "
        f"{value}"
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Rig a 3D model with SkinTokens.")
    parser.add_argument(
        "mesh",
        help="Local GLB file or absolute mesh path on the ComfyUI server",
    )
    parser.add_argument("--workflow-file", default=WORKFLOW_FILE, help="ComfyUI workflow JSON file")
    parser.add_argument(
        "--comfyui-root",
        default=os.environ.get("COMFYUI_ROOT", DEFAULT_COMFYUI_ROOT),
        help=f"Server-side ComfyUI root (default: {DEFAULT_COMFYUI_ROOT})",
    )
    add_connection_arguments(parser)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    client = client_from_args(args)
    client.check_ready()
    mesh_path = resolve_server_mesh_path(client, args.mesh, args.comfyui_root)
    result = run_3d_skinning(client, mesh_path, args.workflow_file)
    print(result.run_dir)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, TimeoutError, requests.RequestException) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
