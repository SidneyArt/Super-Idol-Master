#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 3 ]]; then
  echo "Usage: bash regression-test.sh INPUT.glb [TARGET_QUADS] [WORK_DIR]" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INPUT_GLB="$(realpath "$1")"
TARGET_QUADS="${2:-50000}"
WORK_DIR="${3:-$(mktemp -d -t autoremesher-regression-XXXXXX)}"
BLENDER_BIN="${BLENDER_BIN:-/usr/bin/blender}"
AUTOREMESHER_BIN="${AUTOREMESHER_BIN:-/opt/autoremesher/run-headless}"
PREPROCESS_MAX_FACES="${TOPOLOGY_PREPROCESS_MAX_FACES:-150000}"
MERGE_DISTANCE_RATIO="${TOPOLOGY_PREPROCESS_MERGE_DISTANCE_RATIO:-0.0000001}"
VOXEL_RESOLUTION="${TOPOLOGY_PREPROCESS_VOXEL_RESOLUTION:-256}"
TEXTURE_SIZE="${TOPOLOGY_TEXTURE_SIZE:-2048}"

mkdir -p "${WORK_DIR}"
WORK_DIR="$(realpath "${WORK_DIR}")"
SOURCE_OBJ="${WORK_DIR}/source.obj"
OUTPUT_OBJ="${WORK_DIR}/retopologized.obj"
OUTPUT_GLB="${WORK_DIR}/retopologized.glb"
REPORT="${WORK_DIR}/autoremesher-report.txt"

"${BLENDER_BIN}" --background --python "${SCRIPT_DIR}/blender_bridge.py" -- \
  export-obj --input "${INPUT_GLB}" --output "${SOURCE_OBJ}" \
  --max-faces "${PREPROCESS_MAX_FACES}" \
  --merge-distance-ratio "${MERGE_DISTANCE_RATIO}" \
  --voxel-resolution "${VOXEL_RESOLUTION}"

QT_QPA_PLATFORM="${QT_QPA_PLATFORM:-xcb}" "${AUTOREMESHER_BIN}" \
  --input "${SOURCE_OBJ}" \
  --output "${OUTPUT_OBJ}" \
  --report "${REPORT}" \
  --target-quads "${TARGET_QUADS}" \
  --edge-scaling "${TOPOLOGY_EDGE_SCALING:-1.0}" \
  --sharp-edge "${TOPOLOGY_SHARP_EDGE:-90.0}" \
  --smooth-normal "${TOPOLOGY_SMOOTH_NORMAL:-0.0}" \
  --adaptivity "${TOPOLOGY_ADAPTIVITY:-0.0}"

"${BLENDER_BIN}" --background --python "${SCRIPT_DIR}/blender_bridge.py" -- \
  rebuild-glb --source "${INPUT_GLB}" --topology "${OUTPUT_OBJ}" \
  --output "${OUTPUT_GLB}" --texture-size "${TEXTURE_SIZE}" \
  --smooth-angle "${TOPOLOGY_SMOOTH_SHADING_ANGLE:-60.0}"

python3 - "${OUTPUT_GLB}" <<'PY'
from pathlib import Path
import sys

output = Path(sys.argv[1])
with output.open("rb") as stream:
    magic = stream.read(4)
if output.stat().st_size < 20 or magic != b"glTF":
    raise SystemExit("Regression output is not a valid GLB")
PY

"${BLENDER_BIN}" --background --python "${SCRIPT_DIR}/blender_bridge.py" -- \
  inspect-glb --input "${OUTPUT_GLB}"

printf 'REGRESSION_OK output=%s bytes=%s\n' "${OUTPUT_GLB}" "$(stat -c %s "${OUTPUT_GLB}")"
