#!/usr/bin/env bash
# Verify HTTP and readiness JSON, not merely a listening process. No jq dependency.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${PYTHON_BIN:-python3}" "$SCRIPT_DIR/check_health.py"
