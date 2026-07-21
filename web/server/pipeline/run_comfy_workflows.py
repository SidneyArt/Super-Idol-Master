#!/usr/bin/env python3
"""Run the complete 2D -> 3D -> SkinTokens pipeline."""

from __future__ import annotations

import argparse
import os
import sys

import requests

from comfy_client import (
    DEFAULT_COMFYUI_ROOT,
    add_connection_arguments,
    add_seed_argument,
    client_from_args,
    random_seed,
    server_path_for_artifact,
)
from run_2d_generation import generated_image, run_2d_generation
from run_3d_generation import generated_model, run_3d_generation
from run_3d_skinning import run_3d_skinning


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run 2D generation, 3D generation, and SkinTokens rigging."
    )
    parser.add_argument("--positive", required=True, help="2D positive prompt")
    parser.add_argument("--negative", required=True, help="2D negative prompt")
    parser.add_argument(
        "--comfyui-root",
        default=os.environ.get("COMFYUI_ROOT", DEFAULT_COMFYUI_ROOT),
        help=f"Server-side ComfyUI root (default: {DEFAULT_COMFYUI_ROOT})",
    )
    add_seed_argument(parser)
    add_connection_arguments(parser)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    client = client_from_args(args)
    client.check_ready()
    seed = args.seed if args.seed is not None else random_seed()

    result_2d = run_2d_generation(client, args.positive, args.negative, seed)
    image_path = generated_image(result_2d).local_path

    result_3d = run_3d_generation(client, image_path, seed)
    remote_model = generated_model(result_3d)
    server_mesh_path = server_path_for_artifact(remote_model, args.comfyui_root)

    result_skin = run_3d_skinning(client, server_mesh_path)

    print(f"2D output:   {result_2d.run_dir}")
    print(f"3D output:   {result_3d.run_dir}")
    print(f"Skin output: {result_skin.run_dir}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, TimeoutError, requests.RequestException) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
