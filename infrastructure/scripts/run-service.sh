#!/usr/bin/env bash
# Launch from any working directory; never source .env as executable shell code.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
exec node "$ROOT/scripts/run-python-service.cjs" "$@"
