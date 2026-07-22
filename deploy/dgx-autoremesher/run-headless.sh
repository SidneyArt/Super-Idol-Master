#!/usr/bin/env bash
set -euo pipefail
export QT_QPA_PLATFORM="${QT_QPA_PLATFORM:-xcb}"
exec /usr/bin/xvfb-run -a -s "-screen 0 1280x720x24" /opt/autoremesher/autoremesher "$@"
