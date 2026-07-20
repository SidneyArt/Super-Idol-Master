#!/usr/bin/env python3
"""Run 3D_Gen_Pixal3D.json with a local input image."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import requests

from comfy_client import (
    SCRIPT_DIR,
    ComfyUIClient,
    WorkflowResult,
    add_connection_arguments,
    add_seed_argument,
    client_from_args,
    execute_workflow,
    find_downloaded_artifact,
    find_remote_artifact,
    load_workflow,
    random_seed,
    resolve_local_file,
    workflow_input_name,
)


WORKFLOW_FILE = SCRIPT_DIR / "3D_Gen_Pixal3D.json"
MODEL_SUFFIXES = {".glb"}


def run_3d_generation(
    client: ComfyUIClient,
    image_path: Path,
    seed: int,
    workflow_file=WORKFLOW_FILE,
) -> WorkflowResult:
    uploaded = client.upload_file(image_path)
    workflow = load_workflow(Path(workflow_file))
    workflow["122"]["inputs"]["image"] = workflow_input_name(uploaded)
    workflow["309"]["inputs"]["seed"] = seed
    workflow["313"]["inputs"]["seed"] = seed + 2
    return execute_workflow(client, "3d", workflow)


def generated_model(result: WorkflowResult):
    return find_remote_artifact(result, "308", MODEL_SUFFIXES)


def downloaded_model(result: WorkflowResult):
    return find_downloaded_artifact(result, "308", MODEL_SUFFIXES)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate a 3D model from an image.")
    parser.add_argument("image", help="Local input image")
    parser.add_argument("--workflow-file", default=WORKFLOW_FILE, help="ComfyUI workflow JSON file")
    add_seed_argument(parser)
    add_connection_arguments(parser)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    client = client_from_args(args)
    client.check_ready()
    seed = args.seed if args.seed is not None else random_seed()
    result = run_3d_generation(client, resolve_local_file(args.image), seed, args.workflow_file)
    print(downloaded_model(result).local_path)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, TimeoutError, requests.RequestException) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
