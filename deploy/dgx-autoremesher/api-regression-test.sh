#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 || $# -gt 4 ]]; then
  echo "Usage: bash api-regression-test.sh API_URL INPUT.glb [TARGET_QUADS] [OUTPUT.glb]" >&2
  exit 2
fi

API_URL="${1%/}"
INPUT_GLB="$(realpath "$2")"
TARGET_QUADS="${3:-50000}"
OUTPUT_GLB="${4:-$(pwd)/api-retopologized.glb}"
BLENDER_BIN="${BLENDER_BIN:-/usr/bin/blender}"
BRIDGE="${TOPOLOGY_BLENDER_BRIDGE:-/opt/autoremesher-api/blender_bridge.py}"

mkdir -p "$(dirname "${OUTPUT_GLB}")"
rm -f -- "${OUTPUT_GLB}"
START_SECONDS="$(date +%s)"
HTTP_STATUS="$(curl \
  --noproxy '*' \
  --fail-with-body \
  --silent \
  --show-error \
  --header 'Content-Type: model/gltf-binary' \
  --data-binary "@${INPUT_GLB}" \
  --output "${OUTPUT_GLB}" \
  --write-out '%{http_code}' \
  "${API_URL}/v1/remesh?target_quads=${TARGET_QUADS}")"
ELAPSED_SECONDS="$(( $(date +%s) - START_SECONDS ))"

if [[ "${HTTP_STATUS}" != "200" ]]; then
  echo "API regression failed with HTTP ${HTTP_STATUS}." >&2
  if [[ -f "${OUTPUT_GLB}" ]]; then
    head -c 2000 "${OUTPUT_GLB}" >&2 || true
    echo >&2
  fi
  exit 1
fi

python3 - "${OUTPUT_GLB}" <<'PY'
from pathlib import Path
import sys

output = Path(sys.argv[1])
with output.open("rb") as stream:
    magic = stream.read(4)
if output.stat().st_size < 20 or magic != b"glTF":
    raise SystemExit("API response is not a valid GLB")
PY

"${BLENDER_BIN}" --background --python "${BRIDGE}" -- \
  inspect-glb --input "${OUTPUT_GLB}"

printf 'API_REGRESSION_OK http=%s seconds=%s output=%s bytes=%s\n' \
  "${HTTP_STATUS}" "${ELAPSED_SECONDS}" "${OUTPUT_GLB}" "$(stat -c %s "${OUTPUT_GLB}")"
