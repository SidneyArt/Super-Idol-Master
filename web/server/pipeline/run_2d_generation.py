#!/usr/bin/env python3
"""Run 2D_Gen_QwenImage2512.json with configurable prompts."""

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
    load_workflow,
    random_seed,
)


WORKFLOW_FILE = SCRIPT_DIR / "2D_Gen_QwenImage2512.json"
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp"}


def run_2d_generation(
    client: ComfyUIClient,
    positive_prompt: str,
    negative_prompt: str,
    seed: int,
    workflow_file=WORKFLOW_FILE,
) -> WorkflowResult:
    workflow = load_workflow(Path(workflow_file))
    workflow["268"]["inputs"]["text"] = positive_prompt
    workflow["269"]["inputs"]["text"] = negative_prompt
    workflow["282"]["inputs"]["value"] = seed
    return execute_workflow(client, "2d", workflow)


def generated_image(result: WorkflowResult):
    return find_downloaded_artifact(result, "60", IMAGE_SUFFIXES)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate a 2D character image.")
    parser.add_argument("--positive", required=True, help="Positive prompt")
    parser.add_argument("--negative", required=True, help="Negative prompt")
    parser.add_argument("--workflow-file", default=WORKFLOW_FILE, help="ComfyUI workflow JSON file")
    add_seed_argument(parser)
    add_connection_arguments(parser)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    client = client_from_args(args)
    client.check_ready()
    seed = args.seed if args.seed is not None else random_seed()
    result = run_2d_generation(client, args.positive, args.negative, seed, args.workflow_file)
    print(generated_image(result).local_path)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, TimeoutError, requests.RequestException) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
