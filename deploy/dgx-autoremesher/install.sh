#!/usr/bin/env bash
set -euo pipefail

SERVICE_ONLY=false
if [[ "${1:-}" == "--service-only" ]]; then
  SERVICE_ONLY=true
elif [[ $# -gt 0 ]]; then
  echo "Usage: sudo bash install.sh [--service-only]" >&2
  exit 2
fi

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this installer as root." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUTOREMESHER_REF="${AUTOREMESHER_REF:-6b6e9adb59c4cf2abdd398173a97d030b566226e}"
BUILD_ROOT="${AUTOREMESHER_BUILD_ROOT:-/opt/autoremesher-src}"
INSTALL_ROOT="${AUTOREMESHER_INSTALL_ROOT:-/opt/autoremesher}"
SERVICE_ROOT="/opt/autoremesher-api"
SERVICE_NAME="autoremesher-api"
SERVICE_ENV="/etc/autoremesher-api.env"

for required_file in service.py blender_bridge.py run-headless.sh service.env.example autoremesher-api.service arm64-geogram.patch; do
  if [[ ! -f "${SCRIPT_DIR}/${required_file}" ]]; then
    echo "Missing installer file: ${SCRIPT_DIR}/${required_file}" >&2
    exit 1
  fi
done

if [[ "${SERVICE_ONLY}" == false ]]; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y \
    build-essential git qt5-qmake qtbase5-dev qttools5-dev-tools \
    libqt5svg5-dev libqt5multimedia5-plugins libqt5multimedia5 libtbb-dev \
    libgl1-mesa-dev xvfb blender curl patch

  if [[ ! -d "${BUILD_ROOT}/.git" ]]; then
    git clone https://github.com/huxingyi/autoremesher.git "${BUILD_ROOT}"
  fi
  git -C "${BUILD_ROOT}" fetch --tags origin
  git -C "${BUILD_ROOT}" checkout --detach "${AUTOREMESHER_REF}"

  # Upstream's Linux release flags currently force an x86-64-v2 baseline. DGX
  # Spark is aarch64, so native ARM64 builds must use the compiler default ISA.
  if [[ "$(uname -m)" == "aarch64" || "$(uname -m)" == "arm64" ]]; then
    sed -i 's/[[:space:]]*-march=x86-64-v2//g' "${BUILD_ROOT}/autoremesher.pro"
    GEOGRAM_ATOMICS="${BUILD_ROOT}/thirdparty/geogram/geogram-1.8.3/src/lib/geogram/basic/atomics.h"
    if ! grep -q 'GEO_USE_GNU_ATOMICS' "${GEOGRAM_ATOMICS}"; then
      patch --batch --forward -d "${BUILD_ROOT}" -p1 < "${SCRIPT_DIR}/arm64-geogram.patch"
    fi
  fi

  cd "${BUILD_ROOT}"
  qmake CONFIG+=release
  make -j"$(nproc)"
  install -d "${INSTALL_ROOT}"
  install -m 0755 autoremesher "${INSTALL_ROOT}/autoremesher"
elif [[ ! -x "${INSTALL_ROOT}/autoremesher" ]]; then
  echo "AutoRemesher is not installed at ${INSTALL_ROOT}/autoremesher; run the full installer first." >&2
  exit 1
fi

install -d "${INSTALL_ROOT}" "${SERVICE_ROOT}"
install -m 0755 "${SCRIPT_DIR}/run-headless.sh" "${INSTALL_ROOT}/run-headless"
install -m 0755 "${SCRIPT_DIR}/service.py" "${SERVICE_ROOT}/service.py"
install -m 0644 "${SCRIPT_DIR}/blender_bridge.py" "${SERVICE_ROOT}/blender_bridge.py"
install -m 0644 "${SCRIPT_DIR}/autoremesher-api.service" "/etc/systemd/system/${SERVICE_NAME}.service"

if [[ ! -f "${SERVICE_ENV}" ]]; then
  install -m 0600 "${SCRIPT_DIR}/service.env.example" "${SERVICE_ENV}"
fi
# Remove the legacy token setting when upgrading an existing installation.
sed -i '/^TOPOLOGY_SERVICE_TOKEN=/d' "${SERVICE_ENV}"
# Add safe preprocessing defaults when upgrading an older service environment.
grep -q '^TOPOLOGY_PREPROCESS_MAX_FACES=' "${SERVICE_ENV}" || \
  printf '\nTOPOLOGY_PREPROCESS_MAX_FACES=150000\n' >> "${SERVICE_ENV}"
grep -q '^TOPOLOGY_PREPROCESS_MERGE_DISTANCE_RATIO=' "${SERVICE_ENV}" || \
  printf 'TOPOLOGY_PREPROCESS_MERGE_DISTANCE_RATIO=0.0000001\n' >> "${SERVICE_ENV}"
grep -q '^TOPOLOGY_PREPROCESS_VOXEL_RESOLUTION=' "${SERVICE_ENV}" || \
  printf 'TOPOLOGY_PREPROCESS_VOXEL_RESOLUTION=256\n' >> "${SERVICE_ENV}"
grep -q '^TOPOLOGY_ADAPTIVITY=' "${SERVICE_ENV}" || \
  printf 'TOPOLOGY_ADAPTIVITY=0.0\n' >> "${SERVICE_ENV}"
grep -q '^TOPOLOGY_SMOOTH_SHADING_ANGLE=' "${SERVICE_ENV}" || \
  printf 'TOPOLOGY_SMOOTH_SHADING_ANGLE=60.0\n' >> "${SERVICE_ENV}"
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}.service"
systemctl restart "${SERVICE_NAME}.service"
systemctl --no-pager --full status "${SERVICE_NAME}.service"
HEALTH_HOST="$(awk -F= '$1 == "TOPOLOGY_HOST" { print $2 }' "${SERVICE_ENV}" | tail -n 1)"
HEALTH_PORT="$(awk -F= '$1 == "TOPOLOGY_PORT" { print $2 }' "${SERVICE_ENV}" | tail -n 1)"
[[ -n "${HEALTH_HOST}" ]] || HEALTH_HOST="127.0.0.1"
[[ "${HEALTH_HOST}" == "0.0.0.0" ]] && HEALTH_HOST="127.0.0.1"
[[ -n "${HEALTH_PORT}" ]] || HEALTH_PORT="8190"
HEALTH_URL="http://${HEALTH_HOST}:${HEALTH_PORT}/healthz"
HEALTHY=false
for _attempt in $(seq 1 30); do
  if curl --noproxy '*' --fail --silent --show-error "${HEALTH_URL}"; then
    HEALTHY=true
    break
  fi
  sleep 1
done
if [[ "${HEALTHY}" != true ]]; then
  echo "AutoRemesher API did not become healthy within 30 seconds: ${HEALTH_URL}" >&2
  journalctl -u "${SERVICE_NAME}.service" -n 50 --no-pager >&2 || true
  exit 1
fi
printf '\nAutoRemesher API installed as %s.service.\n' "${SERVICE_NAME}"
printf 'Next: allow trusted private-network clients to reach TCP %s and configure them with this API URL.\n' "${HEALTH_PORT}"
